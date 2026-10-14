"""insights 插件测试：compute_stats 纯函数（发送者聚合、est_tokens、@提及边）
与 REST 端点（路由由插件挂载，create_app 装载仓库 plugins/）。"""

from __future__ import annotations

import importlib.util
from pathlib import Path

_PLUGIN_PATH = (
    Path(__file__).resolve().parent.parent / "plugins" / "insights" / "plugin.py"
)


def _load_insights_plugin():
    """按插件装载路径加载 insights 插件模块（与 PluginManager 同款 importlib 方式）。"""
    spec = importlib.util.spec_from_file_location("insights_plugin", _PLUGIN_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_insights = _load_insights_plugin()
compute_stats = _insights.compute_stats
est_tokens = _insights.est_tokens


def _msg(sender, text, attachments=None, type="chat", **kw):
    return {
        "sender": sender,
        "text": text,
        "type": type,
        "attachments": list(attachments or []),
        **kw,
    }


# ---- est_tokens ----


def test_est_tokens_cjk_and_mixed():
    assert est_tokens("") == 0
    assert est_tokens("你好世界") == 4  # CJK 每字 1 token
    assert est_tokens("hello world") == 2  # 11 字符 // 4
    assert est_tokens("你好 abcd") == 3  # 2 CJK + 5 字符 // 4
    assert est_tokens("，。！") == 3  # 全角标点也算 CJK 区间


# ---- compute_stats: senders ----


def test_senders_aggregated_and_sorted():
    messages = [
        _msg("claude", "a" * 40, attachments=[{"id": "x"}]),
        _msg("我", "你好"),
        _msg("claude", "b" * 40),
        _msg("我", "你好世界"),
    ]
    stats = compute_stats(messages, agents=["claude"])
    assert stats["total_messages"] == 4
    assert [s["name"] for s in stats["senders"]] == ["claude", "我"]  # 消息数降序
    claude = stats["senders"][0]
    assert claude["messages"] == 2
    assert claude["chars"] == 80
    assert claude["est_tokens"] == est_tokens("a" * 40) * 2
    assert claude["in_est_tokens"] == 0  # 无人提及 → 0
    assert claude["attachments"] == 1
    assert stats["senders"][1]["chars"] == len("你好") + len("你好世界")


def test_non_chat_messages_skipped():
    messages = [
        _msg("system", "系统提示 @claude", type="system"),
        _msg("claude", "加入了会话", type="join"),
        _msg("我", "正常消息"),
    ]
    stats = compute_stats(messages, agents=["claude"])
    assert stats["total_messages"] == 1
    assert [s["name"] for s in stats["senders"]] == ["我"]
    assert stats["edges"] == []


# ---- compute_stats: edges ----


def test_edges_from_mentions_aggregated():
    messages = [
        _msg("我", "@claude 看一下"),
        _msg("我", "@claude 再看一下 @kimi"),
        _msg("kimi", "@claude 收到"),
        _msg("我", "@陌生人 不在成员列表里不算"),
    ]
    stats = compute_stats(messages, agents=["claude", "kimi"])
    assert stats["edges"] == [
        {"from": "我", "to": "claude", "count": 2},
        {"from": "kimi", "to": "claude", "count": 1},
        {"from": "我", "to": "kimi", "count": 1},
    ]


def test_mentions_in_code_blocks_not_counted():
    messages = [
        _msg("我", "```\n@claude 代码块里不算\n```\n还有 `@kimi` 也不算"),
        _msg("我", "但 @claude 这里算"),
    ]
    stats = compute_stats(messages, agents=["claude", "kimi"])
    assert stats["edges"] == [{"from": "我", "to": "claude", "count": 1}]


def test_mention_all_expands_to_session_agents():
    messages = [
        _msg("我", "@全部 集合"),
        _msg("claude", "@ALL 收到 @kimi"),
    ]
    stats = compute_stats(messages, agents=["claude", "kimi", "deveco"])
    # @ALL 展开与直接提及去重（与触发路由语义一致）：claude→kimi 只计 1 次
    assert stats["edges"] == [
        {"from": "claude", "to": "claude", "count": 1},
        {"from": "claude", "to": "deveco", "count": 1},
        {"from": "claude", "to": "kimi", "count": 1},
        {"from": "我", "to": "claude", "count": 1},
        {"from": "我", "to": "deveco", "count": 1},
        {"from": "我", "to": "kimi", "count": 1},
    ]


def test_empty_session_stats():
    assert compute_stats([], agents=["claude"]) == {
        "total_messages": 0,
        "senders": [],
        "edges": [],
    }


# ---- REST 端点 ----


def _create(client, auth, title="统计", agents=("claude", "kimi")):
    resp = client.post(
        "/api/sessions", json={"title": title, "agents": list(agents)}, headers=auth
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_stats_endpoint_full_chain(client, auth):
    sid = _create(client, auth)["id"]
    post = lambda text, **kw: client.post(  # noqa: E731
        f"/api/sessions/{sid}/messages", json={"text": text, **kw}, headers=auth
    )
    assert post("@claude 你好").status_code == 201
    assert post("@kimi @claude 都在吗", sender="claude").status_code == 201
    assert post("没人被提及").status_code == 201

    resp = client.get(f"/api/sessions/{sid}/stats", headers=auth)
    assert resp.status_code == 200, resp.text
    stats = resp.json()
    assert stats["total_messages"] == 3
    assert stats["senders"][0]["name"] == "我" and stats["senders"][0]["messages"] == 2
    assert {"from": "我", "to": "claude", "count": 1} in stats["edges"]
    assert {"from": "claude", "to": "kimi", "count": 1} in stats["edges"]


def test_stats_endpoint_ignores_history_limit(client, auth, app_state):
    """统计基于完整 JSONL，不受 history_limit（50）截断影响。"""
    sid = _create(client, auth)["id"]
    for i in range(60):
        app_state.store.add(sid, "我", f"第{i}条")
    stats = client.get(f"/api/sessions/{sid}/stats", headers=auth).json()
    assert stats["total_messages"] == 60


def test_stats_endpoint_auth_and_unknown_session(client, auth):
    sid = _create(client, auth)["id"]
    assert client.get(f"/api/sessions/{sid}/stats").status_code == 401
    assert client.get("/api/sessions/s_nope/stats", headers=auth).status_code == 404


# ---- in_est_tokens（input 估算）----


def test_in_est_tokens_accumulates_per_target():
    messages = [
        _msg("我", "@claude 你好"),  # est = 2(@claude≈7+空格→8//4) + 你好 2 = 4? 见下按函数算
        _msg("kimi", "@claude 收到收到"),
        _msg("我", "没提任何人"),
    ]
    stats = compute_stats(messages, agents=["claude", "kimi"])
    by_name = {s["name"]: s for s in stats["senders"]}
    expected = est_tokens("@claude 你好") + est_tokens("@claude 收到收到")
    assert by_name["claude"]["in_est_tokens"] == expected
    assert by_name["kimi"]["in_est_tokens"] == 0  # 没人 @kimi
    # est_tokens（自己发送的 output）语义不变
    assert by_name["我"]["est_tokens"] == est_tokens("@claude 你好") + est_tokens("没提任何人")
    assert by_name["我"]["in_est_tokens"] == 0


def test_in_est_tokens_mention_all_expands_to_every_member():
    stats = compute_stats([_msg("我", "@全部 集合")], agents=["claude", "kimi"])
    by_name = {s["name"]: s for s in stats["senders"]}
    for name in ("claude", "kimi"):
        assert by_name[name]["in_est_tokens"] == est_tokens("@全部 集合")
        assert by_name[name]["messages"] == 0  # 被@但沉默的 agent 也有条目


def test_in_est_tokens_silent_target_appears():
    """从未发言的 target 也建条目（messages=0，in_est_tokens 有值）。"""
    stats = compute_stats([_msg("我", "@deveco 在吗")], agents=["deveco"])
    deveco = next(s for s in stats["senders"] if s["name"] == "deveco")
    assert deveco["messages"] == 0
    assert deveco["chars"] == 0
    assert deveco["est_tokens"] == 0
    assert deveco["in_est_tokens"] == est_tokens("@deveco 在吗")
    assert stats["total_messages"] == 1  # 总数只算实际发言


def test_stats_endpoint_includes_in_est_tokens(client, auth):
    sid = _create(client, auth)["id"]
    client.post(
        f"/api/sessions/{sid}/messages", json={"text": "@claude 看下"}, headers=auth
    )
    stats = client.get(f"/api/sessions/{sid}/stats", headers=auth).json()
    by_name = {s["name"]: s for s in stats["senders"]}
    assert by_name["claude"]["in_est_tokens"] == est_tokens("@claude 看下")
    assert by_name["我"]["in_est_tokens"] == 0
