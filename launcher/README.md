# @agent/launcher

Philont's **supervisor** (a long-lived management process). It is the foundation of the "browser + small launcher" packaging form:

- serves the control-plane API + the bundled web-ui on `PHILONT_LAUNCHER_PORT` (default **20267**);
- reads/writes the authoritative config file `~/.philont/.env` (masks secrets, preserves user comments);
- **starts / stops / restarts** the agent server (`@agent/server`) as a child process, with automatic backoff-and-relaunch on crash;
- on startup: if configured (an `ANTHROPIC_API_KEY` is present) → launch the agent; otherwise it stays in "awaiting configuration" until the front end fills it in.

The launcher outlives the agent, which is what makes "edit the config, one-click restart" work — a restart just kills and relaunches the child process; the config page never drops.

## Run

```bash
cd launcher
npm install
npm run dev      # tsx src/index.ts (development)
# or: npm run build && npm start
```

Open `http://localhost:20267`. On first run with no key, it prompts you to configure via the web-ui (the settings panel; see Phase 2).

## Control-plane API

| Method | Path | Description |
|------|------|------|
| GET  | `/api/launcher/status`  | agent runtime state: state / pid / port / uptime / recentLogs / configured |
| GET  | `/api/launcher/config`  | current config (secrets masked as `••••last4`) |
| PUT  | `/api/launcher/config`  | write config `{values:{KEY:val}}`; a returned masked value is skipped (does not overwrite the real secret); a validation failure returns 400 |
| POST | `/api/launcher/start`   | start the agent (returns 409 if not configured) |
| POST | `/api/launcher/stop`    | graceful stop (SIGTERM, then SIGKILL on timeout) |
| POST | `/api/launcher/restart` | stop → start (called after a config change) |
| GET  | `/api/launcher/logs`    | the agent's recent logs |

## Environment variables (all optional, with sensible defaults)

| Variable | Default | Description |
|------|------|------|
| `PHILONT_LAUNCHER_PORT` | `20267` | the launcher's own port |
| `PHILONT_HOME`          | `~/.philont` | config + runtime data directory |
| `PHILONT_ENV_FILE`      | `$PHILONT_HOME/.env` | authoritative config file; the launcher injects it when spawning the agent, and the agent's load-env reads from it |
| `PHILONT_SERVER_DIR`    | `../server` | the agent server package directory (overridable after packaging) |
| `PHILONT_WEBUI_DIR`     | `../web-ui/dist` | the web-ui build output directory |
| `PHILONT_NO_OPEN` / `PHILONT_OPEN_BROWSER=0` | — | disable auto-opening the browser on startup |
| `PHILONT_DESKTOP_SHORTCUT=0` | — | disable creating a desktop / app-menu shortcut |

## Contract with the agent server

When the launcher spawns the agent: `cwd = serverDir` (for module resolution), and it injects `PHILONT_ENV_FILE` and `PHILONT_PORT`. The agent's `server/src/load-env.ts` honors `PHILONT_ENV_FILE` → reads `~/.philont/.env`; when unset it falls back to the original "read cwd/.env" behavior, so the plain `tsx src/index.ts` development flow is unaffected.

## Status (2026-06)

- Phase 1 ✓ control plane + process supervision + config read/write + validation.
- Phase 2 ✓ web-ui settings panel + first-run wizard + status light/restart + same-origin/LAN address resolution.
- Phase 3 ✓ auto-open the browser on startup (skipped in headless) + desktop/app-menu shortcut (created once).
  System tray is **deferred to Phase 4**: it needs a cross-platform native helper (a systray library has to bundle a Go/native binary), and it can't be verified in a headless environment, so for now "shortcut + auto-open" covers discoverability.
- Phase 4 (in progress):
  - ✓ optional-capability detection (`GET /api/launcher/capabilities`: python/z3/playwright) + display in the settings panel's "System" section.
  - ✓ start-on-boot (`GET|POST /api/launcher/autostart`: linux XDG / mac LaunchAgent / win Startup folder) + a panel toggle.
  - ✓ assembly script `scripts/assemble.mjs` (build + stage to dist-app, ~14M app layer).
  - ✓ packaging-strategy doc `../PACKAGING.md` (incl. the decision to keep optional capabilities like z3 out of the base package).
  - Pending real-hardware testing: per-platform installers (NSIS/.pkg/AppImage) + system tray (needs a native helper) + uninstaller.

See `../PACKAGING.md` for the packaging-form conventions.
