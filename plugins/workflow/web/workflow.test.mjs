import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dedupeEdges,
  addEdge,
  addBidirectional,
  removeEdgeAt,
  nextMissingEdge,
  normalizeWorkflow,
  specDefaultsFor,
  layoutFlow,
  edgeLinePoints,
  selfLoopArc,
  zoomState,
  applyWheel,
  applyPan,
  resetZoom,
  ZOOM_MIN,
  ZOOM_MAX,
  ROLE_PRESETS,
  presetFor,
  matchPreset,
  applyRolePreset,
} from "./index.js";

test("dedupeEdges：去重保序、滤掉缺端点的边", () => {
  const out = dedupeEdges([
    { from: "我", to: "claude" },
    { from: "我", to: "claude" },
    { from: "claude" },
    { from: "claude", to: "kimi" },
  ]);
  assert.deepEqual(out, [
    { from: "我", to: "claude" },
    { from: "claude", to: "kimi" },
  ]);
  assert.deepEqual(dedupeEdges(null), []);
});

test("addEdge：重复边不产生第二条", () => {
  let edges = addEdge([], "我", "claude");
  edges = addEdge(edges, "我", "claude");
  assert.equal(edges.length, 1);
});

test("addBidirectional：补反向边；自环只留一条", () => {
  const both = addBidirectional([], "我", "claude");
  assert.deepEqual(both, [
    { from: "我", to: "claude" },
    { from: "claude", to: "我" },
  ]);
  const self = addBidirectional([], "claude", "claude");
  assert.deepEqual(self, [{ from: "claude", to: "claude" }]);
  const again = addBidirectional(both, "claude", "我");
  assert.equal(again.length, 2); // 已有双向时不重复
});

test("removeEdgeAt：按下标删除", () => {
  const edges = [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
  ];
  assert.deepEqual(removeEdgeAt(edges, 0), [{ from: "b", to: "c" }]);
});

test("normalizeWorkflow：空/坏输入给默认结构，边去重", () => {
  assert.deepEqual(normalizeWorkflow(null), {
    enabled: false,
    max_hops: 10,
    edges: [],
    roles: {},
    goals: {},
    backstories: {},
    instructions: "",
  });
  const out = normalizeWorkflow({
    enabled: 1,
    max_hops: 0,
    edges: [
      { from: "a", to: "b" },
      { from: "a", to: "b" },
    ],
    roles: { claude: "评审" },
  });
  assert.equal(out.enabled, true);
  assert.equal(out.max_hops, 10); // 非法值回退默认
  assert.equal(out.edges.length, 1);
  assert.equal(out.roles.claude, "评审");
  assert.equal(normalizeWorkflow({ max_hops: 5 }).max_hops, 5);
});

test("normalizeWorkflow：goals 字段处理与旧数据兼容", () => {
  /* 旧数据无 goals -> 默认 {} */
  assert.deepEqual(normalizeWorkflow({ enabled: true, roles: { a: "r" } }).goals, {});
  /* goals 正常保留 */
  assert.equal(normalizeWorkflow({ goals: { claude: "diff 干净" } }).goals.claude, "diff 干净");
  /* 非对象 goals（数组/字符串）-> {} */
  assert.deepEqual(normalizeWorkflow({ goals: ["x"] }).goals, {});
  assert.deepEqual(normalizeWorkflow({ goals: "x" }).goals, {});
});

test("normalizeWorkflow：backstories 字段处理与旧数据兼容", () => {
  /* 旧数据无 backstories -> 默认 {} */
  const old = normalizeWorkflow({ enabled: true, roles: { a: "r" }, goals: { a: "g" } });
  assert.deepEqual(old.backstories, {});
  /* backstories 正常保留 */
  assert.equal(normalizeWorkflow({ backstories: { kimi: "十年后端" } }).backstories.kimi, "十年后端");
  /* 非对象 backstories -> {} */
  assert.deepEqual(normalizeWorkflow({ backstories: ["x"] }).backstories, {});
  assert.deepEqual(normalizeWorkflow({ backstories: "x" }).backstories, {});
});

