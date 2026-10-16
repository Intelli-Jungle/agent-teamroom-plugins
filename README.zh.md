# Agent Teamroom 插件市场

**中文** | [English](README.md)

[Agent Teamroom](https://github.com/Intelli-Jungle/agent-teamroom) 的社区插件仓库——Teamroom 是一个本机多 Agent 聊天室，通过 Web UI / TUI 驱动各 CLI Agent（Claude Code、Kimi Code 等）。本仓库收集可直接装入 Teamroom 的三方插件。

## 插件是什么？

一个插件就是一个目录，不改核心代码即可接入 Teamroom：

```
plugins/<id>/
  plugin.toml      # 清单（必需）
  plugin.py        # 后端钩子（可选）：routers / on_message / prompt_extras
  web/
    index.js       # 前端入口（可选）：export function register(ctx)
    style.css      # 可选，存在时在 index.js 之后加载
```

完整钩子说明见主仓库的[插件架构文档](https://github.com/Intelli-Jungle/agent-teamroom/blob/main/docs/zh/plugins.md)。

## 插件列表

| ID | 名称 | 说明 |
| --- | --- | --- |
| [`msglog`](plugins/msglog/) | Message Log | 把每条消息追加到 `data/plugins/msglog/messages.jsonl`，并提供 `GET /api/msglog/recent?limit=N` 导出接口 |
| [`insights`](plugins/insights/) | Session Insights | 统计看板与提及流程图 |
| [`workflow`](plugins/workflow/) | Workflow | 按会话的有向工作流：边、角色、跳数上限 |

## 安装插件

用 Teamroom CLI（读取本仓库）：

```bash
teamroom plugins available        # 列出本仓库发布的插件
teamroom plugins install workflow  # 把 plugins/workflow/ 下载到你的 plugins/ 目录
```

也可以手动安装——插件就是一个目录：

```bash
git clone https://github.com/Intelli-Jungle/agent-teamroom-plugins.git
cp -r agent-teamroom-plugins/plugins/workflow /path/to/agent-teamroom/plugins/
```

或者不拷贝，直接在 `config.toml` 里指向本仓库检出：

```toml
[plugins]
extra_dirs = ["~/Work/agent-teamroom-plugins/plugins"]
```

也可以用 `TEAMROOM_PLUGINS_DIR` 环境变量。无论哪种方式，**重启服务器生效**（不热重载）。用 `python -m teamroom plugins` 验证发现结果——这是清单级扫描，不会执行插件代码。

卸载：删除目录，或把 id 加进 `[plugins].disabled`，或在它的 `plugin.toml` 里写 `enabled = false`。

## 贡献指南

欢迎 PR。一个 PR 一个插件，放在 `plugins/<id>/`。

### 结构要求

- `plugin.toml` **必需**，字段齐全：`id`（必须与目录名一致，`[A-Za-z0-9_-]+`）、`name`、`version`、`description`、`enabled`
- `plugin.py` 可选；`web/index.js`（+ 可选 `web/style.css`）可选——可以只做后端，但不能只做前端（没有 `plugin.toml` 无法被发现）

### 后端要求

- `plugin.py` 只暴露一个入口：`register(ctx) -> dict`，返回键任选：`routers`（FastAPI `APIRouter`）、`on_message(state, session, msg, mentioned)`、`prompt_extras(session, agent_name) -> list[str]`
- 所有持久化写 `ctx.data_dir`（`data/plugins/<id>/`）——绝不碰核心 schema（`sessions.json`、会话 JSONL）
- `on_message` 在落盘路径上同步执行：必须廉价（只追加/入队，不走网络）
- 路由自带插件域名前缀（如 `/api/msglog/...`），鉴权用标准 `require_token` 依赖（`teamroom.server.api`）
- 不引入主仓库 `requirements.txt` 之外的新依赖
- 宿主会隔离钩子异常，但插件自身也要做到：状态文件损坏时不至于每条消息都崩一次

### 前端要求

- `web/index.js` 导出 `register(ctx)`；ctx 可用面：`store`、`api`、`i18n`、`toast`、`el(tag, cls, text)`、`on(event, fn)`、`pluginLocale(strings)`、`addHeaderButton({id, title, svgIcon, onClick})`、`openModal({title, build, actions, wide})`
- 用户可见文案走 `ctx.pluginLocale({en: {...}, "zh-CN": {...}})`（中英双语）
- 样式用宿主 CSS 变量（`--border`、`--text-faint`……）以适配明暗双主题——参考 `plugins/workflow/web/style.css`
- 优先用 `ctx.openModal`，不要自建 aside 面板
- 所有 CSS 类名加插件 id 前缀（如 `.workflow-...`）

### 跑测试

插件测试在 `tests/` 下，import 主仓库的 `teamroom` 包。用 `TEAMROOM_REPO` 环境变量指向主仓库的本地检出（缺省取与本仓库同级的 `agent-teamroom` 目录），并用主仓库的虚拟环境跑 pytest：

```bash
TEAMROOM_REPO=/path/to/agent-teamroom /path/to/agent-teamroom/.venv/bin/python -m pytest tests/ -q
```

### 提 PR 前自查

- `python -m teamroom plugins` 能列出你的插件且状态为 `enabled` 无错误
- 用主仓库干净检出实测插件可加载、功能正常
- 同步更新两个 README 的"插件列表"表格

## 许可证

Apache License 2.0，与主仓库一致。见 [LICENSE](LICENSE)。
