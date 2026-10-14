"""workflow 插件测试：REST CRUD、单边/双向/环+跳数上限、@提及去重、
人类节点暂停、roles 注入提示词、存储落盘。"""

from __future__ import annotations

import json


def _create(client, auth, title="流程", agents=()):
    resp = client.post(
        "/api/sessions", json={"title": title, "agents": list(agents)}, headers=auth
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _put_workflow(client, auth, sid, edges, enabled=True, max_hops=10, roles=None, goals=None, backstories=None, instructions=""):
    return client.put(
        f"/api/sessions/{sid}/workflow",
        json={
            "enabled": enabled,
            "max_hops": max_hops,
            "edges": edges,
            "roles": roles or {},
            "goals": goals or {},
            "backstories": backstories or {},
            "instructions": instructions,
        },
        headers=auth,
    )


def _say(client, auth, sid, text, sender=None):
    body = {"text": text}
    if sender is not None:
        body["sender"] = sender
    resp = client.post(f"/api/sessions/{sid}/messages", json=body, headers=auth)
    assert resp.status_code == 201, resp.text


def _queue_lines(app_state, name):
    path = app_state.data_dir / "queues" / f"{name}.jsonl"
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


# ---- REST CRUD ----


def test_workflow_crud(client, auth, app_state):
    sid = _create(client, auth)["id"]

    # 无配置返回默认空结构
    resp = client.get(f"/api/sessions/{sid}/workflow", headers=auth)
    assert resp.status_code == 200
    assert resp.json()["workflow"] == {
        "enabled": False,
        "max_hops": 10,
        "edges": [],
        "roles": {},
        "goals": {},
        "backstories": {},
        "instructions": "",
    }

    config = {
        "enabled": True,
        "max_hops": 5,
        "edges": [{"from": "我", "to": "claude"}],
        "roles": {"claude": "评审员"},
        "goals": {"claude": "把 x 从 1 数到 3"},
        "backstories": {"claude": "十年评审经验"},
        "instructions": "",
    }
    resp = _put_workflow(
        client, auth, sid, config["edges"], max_hops=5, roles=config["roles"],
        goals=config["goals"], backstories=config["backstories"],
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["workflow"] == config
    assert client.get(f"/api/sessions/{sid}/workflow", headers=auth).json()["workflow"] == config

    # 落盘在插件私有目录
    stored = json.loads(
        (app_state.data_dir / "plugins" / "workflow" / f"{sid}.json").read_text(encoding="utf-8")
    )
    assert stored == config

    assert client.delete(f"/api/sessions/{sid}/workflow", headers=auth).json()["ok"] is True
    assert (
        client.get(f"/api/sessions/{sid}/workflow", headers=auth).json()["workflow"]["enabled"]
        is False
    )


def test_workflow_validation_and_auth(client, auth):
    sid = _create(client, auth)["id"]
    for body in (
        {"enabled": True, "max_hops": 0, "edges": [], "roles": {}},
        {"enabled": True, "max_hops": 101, "edges": [], "roles": {}},
        {"enabled": True, "max_hops": 5, "edges": [{"from": "", "to": "claude"}], "roles": {}},
        {"enabled": True, "max_hops": 5, "edges": [{"from": "我"}], "roles": {}},
    ):
        assert client.put(
            f"/api/sessions/{sid}/workflow", json=body, headers=auth
        ).status_code == 422

    assert client.get(f"/api/sessions/{sid}/workflow").status_code == 401
    assert client.get("/api/sessions/s_nope/workflow", headers=auth).status_code == 404
    assert (
        _put_workflow(client, auth, "s_nope", []).status_code == 404
    )
    assert client.delete("/api/sessions/s_nope/workflow", headers=auth).status_code == 404


# ---- on_message 路由 ----


def test_single_edge_triggers_agent_with_hops(client, auth, app_state):
    app_state.registry.register("claude")
    sid = _create(client, auth, agents=["claude"])["id"]
    _put_workflow(client, auth, sid, [{"from": "我", "to": "claude"}])

    _say(client, auth, sid, "开始干活")
    entries = _queue_lines(app_state, "claude")
    assert len(entries) == 1
    assert entries[0]["_wf_hops"] == 0  # 人类发言视为新一轮
    # 单一构建路径：工作流触发同样带 cwd 头行，正文在末行
    lines = entries[0]["text"].split("\n")
    assert lines[0].startswith("会话工作目录：")
    assert lines[-1] == "开始干活"
    assert entries[0]["session_id"] == sid


def test_disabled_or_missing_config_does_nothing(client, auth, app_state):
    app_state.registry.register("claude")
    sid = _create(client, auth, agents=["claude"])["id"]
    _say(client, auth, sid, "无配置")
    _put_workflow(client, auth, sid, [{"from": "我", "to": "claude"}], enabled=False)
    _say(client, auth, sid, "禁用中")
    assert _queue_lines(app_state, "claude") == []


def test_explicit_mention_dedupes_workflow(client, auth, app_state):
    """同一条消息里显式 @提及已入队的实例，工作流不再重复入队。"""
    app_state.registry.register("claude")
    sid = _create(client, auth, agents=["claude"])["id"]
    _put_workflow(client, auth, sid, [{"from": "我", "to": "claude"}])

    _say(client, auth, sid, "@claude 显式点名")
    entries = _queue_lines(app_state, "claude")
    assert len(entries) == 1
    assert "_wf_hops" not in entries[0]  # 来自 @提及路由，而非工作流


def test_edge_to_human_is_pause_point(client, auth, app_state):
    app_state.registry.register("claude")
    sid = _create(client, auth, agents=["claude"])["id"]
    _put_workflow(
        client, auth, sid, [{"from": "我", "to": "claude"}, {"from": "claude", "to": "我"}]
    )

    _say(client, auth, sid, "开始")
    assert len(_queue_lines(app_state, "claude")) == 1

    _say(client, auth, sid, "做完了", sender="claude")  # 出边指向人类 → 暂停点
    assert len(_queue_lines(app_state, "claude")) == 1


def test_cycle_stops_at_max_hops(client, auth, app_state):
    """claude ⇄ kimi 环：max_hops=3 时入队 3 次后截停。"""
    app_state.registry.register("claude")
    app_state.registry.register("kimi")
    sid = _create(client, auth, agents=["claude", "kimi"])["id"]
    _put_workflow(
        client,
        auth,
        sid,
        [
            {"from": "我", "to": "claude"},
            {"from": "claude", "to": "kimi"},
            {"from": "kimi", "to": "claude"},
        ],
        max_hops=3,
    )

    _say(client, auth, sid, "开局")  # claude ← hops 0
    _say(client, auth, sid, "claude 回复", sender="claude")  # kimi ← hops 1
    _say(client, auth, sid, "kimi 回复", sender="kimi")  # claude ← hops 2
    _say(client, auth, sid, "claude 再回复", sender="claude")  # hops 3 >= 3 → 截停

    claude_entries = _queue_lines(app_state, "claude")
    kimi_entries = _queue_lines(app_state, "kimi")
    assert [e["_wf_hops"] for e in claude_entries] == [0, 2]
    assert [e["_wf_hops"] for e in kimi_entries] == [1]


def test_human_message_resets_hops(client, auth, app_state):
    """人类插话开启新一轮：跳数重新从 0 计。"""
    app_state.registry.register("claude")
    sid = _create(client, auth, agents=["claude"])["id"]
    _put_workflow(
        client,
        auth,
        sid,
        [{"from": "我", "to": "claude"}, {"from": "claude", "to": "我"}],
        max_hops=1,
    )
    _say(client, auth, sid, "第一轮")
    _say(client, auth, sid, "claude 说完", sender="claude")  # hops 1 >= 1，暂停点也不出边
    _say(client, auth, sid, "第二轮")  # 新一轮 hops=0，claude 再次被入队
    assert [e["_wf_hops"] for e in _queue_lines(app_state, "claude")] == [0, 0]


def test_roles_injected_into_prompt(client, auth, app_state):
    """roles 命中 base 或实例名：@提及注入文本含"你的角色"行（cwd 行之后、正文之前）。"""
    app_state.registry.register("claude")
    app_state.registry.register("claude")  # claude-2
    sid = _create(client, auth, agents=["claude"])["id"]
    _put_workflow(client, auth, sid, [], roles={"claude": "代码评审员"})

    _say(client, auth, sid, "@claude-2 看一下")  # 实例名提及，roles 按 base 命中
    entries = _queue_lines(app_state, "claude-2")
    assert len(entries) == 1
    lines = entries[0]["text"].split("\n")
    assert lines[0].startswith("会话工作目录：")
    assert lines[1] == "你的角色：代码评审员"
    # 有 role 时追加经验笔记行（自动创建空文件），正文在其后
    assert lines[2].startswith("你的经验笔记：")
    memory = (
        app_state.data_dir / "plugins" / "workflow" / "memory" / sid / "claude.md"
    )
    assert str(memory) in lines[2]
    assert memory.is_file() and memory.read_text() == ""
    assert lines[3] == "@claude-2 看一下"


def test_system_message_ignored(client, auth, app_state):
    app_state.registry.register("claude")
    sid = _create(client, auth, agents=["claude"])["id"]
    _put_workflow(client, auth, sid, [{"from": "我", "to": "claude"}])
    app_state.store.add(sid, "system", "系统消息不触发", type="system")
    assert _queue_lines(app_state, "claude") == []


# ---- goals 字段 ----


def test_goals_crud_and_legacy_data_compat(client, auth, app_state):
    sid = _create(client, auth)["id"]

    # 旧数据（无 goals 字段）：GET 回填空 dict
    legacy = {"enabled": True, "max_hops": 5, "edges": [], "roles": {"kimi": "旧角色"}}
    store_dir = app_state.data_dir / "plugins" / "workflow"
    store_dir.mkdir(parents=True, exist_ok=True)
    (store_dir / f"{sid}.json").write_text(
        json.dumps(legacy, ensure_ascii=False), encoding="utf-8"
    )
    workflow = client.get(f"/api/sessions/{sid}/workflow", headers=auth).json()["workflow"]
    assert workflow["goals"] == {}
    assert workflow["roles"] == {"kimi": "旧角色"}  # 其余字段不受影响

    # PUT 接受 goals 并整存整取
    resp = _put_workflow(client, auth, sid, [], goals={"kimi": "把 x 从 1 数到 3"})
    assert resp.status_code == 200
    assert resp.json()["workflow"]["goals"] == {"kimi": "把 x 从 1 数到 3"}
    workflow = client.get(f"/api/sessions/{sid}/workflow", headers=auth).json()["workflow"]
    assert workflow["goals"] == {"kimi": "把 x 从 1 数到 3"}


# ---- 自环续跑与 [GOAL_DONE] ----


def test_self_loop_continues_without_goal_done(client, auth, app_state):
    """自环：回复无 [GOAL_DONE] → 以 hops+1 再入队，text 用续跑文案含 goal。"""
    app_state.registry.register("kimi")
    sid = _create(client, auth, agents=["kimi"])["id"]
    _put_workflow(
        client,
        auth,
        sid,
        [{"from": "我", "to": "kimi"}, {"from": "kimi", "to": "kimi"}],
        goals={"kimi": "把 x 从 1 数到 3"},
    )

    _say(client, auth, sid, "开始数")
    _say(client, auth, sid, "x = 1", sender="kimi")  # 未标记 → 自驱续跑
    entries = _queue_lines(app_state, "kimi")
    assert [e["_wf_hops"] for e in entries] == [0, 1]
    assert "（工作流自驱续跑）" in entries[1]["text"]
    assert "[GOAL_DONE]" in entries[1]["text"]
    assert "把 x 从 1 数到 3" in entries[1]["text"]
    assert entries[1]["sender"] == "kimi"


def test_self_loop_continuation_generic_text_without_goal(client, auth, app_state):
    app_state.registry.register("kimi")
    sid = _create(client, auth, agents=["kimi"])["id"]
    _put_workflow(client, auth, sid, [{"from": "kimi", "to": "kimi"}])

    _say(client, auth, sid, "随便说一句", sender="kimi")  # 无 goal 配置
    entries = _queue_lines(app_state, "kimi")
    assert len(entries) == 1
    assert "（工作流自驱续跑）" in entries[0]["text"]
    assert "请继续推进。" in entries[0]["text"]


def test_goal_done_stops_self_loop_but_other_edges_fire(client, auth, app_state):
    """含 [GOAL_DONE]：自环停止；其他出边照常触发（交棒下一节点）。"""
    app_state.registry.register("kimi")
    app_state.registry.register("claude")
    sid = _create(client, auth, agents=["kimi", "claude"])["id"]
    _put_workflow(
        client,
        auth,
        sid,
        [{"from": "kimi", "to": "kimi"}, {"from": "kimi", "to": "claude"}],
        goals={"kimi": "数到 3"},
    )

    _say(client, auth, sid, "x = 3，数完了\n[GOAL_DONE]", sender="kimi")
    assert _queue_lines(app_state, "kimi") == []  # 自环不再续跑
    handoff = _queue_lines(app_state, "claude")  # 交棒边照常
    assert len(handoff) == 1
    assert handoff[0]["_wf_hops"] == 1


def test_self_loop_stops_at_max_hops(client, auth, app_state):
    app_state.registry.register("kimi")
    sid = _create(client, auth, agents=["kimi"])["id"]
    _put_workflow(
        client,
        auth,
        sid,
        [{"from": "我", "to": "kimi"}, {"from": "kimi", "to": "kimi"}],
        max_hops=2,
    )
    _say(client, auth, sid, "开局")  # kimi ← 0
    _say(client, auth, sid, "第一轮", sender="kimi")  # hop 1 < 2 → 续跑 ← 1
    _say(client, auth, sid, "第二轮", sender="kimi")  # hop 2 >= 2 → 截停
    assert [e["_wf_hops"] for e in _queue_lines(app_state, "kimi")] == [0, 1]


def test_no_self_loop_no_continuation(client, auth, app_state):
    """无自环边时 agent 发言不会自我续跑，其他边正常。"""
    app_state.registry.register("kimi")
    app_state.registry.register("claude")
    sid = _create(client, auth, agents=["kimi", "claude"])["id"]
    _put_workflow(client, auth, sid, [{"from": "kimi", "to": "claude"}])

    _say(client, auth, sid, "kimi 说完了（无标记）", sender="kimi")
    assert _queue_lines(app_state, "kimi") == []
    assert len(_queue_lines(app_state, "claude")) == 1


# ---- prompt_extras 四行 ----


def test_prompt_extras_full_stack_order(client, auth, app_state):
    """role + goal + 自环：附加行按序为角色/目标/停止约定/经验笔记。"""
    app_state.registry.register("kimi")
    sid = _create(client, auth, agents=["kimi"])["id"]
    _put_workflow(
        client,
        auth,
        sid,
        [{"from": "kimi", "to": "kimi"}],
        roles={"kimi": "计数员"},
        goals={"kimi": "数到 3"},
    )

    _say(client, auth, sid, "@kimi 开工")
    lines = _queue_lines(app_state, "kimi")[0]["text"].split("\n")
    assert lines[0].startswith("会话工作目录：")
    assert lines[1] == "你的角色：计数员"
    assert lines[2] == "你的目标：数到 3"
    assert lines[3].startswith("目标达成时在回复末尾单独一行写 [GOAL_DONE]")
    assert "（剩余 10 轮）" in lines[3]
    assert lines[4].startswith("你的经验笔记：")
    assert lines[5] == "@kimi 开工"


def test_prompt_extras_no_self_loop_no_stop_line(client, auth, app_state):
    """无自环边：不出现停止约定行；role/goal/经验笔记照常。"""
    app_state.registry.register("kimi")
    sid = _create(client, auth, agents=["kimi"])["id"]
    _put_workflow(
        client, auth, sid, [], roles={"kimi": "评审"}, goals={"kimi": "把关"}
    )
    _say(client, auth, sid, "@kimi 看看")
    text = _queue_lines(app_state, "kimi")[0]["text"]
    assert "你的角色：评审" in text
    assert "你的目标：把关" in text
    assert "你的经验笔记：" in text
    assert "GOAL_DONE" not in text


def test_prompt_extras_nothing_configured(client, auth, app_state):
    """无 role/goal/自环：不附加任何行。"""
    app_state.registry.register("kimi")
    sid = _create(client, auth, agents=["kimi"])["id"]
    _put_workflow(client, auth, sid, [])
    _say(client, auth, sid, "@kimi 干净")
    text = _queue_lines(app_state, "kimi")[0]["text"]
    assert "你的角色" not in text and "经验笔记" not in text and "GOAL_DONE" not in text


# ---- 单一构建路径（enqueue_trigger）----


def test_workflow_turn_gets_full_prompt_stack(client, auth, app_state):
    """工作流触发的队列条目与 @提及同构：cwd 头行 + role/goal/停止约定/经验笔记。"""
    app_state.registry.register("kimi")
    sid = _create(client, auth, agents=["kimi"])["id"]
    _put_workflow(
        client,
        auth,
        sid,
        [{"from": "我", "to": "kimi"}, {"from": "kimi", "to": "kimi"}],
        roles={"kimi": "计数员"},
        goals={"kimi": "数到 3"},
    )

    _say(client, auth, sid, "开局")  # 纯工作流触发，无 @提及
    entries = _queue_lines(app_state, "kimi")
    assert len(entries) == 1
    lines = entries[0]["text"].split("\n")
    assert lines[0].startswith("会话工作目录：")
    assert lines[1] == "你的角色：计数员"
    assert lines[2] == "你的目标：数到 3"
    assert lines[3].startswith("目标达成时在回复末尾单独一行写 [GOAL_DONE]")
    assert lines[4].startswith("你的经验笔记：")
    assert lines[5] == "开局"
    # 经验笔记文件在 collect 时被创建
    memory = app_state.data_dir / "plugins" / "workflow" / "memory" / sid / "kimi.md"
    assert str(memory) in lines[4]
    assert memory.is_file()

    # 自环续跑条目同样带 extras（role/goal 每轮重复注入是期望行为）
    _say(client, auth, sid, "x = 1", sender="kimi")
    cont = _queue_lines(app_state, "kimi")[1]
    assert cont["_wf_hops"] == 1
    assert "你的角色：计数员" in cont["text"]
    assert "你的目标：数到 3" in cont["text"]
    assert "（工作流自驱续跑）" in cont["text"]
    assert cont["text"].startswith("会话工作目录：")


def test_enqueue_trigger_public_helper(app_state):
    """公共 helper：解析目标 + 组装提示词 + 返回入队集合；hops 透传进条目。"""
    from teamroom.server.triggers import enqueue_trigger

    app_state.registry.register("opencode")
    app_state.registry.register("opencode")  # opencode-2
    session = app_state.sessions.create("直调", agents=["opencode"])

    queued = enqueue_trigger(
        app_state, session, sender="我", text="直接注入", targets=["opencode"], hops=2
    )
    assert queued == {"opencode", "opencode-2"}  # base 扇出
    for name in ("opencode", "opencode-2"):
        entry = _queue_lines(app_state, name)[0]
        assert entry["_wf_hops"] == 2
        assert entry["sender"] == "我"
        assert entry["text"].startswith("会话工作目录：")
        assert entry["text"].endswith("直接注入")
        assert entry["session_title"] == "直调"


# ---- 人设三件套：双层配置与回退链 ----


def test_backstories_crud_and_legacy_compat(client, auth, app_state):
    sid = _create(client, auth)["id"]

    # 旧数据（无 backstories/goals 字段）：GET 回填空 dict
    legacy = {"enabled": True, "max_hops": 5, "edges": [], "roles": {"kimi": "旧"}}
    store_dir = app_state.data_dir / "plugins" / "workflow"
    store_dir.mkdir(parents=True, exist_ok=True)
    (store_dir / f"{sid}.json").write_text(
        json.dumps(legacy, ensure_ascii=False), encoding="utf-8"
    )
    workflow = client.get(f"/api/sessions/{sid}/workflow", headers=auth).json()["workflow"]
    assert workflow["backstories"] == {}
    assert workflow["goals"] == {}

    resp = _put_workflow(client, auth, sid, [], backstories={"kimi": "十年老兵"})
    assert resp.status_code == 200
    assert resp.json()["workflow"]["backstories"] == {"kimi": "十年老兵"}
    stored = json.loads((store_dir / f"{sid}.json").read_text(encoding="utf-8"))
    assert stored["backstories"] == {"kimi": "十年老兵"}


def test_persona_fallback_chain(client, auth, app_state):
    """会话 workflow 值 > spec 全局值 > 无；逐字段独立回退。"""
    app_state.registry.register("opencode")
    spec = app_state.config.agents["opencode"]
    spec.role = "全局角色"
    spec.goal = "全局目标"
    spec.backstory = "全局背景"
    sid = _create(client, auth, agents=["opencode"])["id"]

    # 会话只覆盖 role：goal/backstory 回退 spec
    _put_workflow(client, auth, sid, [], roles={"opencode": "会话角色"})
    _say(client, auth, sid, "@opencode 来")
    lines = _queue_lines(app_state, "opencode")[0]["text"].split("\n")
    assert "你的角色：会话角色" in lines
    assert "你的目标：全局目标" in lines
    assert "你的背景：全局背景" in lines
    assert "你的角色：全局角色" not in lines  # 会话值优先


def test_spec_persona_injected_without_session_workflow(client, auth, app_state):
    """无会话 workflow 配置时，spec 人设仍注入（不再直接返回空）。"""
    app_state.registry.register("opencode")
    spec = app_state.config.agents["opencode"]
    spec.role = "全局角色"
    spec.goal = "全局目标"
    spec.backstory = "全局背景"
    sid = _create(client, auth, agents=["opencode"])["id"]  # 不 PUT 任何 workflow

    _say(client, auth, sid, "@opencode 裸配")
    lines = _queue_lines(app_state, "opencode")[0]["text"].split("\n")
    assert lines[0].startswith("会话工作目录：")
    assert lines[1] == "你的角色：全局角色"
    assert lines[2] == "你的目标：全局目标"
    assert lines[3] == "你的背景：全局背景"
    assert lines[4].startswith("你的经验笔记：")  # 三件套任一存在即给
    assert "GOAL_DONE" not in "\n".join(lines)  # 无自环边 → 无停止约定行


def test_backstory_alone_triggers_memory_line(client, auth, app_state):
    """经验笔记触发条件变化：仅配 backstory（无 role/goal）也给经验笔记行。"""
    app_state.registry.register("opencode")
    sid = _create(client, auth, agents=["opencode"])["id"]
    _put_workflow(client, auth, sid, [], backstories={"opencode": "只有背景"})

    _say(client, auth, sid, "@opencode 只带背景")
    text = _queue_lines(app_state, "opencode")[0]["text"]
    assert "你的背景：只有背景" in text
    assert "你的经验笔记：" in text
    assert "你的角色" not in text and "你的目标" not in text


def test_no_persona_anywhere_no_extras(client, auth, app_state):
    """会话与 spec 都无人设：不附加任何行（回归）。"""
    app_state.registry.register("opencode")
    sid = _create(client, auth, agents=["opencode"])["id"]
    _say(client, auth, sid, "@opencode 干净")
    text = _queue_lines(app_state, "opencode")[0]["text"]
    assert "你的角色" not in text
    assert "你的目标" not in text
    assert "你的背景" not in text
    assert "经验笔记" not in text


# ---- 会话级 instructions（交互指令）----


def test_instructions_crud_and_legacy_compat(client, auth, app_state):
    sid = _create(client, auth)["id"]

    # 旧数据（无 instructions 字段）：GET 回填 ""
    legacy = {"enabled": True, "max_hops": 5, "edges": [], "roles": {}}
    store_dir = app_state.data_dir / "plugins" / "workflow"
    store_dir.mkdir(parents=True, exist_ok=True)
    (store_dir / f"{sid}.json").write_text(
        json.dumps(legacy, ensure_ascii=False), encoding="utf-8"
    )
    workflow = client.get(f"/api/sessions/{sid}/workflow", headers=auth).json()["workflow"]
    assert workflow["instructions"] == ""

    resp = _put_workflow(client, auth, sid, [], instructions="只许用中文回答")
    assert resp.status_code == 200
    assert resp.json()["workflow"]["instructions"] == "只许用中文回答"
    workflow = client.get(f"/api/sessions/{sid}/workflow", headers=auth).json()["workflow"]
    assert workflow["instructions"] == "只许用中文回答"

    # str 校验：非字符串 422
    resp = client.put(
        f"/api/sessions/{sid}/workflow",
        json={"enabled": True, "max_hops": 5, "edges": [], "roles": {}, "instructions": 42},
        headers=auth,
    )
    assert resp.status_code == 422


def test_instructions_injected_before_persona_lines(client, auth, app_state):
    """instructions 行在最前（人设三件套之前）。"""
    app_state.registry.register("opencode")
    sid = _create(client, auth, agents=["opencode"])["id"]
    _put_workflow(
        client,
        auth,
        sid,
        [],
        roles={"opencode": "评审"},
        goals={"opencode": "把关"},
        instructions="先复述需求再动手",
    )
    _say(client, auth, sid, "@opencode 来")
    lines = _queue_lines(app_state, "opencode")[0]["text"].split("\n")
    assert lines[0].startswith("会话工作目录：")
    assert lines[1] == "会话交互指令（每次回复都必须遵守）：先复述需求再动手"
    assert lines[2] == "你的角色：评审"
    assert lines[3] == "你的目标：把关"


def test_instructions_empty_or_missing_not_injected(client, auth, app_state):
    app_state.registry.register("opencode")
    sid = _create(client, auth, agents=["opencode"])["id"]

    # 空 instructions 不注入
    _put_workflow(client, auth, sid, [], roles={"opencode": "评审"}, instructions="")
    _say(client, auth, sid, "@opencode 空指令")
    text = _queue_lines(app_state, "opencode")[0]["text"]
    assert "会话交互指令" not in text

    # 无会话配置不注入（即便 spec 有人设）
    sid2 = _create(client, auth, title="无配置", agents=["opencode"])["id"]
    _say(client, auth, sid2, "@opencode 第二条")
    text2 = _queue_lines(app_state, "opencode")[1]["text"]
    assert "会话交互指令" not in text2