test("specDefaultsFor：精确名优先，实例名回落 base", () => {
  const specs = [
    { name: "claude", role: "全栈工程师", goal: "干净交付" },
    { name: "kimi", backstory: "快速原型手" },
  ];
  assert.deepEqual(specDefaultsFor(specs, "claude"), {
    role: "全栈工程师",
    goal: "干净交付",
    backstory: "",
  });
  assert.equal(specDefaultsFor(specs, "kimi-2").backstory, "快速原型手");
  assert.deepEqual(specDefaultsFor(specs, "nobody"), {});
  assert.deepEqual(specDefaultsFor(null, "claude"), {});
});

test("normalizeWorkflow：instructions 字段处理与旧数据兼容", () => {
  /* 旧数据无 instructions -> 默认 "" */
  assert.equal(normalizeWorkflow({ enabled: true }).instructions, "");
  assert.equal(normalizeWorkflow(null).instructions, "");
  /* 字符串正常保留 */
  assert.equal(normalizeWorkflow({ instructions: "一律中文" }).instructions, "一律中文");
  /* 非字符串（数字/数组/对象）-> "" */
  assert.equal(normalizeWorkflow({ instructions: 5 }).instructions, "");
  assert.equal(normalizeWorkflow({ instructions: ["x"] }).instructions, "");
  assert.equal(normalizeWorkflow({ instructions: {} }).instructions, "");
});

test("自环边：addEdge/addBidirectional 幂等", () => {
  let edges = addEdge([], "claude", "claude");
  edges = addEdge(edges, "claude", "claude");
  assert.deepEqual(edges, [{ from: "claude", to: "claude" }]);
  /* 双向按钮对自环只留一条；再来一次仍是一条 */
  let both = addBidirectional([], "kimi", "kimi");
  both = addBidirectional(both, "kimi", "kimi");
  assert.deepEqual(both, [{ from: "kimi", to: "kimi" }]);
  /* 自环与普通边互不干扰 */
  const mixed = addBidirectional([{ from: "a", to: "a" }], "a", "b");
  assert.equal(mixed.length, 3);
});

test("layoutFlow：人类左列 Agent 右列（默认 640 宽适配 wide modal）", () => {
  const layout = layoutFlow({ humans: ["我"], agents: ["claude", "kimi"] });
  const me = layout.nodes.find((n) => n.name === "我");
  const claude = layout.nodes.find((n) => n.name === "claude");
  assert.equal(me.x, 96);
  assert.equal(claude.x, 640 - 96);
  assert.equal(layout.nodes.length, 3);
  /* 紧凑间距：rowH=68、padY=36，两行时高度 36*2+68=140，左列单行垂直居中 */
  assert.equal(layout.height, 140);
  assert.equal(me.y, 36 + 34);
  assert.equal(claude.y, 36);
});

test("edgeLinePoints：端点缩短、双向 ±4 反向偏移", () => {
  /* 水平边 a(0,0) → b(100,0)：ux=1,uy=0 */
  const fwd = edgeLinePoints({ x: 0, y: 0 }, { x: 100, y: 0 }, false);
  assert.equal(fwd.x1, 16); // NODE_R+2
  assert.equal(fwd.y1, -4); // off=-4 时 oy=ux*off
  assert.equal(fwd.x2, 100 - 18); // NODE_R+4
  assert.equal(fwd.y2, -4);
  /* 反向边偏移 +4，两点连线中垂方向对称 */
  const rev = edgeLinePoints({ x: 0, y: 0 }, { x: 100, y: 0 }, true);
  assert.equal(rev.y1, 4);
  assert.equal(rev.y2, 4);
  assert.equal(rev.x1, fwd.x1);
  /* 垂直边：偏移落在 x 方向 */
  const vert = edgeLinePoints({ x: 0, y: 0 }, { x: 0, y: 100 }, false);
  assert.equal(vert.x1, 4); // ox=-uy*off
  assert.equal(vert.y1, 16);
  /* 零长度兜底不抛 */
  const zero = edgeLinePoints({ x: 5, y: 5 }, { x: 5, y: 5 }, false);
  assert.ok(Number.isFinite(zero.x1) && Number.isFinite(zero.y2));
});

