#!/usr/bin/env bash
#
# One-command build for philont (pure TypeScript, no Rust needed).
#
# Builds all TS packages + web-ui + launcher in dependency order.
# The server runs via tsx (no build script), so it only gets deps installed.
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

build_pkg() {
  echo ""
  echo "==> build $1"
  ( cd "$1" && npm install --no-audit --no-fund && npm run build )
}

# TS packages, bottom-up (agent-policy is the base; the rest depend on it)
for p in agent-policy agent-tools agent-mcp agent-plugins agent-memory; do
  build_pkg "$p"
done

echo ""
echo "==> install server deps (runs via tsx, no build)"
( cd server && npm install --no-audit --no-fund )

build_pkg web-ui     # vite  -> web-ui/dist
build_pkg launcher   # tsc   -> launcher/dist

echo ""
echo "Build complete. Start with: ./scripts/start.sh"
