/* Hello 插件前端入口：会话头部加一个按钮，点击弹出宿主模态框，
   显示"本 session 消息数"（数据来自插件自己的后端 GET /api/sessions/{id}/hello）。

   由宿主 web/js/plugins.js 在启动时动态 import 并调用 register(ctx)。
   ctx 可用面：store / api / i18n / toast / el / on / pluginLocale /
   addHeaderButton / openModal。 */

/* 插件自己的后端路由不在宿主 ctx.api 的固定方法表里，需要直连 fetch。
   宿主 api.js 是 ES 模块单例（同 URL 共享实例），import getToken 即可拿到
   宿主已设置的会话令牌，与核心 API 走同一鉴权。 */
import { getToken } from "../../static/js/api.js";

/* 用户可见文案：中英双语，宿主按当前语言取，缺语言回退 en。 */
const STRINGS = {
  en: {
    button: "Hello plugin",
    title: "Hello",
    loading: "Loading…",
    no_session: "Open a session first.",
    count_line: "chat messages in this session (counted by the hello plugin)",
    error: "Failed to load",
    close: "Close",
  },
  "zh-CN": {
    button: "Hello 插件",
    title: "Hello",
    loading: "加载中……",
    no_session: "先打开一个会话。",
    count_line: "条聊天消息（hello 插件计数）",
    error: "加载失败",
    close: "关闭",
  },
};

/* 头部按钮图标（SVG 字符串，宿主原样塞进按钮 innerHTML）。 */
const HELLO_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

/* 带鉴权头的 GET 封装：请求插件自己的后端路由。 */
async function apiGet(path) {
  const res = await fetch(path, { headers: { "X-Session-Token": getToken() } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function register(ctx) {
  /* 文案函数：t("title")、t("error") 等；变量插值用 t(key, {name: ...})。 */
  const t = ctx.pluginLocale(STRINGS);

  function openHello() {
    /* 当前激活会话 id 从宿主 store 取；没开会话就 toast 提示。 */
    const sessionId = ctx.store.state.activeSessionId;
    if (!sessionId) {
      ctx.toast(t("no_session"), true);
      return;
    }
    /* 优先用宿主 openModal（与 schedule 对话框同款样式），不要自建面板。 */
    ctx.openModal({
      title: t("title"),
      build: (body) => {
        body.append(ctx.el("p", "hello-loading", t("loading")));
        apiGet(`/api/sessions/${sessionId}/hello`)
          .then((data) => {
            body.textContent = "";
            body.append(
              ctx.el("div", "hello-count", String(data.messages || 0)),
              ctx.el("p", "hello-desc", t("count_line"))
            );
          })
          .catch((err) => {
            body.textContent = "";
            body.append(ctx.el("p", "hello-error", `${t("error")}：${err.message}`));
          });
      },
      actions: [{ label: t("close"), onClick: (close) => close() }],
    });
  }

  /* 在会话头部按钮区加图标按钮（宿主插在 Manage session 之前）。 */
  const btn = ctx.addHeaderButton({
    id: "hello",
    title: t("button"),
    svgIcon: HELLO_SVG,
    onClick: openHello,
  });

  /* 语言切换时刷新按钮提示文字（模态框内的文案下次打开时重建）。 */
  ctx.on("locale", () => {
    btn.title = t("button");
    btn.setAttribute("aria-label", t("button"));
  });
}