test("selfLoopArc：-35° 起弧越过顶部到 -145°，随节点平移", () => {
  const r = 14;
  const rad = (deg) => (deg * Math.PI) / 180;
  const d = selfLoopArc(100, 50);
  const x1 = 100 + r * Math.cos(rad(-35));
  const y1 = 50 + r * Math.sin(rad(-35));
  const x2 = 100 + r * Math.cos(rad(-145));
  const y2 = 50 + r * Math.sin(rad(-145));
  assert.equal(d, `M ${x1} ${y1} A 12 12 0 1 1 ${x2} ${y2}`);
  /* 平移节点 → 整体平移 */
  assert.equal(selfLoopArc(0, 0).startsWith(`M ${r * Math.cos(rad(-35))} `), true);
  const moved = selfLoopArc(10, 20);
  assert.ok(moved.includes(`A 12 12 0 1 1 ${10 + r * Math.cos(rad(-145))}`));
});

test("缩放纯函数：焦点不变性、clamp、pan、reset", () => {
  let z = zoomState();
  z = applyWheel(z, -200, 100, 80);
  assert.ok(z.scale > 1);
  const after = (100 - z.tx) / z.scale;
  assert.ok(Math.abs(100 - after) < 1e-9); // 焦点内容坐标不变
  for (let i = 0; i < 50; i++) z = applyWheel(z, -500, 0, 0);
  assert.equal(z.scale, ZOOM_MAX);
  for (let i = 0; i < 50; i++) z = applyWheel(z, 500, 0, 0);
  assert.equal(z.scale, ZOOM_MIN);
  z = { ...z, tx: 0, ty: 0 };
  z = applyPan(applyPan(z, 10, -5), 2, 3);
  assert.ok(Math.abs(z.tx - 12) < 1e-9 && Math.abs(z.ty + 2) < 1e-9);
  assert.deepEqual(resetZoom(z), { scale: 1, tx: 0, ty: 0 });
});

test("nextMissingEdge：按 from→to 顺序找第一条缺失组合（含自环）", () => {
  const names = ["我", "claude"];
  assert.deepEqual(nextMissingEdge([], names), { from: "我", to: "我" });
  assert.deepEqual(nextMissingEdge([{ from: "我", to: "我" }], names), {
    from: "我",
    to: "claude",
  });
  /* 全部组合（4 条）占满 -> null */
  const full = [
    { from: "我", to: "我" },
    { from: "我", to: "claude" },
    { from: "claude", to: "我" },
    { from: "claude", to: "claude" },
  ];
  assert.equal(nextMissingEdge(full, names), null);
  /* 删掉一条后出现空缺 */
  assert.deepEqual(nextMissingEdge(removeEdgeAt(full, 2), names), {
    from: "claude",
    to: "我",
  });
  assert.equal(nextMissingEdge([], null), null);
});

test("ROLE_PRESETS：至少 5 个，中英模板三字段齐全", () => {
  assert.ok(ROLE_PRESETS.length >= 5);
  for (const p of ROLE_PRESETS) {
    for (const locale of ["en", "zh-CN"]) {
      const s = presetFor(p, locale);
      assert.ok(s.label && s.role && s.goal && s.backstory, `${p.id}/${locale} 缺字段`);
    }
    assert.equal(presetFor(p, "fr"), p.en); // 未知语言回退 en
  }
});

test("matchPreset：中英文本都命中；不匹配返回 null", () => {
  const p = ROLE_PRESETS[0];
  assert.equal(matchPreset(p.en.role).id, p.id);
  assert.equal(matchPreset(p["zh-CN"].role).id, p.id);
  assert.equal(matchPreset("自定义角色"), null);
  assert.equal(matchPreset(""), null);
});

test("applyRolePreset：role 覆盖；goal/backstory 只在为空时预填", () => {
  const preset = presetFor(ROLE_PRESETS[0], "en");
  const out = applyRolePreset({}, {}, {}, "claude", preset);
  assert.equal(out.roles.claude, preset.role);
  assert.equal(out.goals.claude, preset.goal);
  assert.equal(out.backstories.claude, preset.backstory);
  /* 已有 goal 不被覆盖，空的 backstory 被预填 */
  const out2 = applyRolePreset({}, { claude: "我自己的目标" }, {}, "claude", preset);
  assert.equal(out2.goals.claude, "我自己的目标");
  assert.equal(out2.backstories.claude, preset.backstory);
  /* 不改动传入对象 */
  const roles = {};
  applyRolePreset(roles, {}, {}, "x", preset);
  assert.deepEqual(roles, {});
});

