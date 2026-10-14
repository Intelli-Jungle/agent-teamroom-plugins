import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatCount,
  sortSenders,
  edgeTier,
  EDGE_WIDTHS,
  splitFlowNodes,
  flowEdges,
  layoutFlow,
  bezierControl,
  bezierMid,
  edgeGeometry,
} from "./index.js";

const STATS = {
  total_messages: 45,
  senders: [
    { name: "claude", messages: 20, chars: 500, est_tokens: 200, attachments: 1 },
    { name: "我", messages: 12, chars: 300, est_tokens: 120, attachments: 2 },
    { name: "codex", messages: 13, chars: 400, est_tokens: 160, attachments: 0 },
  ],
  edges: [
    { from: "我", to: "claude", count: 5 },
    { from: "claude", to: "codex", count: 2 },
    { from: "我", to: "我", count: 3 }, // 自环，应被过滤
  ],
};

test("sortSenders：按消息数降序，不改动原数组", () => {
  const sorted = sortSenders(STATS.senders);
  assert.deepEqual(sorted.map((s) => s.name), ["claude", "codex", "我"]);
  assert.equal(STATS.senders[0].name, "claude");
  assert.deepEqual(sortSenders(null), []);
});

test("edgeTier：三等分分档", () => {
  assert.equal(edgeTier(1, 9), 1);
  assert.equal(edgeTier(3, 9), 1);
  assert.equal(edgeTier(4, 9), 2);
  assert.equal(edgeTier(6, 9), 2);
  assert.equal(edgeTier(7, 9), 3);
  assert.equal(edgeTier(9, 9), 3);
  assert.equal(edgeTier(5, 0), 1); // maxCount 为 0 时兜底最低档
  assert.deepEqual(Object.keys(EDGE_WIDTHS), ["1", "2", "3"]);
});

test("splitFlowNodes：人类左列、其余右列，保持出现顺序", () => {
  const { humans, agents } = splitFlowNodes(STATS, "我");
  assert.deepEqual(humans, ["我"]);
  assert.deepEqual(agents, ["claude", "codex"]);
  assert.deepEqual(splitFlowNodes(null, "我"), { humans: [], agents: [] });
});

test("flowEdges：过滤自环与无效边", () => {
  const edges = flowEdges(STATS);
  assert.equal(edges.length, 2);
  assert.ok(edges.every((e) => e.from !== e.to));
  assert.deepEqual(flowEdges(null), []);
});

test("formatCount：k/M 分档并去末尾 .0", () => {
  assert.equal(formatCount(999), "999");
  assert.equal(formatCount(1000), "1k");
  assert.equal(formatCount(1234), "1.2k");
  assert.equal(formatCount(999_999), "1000k");
  assert.equal(formatCount(1_000_000), "1M");
  assert.equal(formatCount(1_234_567), "1.2M");
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(NaN), "0");
});

test("layoutFlow：径向布局——人类中心，agent 在外围椭圆", () => {
  const layout = layoutFlow({ humans: ["我"], agents: ["claude", "codex"] }, 460);
  assert.equal(layout.width, 460);
  assert.equal(layout.height, 340);
  const me = layout.nodes.find((n) => n.name === "我");
  assert.deepEqual([me.x, me.y], [230, 170]); // 中心
  const claude = layout.nodes.find((n) => n.name === "claude");
  const codex = layout.nodes.find((n) => n.name === "codex");
  /* 2 个 agent：左右对称 */
  assert.ok(claude.x > 230 && Math.abs(claude.y - 170) < 1e-9); // 正右
  assert.ok(codex.x < 230 && Math.abs(codex.y - 170) < 1e-9); // 正左
  assert.ok(Math.abs(claude.x - 230 + (codex.x - 230)) < 1e-9);
});

test("layoutFlow：1 个 agent 放正右方；默认宽度 460；空输入合法", () => {
  const one = layoutFlow({ humans: ["我"], agents: ["claude"] }, 460);
  const claude = one.nodes.find((n) => n.name === "claude");
  assert.ok(claude.x > 230 && Math.abs(claude.y - 170) < 1e-9);
  const dflt = layoutFlow({ humans: ["我"], agents: [] });
  assert.equal(dflt.width, 460);
  assert.equal(dflt.height, 340);
  assert.deepEqual(dflt.nodes[0] && [dflt.nodes[0].x, dflt.nodes[0].y], [230, 170]);
  const empty = layoutFlow({ humans: [], agents: [] });
  assert.deepEqual(empty.nodes, []);
});

test("bezierControl/bezierMid：双向边分到弦两侧，徽标点偏离弦", () => {
  const a = { x: 160, y: 120 };
  const b = { x: 268, y: 120 };
  const fwd = bezierControl(a, b, "claude", "我"); // "claude" < "我"（按码点）
  const rev = bezierControl(a, b, "我", "claude");
  assert.ok(fwd.y !== 120 && rev.y !== 120);
  assert.ok(Math.sign(fwd.y - 120) === -Math.sign(rev.y - 120)); // 反向边在另一侧
  const mid = bezierMid(a, fwd, b);
  assert.ok(Math.abs(mid.x - 214) < 1e-9); // 中点 x 居中
  assert.ok(mid.y !== 120); // 偏离弦，不压线
});

