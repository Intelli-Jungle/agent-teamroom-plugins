/* Session Insights 插件（web 端）：统计表 + 对话流程图右侧面板。
   由 web/js/plugins.js 动态 import 并调 register(ctx)。
   纯布局/分档/排序函数无 DOM，Node 可测（insights.test.mjs 同目录）。 */

const REFRESH_MS = 2000;
const HUMAN_COLOR = "#9ca3af";
const NODE_R = 14;

const STRINGS = {
  en: {
    toggle: "Session insights",
    title: "Session insights",
    stats: "Stats",
    flow: "Flow",
    col_messages: "Messages",
    col_files: "Files",
    col_tokens_in: "Tokens in ≈",
    col_tokens_out: "Tokens out ≈",
    est: "Estimated from character count",
    total: "Total",
    empty_stats: "No messages yet.",
    empty_flow: "No mentions yet.",
    close: "Close",
    zoom_in: "Zoom in",
    zoom_out: "Zoom out",
    zoom_reset: "Reset zoom",
  },
  "zh-CN": {
    toggle: "会话洞察",
    title: "会话洞察",
    stats: "统计",
    flow: "对话流程",
    col_messages: "消息",
    col_files: "附件",
    col_tokens_in: "输入 Token ≈",
    col_tokens_out: "输出 Token ≈",
    est: "按字符数估算",
    total: "总计",
    empty_stats: "还没有消息。",
    empty_flow: "还没有 @提及。",
    close: "关闭",
    zoom_in: "放大",
    zoom_out: "缩小",
    zoom_reset: "重置缩放",
  },
};

const CHART_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 15v3"/><path d="M12 10v8"/><path d="M17 5v13"/></svg>`;

/* ================= 纯函数 ================= */

/* 计数格式化：999→"999"，1234→"1.2k"，1234567→"1.2M"，去掉末尾 .0（1000→"1k"）。 */
export function formatCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1000) return String(Math.max(0, Math.round(v) || 0));
  const trim = (x) => x.toFixed(1).replace(/\.0$/, "");
  if (v < 1e6) return `${trim(v / 1e3)}k`;
  return `${trim(v / 1e6)}M`;
}

/* 按消息数降序（同数按字符数降序），不改动原数组。 */
export function sortSenders(senders) {
  return [...(senders || [])].sort((a, b) => b.messages - a.messages || b.chars - a.chars);
}

/* 线宽分档：相对最大值三等分 -> 1/2/3 档。 */
export function edgeTier(count, maxCount) {
  if (maxCount <= 0 || count <= maxCount / 3) return 1;
  if (count <= (2 * maxCount) / 3) return 2;
  return 3;
}

export const EDGE_WIDTHS = { 1: 1.5, 2: 2.5, 3: 4 };

/* 节点归类：发言者 + 连线端点的并集；humanName 进左列，其余进右列。
   保持出现顺序（senders 优先，edges 补充）。 */
export function splitFlowNodes(stats, humanName) {
  const names = [];
  const seen = new Set();
  const push = (n) => {
    if (n && !seen.has(n)) {
      seen.add(n);
      names.push(n);
    }
  };
  for (const s of (stats && stats.senders) || []) push(s.name);
  for (const e of (stats && stats.edges) || []) {
    push(e.from);
    push(e.to);
  }
  const humans = names.filter((n) => n === humanName);
  const agents = names.filter((n) => n !== humanName);
  return { humans, agents };
}

/* 有向边：去掉自环与无效边。 */
export function flowEdges(stats) {
  return ((stats && stats.edges) || []).filter(
    (e) => e.from && e.to && e.from !== e.to && e.count > 0
  );
}

/* 径向布局：人类节点在中心（多个则竖排居中），Agent 均匀分布在外围椭圆上
   （1 个放正右方，2 个放左右，n 个从正右起逆时针均布）。
   返回 { width, height, nodes: [{ name, side, x, y }] }。 */