/* ================= 模态框集成（最小 DOM stub，无 jsdom） ================= */

class StubEl {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attrs = {};
    this.style = {};
    this.dataset = {};
    this.className = "";
    this._text = "";
  }
  set textContent(v) {
    this._text = String(v);
    if (v === "") this.children = [];
  }
  get textContent() {
    return this._text;
  }
  append(...kids) {
    this.children.push(...kids);
  }
  prepend(...kids) {
    this.children.unshift(...kids);
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener() {}
  querySelector() {
    return null;
  }
  focus() {}
  get firstChild() {
    return this.children[0] || null;
  }
  cloneNode(deep) {
    const n = new StubEl(this.tag);
    n.attrs = { ...this.attrs };
    if (deep) n.children = [...this.children];
    return n;
  }
}

globalThis.document = {
  createElement: (tag) => new StubEl(tag),
  createElementNS: (ns, tag) => new StubEl(tag),
};

const WORKFLOW_RESP = {
  workflow: {
    enabled: true,
    max_hops: 5,
    edges: [{ from: "我", to: "claude" }],
    roles: {},
    goals: {},
    backstories: {},
    instructions: "一律中文",
  },
};

function makeWorkflowCtx(over = {}) {
  const calls = { modal: null, headerButton: null, put: null };
  const ctx = {
    store: {
      state: { settings: {}, agents: [], specs: [], activeSessionId: "s1" },
      getSession: () => ({ id: "s1", agents: ["claude"] }),
    },
    api: {
      getWorkflow: async () => WORKFLOW_RESP,
      listSpecs: async () => ({ specs: [] }),
      putWorkflow: async (id, body) => {
        calls.put = body;
        return { workflow: body };
      },
      deleteWorkflow: async () => ({ ok: true }),
    },
    i18n: { locale: "en" },
    toast: () => {},
    el: (tag, cls, text) => {
      const n = new StubEl(tag);
      n.className = cls || "";
      if (text !== undefined) n.textContent = text;
      return n;
    },
    pluginLocale: (strings) => (key) => strings.en[key] ?? key,
    on: () => {},
    addHeaderButton: (opts) => {
      calls.headerButton = opts;
      return new StubEl("button");
    },
    openModal: (opts) => {
      const body = new StubEl("div");
      opts.build(body);
      calls.modal = { ...opts, body };
      return () => {};
    },
    ...over,
  };
  return { ctx, calls };
}

test("register：点击头部按钮打开 wide 模态框并渲染编辑器", async () => {
  const { register } = await import("./index.js");
  const { ctx, calls } = makeWorkflowCtx();
  register(ctx);
  assert.ok(calls.headerButton);
  calls.headerButton.onClick();
  assert.ok(calls.modal, "应调用 openModal");
  assert.equal(calls.modal.wide, true, "workflow 用 wide 模态框");
  assert.equal(calls.modal.title, "Workflow");
  /* footer：Cancel / Reset / Save（primary） */
  const labels = calls.modal.actions.map((a) => a.label);
  assert.deepEqual(labels, ["Cancel", "Reset", "Save"]);
  assert.ok(calls.modal.actions[2].primary);
  /* load() 异步：flush 后 body 渲染出编辑区（top/instructions/graph/edges/roles） */
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(calls.modal.body.children.length >= 5, "应渲染出编辑内容");
});

test("register：Save 动作 PUT 完整 model（含 instructions/backstories/goals）", async () => {
  const { register } = await import("./index.js");
  const { ctx, calls } = makeWorkflowCtx();
  register(ctx);
  calls.headerButton.onClick();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  let closed = false;
  const btnStub = { disabled: false };
  await calls.modal.actions[2].onClick(() => {
    closed = true;
  }, btnStub);
  assert.ok(calls.put, "Save 应调 putWorkflow");
  assert.equal(calls.put.instructions, "一律中文");
  assert.deepEqual(calls.put.edges, [{ from: "我", to: "claude" }]);
  assert.equal(calls.put.max_hops, 5);
  assert.ok(closed, "保存成功后应关闭模态框");
});
