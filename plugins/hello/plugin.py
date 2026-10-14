"""hello 插件：最小完整示例（教学模板，照抄这个结构写你自己的插件）。

演示全部三个后端钩子 + 一个前端入口的接线方式：

- prompt_extras：每次给 agent 注入提示词时追加一行问候
- on_message：消息落盘后按会话计数，写入插件私有目录 data/plugins/hello/
- routers：GET /api/sessions/{id}/hello 返回该会话的消息计数，
  供前端 web/index.js 的头部按钮弹窗展示

对应前端：web/index.js（头部按钮 + 宿主模态框）、web/style.css（弹窗样式）。
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends

# 复用宿主的标准件：会话 404、AppState 注入、令牌鉴权。
# 插件路由一律挂 require_token，与核心 API 同一鉴权口径。
from teamroom.server.api import _session_or_404, get_state, require_token


def register(ctx) -> dict[str, Any]:
    """插件入口：宿主装载时调用一次，返回要注册的钩子（所有键均可省略）。

    ctx.state    -> AppState（config、store、sessions、registry、ws……）
    ctx.data_dir -> Path("data/plugins/hello")，插件私有存储，目录已由宿主创建
    """
    # 计数持久化到插件私有目录：卸载插件不会在核心数据里留残渣。
    counts_file = ctx.data_dir / "counts.json"

    def _load_counts() -> dict[str, int]:
        """读取 {session_id: 消息数}；文件缺失或损坏时从零开始（插件不该因此崩溃）。"""
        try:
            data = json.loads(counts_file.read_text(encoding="utf-8"))
            return {str(k): int(v) for k, v in data.items()}
        except Exception:
            return {}

    def _save_counts(counts: dict[str, int]) -> None:
        counts_file.write_text(
            json.dumps(counts, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    # ---- 钩子 1：on_message ------------------------------------------------
    # 签名固定为 (state, session, msg, mentioned)，在消息落盘路径上同步执行，
    # 必须廉价：只做内存/文件追加，不走网络、不做重计算。
    # mentioned 是本条消息里已被 @提及路由入队的实例名集合，本例用不到。
    def on_message(state, session: dict[str, Any], msg: dict[str, Any], mentioned: set[str]) -> None:
        if msg.get("type") != "chat":  # 只统计聊天消息，跳过系统/事件消息
            return
        counts = _load_counts()
        session_id = str(session["id"])
        counts[session_id] = counts.get(session_id, 0) + 1
        _save_counts(counts)

    # ---- 钩子 2：prompt_extras ----------------------------------------------
    # 每次构建发给某个 agent 的提示词时调用，返回追加到末尾的若干行。
    # 返回空列表 = 什么都不注入。
    def prompt_extras(session: dict[str, Any], agent_name: str) -> list[str]:
        return [f"（hello 插件）你好 {agent_name}，很高兴和你一起开会！"]

    # ---- 钩子 3：routers ----------------------------------------------------
    # 路由原样挂载到 FastAPI 应用；路径要自带插件域名前缀，避免与其他插件冲突。
    router = APIRouter(prefix="/api/sessions", tags=["hello"])

    @router.get("/{session_id}/hello", dependencies=[Depends(require_token)])
    def hello_counter(session_id: str, state=Depends(get_state)) -> dict[str, Any]:
        """返回指定会话的聊天消息计数（前端头部按钮弹窗的数据源）。"""
        _session_or_404(state, session_id)  # 会话不存在 -> 404
        return {
            "session_id": session_id,
            "messages": _load_counts().get(session_id, 0),
        }

    return {
        "routers": [router],
        "on_message": on_message,
        "prompt_extras": prompt_extras,
    }
