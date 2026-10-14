"""insights 插件：会话统计看板后端（原 core/stats.py + server/api_stats.py）。

路由保持 `GET /api/sessions/{id}/stats` 不变；统计基于服务端完整 JSONL。
"""

from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends

from teamroom.core.router import _strip_code
from teamroom.server.api import _session_or_404, get_state, require_token

Message = dict[str, Any]

_MENTION_RE = re.compile(r"@([A-Za-z0-9_-]+)")
_MENTION_ALL_RE = re.compile(r"@(全部|all)(?![A-Za-z0-9_-])", re.IGNORECASE)

# 常见 CJK 区间：平/片假名（U+3040–30FF）、CJK 符号与标点（U+3000–303F）、
# 扩展 A（U+3400–4DBF）、统一表意文字（U+4E00–9FFF）、兼容表意文字（U+F900–FAFF）、
# 全角字符（U+FF00–FFEF）
_CJK_RE = re.compile(
    r"[\u3040-\u30FF\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]"
)


def est_tokens(text: str) -> int:
    """估算文本 token 数：CJK 字符每个 1 token，其余字符每 4 个 1 token（向下取整）。"""
    cjk = len(_CJK_RE.findall(text))
    return cjk + (len(text) - cjk) // 4


def _mentions(text: str, known: dict[str, str]) -> list[str]:
    """从正文解析 @提及目标（忽略代码块/行内代码，大小写不敏感，按序去重），
    返回 agents 列表里的规范写法；@all/@全部 不在此处理。"""
    targets: list[str] = []
    seen: set[str] = set()
    for match in _MENTION_RE.finditer(_strip_code(text)):
        key = match.group(1).lower()
        if key in known and key not in seen:
            seen.add(key)
            targets.append(known[key])
    return targets


def compute_stats(messages: list[Message], agents: list[str]) -> dict[str, Any]:
    """基于服务端完整消息列表计算会话统计（不受前端 history_limit 截断影响）。

    agents 为会话当前成员列表（base 名或实例名），既是 @提及的已知名字表，
    也是 @all/@全部 的展开目标（与直接提及去重，与触发路由语义一致）。

    每个 sender 条目的 in_est_tokens：累加"提到该 sender 的消息"的 est_tokens
    （input 估算）；被 @但从未发言的 target 也会建条目（messages=0 等），
    让前端能看到"被@但沉默"的 agent。est_tokens 保持"自己发送的"（output）语义。
    """
    known = {name.lower(): name for name in agents}
    senders: dict[str, dict[str, Any]] = {}
    edges: dict[tuple[str, str], int] = {}

    def _entry(name: str) -> dict[str, Any]:
        return senders.setdefault(
            name,
            {
                "name": name,
                "messages": 0,
                "chars": 0,
                "est_tokens": 0,
                "in_est_tokens": 0,
                "attachments": 0,
            },
        )

    for msg in messages:
        if msg.get("type") != "chat":
            continue
        sender = str(msg.get("sender", ""))
        text = str(msg.get("text", ""))
        msg_tokens = est_tokens(text)
        entry = _entry(sender)
        entry["messages"] += 1
        entry["chars"] += len(text)
        entry["est_tokens"] += msg_tokens
        entry["attachments"] += len(msg.get("attachments") or [])

        stripped = _strip_code(text)
        targets = _mentions(stripped, known)
        if _MENTION_ALL_RE.search(stripped):
            # @all/@全部 展开为到会话每个成员的边（按 agents 列表原样，去重）
            seen = {t.lower() for t in targets}
            targets += [name for name in agents if name.lower() not in seen]
        for target in targets:
            key = (sender, target)
            edges[key] = edges.get(key, 0) + 1
            _entry(target)["in_est_tokens"] += msg_tokens

    return {
        "total_messages": sum(s["messages"] for s in senders.values()),
        "senders": sorted(senders.values(), key=lambda s: (-s["messages"], s["name"])),
        "edges": [
            {"from": src, "to": dst, "count": count}
            for (src, dst), count in sorted(edges.items(), key=lambda kv: (-kv[1], kv[0]))
        ],
    }


def register(ctx) -> dict[str, Any]:
    """插件入口：挂载统计路由。"""
    router = APIRouter(prefix="/api/sessions", tags=["stats"])

    @router.get("/{session_id}/stats", dependencies=[Depends(require_token)])
    def session_stats(session_id: str, state=Depends(get_state)) -> dict[str, Any]:
        """会话统计看板数据：发送者聚合 + @提及流向边。"""
        session = _session_or_404(state, session_id)
        return compute_stats(state.store.list(session_id), list(session.get("agents", [])))

    return {"routers": [router]}