export function layoutFlow({ humans = [], agents = [] }, width = 460) {
  const height = 340;
  const cx = width / 2;
  const cy = height / 2;
  const rx = width / 2 - 64;
  const ry = height / 2 - 46;
  const nodes = [];
  humans.forEach((name, i) => {
    nodes.push({ name, side: "human", x: cx, y: cy + (i - (humans.length - 1) / 2) * 72 });
  });
  agents.forEach((name, i) => {
    const angle = (-2 * Math.PI * i) / agents.length;
    nodes.push({
      name,
      side: "agent",
      x: cx + rx * Math.cos(angle),
      y: cy + ry * Math.sin(angle),
    });
  });
  return { width, height, nodes };
}

/* 模态框在手机上只有约 300px 可用宽度；缩小 viewBox 比例比把 460px
   图硬压缩更易读。Node 测试没有 window 时保持桌面默认值。 */
function responsiveGraphWidth(maxWidth = 720) {
  if (typeof window === "undefined") return maxWidth;
  return Math.min(maxWidth, Math.max(320, window.innerWidth - 64));
}

/* 二次贝塞尔曲线控制点：垂直于弦方向偏移，方向由 from/to 名字序决定
   （反向边自动分到弦另一侧）。 */
export function bezierControl(a, b, from, to) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const px = -(b.y - a.y) / len;
  const py = (b.x - a.x) / len;
  const dir = String(from) < String(to) ? 1 : -1;
  const bend = Math.min(28, len * 0.18) * dir;
  return { x: mx + px * bend, y: my + py * bend };
}

/* t=0.5 处的二次贝塞尔点（徽标位置，天然偏离弦）。 */
export function bezierMid(p0, c, p1) {
  return {
    x: 0.25 * p0.x + 0.5 * c.x + 0.25 * p1.x,
    y: 0.25 * p0.y + 0.5 * c.y + 0.25 * p1.y,
  };
}

/* 一条边的完整几何：端点各让出节点半径（终点多让 2px 给箭头），
   二次贝塞尔控制点垂直弦偏移，返回 { p0, p1, c, d }。
   拖拽节点时用同一函数重算，保证初绘与拖拽路径一致。 */
export function edgeGeometry(a, b, from, to) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const p0 = { x: a.x + ux * (NODE_R + 2), y: a.y + uy * (NODE_R + 2) };
  const p1 = { x: b.x - ux * (NODE_R + 4), y: b.y - uy * (NODE_R + 4) };
  const c = bezierControl(a, b, from, to);
  return { p0, p1, c, d: `M ${p0.x} ${p0.y} Q ${c.x} ${c.y} ${p1.x} ${p1.y}` };
}

/* ---- 缩放/平移状态（纯函数；viewBox 坐标系） ---- */

export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 3;

export function zoomState() {
  return { scale: 1, tx: 0, ty: 0 };
}

/* 以 (cx, cy) 为焦点缩放：焦点下的内容点缩放前后不动；scale clamp 到 [0.3, 3]。 */
export function applyWheel(state, deltaY, cx, cy) {
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, state.scale * Math.exp(-deltaY * 0.0015)));
  const k = next / state.scale;
  return { scale: next, tx: cx - (cx - state.tx) * k, ty: cy - (cy - state.ty) * k };
}

export function applyPan(state, dx, dy) {
  return { scale: state.scale, tx: state.tx + dx, ty: state.ty + dy };
}

export function resetZoom() {
  return zoomState();
}

/* ================= 插件注册 ================= */

