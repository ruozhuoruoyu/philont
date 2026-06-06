# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Open-source documentation: rewritten `README.md`, deployment guide
  (`DEPLOYMENT.md`), `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`,
  issue/PR templates, and CI workflow.

## [0.1.0] — Developer preview

Initial public developer preview.

### Added
- **Mechanism/policy architecture** — a kernel design (`agent-core`, Rust,
  currently dormant) plus userspace TypeScript packages for concrete tools.
- **`agent-policy`** — 3×4 capability×domain permission matrix, validator chain
  (path ACLs, SSRF, dangerous commands, secret-leak detection), SHA-256 audit
  log, and per-session grants.
- **`agent-tools`** — built-in filesystem/runtime/network/git/vision tools,
  capability profiles, and a `SKILL.md` loader.
- **`agent-memory`** — 5-layer persistent memory (raw timeline, actions, notes
  with FTS5 search, structured facts, learned skills), cross-session fact
  extraction, skill reflection, context compaction, and an idle-time autonomous
  loop.
- **`agent-mcp`** — bridge to mount external MCP servers (stdio/SSE) as tools.
- **`agent-plugins`** — sandboxed third-party plugin discovery and loading.
- **`server`** — HTTP + WebSocket chat server with WeChat/Telegram channel
  gateways and a memory REST API.
- **`web-ui`** — Lit-based Web UI with chat, memory, and autonomy dashboards.
- **`launcher`** — supervisor with a setup wizard and process management.
- Multi-provider model support (Anthropic-, OpenAI-compatible: Claude, DeepSeek,
  GLM, Kimi, MiniMax, Gemini).

[Unreleased]: https://github.com/<your-org>/philont/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/<your-org>/philont/releases/tag/v0.1.0
