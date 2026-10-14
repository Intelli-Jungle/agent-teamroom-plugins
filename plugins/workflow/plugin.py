"""workflow 插件：会话级有向工作流（语义见 docs/plugins.md "工作流插件语义"节）。

存储：ctx.data_dir/{session_id}.json（data/plugins/workflow/ 下，原子写、损坏容忍），
结构 {"enabled": bool, "max_hops": int 1..100, "edges": [{"from","to"}],
      "roles": {agent: text}, "goals": {agent: text}}。
旧数据无 goals 字段：读取时回填为空 dict。edges 允许 from==to（自环）。

on_message 路由（经 triggers.enqueue_trigger 单一构建路径写队列，
自动获得 cwd 头行 + 全部插件 prompt_extras + 附件路径）：
- 只处理 type=="chat"；会话无配置或 enabled=false 直接返回；
- 消息 sender 作为源节点，沿每条出边推进（自环边除外，单独处理）：
  目标是人类节点（"我"或任何非 agent 名）→ 跳过（暂停点）；
  目标是 agent → 已在 mentioned 集合则跳过，否则入队，条目带 _wf_hops；
- 自环续跑：sender 与某 agent base 匹配、存在自环边、本次 hops < max_hops、
  且回复正文不含 [GOAL_DONE] → 以 hops+1 再入队该 agent（续跑文案）；
  含 [GOAL_DONE] → 自环停止，其他出边照常触发；
- hops 延续：插件内存维护 {(session_id, agent_base): hops}——入队时记 hops，
  该 agent 之后发言时以 hops+1 续跑；hops >= max_hops 不再出边；
  人类发言视为新一轮 hops=0。

prompt_extras（按序，双层回退：会话 workflow 值（实例名优先、base 兜底）>
config.toml 的 spec.role/goal/backstory）：会话交互指令（instructions 非空时
最前）→ 你的角色 → 你的目标 → 你的背景 → 自环停止约定行（含剩余轮数）
→ 你的经验笔记（三件套任一存在即给；
data/plugins/workflow/memory/{sid}/{base}.md，自动创建）。无会话配置时
也回退到 spec 人设。
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from teamroom.server.api import _session_or_404, get_state, require_token
from teamroom.server.triggers import _resolve_instances, enqueue_trigger

HUMAN_NODE = "我"
GOAL_DONE_MARK = "[GOAL_DONE]"
MAX_HOPS_LIMIT = 100
GOAL_BRIEF_LIMIT = 100

DEFAULT_WORKFLOW: dict[str, Any] = {
    "enabled": False,
    "max_hops": 10,
    "edges": [],
    "roles": {},
    "goals": {},
    "backstories": {},
    "instructions": "",
}


class WorkflowPut(BaseModel):
    enabled: bool
    max_hops: int = Field(ge=1, le=MAX_HOPS_LIMIT)
    edges: list[dict[str, Any]] = Field(default_factory=list)
    roles: dict[str, str] = Field(default_factory=dict)
    goals: dict[str, str] = Field(default_factory=dict)
    backstories: dict[str, str] = Field(default_factory=dict)
    instructions: str = ""


def _validate_edges(edges: list[dict[str, Any]]) -> None:
    for edge in edges:
        if (
            not isinstance(edge.get("from"), str)
            or not edge["from"].strip()
            or not isinstance(edge.get("to"), str)
            or not edge["to"].strip()
        ):
            raise ValueError("edges 每项的 from/to 必须是非空字符串")


class WorkflowStore:
    """每会话一个 JSON 文件的工作流配置读写（原子写、损坏容忍）。"""

    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _path(self, session_id: str) -> Path:
        if not session_id or "/" in session_id or "\\" in session_id:
            raise ValueError(f"非法会话 id: {session_id!r}")
        return self.data_dir / f"{session_id}.json"

    def get(self, session_id: str) -> dict[str, Any] | None:
        path = self._path(session_id)
        if not path.is_file():
            return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else None
        except (json.JSONDecodeError, OSError):
            return None

    def put(self, session_id: str, config: dict[str, Any]) -> None:
        with self._lock:
            path = self._path(session_id)
            tmp = path.with_suffix(".json.tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(config, f, ensure_ascii=False, indent=2)
            os.replace(tmp, path)

    def remove(self, session_id: str) -> bool:
        with self._lock:
            path = self._path(session_id)
            if not path.is_file():
                return False
            path.unlink()
            return True


def register(ctx) -> dict[str, Any]:
    """插件入口：挂载工作流路由，返回 on_message / prompt_extras 钩子。"""
    store = WorkflowStore(ctx.data_dir)
    hops: dict[tuple[str, str], int] = {}  # (session_id, agent_base) -> hops

    router = APIRouter(prefix="/api/sessions", tags=["workflow"])

    @router.get("/{session_id}/workflow", dependencies=[Depends(require_token)])
    def get_workflow(session_id: str, state=Depends(get_state)) -> dict[str, Any]:
        _session_or_404(state, session_id)
        stored = store.get(session_id)
        # 旧数据无 goals 等新字段：用默认结构回填
        return {"workflow": {**DEFAULT_WORKFLOW, **stored} if stored else dict(DEFAULT_WORKFLOW)}

    @router.put("/{session_id}/workflow", dependencies=[Depends(require_token)])
    def put_workflow(
        session_id: str, body: WorkflowPut, state=Depends(get_state)
    ) -> dict[str, Any]:
        _session_or_404(state, session_id)
        try:
            _validate_edges(body.edges)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        config = {
            "enabled": body.enabled,
            "max_hops": body.max_hops,
            "edges": [{"from": e["from"], "to": e["to"]} for e in body.edges],
            "roles": dict(body.roles),
            "goals": dict(body.goals),
            "backstories": dict(body.backstories),
            "instructions": body.instructions,
        }
        store.put(session_id, config)
        return {"workflow": config}

    @router.delete("/{session_id}/workflow", dependencies=[Depends(require_token)])
    def delete_workflow(session_id: str, state=Depends(get_state)) -> dict[str, Any]:
        _session_or_404(state, session_id)
        store.remove(session_id)
        return {"ok": True}

    # ---- 钩子 ----

    def _sender_base(state, sender: str) -> str:
        """注册实例发言归一到 base 名；未注册（人类等）原样返回。"""
        inst = state.registry.get(sender)
        return str(inst["base"]) if inst else sender

    def _agent_bases(state) -> set[str]:
        return {str(i["base"]) for i in state.registry.list()}

    def _is_agent_target(state, session: dict[str, Any], name: str) -> bool:
        """目标是 agent 节点：命中注册实例名/base 或会话成员列表；
        否则视为人类节点（"我"或任意非 agent 名）。"""
        if name == HUMAN_NODE:
            return False
        if name in set(session.get("agents", [])):
            return True
        return any(
            i["name"] == name or i["base"] == name for i in state.registry.list()
        )

    def _lookup(mapping: dict[str, str], agent_name: str, base: str) -> str | None:
        """roles/goals 查找：实例名优先，其次 base 名。"""
        return mapping.get(agent_name) or mapping.get(base)

    def _memory_path(session_id: str, base: str) -> Path:
        """经验笔记文件：自动 mkdir，文件不存在就创建空文件。"""
        safe_base = base.replace("/", "_").replace("\\", "_")
        directory = ctx.data_dir / "memory" / session_id
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{safe_base}.md"
        path.touch(exist_ok=True)
        return path.resolve()

    def on_message(state, session: dict[str, Any], msg: dict[str, Any], mentioned: set[str]) -> None:
        if msg.get("type") != "chat":
            return
        config = store.get(session["id"])
        if not config or not config.get("enabled"):
            return
        sender = str(msg.get("sender", ""))
        sender_base = _sender_base(state, sender)
        max_hops = int(config.get("max_hops", 10))
        instances = state.registry.list()
        agent_bases = {str(i["base"]) for i in instances}
        if sender_base not in agent_bases:
            hop = 0  # 人类发言：新一轮
        else:
            hop = hops.get((session["id"], sender_base), 0) + 1
        if hop >= max_hops:
            return  # 达到跳数上限，不再出边（含自环）

        goals = config.get("goals") or {}
        edges = config.get("edges", [])

        def _enqueue(target: str, text: str) -> None:
            """经单一构建路径入队目标实例（自动带 cwd/extras/附件），
            mentioned 去重保留在本侧；入队成功后记跳数。"""
            for inst in _resolve_instances(instances, target, session):
                if inst["name"] in mentioned:
                    continue  # 同条消息的显式 @提及已入队，去重
                queued = enqueue_trigger(
                    state,
                    session,
                    sender=sender,
                    text=text,
                    targets=[inst["name"]],
                    hops=hop,
                    time_str=str(msg.get("time", "")),
                )
                if queued:
                    hops[(session["id"], str(inst["base"]))] = hop

        # 普通出边（自环边跳过，走下方 GOAL_DONE 约定）
        for edge in edges:
            if edge.get("from") == edge.get("to"):
                continue
            if edge.get("from") not in (sender, sender_base):
                continue
            target = str(edge.get("to", ""))
            if not target or not _is_agent_target(state, session, target):
                continue  # 人类节点 = 暂停点
            _enqueue(target, str(msg.get("text", "")))

        # 自环续跑：未标记 [GOAL_DONE] 则以 hops+1 再入队自身
        has_self_loop = any(
            e.get("from") == e.get("to") and e.get("from") in (sender, sender_base)
            for e in edges
        )
        if (
            has_self_loop
            and sender_base in agent_bases
            and GOAL_DONE_MARK not in str(msg.get("text", ""))
        ):
            goal = _lookup(goals, sender, sender_base)
            if goal:
                brief = goal if len(goal) <= GOAL_BRIEF_LIMIT else goal[:GOAL_BRIEF_LIMIT] + "…"
                text = f"（工作流自驱续跑）你上一轮未标记 {GOAL_DONE_MARK}，请继续推进目标：{brief}"
            else:
                text = f"（工作流自驱续跑）你上一轮未标记 {GOAL_DONE_MARK}，请继续推进。"
            _enqueue(sender_base, text)

    def _spec_persona(agent_name: str, base: str):
        """该 agent 的全局人设（config.toml [agents.<base>]），无配置返回 None。"""
        agents = ctx.state.config.agents
        return agents.get(base) or agents.get(agent_name)

    def prompt_extras(session: dict[str, Any], agent_name: str) -> list[str]:
        stored = store.get(session["id"])
        # 无会话 workflow 配置时也要回退到 spec 人设，不提前返回空
        config = {**DEFAULT_WORKFLOW, **stored} if stored else dict(DEFAULT_WORKFLOW)
        inst = ctx.state.registry.get(agent_name)
        base = str(inst["base"]) if inst else agent_name
        spec = _spec_persona(agent_name, base)

        # 双层回退链：会话 workflow 值（实例名优先、base 兜底）> spec 全局值
        role = _lookup(config["roles"], agent_name, base) or (spec.role if spec else "")
        goal = _lookup(config["goals"], agent_name, base) or (spec.goal if spec else "")
        backstory = _lookup(config["backstories"], agent_name, base) or (
            spec.backstory if spec else ""
        )

        lines: list[str] = []
        instructions = str(config["instructions"] or "")
        if instructions:
            lines.append(f"会话交互指令（每次回复都必须遵守）：{instructions}")
        if role:
            lines.append(f"你的角色：{role}")
        if goal:
            lines.append(f"你的目标：{goal}")
        if backstory:
            lines.append(f"你的背景：{backstory}")
        has_self_loop = any(
            e.get("from") == e.get("to") and e.get("from") in (agent_name, base)
            for e in config["edges"]
        )
        if has_self_loop:
            remaining = int(config["max_hops"]) - hops.get((session["id"], base), 0)
            lines.append(
                f"目标达成时在回复末尾单独一行写 {GOAL_DONE_MARK}；"
                f"未达成则不要写，系统会自动让你继续（剩余 {remaining} 轮）"
            )
        if role or goal or backstory:
            memory = _memory_path(session["id"], base)
            lines.append(f"你的经验笔记：{memory}（可读写，内容跨轮次保留，建议每轮结束更新）")
        return lines

    return {
        "routers": [router],
        "on_message": on_message,
        "prompt_extras": prompt_extras,
    }
