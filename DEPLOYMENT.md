# Deploying Philont

This guide covers three ways to run Philont:

1. [**Local from source**](#1-local-from-source) — the normal development and self-hosting path.
2. [**Docker**](#2-docker) — a single container running the agent server.
3. [**Production hardening**](#production-hardening) — what to add before exposing it to anyone but yourself.

> **TL;DR:** Node.js ≥ 20, copy `.env.example` → `.env`, set one API key, run
> `./scripts/start.sh`. No Rust toolchain required — the runtime is pure
> TypeScript. The Rust crates (`agent-core`, `agent-node`) are dormant and are
> **not** part of the build or runtime.

---

## 1. Local from source

### Prerequisites

| Component | Version | Why |
| --- | --- | --- |
| **Node.js** | ≥ 20 | Runs the entire TypeScript runtime. |
| **npm** | ≥ 10 | Package management. |
| **C toolchain** | `build-essential` / Xcode CLT / MSVC | Compiles the `better-sqlite3` native module during `npm install`. |
| **API key** | — | An Anthropic- or OpenAI-compatible key (or run with `LLM_PROVIDER=mock` for a no-key smoke test). |

Install a C toolchain if you don't have one:

```bash
# Debian/Ubuntu
sudo apt-get install -y build-essential python3
# macOS
xcode-select --install
# Windows: install "Visual Studio Build Tools" with the Desktop C++ workload
```

### The one-command path

```bash
git clone https://github.com/<your-org>/philont.git
cd philont
cp .env.example .env          # then edit .env and set ANTHROPIC_API_KEY
./scripts/start.sh            # Windows: .\scripts\start.ps1
```

`start.sh` builds every package in dependency order, starts the launcher, and
opens your browser to the setup wizard. From there the launcher supervises the
server and Web UI.

### The manual path (more control)

Build in dependency order (the script `scripts/build-all.sh` automates exactly this):

```
agent-policy → agent-tools → agent-mcp → agent-plugins → agent-memory → server / web-ui / launcher
```

```bash
./scripts/build-all.sh        # Windows: .\scripts\build-all.ps1

# Run the two long-lived processes in separate shells:
(cd server && npm run dev)    # HTTP + WebSocket  → http://localhost:20266
(cd web-ui && npm run dev)    # Vite dev server   → http://localhost:5173
```

Open **http://localhost:5173**.

### Optional: seed sample data

To see the memory dashboard populated before you've chatted:

```bash
# Linux/macOS
(cd server && MEMORY_DB_PATH=./memory.sqlite npx tsx scripts/seed-memory.ts)
# Windows PowerShell
cd server; $env:MEMORY_DB_PATH=".\memory.sqlite"; npx tsx scripts\seed-memory.ts
```

### No-key smoke test

Philont runs without any API key in mock mode — useful for verifying the build:

```bash
(cd server && LLM_PROVIDER=mock MEMORY_DB_PATH=./memory.sqlite npm run dev)
```

Chat replies will be placeholder strings, but every other subsystem (memory,
policy, dashboards, HTTP API) works normally.

---

## 2. Docker

A `Dockerfile` is included that builds the full stack into one image and runs the
server.

```bash
# Build
docker build -t philont .

# Run (long-lived server, state persisted in a named volume)
docker run -d --name philont \
  -p 20266:20266 \
  -v philont-state:/root/.philont \
  -e LLM_PROVIDER=anthropic \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  philont
```

Then point a browser/proxy at the server on port `20266`.

Notes:

- **State** lives under `/root/.philont` (memory DB, skills, credentials). Mount a
  volume there to persist it across container restarts.
- **Behind a region-restricted network?** Pass a pip mirror at build time:
  `docker build --build-arg PIP_INDEX_URL=https://pypi.org/simple/ .`
- **Headless / single-task** runs are supported by overriding the command:
  `docker run --rm -v "$PWD/ws:/ws" -e ... philont npm run headless -- --task "…" --workspace /ws`.
- The image is single-stage and bundles a document/media toolchain (poppler,
  ffmpeg, common Python libs) so the agent's file tools work out of the box. A
  slimmer multi-stage runtime image is on the roadmap.

A `docker-compose.yml` is not shipped yet; a minimal one looks like:

```yaml
services:
  philont:
    build: .
    ports: ["20266:20266"]
    volumes: ["philont-state:/root/.philont"]
    environment:
      LLM_PROVIDER: anthropic
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
    restart: unless-stopped
volumes:
  philont-state:
```

---

## Configuration

All configuration is via environment variables. Copy `.env.example` (fully
annotated) to `.env`. The essentials:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | Main model key (required unless using another provider or `mock`). |
| `ANTHROPIC_MODEL` | current Claude | Main model id. |
| `LLM_PROVIDER` | `anthropic` | `anthropic` \| `openai` \| `glm` \| `kimi` \| `minimax` \| `gemini` \| `mock`. |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | — | Any OpenAI-compatible endpoint. |
| `MEMORY_DB_PATH` | `~/.philont/memory/memory.sqlite` | SQLite memory database. |
| `PHILONT_PORT` | `20266` | Server HTTP + WebSocket port. |
| `PHILONT_AUTONOMOUS` | `1` | Idle-time autonomous loop on/off. |
| `PHILONT_AUTONOMOUS_DAILY_TOKENS` | `20000` | Daily token ceiling for the autonomous loop. |
| `PHILONT_PROXY` / `HTTPS_PROXY` | — | Global outbound proxy for all fetch traffic. |
| `AGENT_TIMEZONE` | system | IANA timezone for scheduling/display. |

See `.env.example` for vision, MCP/browser, deep-reasoning, and channel
(Telegram/WeChat) settings.

---

## Production hardening

Philont is built for **single-user, self-hosted** use. Before exposing it beyond
localhost, treat the following as required, not optional:

1. **Add authentication and TLS.** The Web UI and HTTP API ship with **no auth**
   and assume a trusted local network. Put the server behind a reverse proxy
   (nginx, Caddy, Traefik) that terminates TLS and enforces auth (basic auth,
   OAuth proxy, or an allowlist). **Never** expose port `20266` directly to the
   internet.

   Minimal nginx sketch:

   ```nginx
   server {
     listen 443 ssl;
     server_name philont.example.com;
     # ssl_certificate / ssl_certificate_key ...
     auth_basic "philont";
     auth_basic_user_file /etc/nginx/.htpasswd;
     location / {
       proxy_pass http://127.0.0.1:20266;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;     # WebSocket
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
     }
   }
   ```

2. **Scope the agent's filesystem and shell access.** The permission layer
   (`agent-policy`) is the safety boundary — review the path ACLs and command
   policies, and run the process as an unprivileged user inside a container or VM,
   not as your login account.

3. **Protect the state directory.** `~/.philont` holds the memory DB and stored
   credentials. Restrict its permissions and back it up; it is not encrypted at
   rest beyond the credential store.

4. **Budget the model spend.** Set `PHILONT_AUTONOMOUS_DAILY_TOKENS` and your
   provider-side spend limits; the idle-time autonomous loop will consume tokens
   on its own.

5. **Lock down channels.** If you enable Telegram/WeChat, use the `allowlist` DM
   and group policies (see `.env.example`) rather than `open`.

---

## Verifying a deployment

Run the per-package test suites:

```bash
for pkg in agent-policy agent-memory agent-tools agent-mcp agent-plugins; do
  echo "== $pkg =="; (cd "$pkg" && npm test 2>&1 | tail -5)
done
```

Check the server is healthy:

```bash
curl http://localhost:20266/api/memory/stats
```

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `better-sqlite3` fails to install | Missing C toolchain — install `build-essential` (Linux), Xcode CLT (macOS), or MSVC Build Tools (Windows), then `npm rebuild better-sqlite3` in the affected package. |
| `Cannot find module '@agent/...'` | A dependency package wasn't built. Rebuild in dependency order (`./scripts/build-all.sh`), then `rm -rf node_modules/@agent && npm install` in the consumer. |
| Chat replies `Mock response to: …` | `LLM_PROVIDER` is unset → mock mode. Set a real provider + key and restart the server. |
| Web UI is blank | Server isn't running or is on another port — confirm `curl localhost:20266/api/memory/stats`, then check the browser DevTools Network tab. |
| Port already in use | Override with `PHILONT_PORT` (server) or Vite's `--port` (web-ui). |

For deeper background on each subsystem, see
[ARCHITECTURE_EVOLUTION.md](ARCHITECTURE_EVOLUTION.md) and
[TOOLS_ARCHITECTURE.md](TOOLS_ARCHITECTURE.md).
