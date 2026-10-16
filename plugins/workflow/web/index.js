/* Workflow 插件（web 端）：会话工作流可视化编辑器（右侧面板）。
   图预览（SVG 两列布局：人类左、Agent 右）+ 边编辑行 + 角色 textarea
   + max_hops/enabled；保存 PUT / 重置 DELETE。环允许，靠 max_hops 截停。
   纯逻辑（规范化/去重/双向补全/布局）无 DOM，Node 可测。 */

const HUMAN_COLOR = "#9ca3af";
const NODE_R = 14;

const STRINGS = {
  en: {
    toggle: "Workflow",
    title: "Workflow",
    graph_preview: "Loop map",
    enabled: "Enabled",
    max_hops: "Max hops",
    instructions: "Instructions",
    instructions_placeholder:
      "Optional rules every agent must follow on every turn, e.g. “Always reply in Chinese and keep it under 3 sentences”",
    edges: "Edges",
    agents: "Agents",
    role: "Role",
    zoom_in: "Zoom in",
    zoom_out: "Zoom out",
    zoom_reset: "Reset zoom",
    add_edge: "Add edge",
    both_ways: "Both ways",
    delete_edge: "Delete edge",
    goal: "Goal",
    backstory: "Backstory",
    role_placeholder: "You are the reviewer…",
    custom: "Custom",
    all_edges_exist: "All possible edges exist",
    goal_placeholder: "e.g. Keep refactoring until the diff is clean",
    backstory_placeholder: "e.g. A pragmatic engineer with 10 years on payment systems",
    default_prefix: "Default:",
    self_loop: "Self-loop: re-runs until [GOAL_DONE] or max hops",
    save: "Save",
    reset: "Reset",
    cancel: "Cancel",
    saved: "Workflow saved",
    reset_done: "Workflow cleared",
    empty_edges: "No edges yet — messages won't auto-route.",
  },
  "zh-CN": {
    toggle: "工作流",
    title: "工作流",
    graph_preview: "Loop 关系图",
    enabled: "启用",
    max_hops: "最大跳数",
    instructions: "交互指令",
    instructions_placeholder: "可选：每次交互所有 agent 都必须遵守的规则，例如“一律用中文回复，不超过三句”",
    edges: "边",
    agents: "智能体",
    role: "角色",
    zoom_in: "放大",
    zoom_out: "缩小",
    zoom_reset: "重置缩放",
    add_edge: "加边",
    both_ways: "双向",
    delete_edge: "删除",
    goal: "目标",
    backstory: "背景",
    role_placeholder: "你是评审…",
    custom: "自定义",
    all_edges_exist: "已包含所有可能的连线",
    goal_placeholder: "例如：持续重构直到 diff 干净",
    backstory_placeholder: "例如：做了十年支付系统的务实工程师",
    default_prefix: "默认：",
    self_loop: "自环：未标记 [GOAL_DONE] 前自动续跑，直到标记或达到最大跳数",
    save: "保存",
    reset: "重置",
    cancel: "取消",
    saved: "工作流已保存",
    reset_done: "工作流已清空",
    empty_edges: "暂无边——消息不会自动路由。",
  },
};

