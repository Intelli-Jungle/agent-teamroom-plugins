# Agent Teamroom Plugins

[中文](README.zh.md) | **English**

Community plugin registry for [Agent Teamroom](https://github.com/Intelli-Jungle/agent-teamroom) — a localhost multi-agent chat room that drives CLI agents (Claude Code, Kimi Code, etc.) through a web UI and TUI. This repository collects third-party plugins you can drop into your Teamroom installation.

## What is a plugin?

A plugin is a single directory that hooks into Teamroom without touching core code:

```
plugins/<id>/
  plugin.toml      # manifest (required)
  plugin.py        # backend hooks (optional): routers / on_message / prompt_extras
  web/
    index.js       # frontend entry (optional): export function register(ctx)
    style.css      # optional, loaded after index.js when present
```

See the [plugin architecture doc](https://github.com/Intelli-Jungle/agent-teamroom/blob/main/docs/plugins.md) in the main repository for the full hook reference.

## Available plugins

| ID | Name | Description |
| --- | --- | --- |
| [`hello`](plugins/hello/) | Hello | Minimal example / starter template: greeting prompt line, per-session message counter, header button with a host modal |
| [`msglog`](plugins/msglog/) | Message Log | Appends every message to `data/plugins/msglog/messages.jsonl` and exposes a `GET /api/msglog/recent?limit=N` export endpoint |

## Installing a plugin

With the Teamroom CLI (talks to this registry):

```bash
teamroom plugins available        # list plugins published here
teamroom plugins install hello    # download plugins/hello/ into your plugins/ directory
```

Manual install works too — a plugin is just a directory:

```bash
git clone https://github.com/Intelli-Jungle/agent-teamroom-plugins.git
cp -r agent-teamroom-plugins/plugins/hello /path/to/agent-teamroom/plugins/
```

Or point Teamroom at a checkout without copying anything, via `config.toml`:

```toml
[plugins]
extra_dirs = ["~/Work/agent-teamroom-plugins/plugins"]
```

`TEAMROOM_PLUGINS_DIR` also works. Either way, **restart the server** to pick up changes (no hot reload). Verify discovery with `python -m teamroom plugins` — a manifest-level scan that never executes plugin code.

To uninstall: delete the directory, add the id to `[plugins].disabled`, or set `enabled = false` in its `plugin.toml`.

## Contributing

Pull requests welcome. One plugin per PR, in `plugins/<id>/`.

### Structure

- `plugin.toml` **required**, with all of: `id` (must equal the directory name, `[A-Za-z0-9_-]+`), `name`, `version`, `description`, `enabled`
- `plugin.py` optional; `web/index.js` (+ optional `web/style.css`) optional — a plugin may be backend-only, but not frontend-only (the frontend needs `plugin.toml` to be discovered)
- Reserved ids: `insights`, `workflow` (bundled with the main repo). Pick something else

### Backend rules

- `plugin.py` exposes exactly one entry point: `register(ctx) -> dict`, returning any of `routers` (FastAPI `APIRouter`s), `on_message(state, session, msg, mentioned)`, `prompt_extras(session, agent_name) -> list[str]`
- Use `ctx.data_dir` (`data/plugins/<id>/`) for all persistence — never touch core schemas (`sessions.json`, session JSONL)
- `on_message` runs synchronously on the persist path: keep it cheap (append/enqueue only, no network)
- Prefix routes with your plugin's own domain (e.g. `/api/msglog/...`) and guard them with the standard `require_token` dependency (`teamroom.server.api`)
- No new third-party dependencies beyond what the main repo already requires (`requirements.txt`)
- Hook exceptions are isolated by the host, but write your plugin so a broken state file doesn't crash it on every message

### Frontend rules

- `web/index.js` exports `register(ctx)`; available ctx surface: `store`, `api`, `i18n`, `toast`, `el(tag, cls, text)`, `on(event, fn)`, `pluginLocale(strings)`, `addHeaderButton({id, title, svgIcon, onClick})`, `openModal({title, build, actions, wide})`
- Use `ctx.pluginLocale({en: {...}, "zh-CN": {...}})` for user-facing strings (both locales)
- Use host CSS variables (`--border`, `--text-faint`, ...) so both themes work — see `plugins/hello/web/style.css`
- Prefer `ctx.openModal` over building your own panel
- Scope every CSS class with your plugin id prefix (e.g. `.hello-...`)

### Before opening the PR

- `python -m teamroom plugins` lists your plugin as `enabled` with no error
- The plugin loads and works against a fresh main-repo checkout
- Update the "Available plugins" table in both READMEs

## License

Apache License 2.0, same as the main repository. See [LICENSE](LICENSE).
