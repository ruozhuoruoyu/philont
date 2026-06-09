# philont

**philont: the being-agent.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Runtime: Node ≥ 20](https://img.shields.io/badge/runtime-Node%20%E2%89%A5%2020-green.svg)](#quick-start)
[![Status: developer preview](https://img.shields.io/badge/status-developer%20preview-orange.svg)](#status)
[![Bring your own model](https://img.shields.io/badge/LLM-bring%20your%20own-7c3aed.svg)](#configuration)
[![~100× cheaper](https://img.shields.io/badge/cost-~100%C3%97%20cheaper%20per%20token-16a34a.svg)](#why-a-cheap-model-is-enough)

philont is a self-hostable AI agent that has personality, drives its own learning, and reasons through hard problems step by step. Most open-source agents — OpenClaw, Hermes, and the rest — are **task runners**: you hand them a job, they execute it, they stop. philont is built to be something else: a **being** — an agent with an independent character, intrinsic curiosity, and a compulsion to understand before it acts. It grows with every session, teaches itself from failure, and never pretends to have succeeded when it hasn't.

And because its intelligence lives in the **architecture, not the model**, philont runs sophisticated, fully autonomous work on a model that costs a fraction of the frontier — typically **~100× cheaper per token** than agents that depend on a top-tier model. See [Why a cheap model is enough](#why-a-cheap-model-is-enough).

---

## Why philont is different from OpenClaw and Hermes

The open-source agent field competes on cost-per-token, tool count, and integration breadth. philont competes on a different axis: **what the agent actually is**, and **what it costs to run it well**.

| | OpenClaw | Hermes | **philont** |
|---|:---:|:---:|:---:|
| Core model | extrinsic task runner | task runner + learning loop | **autonomous being with intrinsic drives** |
| Acts on its own initiative | ❌ | ⚠️ scheduled cron | ✅ curiosity · pursuit · commitment drives |
| Self-learning from failure | ❌ | ✅ | ✅ **+ honesty gates against pretended success** |
| Step-by-step deep reasoning | ❌ | ❌ | ✅ `deep_explore` conjecture loop |
| Built-in permission / audit layer | command allowlist | command approval | ✅ 3×4 capability matrix · validator chain · SHA-256 audit log |
| Runs complex tasks on a **cheap** model | needs a strong model | needs a strong model | ✅ **DeepSeek V4 Flash — ~100× cheaper** |
| BYOK / model freedom | ✅ | ✅ | ✅ |
| Persistent cross-session memory | ✅ | ✅ | ✅ 5-layer (timeline · actions · FTS notes · facts · skills) |
| Lives across channels (WeChat / Telegram / …) | ✅ | ✅ | ✅ |

OpenClaw and Hermes are excellent at *doing what you ask*. philont is built to *want things, reason about them, and stay honest* — and to do it on hardware-store-cheap inference.

### Why a cheap model is enough

Other agents push complex reasoning, planning, and memory **into the prompt**, so they need a frontier model (Claude Opus, GPT-class) to hold it all together every turn — and they pay frontier prices for every token.

philont moves that work **into the runtime**. A kernel-style separation puts the heavy lifting in the **policy layer** — multi-step deep-reasoning loops, 5-layer persistent memory, self-learning, and honesty gates — while the model is only ever asked to take the *next* step. The intelligence comes from the architecture, not from the size of the model behind the API.

The result: tasks that would otherwise demand a frontier model run comfortably on **DeepSeek V4 Flash** — roughly **100× cheaper per token**. Where token-efficiency-focused agents shave ~1.5–3× off the bill by trimming the harness, philont changes the model class entirely. And it's still BYOK: point it at Claude or GPT when you want maximum ceiling, drop to Flash when you want maximum economy.

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
| **Permission layer** | Every tool call is checked against a 3×4 capability matrix (read/write/execute × local/network/system/self): external writes and command execution require explicit per-capability approval, and a SHA-256-chained audit log records everything. A validator chain adds a sensitive-path denylist (blocks tool reads/writes to `~/.ssh`, `.env`, `/etc/shadow`, …) and hard-denies catastrophic shell commands (`rm -rf /`, `mkfs`, `dd`, fork bombs, secret-exfil pipes). Boundary-crossing actions are gated and audited — see **[SECURITY-DESIGN.md](SECURITY-DESIGN.md)** for exactly what is and isn't enforced today (SSRF allowlisting and OS sandboxing are on the roadmap, not yet shipped). |
| **Conscience gate (optional)** | Off by default. When enabled, every outbound message to a person (WeChat/Telegram) is first judged by one LLM call against a short no-harm constitution — defamation, doxxing, disinformation, harm-enabling instructions — before it's sent. Fail-open by design: a judge error never blocks a reply. |
| **5-layer persistent memory** | SQLite-backed raw timeline, action log, full-text-search notes (FTS5), structured facts, and learned skills — all cross-session. The agent remembers. |
| **Idle-time autonomy** | When you're not talking to it, philont runs a budgeted autonomous loop: proactive research, gap-filling, self-review — under a hard daily token ceiling. |
| **MCP bridge & plugins** | Mount any MCP server (browser automation, code execution, external APIs) or load sandboxed third-party plugins. Playwright MCP gives it a full browser. |
| **Lives where you are** | One server process drives a Lit Web UI, WeChat, Telegram, and a headless CLI. |
| **Mechanism, not policy** | Inspired by OS kernel design: philont's core defines *how* tools execute and how policy is enforced — not *which* tools exist or what they do. Complex capabilities (self-learning, deep reasoning, memory) live entirely in the policy/userspace layer, not in the model. This is what lets a cost-efficient model like DeepSeek V4 Flash handle work that would otherwise demand a frontier model — see [Why a cheap model is enough](#why-a-cheap-model-is-enough). |
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
| `PHILONT_CONSCIENCE_GATE` | off | LLM safety check on each outbound human-facing message (fail-open; adds one LLM call/reply when on). |
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

## Acknowledgements

philont stands on the shoulders of two open-source agents we genuinely admire — and the comparison earlier in this README is about *positioning*, not disparagement. We studied both closely and are better for it. Where we adapted their work, the borrowing is credited inline in the source with a `Reference:` comment (the convention is documented in [CONTRIBUTING.md](CONTRIBUTING.md)); the list below is not exhaustive.

**[Hermes Agent](https://github.com/NousResearch/hermes-agent) — Nous Research.** We owe Hermes a real debt:
- the dangerous-command pattern set in our permission layer is derived from Hermes' `tools/approval.py` → `agent-policy/src/validators/dangerousCommands.ts`;
- our WeChat bridge — login state machine, message extraction, and the lenient decrypt variant — follows the Hermes WeChat adapter → `server/src/channels/wechat/*`;
- our Telegram gateway approach is informed by Hermes' Telegram platform → `server/src/channels/telegram/client.ts`;
- our tool-call parser handles the `<tool_call>` tag format used by Hermes / Nous models → `server/src/llm-adapter.ts`.

**OpenClaw.** We learned from OpenClaw too:
- our path-ACL workspace-root resolution is modeled on OpenClaw's `media-tool-shared.ts` → `agent-policy/src/validators/pathAcl.ts`;
- philont's skills loader is **compatible with the OpenClaw / `clawhub` skill convention** (`<workdir>/skills/`), so skills installed the OpenClaw way work in philont unchanged → `agent-tools/src/skills/loader.ts`.

We also reference [Claude Code](https://claude.com/claude-code)'s WebFetch design and several research papers (FunSearch, LATS, Self-Consistency, …) in the deep-reasoning module; those are credited inline where used. Thank you to all of these projects and their authors.

---

## License

MIT — see [LICENSE](LICENSE).

Built by [xiaozhou ye](https://github.com/ruozhuoruoyu).
