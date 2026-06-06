#!/usr/bin/env bash
#
# Start philont: launch only (no auto-build).
#
# Run ./scripts/build-all.sh first (or after a git pull) to (re)build.
# The launcher serves the web UI (localhost:20267), opens your browser to the
# setup wizard, and supervises the agent process.
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f launcher/dist/index.js ] || [ ! -d web-ui/dist ]; then
  echo "Build output missing (launcher/dist or web-ui/dist). Run ./scripts/build-all.sh first." >&2
  exit 1
fi

echo "Starting launcher (serves web UI + supervises agent + opens browser; Ctrl+C to exit)..."
exec node launcher/dist/index.js