/* lucide workflow 风格图标 */
const FLOW_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="15" y="15" width="6" height="6" rx="1.5"/><circle cx="18" cy="6" r="3"/><path d="M9 6h3a3 3 0 0 1 3 3v3"/><path d="M6 9v3a3 3 0 0 0 3 3h3"/></svg>`;

/* ================= 纯函数 ================= */

export function edgeKey(e) {
  return `${e.from}→${e.to}`;
}

/* 去重 + 去掉缺端点的边，保序。 */
export function dedupeEdges(edges) {
  const seen = new Set();
  const out = [];
  for (const e of edges || []) {
    if (!e || !e.from || !e.to) continue;
    const key = edgeKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from: e.from, to: e.to });
  }
  return out;
}

export function addEdge(edges, from, to) {
  return dedupeEdges([...(edges || []), { from, to }]);
}

/* 双向快捷：补两条反向边（自环只留一条）。 */
export function addBidirectional(edges, a, b) {
  let out = addEdge(edges, a, b);
  if (a !== b) out = addEdge(out, b, a);
  return out;
}

export function removeEdgeAt(edges, idx) {
  return (edges || []).filter((_, i) => i !== idx);
}

/* "加边"的下一条候选：按 from→to 顺序遍历全部组合（含自环），
   返回第一条尚未存在的边；全部已存在返回 null。 */
export function nextMissingEdge(edges, names) {
  for (const from of names || []) {
    for (const to of names || []) {
      const exists = (edges || []).some((e) => e.from === from && e.to === to);
      if (!exists) return { from, to };
    }
  }
  return null;
}

/* Role 预设：每个预设带 role/goal/backstory 模板，中英两份随 locale 切换。 */
export const ROLE_PRESETS = [
  {
    id: "software-development",
    en: {
      label: "Software Development",
      role: "Senior software engineer focused on clean, testable code",
      goal: "Deliver working, reviewed code in small increments",
      backstory: "Years of shipping production systems in large codebases",
    },
    "zh-CN": {
      label: "软件开发",
      role: "资深软件工程师，注重整洁、可测试的代码",
      goal: "小步交付可运行、经过评审的代码",
      backstory: "长期在大型代码库中交付生产系统",
    },
  },
  {
    id: "project-management",
    en: {
      label: "Project Management",
      role: "Project manager who keeps scope, priorities and risks visible",
      goal: "Break work into clear tasks and keep the team unblocked",
      backstory: "Ran cross-functional engineering teams through many releases",
    },
    "zh-CN": {
      label: "项目管理",
      role: "项目经理，让范围、优先级和风险始终可见",
      goal: "把工作拆成清晰任务，保持团队不被阻塞",
      backstory: "带跨职能工程团队交付过多次发布",
    },
  },
  {
    id: "technical-insights",
    en: {
      label: "Technical Insights",
      role: "Analyst surfacing technical trends, trade-offs and benchmarks",
      goal: "Give evidence-backed insights, not opinions",
      backstory: "Researched developer tooling and infra trends for years",
    },
    "zh-CN": {
      label: "技术洞察",
      role: "技术分析师，挖掘趋势、权衡与基准数据",
      goal: "给有证据支撑的洞察，而非观点",
      backstory: "多年研究开发者工具与基础设施趋势",
    },
  },
  {
    id: "paper-research",
    en: {
      label: "Paper Research",
      role: "Academic researcher: precise, citation-driven, skeptical",
      goal: "Ground every claim in literature; flag weak evidence",
      backstory: "Published and reviewed papers in peer-reviewed venues",
    },
    "zh-CN": {
      label: "论文研究",
      role: "学术研究者：严谨、以引用为准、保持怀疑",
      goal: "每个结论都有文献支撑；标注证据薄弱处",
      backstory: "在同行评审 venue 发表并评审过论文",
    },
  },
  {
    id: "code-review",
    en: {
      label: "Code Review",
      role: "Strict code reviewer: correctness, style, security",
      goal: "Catch defects before merge; suggest concrete fixes",
      backstory: "Reviewed thousands of PRs across multiple languages",
    },
    "zh-CN": {
      label: "代码评审",
      role: "严格的代码评审：正确性、风格、安全",
      goal: "在合并前揪出缺陷；给出具体修改建议",
      backstory: "评审过数千个跨语言 PR",
    },
  },
];

/* 预设按当前语言解析（label/role/goal/backstory），回退 en。 */
export function presetFor(preset, locale) {
  return preset[locale] || preset.en;
}

/* 当前 role 值匹配的预设（中英文本都算命中）；都不匹配返回 null（自定义）。 */
export function matchPreset(roleValue) {
  if (!roleValue) return null;
  return (
    ROLE_PRESETS.find((p) => p.en.role === roleValue || p["zh-CN"].role === roleValue) || null
  );
}

/* 应用预设：role 覆盖为预设值；goal/backstory 仅在当前为空时用模板预填
   （不覆盖用户已写内容）。返回新的 { roles, goals, backstories }。 */
export function applyRolePreset(roles, goals, backstories, name, preset) {
  const nextRoles = { ...(roles || {}), [name]: preset.role };
  const nextGoals = { ...(goals || {}) };
  const nextBackstories = { ...(backstories || {}) };
  if (!nextGoals[name]) nextGoals[name] = preset.goal;
  if (!nextBackstories[name]) nextBackstories[name] = preset.backstory;
  return { roles: nextRoles, goals: nextGoals, backstories: nextBackstories };
}

/* 后端返回缺字段时补默认值：enabled=false、max_hops=10、edges=[]、roles/goals/backstories={}。 */
export function normalizeWorkflow(raw) {
  const d = raw || {};
  const objMap = (v) => (v && typeof v === "object" && !Array.isArray(v) ? { ...v } : {});
  return {
    enabled: Boolean(d.enabled),
    max_hops: Number.isInteger(d.max_hops) && d.max_hops > 0 ? d.max_hops : 10,
    edges: dedupeEdges(Array.isArray(d.edges) ? d.edges : []),
    roles: objMap(d.roles),
    goals: objMap(d.goals),
    backstories: objMap(d.backstories),
    instructions: typeof d.instructions === "string" ? d.instructions : "",
  };
}

/* agent 名（可能是实例名 kimi-2）匹配 spec 默认人设：先精确名再 base 名。 */
export function specDefaultsFor(specs, agentName) {
  const base = String(agentName || "").replace(/-\d+$/, "");
  const spec = (specs || []).find((s) => s.name === agentName || s.name === base);
  if (!spec) return {};
  return { role: spec.role || "", goal: spec.goal || "", backstory: spec.backstory || "" };
}

/* 紧凑两列布局：人类左列、Agent 右列垂直均布居中，避免多个 Agent 挤成一排。 */
export function layoutFlow({ humans = [], agents = [] }, width = 640) {
  const rows = Math.max(humans.length, agents.length, 1);
  const rowH = 68;
  const padY = 36;
  const height = padY * 2 + (rows - 1) * rowH;
  const leftX = 96;
  const rightX = width - 96;
  const nodes = [];
  const place = (list, side, x) => {
    const startY = padY + ((rows - list.length) * rowH) / 2;
    list.forEach((name, i) => nodes.push({ name, side, x, y: startY + i * rowH }));
  };
  place(humans, "human", leftX);
  place(agents, "agent", rightX);
  return { width, height, nodes };
}

/* 手机端模态框可用宽度约 300px；按视口收窄 viewBox，避免 640px 图缩放后
   节点文字和连线标记难以阅读。Node 测试没有 window 时保持桌面默认值。 */
function responsiveGraphWidth(maxWidth = 720) {
  if (typeof window === "undefined") return maxWidth;
  return Math.min(maxWidth, Math.max(320, window.innerWidth - 64));
}

/* 普通边几何：端点沿连线方向按节点半径缩短（to 侧多留箭头空间），
   双向边对各自反向 ±4 垂直偏移避免重叠。拖拽节点时按新位置重算。 */
export function edgeLinePoints(a, b, reverse) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const off = reverse ? 4 : -4;
  const ox = -uy * off;
  const oy = ux * off;
  return {
    x1: a.x + ux * (NODE_R + 2) + ox,
    y1: a.y + uy * (NODE_R + 2) + oy,
    x2: b.x - ux * (NODE_R + 4) + ox,
    y2: b.y - uy * (NODE_R + 4) + oy,
  };
}

/* 自环几何：从节点 -35° 处起弧，越过顶部回到 -145° 处（半径 12 小圆弧），
   返回 path 的 d。拖拽节点时按新位置重算。 */
export function selfLoopArc(x, y) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const x1 = x + NODE_R * Math.cos(rad(-35));
  const y1 = y + NODE_R * Math.sin(rad(-35));
  const x2 = x + NODE_R * Math.cos(rad(-145));
  const y2 = y + NODE_R * Math.sin(rad(-145));
  return `M ${x1} ${y1} A 12 12 0 1 1 ${x2} ${y2}`;
}

/* ---- 缩放/平移状态（纯函数；viewBox 坐标系。与 insights 插件同逻辑、各自复制） ---- */

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
  let model = null; // normalizeWorkflow 后的本地编辑副本
  let specs = []; // /api/agent-specs（含 role/goal/backstory 默认人设）
  let modalBody = null; // 打开中的模态框 body 容器
  const nodePos = new Map(); // 拖拽摆过的节点位置（name → {x,y}），render() 重建后保留

  const humanName = () => (ctx.store.state.settings || {}).human_name || "我";
  const activeSession = () => ctx.store.getSession(ctx.store.state.activeSessionId);
  const sessionAgents = () => (activeSession() && activeSession().agents) || [];
  const participants = () => [humanName(), ...sessionAgents()];

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

  /* ---- 图预览 ---- */

  function graphSvg() {
    const agents = sessionAgents();
    const layout = layoutFlow(
      { humans: [humanName()], agents },
      responsiveGraphWidth()
    );
    /* 应用拖拽摆过的位置（render() 重建后保留） */
    for (const n of layout.nodes) {
      const p = nodePos.get(n.name);
      if (p) {
        n.x = p.x;
        n.y = p.y;
      }
    }
    const byName = new Map(layout.nodes.map((n) => [n.name, n]));
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
    svg.setAttribute("class", "wf-graph");
    svg.setAttribute("role", "img");
    /* 内容层：缩放/平移 transform 作用在它上面 */
    const layer = document.createElementNS(NS, "g");
    svg.append(layer);

    const defs = document.createElementNS(NS, "defs");
    const marker = document.createElementNS(NS, "marker");
    marker.setAttribute("id", "wf-arrow");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "7");
    marker.setAttribute("markerHeight", "7");
    marker.setAttribute("orient", "auto-start-reverse");
    const arrow = document.createElementNS(NS, "path");
    arrow.setAttribute("d", "M 0 1 L 9 5 L 0 9 z");
    arrow.setAttribute("class", "wf-arrow-head");
    marker.append(arrow);
    defs.append(marker);
    /* 自环用强调色箭头 */
    const marker2 = marker.cloneNode(true);
    marker2.setAttribute("id", "wf-arrow-accent");
    marker2.firstChild.setAttribute("class", "wf-arrow-head-accent");
    defs.append(marker2);
    layer.append(defs);

    /* 双向边对各自反向偏移，避免完全重叠；自环画节点上方小圆弧箭头。
       每条边登记到 edgeEls，拖拽节点时按新位置重算几何。 */
    const seen = new Set();
    const selfLoopNodes = new Set();
    const edgeEls = [];
    for (const e of model.edges) {
      const a = byName.get(e.from);
      const b = byName.get(e.to);
      if (!a || !b) continue;
      const reverse = seen.has(`${e.to}→${e.from}`);
      seen.add(`${e.from}→${e.to}`);
      if (a === b) {
        selfLoopNodes.add(e.from);
        const arc = document.createElementNS(NS, "path");
        arc.setAttribute("d", selfLoopArc(a.x, a.y));
        arc.setAttribute("class", "wf-edge wf-selfloop");
        arc.setAttribute("fill", "none");
        arc.setAttribute("marker-end", "url(#wf-arrow-accent)");
        const tip = document.createElementNS(NS, "title");
        tip.textContent = t("self_loop");
        arc.append(tip);
        layer.append(arc);
        edgeEls.push({ el: arc, from: e.from, to: e.to, self: true });
        continue;
      }
      const line = document.createElementNS(NS, "line");
      const pts = edgeLinePoints(a, b, reverse);
      line.setAttribute("x1", pts.x1);
      line.setAttribute("y1", pts.y1);
      line.setAttribute("x2", pts.x2);
      line.setAttribute("y2", pts.y2);
      line.setAttribute("class", "wf-edge");
      line.setAttribute("marker-end", "url(#wf-arrow)");
      layer.append(line);
      edgeEls.push({ el: line, from: e.from, to: e.to, reverse });
    }
    /* 图小，拖拽时每个 move 重算全部相连边即可 */
    const redrawEdges = () => {
      for (const entry of edgeEls) {
        const a = byName.get(entry.from);
        const b = byName.get(entry.to);
        if (entry.self) {
          entry.el.setAttribute("d", selfLoopArc(a.x, a.y));
        } else {
          const pts = edgeLinePoints(a, b, entry.reverse);
          entry.el.setAttribute("x1", pts.x1);
          entry.el.setAttribute("y1", pts.y1);
          entry.el.setAttribute("x2", pts.x2);
          entry.el.setAttribute("y2", pts.y2);
        }
      }
    };

    for (const node of layout.nodes) {
      /* circle + label 包进 <g class="wf-node">，整组可拖拽 */
      const g = document.createElementNS(NS, "g");
      g.setAttribute("class", "wf-node");
      const circle = document.createElementNS(NS, "circle");
      circle.setAttribute("cx", node.x);
      circle.setAttribute("cy", node.y);
      circle.setAttribute("r", NODE_R);
      circle.setAttribute("fill", nodeColor(node.name));
      if (selfLoopNodes.has(node.name)) {
        /* 自驱节点：描边高亮 + 悬停提示 */
        circle.setAttribute("class", "wf-node-selfloop");
        const tip = document.createElementNS(NS, "title");
        tip.textContent = t("self_loop");
        circle.append(tip);
      }
      const human = node.side === "human";
      const label = document.createElementNS(NS, "text");
      label.setAttribute("x", node.x + (human ? NODE_R + 6 : -(NODE_R + 6)));
      label.setAttribute("y", node.y + 4);
      label.setAttribute("text-anchor", human ? "start" : "end");
      label.setAttribute("class", "wf-node-label");
      label.textContent = node.name;
      g.append(circle, label);
      layer.append(g);

      /* 节点拖拽：stopPropagation 避免触发画布平移；指针屏幕坐标经
         layer 的 CTM 逆矩阵换算回内容坐标（缩放/平移下也正确）。 */
      let dragging = false;
      g.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        dragging = true;
        g.setPointerCapture && g.setPointerCapture(e.pointerId);
      });
      g.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const ctm = layer.getScreenCTM && layer.getScreenCTM();
        if (!ctm || typeof DOMPoint === "undefined") return;
        const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
        node.x = p.x;
        node.y = p.y;
        circle.setAttribute("cx", p.x);
        circle.setAttribute("cy", p.y);
        label.setAttribute("x", p.x + (human ? NODE_R + 6 : -(NODE_R + 6)));
        label.setAttribute("y", p.y + 4);
        redrawEdges();
      });
      const endDrag = () => {
        if (!dragging) return;
        dragging = false;
        nodePos.set(node.name, { x: node.x, y: node.y });
      };
      g.addEventListener("pointerup", endDrag);
      g.addEventListener("pointercancel", endDrag);
    }
    const zoomWrap = ctx.el("div", "wf-zoom wf-graph-card");
    attachZoom(zoomWrap, svg, layer, layout.width);
    return zoomWrap;
  }

  /* ---- 编辑区 ---- */

  function nameSelect(value) {
    const select = ctx.el("select", "wf-select");
    for (const name of participants()) {
      const opt = ctx.el("option", "", name);
      opt.value = name;
      if (name === value) opt.selected = true;
      select.append(opt);
    }
    return select;
  }

  function edgeRow(edge, idx) {
    const row = ctx.el("div", "wf-edge-row");
    const from = nameSelect(edge.from);
    from.addEventListener("change", () => {
      model.edges = dedupeEdges(
        model.edges.map((e, i) => (i === idx ? { from: from.value, to: e.to } : e))
      );
      render();
    });
    const to = nameSelect(edge.to);
    to.addEventListener("change", () => {
      model.edges = dedupeEdges(
        model.edges.map((e, i) => (i === idx ? { from: e.from, to: to.value } : e))
      );
      render();
    });
    const both = ctx.el("button", "icon-btn wf-both", "⇄");
    both.title = t("both_ways");
    both.addEventListener("click", () => {
      model.edges = addBidirectional(model.edges, edge.from, edge.to);
      render();
    });
    const del = ctx.el("button", "icon-btn wf-del", "×");
    del.title = t("delete_edge");
    del.addEventListener("click", () => {
      model.edges = removeEdgeAt(model.edges, idx);
      render();
    });
    row.append(from, ctx.el("span", "wf-arrow-char", "→"), to, both, del);
    return row;
  }

  function render() {
    if (!modalBody || !model) return;
    modalBody.textContent = "";

    const top = ctx.el("div", "wf-top wf-control-bar");
    const enabledLabel = ctx.el("label", "wf-enabled");
    const enabledBox = document.createElement("input");
    enabledBox.type = "checkbox";
    enabledBox.checked = model.enabled;
    enabledBox.addEventListener("change", () => {
      model.enabled = enabledBox.checked;
    });
    enabledLabel.append(enabledBox, ctx.el("span", "", t("enabled")));
    const hopsLabel = ctx.el("label", "wf-hops");
    const hopsInput = ctx.el("input", "modal-input wf-hops-input");
    hopsInput.type = "number";
    hopsInput.min = "1";
    hopsInput.max = "100";
    hopsInput.value = String(model.max_hops);
    hopsInput.addEventListener("change", () => {
      const v = Number(hopsInput.value);
      model.max_hops = Number.isInteger(v) && v > 0 ? v : 10;
      hopsInput.value = String(model.max_hops);
    });
    hopsLabel.append(ctx.el("span", "", t("max_hops")), hopsInput);
    top.append(enabledLabel, hopsLabel);
    modalBody.append(top);

    /* 会话级交互指令：非空时每次交互注入所有 agent 的上下文 */
    const instrField = ctx.el("div", "modal-field wf-instructions");
    instrField.append(ctx.el("label", "modal-label", t("instructions")));
    const instrArea = ctx.el("textarea", "modal-input wf-area");
    instrArea.rows = 2;
    instrArea.placeholder = t("instructions_placeholder");
    instrArea.value = model.instructions || "";
    instrArea.addEventListener("input", () => {
      model.instructions = instrArea.value.trim();
    });
    instrField.append(instrArea);
    modalBody.append(instrField);

    const graph = graphSvg();
    graph.dataset.label = t("graph_preview");
    modalBody.append(graph);

    const edgePanel = ctx.el("section", "wf-panel wf-edge-panel");
    edgePanel.append(ctx.el("div", "wf-heading", t("edges")));
    const edgeList = ctx.el("div", "wf-edge-list");
    if (model.edges.length === 0) {
      edgeList.append(ctx.el("p", "wf-empty", t("empty_edges")));
    }
    model.edges.forEach((edge, idx) => edgeList.append(edgeRow(edge, idx)));
    /* 加边：插第一条尚未存在的组合（含自环）；组合占满则置灰 */
    const missing = nextMissingEdge(model.edges, participants());
    const addBtn = ctx.el("button", "ghost-btn wf-add", `+ ${t("add_edge")}`);
    addBtn.disabled = !missing;
    addBtn.title = missing ? "" : t("all_edges_exist");
    addBtn.addEventListener("click", () => {
      const next = nextMissingEdge(model.edges, participants());
      if (!next) return;
      model.edges = addEdge(model.edges, next.from, next.to);
      render();
    });
    edgeList.append(addBtn);
    edgePanel.append(edgeList);
    modalBody.append(edgePanel);

    const agents = sessionAgents();
    if (agents.length) {
      const agentsPanel = ctx.el("section", "wf-panel wf-agents-panel");
      agentsPanel.append(ctx.el("div", "wf-heading", t("agents")));
      for (const name of agents) {
        const field = ctx.el("div", "wf-role");
        const label = ctx.el("label", "wf-role-label", name);
        const dot = ctx.el("span", "agent-dot");
        dot.style.background = nodeColor(name);
        label.prepend(dot);
        field.append(label);
        const defaults = specDefaultsFor(specs, name);
        const locale = ctx.i18n.locale;

        /* Role：预设下拉 + 自定义输入（当前值不匹配任何预设时显示自定义） */
        field.append(ctx.el("label", "modal-label wf-sublabel", t("role")));
        const currentRole = model.roles[name] || "";
        const matched = matchPreset(currentRole);
        const roleSel = ctx.el("select", "wf-select wf-role-select");
        for (const preset of ROLE_PRESETS) {
          const opt = ctx.el("option", "", presetFor(preset, locale).label);
          opt.value = preset.id;
          if (matched && matched.id === preset.id) opt.selected = true;
          roleSel.append(opt);
        }
        const customOpt = ctx.el("option", "", t("custom"));
        customOpt.value = "__custom__";
        if (!matched) customOpt.selected = true;
        roleSel.append(customOpt);
        const customInput = ctx.el("input", "modal-input wf-role-custom");
        customInput.type = "text";
        customInput.placeholder = defaults.role
          ? `${t("default_prefix")} ${defaults.role}`
          : t("role_placeholder");
        customInput.value = matched ? "" : currentRole;
        customInput.hidden = Boolean(matched);
        customInput.addEventListener("input", () => {
          const text = customInput.value.trim();
          if (text) model.roles[name] = text;
          else delete model.roles[name];
        });
        roleSel.addEventListener("change", () => {
          if (roleSel.value === "__custom__") {
            customInput.hidden = false;
            customInput.focus();
            return;
          }
          const preset = ROLE_PRESETS.find((p) => p.id === roleSel.value);
          if (!preset) return;
          /* role 覆盖为预设值；goal/backstory 仅在为空时用模板预填 */
          const next = applyRolePreset(
            model.roles,
            model.goals,
            model.backstories,
            name,
            presetFor(preset, locale)
          );
          model.roles = next.roles;
          model.goals = next.goals;
          model.backstories = next.backstories;
          render();
        });
        field.append(roleSel, customInput);

        /* Goal → Backstory textarea；placeholder 优先显示 spec 默认人设 */
        const persona = (labelKey, pluralKey, singularKey) => {
          const group = ctx.el("div", "wf-rgb-field");
          const sub = ctx.el("label", "modal-label wf-sublabel", t(labelKey));
          const area = ctx.el("textarea", "modal-input wf-area");
          area.rows = 2;
          area.placeholder = defaults[singularKey]
            ? `${t("default_prefix")} ${defaults[singularKey]}`
            : t(`${singularKey}_placeholder`);
          area.value = model[pluralKey][name] || "";
          area.addEventListener("input", () => {
            const text = area.value.trim();
            if (text) model[pluralKey][name] = text;
            else delete model[pluralKey][name];
          });
          group.append(sub, area);
          field.append(group);
        };
        const roleGroup = ctx.el("div", "wf-rgb-field");
        roleGroup.append(ctx.el("label", "modal-label wf-sublabel", t("role")), roleSel, customInput);
        /* Role 也放进统一字段容器，三列布局不会让 textarea 互相覆盖。 */
        field.textContent = "";
        field.append(label, roleGroup);
        persona("goal", "goals", "goal");
        persona("backstory", "backstories", "backstory");
        agentsPanel.append(field);
      }
      modalBody.append(agentsPanel);
    }
  }

  async function save(close, btn) {
    const session = activeSession();
    if (!session) return;
    btn.disabled = true;
    try {
      await ctx.api.putWorkflow(session.id, {
        enabled: model.enabled,
        max_hops: model.max_hops,
        edges: model.edges,
        roles: model.roles,
        goals: model.goals,
        backstories: model.backstories,
        instructions: model.instructions,
      });
      ctx.toast(t("saved"));
      close();
    } catch (err) {
      ctx.toast(`${t("save")}：${err.message}`, true);
      btn.disabled = false;
    }
  }

  async function reset(btn) {
    const session = activeSession();
    if (!session) return;
    btn.disabled = true;
    try {
      await ctx.api.deleteWorkflow(session.id);
      model = normalizeWorkflow(null);
      render();
      ctx.toast(t("reset_done"));
    } catch (err) {
      ctx.toast(`${t("reset")}：${err.message}`, true);
    } finally {
      btn.disabled = false;
    }
  }

  async function load() {
    const session = activeSession();
    if (!session) return;
    try {
      /* 后端响应包一层 {"workflow": {...}}；同时拉 spec 默认人设用于 placeholder */
      const [data, specData] = await Promise.all([
        ctx.api.getWorkflow(session.id),
        ctx.api.listSpecs(),
      ]);
      model = normalizeWorkflow(data && data.workflow);
      specs = specData.specs || [];
    } catch {
      model = normalizeWorkflow(null);
    }
    render();
  }

  /* 模态框打开判定：容器仍挂在 DOM 上（关闭后 openModal 清空 modal-root） */
  const isModalOpen = () => modalBody !== null && modalBody.isConnected !== false;

  function openWorkflow() {
    ctx.openModal({
      title: t("title"),
      wide: true,
      build: (body) => {
        modalBody = body;
        body.className = `${body.className || "modal-body"} workflow-modal-body`;
        model = null;
        nodePos.clear(); // 重新打开时回到默认布局
        load();
      },
      actions: [
        { label: t("cancel"), onClick: (close) => close() },
        { label: t("reset"), onClick: async (close, btn) => reset(btn) },
        { label: t("save"), primary: true, onClick: (close, btn) => save(close, btn) },
      ],
    });
  }

  const btn = ctx.addHeaderButton({
    id: "toggle",
    title: t("toggle"),
    svgIcon: FLOW_SVG,
    onClick: openWorkflow,
  });

  ctx.on("session_active", () => {
    nodePos.clear(); // 换会话后旧坐标无意义
    if (isModalOpen()) load();
  });
  ctx.on("locale", () => {
    btn.title = t("toggle");
    btn.setAttribute("aria-label", t("toggle"));
    render();
  });
}