test("edgeGeometry：端点让出节点半径，d 与 p0/c/p1 一致", () => {
  const a = { x: 230, y: 170 };
  const b = { x: 396, y: 170 }; // 正右（rx = 460/2 - 64 = 166）
  const geo = edgeGeometry(a, b, "我", "claude");
  /* 水平边：p0 距 a 为 NODE_R+2，p1 距 b 为 NODE_R+4（多让 2px 给箭头） */
  assert.ok(Math.abs(geo.p0.x - (a.x + 16)) < 1e-9 && Math.abs(geo.p0.y - 170) < 1e-9);
  assert.ok(Math.abs(geo.p1.x - (b.x - 18)) < 1e-9 && Math.abs(geo.p1.y - 170) < 1e-9);
  assert.equal(
    geo.d,
    `M ${geo.p0.x} ${geo.p0.y} Q ${geo.c.x} ${geo.c.y} ${geo.p1.x} ${geo.p1.y}`
  );
  /* 控制点与 bezierControl 一致（同一函数，拖拽重算不跑偏） */
  const c2 = bezierControl(a, b, "我", "claude");
  assert.deepEqual(geo.c, c2);
  /* 节点移动后重算：d 随端点变化 */
  const moved = edgeGeometry({ x: a.x, y: a.y + 50 }, b, "我", "claude");
  assert.notEqual(moved.d, geo.d);
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
}

globalThis.document = {
  createElement: (tag) => new StubEl(tag),
  createElementNS: (ns, tag) => new StubEl(tag),
};

function makeInsightsCtx(over = {}) {
  const calls = { modal: null, headerButton: null };
  const ctx = {
    store: { state: { settings: {}, agents: [], specs: [], activeSessionId: "s1" } },
    api: { getSessionStats: async () => STATS },
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

test("register：头部按钮点击后 openModal 打开并渲染 stats + flow 两区块", async () => {
  const { register } = await import("./index.js");
  const { ctx, calls } = makeInsightsCtx();
  register(ctx);
  assert.ok(calls.headerButton, "应注册头部按钮");
  calls.headerButton.onClick();
  assert.ok(calls.modal, "应调用 openModal");
  assert.equal(calls.modal.title, "Session insights");
  assert.ok(!calls.modal.wide, "insights 用默认宽度");
  /* fetchStats 是异步的，flush 微任务后 body 应有 stats 表 + 流程图 */
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.modal.body.children.length, 2);
  const findDeep = (node, pred) => {
    if (pred(node)) return node;
    for (const c of node.children || []) {
      const hit = findDeep(c, pred);
      if (hit) return hit;
    }
    return null;
  };
  const table = findDeep(calls.modal.body, (c) => c.className === "insights-table");
  assert.ok(table, "第一区块应含统计表");
  const svg = findDeep(calls.modal.body, (c) => c.tag === "svg");
  assert.ok(svg, "第二区块应含流程图 SVG（STATS 有两条有效边）");
  /* 节点包成 g.insights-node（circle + label），3 个节点各一个 */
  const nodeGroups = [];
  findDeep(svg, (c) => {
    if (c.attrs && c.attrs.class === "insights-node") nodeGroups.push(c);
    return false;
  });
  assert.equal(nodeGroups.length, 3);
  assert.ok(nodeGroups.every((g) => g.children.length === 2));
  /* 缩放控件：+ / − / ⟲ 三个按钮 */
  const zoomWrap = findDeep(calls.modal.body, (c) => c.className === "insights-zoom");
  assert.ok(zoomWrap, "流程图应包在缩放容器里");
  const zoomBtns = [];
  findDeep(zoomWrap, (c) => {
    if (c.className === "zoom-btn") zoomBtns.push(c);
    return false;
  });
  assert.equal(zoomBtns.length, 3);
  /* footer 有 Close 动作 */
  assert.equal(calls.modal.actions.length, 1);
});

test("缩放纯函数：焦点不变性、clamp、pan 累加、reset", async () => {
  const { zoomState, applyWheel, applyPan, resetZoom, ZOOM_MIN, ZOOM_MAX } = await import(
    "./index.js"
  );
  let z = zoomState();
  /* 焦点不变性：焦点下的内容点缩放前后坐标一致 */
  z = applyWheel(z, -200, 100, 80);
  assert.ok(z.scale > 1);
  const before = (100 - 0) / 1; // 缩放前焦点内容坐标
  const after = (100 - z.tx) / z.scale;
  assert.ok(Math.abs(before - after) < 1e-9);
  /* clamp：持续放大/缩小不超过边界 */
  for (let i = 0; i < 50; i++) z = applyWheel(z, -500, 0, 0);
  assert.equal(z.scale, ZOOM_MAX);
  for (let i = 0; i < 50; i++) z = applyWheel(z, 500, 0, 0);
  assert.equal(z.scale, ZOOM_MIN);
  /* pan 累加（从干净的 clamp 态起） */
  z = { ...z, tx: 0, ty: 0 };
  z = applyPan(z, 10, -5);
  z = applyPan(z, 2, 3);
  assert.ok(Math.abs(z.tx - 12) < 1e-9 && Math.abs(z.ty + 2) < 1e-9);
  assert.equal(z.scale, ZOOM_MIN); // pan 不动 scale
  /* reset 回单位态 */
  z = resetZoom(z);
  assert.deepEqual(z, { scale: 1, tx: 0, ty: 0 });
});