export function register(ctx) {
  const t = ctx.pluginLocale(STRINGS);
  let stats = null;
  let modalBody = null; // 打开中的模态框 body 容器
  let lastFetch = 0;
  let trailingTimer = null;
  /* 节点拖拽位置覆盖：name → {x, y}；周期重渲染后仍保留手动摆位。
     节点消失后残留条目无害（布局时按名字命中才生效）。 */
  const nodePosOverrides = new Map();

  const humanName = () => (ctx.store.state.settings || {}).human_name || "我";

  function nodeColor(name) {
    if (name === humanName()) return HUMAN_COLOR;
    const { agents, specs } = ctx.store.state;
    const inst = agents.find((i) => i.name === name);
    if (inst) return inst.color || HUMAN_COLOR;
    const spec = specs.find((s) => s.name === name);
    if (spec) return spec.color || HUMAN_COLOR;
    let hash = 0;
    for (const ch of String(name)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return `hsl(${hash % 360} 45% 52%)`;
  }

  /* ---- 模态框内容（openModal 由宿主 ctx 提供） ---- */

  function statsTable(data) {
    const wrap = ctx.el("div", "insights-section");
    wrap.append(ctx.el("div", "insights-heading", t("stats")));
    const table = ctx.el("table", "insights-table");
    const head = ctx.el("tr", "insights-head");
    head.append(
      ctx.el("th", "", ""),
      ctx.el("th", "insights-num", t("col_messages")),
      ctx.el("th", "insights-num", t("col_files"))
    );
    /* In（被 @ 接收）/ Out（发送）两列 token 估算 */
    const tokInHead = ctx.el("th", "insights-num", t("col_tokens_in"));
    tokInHead.title = t("est");
    const tokOutHead = ctx.el("th", "insights-num", t("col_tokens_out"));
    tokOutHead.title = t("est");
    head.append(tokInHead, tokOutHead);
    table.append(head);

    const senders = sortSenders(data.senders);
    if (senders.length === 0) {
      wrap.append(table, ctx.el("p", "insights-empty", t("empty_stats")));
      return wrap;
    }
    let files = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    for (const s of senders) {
      files += s.attachments || 0;
      tokensIn += s.in_est_tokens || 0;
      tokensOut += s.est_tokens || 0;
      const row = ctx.el("tr");
      const nameCell = ctx.el("td", "insights-name");
      const dot = ctx.el("span", "agent-dot");
      dot.style.background = nodeColor(s.name);
      nameCell.append(dot, ctx.el("span", "", s.name));
      const tokInCell = ctx.el("td", "insights-num", `≈${formatCount(s.in_est_tokens || 0)}`);
      tokInCell.title = t("est");
      const tokOutCell = ctx.el("td", "insights-num", `≈${formatCount(s.est_tokens || 0)}`);
      tokOutCell.title = t("est");
      row.append(
        nameCell,
        ctx.el("td", "insights-num", String(s.messages || 0)),
        ctx.el("td", "insights-num", String(s.attachments || 0)),
        tokInCell,
        tokOutCell
      );
      table.append(row);
    }
    const total = ctx.el("tr", "insights-total");
    const totalTokIn = ctx.el("td", "insights-num", `≈${formatCount(tokensIn)}`);
    totalTokIn.title = t("est");
    const totalTokOut = ctx.el("td", "insights-num", `≈${formatCount(tokensOut)}`);
    totalTokOut.title = t("est");
    total.append(
      ctx.el("td", "", t("total")),
      ctx.el("td", "insights-num", String(data.total_messages || 0)),
      ctx.el("td", "insights-num", String(files)),
      totalTokIn,
      totalTokOut
    );
    table.append(total);
    wrap.append(table);
    return wrap;
  }

  /* 缩放/平移装配：滚轮以指针为焦点、拖拽平移、双击或按钮复位；
     指针屏幕坐标按 viewBox 比例换算。控件在图右上角。 */
  function attachZoom(container, svg, layer, viewWidth) {
    let z = zoomState();
    const apply = () =>
      layer.setAttribute("transform", `translate(${z.tx} ${z.ty}) scale(${z.scale})`);
    const toView = (px, py) => {
      const r = svg.getBoundingClientRect();
      const k = viewWidth / (r.width || viewWidth);
      return [px * k, py * k, k];
    };
    svg.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const r = svg.getBoundingClientRect();
        const [x, y] = toView(e.clientX - r.left, e.clientY - r.top);
        z = applyWheel(z, e.deltaY, x, y);
        apply();
      },
      { passive: false }
    );
    let drag = null;
    svg.addEventListener("pointerdown", (e) => {
      drag = [e.clientX, e.clientY];
      svg.setPointerCapture && svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const [, , k] = toView(0, 0);
      z = applyPan(z, (e.clientX - drag[0]) * k, (e.clientY - drag[1]) * k);
      drag = [e.clientX, e.clientY];
      apply();
    });
    svg.addEventListener("pointerup", () => {
      drag = null;
    });
    svg.addEventListener("dblclick", () => {
      z = resetZoom();
      apply();
    });
    const controls = ctx.el("div", "zoom-controls");
    const mkBtn = (label, titleKey, fn) => {
      const b = ctx.el("button", "zoom-btn", label);
      b.title = t(titleKey);
      b.setAttribute("aria-label", t(titleKey));
      b.addEventListener("click", fn);
      return b;
    };
    const center = () => {
      const r = svg.getBoundingClientRect();
      return toView(r.width / 2, r.height / 2);
    };
    controls.append(
      mkBtn("+", "zoom_in", () => {
        const [x, y] = center();
        z = applyWheel(z, -120, x, y);
        apply();
      }),
      mkBtn("−", "zoom_out", () => {
        const [x, y] = center();
        z = applyWheel(z, 120, x, y);
        apply();
      }),
      mkBtn("⟲", "zoom_reset", () => {
        z = resetZoom();
        apply();
      })
    );
    container.append(svg, controls);
  }

  /* 节点拖拽装配：pointerdown 拦下事件（不触发画布平移），pointermove 把屏幕
     坐标经 layer 的 getScreenCTM 逆矩阵换算回 viewBox 坐标系（含缩放/平移），
     实时更新节点 transform 并由 onMove 重算相连边；结束时写入位置覆盖表。 */
  function attachNodeDrag(g, node, layer, onMove) {
    let dragging = false;
    g.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      dragging = true;
      if (g.setPointerCapture) g.setPointerCapture(e.pointerId);
    });
    g.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      if (typeof DOMPoint === "undefined" || !layer.getScreenCTM) return;
      const ctm = layer.getScreenCTM();
      if (!ctm) return;
      const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
      node.x = p.x;
      node.y = p.y;
      g.setAttribute("transform", `translate(${p.x} ${p.y})`);
      onMove();
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      nodePosOverrides.set(node.name, { x: node.x, y: node.y });
    };
    g.addEventListener("pointerup", end);
    g.addEventListener("pointercancel", end);
  }

  function flowSvg(data) {
    const wrap = ctx.el("div", "insights-section");
    wrap.append(ctx.el("div", "insights-heading", t("flow")));
    const edges = flowEdges(data);
    if (edges.length === 0) {
      wrap.append(ctx.el("p", "insights-empty", t("empty_flow")));
      return wrap;
    }
    const { humans, agents } = splitFlowNodes(data, humanName());
    const layout = layoutFlow({ humans, agents }, responsiveGraphWidth());
    /* 应用拖拽留下的位置覆盖（节点对象可变，边重算直接读它） */
    for (const n of layout.nodes) {
      const o = nodePosOverrides.get(n.name);
      if (o) {
        n.x = o.x;
        n.y = o.y;
      }
    }
    const byName = new Map(layout.nodes.map((n) => [n.name, n]));
    const maxCount = Math.max(...edges.map((e) => e.count));

    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
    svg.setAttribute("class", "insights-flow-svg");
    svg.setAttribute("role", "img");
    /* 内容层：缩放/平移 transform 作用在它上面 */
    const layer = document.createElementNS(NS, "g");
    svg.append(layer);

    const defs = document.createElementNS(NS, "defs");
    const marker = document.createElementNS(NS, "marker");
    marker.setAttribute("id", "insights-arrow");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "7");
    marker.setAttribute("markerHeight", "7");
    marker.setAttribute("orient", "auto-start-reverse");
    const arrow = document.createElementNS(NS, "path");
    arrow.setAttribute("d", "M 0 1 L 9 5 L 0 9 z");
    arrow.setAttribute("class", "insights-arrow-head");
    marker.append(arrow);
    defs.append(marker);
    layer.append(defs);

    /* 边的元素引用收集到 edgeEls，节点拖拽时 refreshEdges 全部重算（图很小） */
    const edgeEls = [];
    for (const e of edges) {
      const a = byName.get(e.from);
      const b = byName.get(e.to);
      if (!a || !b) continue;
      const geo = edgeGeometry(a, b, e.from, e.to);
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", geo.d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke-width", EDGE_WIDTHS[edgeTier(e.count, maxCount)]);
      path.setAttribute("class", "insights-edge");
      path.setAttribute("marker-end", "url(#insights-arrow)");
      layer.append(path);

      /* ×n 徽标放在曲线 t=0.5 处（偏离弦，不压线） */
      const mid = bezierMid(geo.p0, geo.c, geo.p1);
      const label = `×${e.count}`;
      const badgeW = label.length * 7 + 8;
      const rect = document.createElementNS(NS, "rect");
      rect.setAttribute("x", mid.x - badgeW / 2);
      rect.setAttribute("y", mid.y - 9);
      rect.setAttribute("width", badgeW);
      rect.setAttribute("height", 18);
      rect.setAttribute("rx", 9);
      rect.setAttribute("class", "insights-badge");
      const text = document.createElementNS(NS, "text");
      text.setAttribute("x", mid.x);
      text.setAttribute("y", mid.y + 4);
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("class", "insights-badge-text");
      text.textContent = label;
      layer.append(rect, text);
      edgeEls.push({ e, a, b, path, rect, text, badgeW });
    }

    /* 拖拽节点时重算全部边的 path d 与徽标位置 */
    const refreshEdges = () => {
      for (const it of edgeEls) {
        const geo = edgeGeometry(it.a, it.b, it.e.from, it.e.to);
        it.path.setAttribute("d", geo.d);
        const mid = bezierMid(geo.p0, geo.c, geo.p1);
        it.rect.setAttribute("x", mid.x - it.badgeW / 2);
        it.rect.setAttribute("y", mid.y - 9);
        it.text.setAttribute("x", mid.x);
        it.text.setAttribute("y", mid.y + 4);
      }
    };

    for (const node of layout.nodes) {
      /* circle + label 包进一个 g，整体用 transform 定位，拖拽只改 transform */
      const g = document.createElementNS(NS, "g");
      g.setAttribute("class", "insights-node");
      g.setAttribute("transform", `translate(${node.x} ${node.y})`);
      const circle = document.createElementNS(NS, "circle");
      circle.setAttribute("cx", 0);
      circle.setAttribute("cy", 0);
      circle.setAttribute("r", NODE_R);
      circle.setAttribute("fill", nodeColor(node.name));
      /* 径向布局：标签统一放节点正下方居中 */
      const label = document.createElementNS(NS, "text");
      label.setAttribute("x", 0);
      label.setAttribute("y", NODE_R + 13);
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("class", "insights-node-label");
      label.textContent = node.name;
      g.append(circle, label);
      attachNodeDrag(g, node, layer, refreshEdges);
      layer.append(g);
    }
    const zoomWrap = ctx.el("div", "insights-zoom");
    attachZoom(zoomWrap, svg, layer, layout.width);
    wrap.append(zoomWrap);
    return wrap;
  }

  function render() {
    if (!modalBody || !stats) return;
    modalBody.textContent = "";
    modalBody.append(statsTable(stats), flowSvg(stats));
  }

  async function fetchStats() {
    const id = ctx.store.state.activeSessionId;
    if (!id) return;
    lastFetch = Date.now();
    try {
      stats = await ctx.api.getSessionStats(id);
      render();
    } catch (err) {
      ctx.toast(`${t("title")}：${err.message}`, true);
    }
  }

  /* 模态框打开判定：容器仍挂在 DOM 上（关闭后 openModal 清空 modal-root） */
  const isModalOpen = () => modalBody !== null && modalBody.isConnected !== false;

  function openInsights() {
    ctx.openModal({
      title: t("title"),
      wide: true,
      build: (body) => {
        modalBody = body;
        stats = null;
        fetchStats();
      },
      actions: [{ label: t("close"), onClick: (close) => close() }],
    });
  }

  const btn = ctx.addHeaderButton({
    id: "toggle",
    title: t("toggle"),
    svgIcon: CHART_SVG,
    onClick: openInsights,
  });

  /* 打开期间：新消息节流刷新（2s，含尾调用）；切会话重拉；语言切换重渲染 */
  ctx.on("message", () => {
    if (!isModalOpen()) return;
    const wait = REFRESH_MS - (Date.now() - lastFetch);
    if (wait <= 0) {
      fetchStats();
      return;
    }
    if (!trailingTimer) {
      trailingTimer = setTimeout(() => {
        trailingTimer = null;
        if (isModalOpen()) fetchStats();
      }, wait);
    }
  });
  ctx.on("session_active", () => {
    if (isModalOpen()) fetchStats();
  });
  ctx.on("locale", () => {
    btn.title = t("toggle");
    btn.setAttribute("aria-label", t("toggle"));
    render();
  });
}
