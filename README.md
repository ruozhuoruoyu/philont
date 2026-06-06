# philont

**philont: the being-agent.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Runtime: Node ≥ 20](https://img.shields.io/badge/runtime-Node%20%E2%89%A5%2020-green.svg)](#quick-start)
[![Status: developer preview](https://img.shields.io/badge/status-developer%20preview-orange.svg)](#status)
[![Bring your own model](https://img.shields.io/badge/LLM-bring%20your%20own-7c3aed.svg)](#configuration)

philont is a self-hostable AI agent that has personality, drives its own learning, and reasons through hard problems step by step. It is not a chatbot wrapper or an automation framework. It is a **being** — an agent with an independent character, intrinsic curiosity, and a compulsion to understand before it acts. It grows with every session, teaches itself from failure, and never pretends to have succeeded when it hasn't.

---

## What makes it a being

| | |
|---|---|
| **Independent personality** | philont carries a persistent character across every conversation — not a system-prompt trick, but a live identity shaped by what it has learned, the values it holds, and the person it knows you to be. It pushes back when something conflicts with its principles. |
| **Intrinsic drives** | Most agents are purely *extrinsically driven* — they wait for a task, execute it, and stop. philont is different: built-in drives give it goals of its own. A **curiosity engine** scans its memory for knowledge gaps and proactively researches them at idle time. A **pursuit driver** advances stalled long-term goals without being asked. A **task-commitment drive** detects when it's about to give up on a tool-reachable problem and pushes back on itself first. It acts because it wants to, not only because you told it to. |
| **Self-learning evolution** | Every failure matters. When philont hits a wall, it doesn't quietly move on — it writes an honest failure note, distils a rule, and crystallises a reusable skill. Skills carry maturity grades and confidence decay; knowledge evolves instead of accumulating unchecked. |
| **Deep exploration** | Hard problems get the `deep_explore` treatment: a multi-step conjecture loop that decomposes the question, attacks sub-problems independently, and reasons through contradictions before committing to an answer. |

---

## What it does

| | |
|---|---|
| **Honesty guardrails** | Gates catch pretended success, fabricated numbers, and half-finished hand-offs — and force an honest regeneration. You can't learn from a failure you pretended didn't happen. |
| **Permission layer** | Every tool call passes through a 3×4 capability matrix (read/write/execute × local/network/system/self), a validator chain (path ACLs, SSRF, dangerous-command and secret-leak detection), and a SHA-256-chained audit log. Nothing runs without authorisation. |
| **5-layer persistent memory** | SQLite-backed raw timeline, action log, full-text-search notes (FTS5), structured facts, and learned skills — all cross-session. The agent remembers. |
| **Idle-time autonomy** | When you're not talking to it, philont runs a budgeted autonomous loop: proactive research, gap-filling, self-review — under a hard daily token ceiling. |
| **MCP bridge & plugins** | Mount any MCP server (browser automation, code execution, external APIs) or load sandboxed third-party plugins. Playwright MCP gives it a full browser. |
| **Lives where you are** | One server process drives a Lit Web UI, WeChat, Telegram, and a headless CLI. |
| **Mechanism, not policy** | Inspired by OS kernel design: philont's core defines *how* tools execute and how policy is enforced — not *which* tools exist or what they do. This clean separation means complex capabilities (self-learning, deep reasoning, memory) live entirely in the policy/userspace layer, not in the model. A cost-efficient model like DeepSeek V4 Flash can handle sophisticated tasks that would otherwise require a much more expensive frontier model — the intelligence comes from the architecture, not the API bill. |
| **Bring your own model** | Any Anthropic- or OpenAI-compatible endpoint: Claude, DeepSeek, GLM, Kimi, MiniMax, Gemini, or your own. Switch with a config change — no code edits, no lock-in. |

---

## Quick start

> **Platform status:** Developed and tested on **Windows only**. macOS and Linux have not been tested by the author — the runtime is cross-platform in principle, but rough edges are expected. If you run philont on macOS or Linux and hit issues (or get it working), please open an issue or PR.

> **Prerequisites:** Node.js ≥ 20 and an Anthropic- or OpenAI-compatible API key.
> No Rust toolchain needed — the runtime is pure TypeScript.

```bash
git clone https://github.com/ruozhuoruoyu/philont.git
cd philont

# Build everything and start.
# The launcher opens your browser to a setup wizard, then supervises the agent.
./scripts/start.sh            # Windows: .\scripts\start.ps1
```

Or step by step:

```bash
./scripts/build-all.sh        # Windows: .\scripts\build-all.ps1
cp .env.example .env          # add your API key
(cd server && npm run dev)    # agent server  → http://localhost:20266
(cd web-ui && npm run dev)    # web UI        → http://localhost:5173
```

Open **http://localhost:5173**. The **Memory** tab shows the facts, skills, and notes philont builds as you talk to it.

For Docker and production deployment (reverse proxy, auth, TLS), see **[DEPLOYMENT.md](DEPLOYMENT.md)**.

---

## Configuration

Everything is configured via environment variables (`.env` in the repo root, or the launcher's setup wizard). See **[.env.example](.env.example)** for the fully annotated list.

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Main model key (required for the default provider). |
| `ANTHROPIC_MODEL` | current Claude | Model id. |
| `LLM_PROVIDER` | `anthropic` | `anthropic` \| `openai` \| `glm` \| `kimi` \| `minimax` \| `gemini`. |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | — | Any OpenAI-compatible endpoint (DeepSeek, Together, local, …). |
| `PHILONT_MCP_BROWSER` | off | Browser automation via Playwright MCP. |
| `PHILONT_DEEP_EXPLORE` | on | Multi-step deep reasoning tool. |
| `PHILONT_AUTONOMOUS` / `PHILONT_AUTONOMOUS_DAILY_TOKENS` | on / `20000` | Idle-time autonomous loop and its daily token ceiling. |
| `MEMORY_DB_PATH` | `~/.philont/memory/memory.sqlite` | SQLite memory database path. |
| `PHILONT_PORT` | `20266` | Server port. |
| `PHILONT_PROXY` / `HTTPS_PROXY` | — | Global outbound proxy for all fetch traffic. |
| `TELEGRAM_ENABLED` / `WECHAT_ENABLED` | off | Messaging channel gateways. |

> ⚠️ The Web UI ships without authentication and binds to localhost. Do not expose the port to the internet — put a reverse proxy with auth and TLS in front. See [DEPLOYMENT.md](DEPLOYMENT.md#production-hardening).

---

## Channels

philont runs one server that drives all interfaces simultaneously. Channels are independent — enable any combination. All channel settings are configured from the **Settings** panel in the Web UI.

### Web UI (default)

No configuration needed. Open **http://localhost:5173** after starting the server, or let the launcher open it automatically. Provides chat, memory browsing, and the autonomy dashboard.

### Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Open the Web UI → **Settings → Channels**, enable Telegram, and paste the token.
3. Set DM and group access policies (allowlist is the safe default) and add allowed user/group IDs.
4. Save and restart — send the bot a message to verify.

> If `api.telegram.org` is blocked in your region, set `TELEGRAM_PROXY` in Settings → Advanced to route only Telegram traffic through a proxy.

### WeChat

philont connects to WeChat via an iLink Bot bridge (web-protocol login — no WeCom or API account needed).

1. Scan in from the command line (one-time; state persists across restarts):

```bash
(cd server && npm run wechat:login)
# Opens a URL — open it in a browser and scan the QR code with WeChat.
```

2. Open the Web UI → **Settings → Channels**, enable WeChat, and configure DM and group access policies.
3. Save and restart. Re-run `wechat:login` only if the session expires.

---

## Repository layout

```
philont/
├── agent-policy/   Permission matrix, validator chain, SHA-256 audit log, grant store.
├── agent-tools/    Built-in tools (fs, shell, network, git, vision, …) + SKILL.md loader.
├── agent-mcp/      MCP bridge — mounts external MCP servers as native tools.
├── agent-plugins/  Third-party plugin discovery and sandboxed loading.
├── agent-memory/   5-layer memory, self-learning loop, autonomy drives.
├── server/         HTTP + WebSocket server; WeChat / Telegram gateways.
├── web-ui/         Lit-based Web UI (chat · memory · autonomy).
├── launcher/       Supervisor: setup wizard + process management.
└── demo/           End-to-end demos.
```

Build order: `agent-policy → agent-tools → agent-mcp → agent-plugins → agent-memory → server / web-ui / launcher`.
`scripts/build-all.{sh,ps1}` handles this.

---

## Testing

```bash
# One package
cd agent-tools && npm test

# All TypeScript packages
for pkg in agent-policy agent-memory agent-tools agent-mcp agent-plugins; do
  echo "== $pkg =="; (cd "$pkg" && npm test 2>&1 | tail -5)
done
```

---

## Status

**Developer preview (v0.x).** Core features are implemented and covered by tests; production hardening (sandbox stress/escape testing, cross-platform binaries) is in progress. Good for research, experimentation, and self-hosted personal assistants — not yet for unattended production workloads.

**Roadmap (selected)**
- Additional autonomy drivers and write-capable autonomous actions (behind stricter budget + audit).
- English-first prompts and a locale layer.
- npm / Docker publishing and continuous integration.

---

## Contributing

Issues and pull requests are welcome. See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the build/test workflow and **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** for community expectations. Security issues go to **[SECURITY.md](SECURITY.md)** — not a public issue.

---

## License

MIT — see [LICENSE](LICENSE).

Built by [xiaozhou ye](https://github.com/ruozhuoruoyu).
