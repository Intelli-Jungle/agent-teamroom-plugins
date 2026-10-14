"""msglog 插件：把每个会话的每条消息追加到全局 JSONL 日志（实用型，无前端）。

- on_message：消息落盘后追加一行到 data/plugins/msglog/messages.jsonl
  （每行 = 原始消息 dict + session_id 字段）
- routers：GET /api/msglog/recent?limit=N 导出最近 N 条（默认 50，上限 500）

日志文件随消息单调增长；需要轮转/清理时直接删文件即可（插件会在下一条
消息时重建），核心数据不受影响。
"""

from __future__ import annotations

import json
from collections import deque
from typing import Any

from fastapi import APIRouter, Depends, Query

from teamroom.server.api import require_token


def register(ctx) -> dict[str, Any]:
    """插件入口：注册消息日志钩子与导出路由。"""
    log_file = ctx.data_dir / "messages.jsonl"

    def on_message(state, session: dict[str, Any], msg: dict[str, Any], mentioned: set[str]) -> None:
        """落盘路径上的同步钩子：只追加一行 JSON，保持廉价。"""
        record = {"session_id": session["id"], **msg}
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

    router = APIRouter(prefix="/api/msglog", tags=["msglog"])

    @router.get("/recent", dependencies=[Depends(require_token)])
    def recent_messages(limit: int = Query(50, ge=1, le=500)) -> dict[str, Any]:
        """导出最近 limit 条消息（跨会话，按写入顺序）。坏行跳过。"""
        if not log_file.exists():
            return {"messages": []}
        tail: deque[dict[str, Any]] = deque(maxlen=limit)
        with open(log_file, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    tail.append(json.loads(line))
                except json.JSONDecodeError:
                    continue  # 容忍截断/损坏行，不影响导出其余记录
        return {"messages": list(tail)}

    return {"routers": [router], "on_message": on_message}
