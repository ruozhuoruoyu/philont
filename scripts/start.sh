#!/usr/bin/env bash
#
# 一键启动 philont:起 launcher(不构建)。
#
# 构建请先单独跑 ./scripts/build-all.sh。本脚本只负责启动,不再自动 build,
# 避免每次启动都重跑 tsc/vite,也避免跑到过期 dist。
#
# launcher 会:serve web-ui(localhost:20267)+ 自动开浏览器 + 监督 agent 子进程。
# 首次打开 web-ui 走配置向导填 API Key 等;保存后自动拉起 agent。
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f launcher/dist/index.js ] || [ ! -d web-ui/dist ]; then
  echo "缺少构建产物(launcher/dist 或 web-ui/dist)。请先运行:./scripts/build-all.sh" >&2
  exit 1
fi

echo "启动 launcher(serve web-ui + 监督 agent + 自动开浏览器;Ctrl+C 退出)…"
exec node launcher/dist/index.js
