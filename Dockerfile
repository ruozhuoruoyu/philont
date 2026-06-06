# Philont runtime image — builds the full TypeScript stack and runs the server.
#
#   docker build -t philont .
#   docker run -d --name philont \
#     -p 20266:20266 \
#     -v philont-state:/root/.philont \
#     -e LLM_PROVIDER=anthropic -e ANTHROPIC_API_KEY=sk-ant-... \
#     philont
#
# The Rust crates (agent-core / agent-node) are dormant and NOT built here — the
# runtime is pure TypeScript. The only native build is better-sqlite3.
#
# Single-stage image; a slimmer multi-stage runtime image is on the roadmap.

FROM node:22-bookworm

# ── Native build toolchain (for better-sqlite3 / node-gyp) ───────────────────
# Placed before COPY so source changes don't invalidate this layer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# ── Document / media toolchain ───────────────────────────────────────────────
# Lets the agent's file tools handle common formats out of the box (PDF text
# extraction, media, JSON, office documents). Override the pip mirror in
# restricted regions with: --build-arg PIP_INDEX_URL=https://pypi.org/simple/
ARG PIP_INDEX_URL=https://pypi.org/simple/
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg poppler-utils jq \
 && rm -rf /var/lib/apt/lists/*
RUN pip3 install --break-system-packages --no-cache-dir -i "$PIP_INDEX_URL" \
      pillow requests beautifulsoup4 lxml pypdf openpyxl python-docx python-pptx

# ── Build the Philont stack (dependency order) ───────────────────────────────
# Packages link to each other via file: paths, so the sibling tree must be kept
# intact and built bottom-up. Each package gets its own layer for cache friend-
# liness; the retry guards a transient ETXTBSY race on overlay filesystems.
WORKDIR /philont
COPY . .
RUN set -e; for pkg in agent-policy agent-tools agent-mcp agent-plugins agent-memory server; do \
      cd /philont/$pkg; \
      (npm install --no-audit --no-fund --prefer-offline \
        || (sleep 3 && npm install --no-audit --no-fund --prefer-offline)); \
      sync; \
      if [ "$pkg" != "server" ]; then npm run build; fi; \
    done

# ── Runtime ──────────────────────────────────────────────────────────────────
WORKDIR /philont/server
# Persistent agent state (memory DB, skills, credentials). Mount a volume here.
VOLUME ["/root/.philont"]
EXPOSE 20266
CMD ["npm", "run", "dev"]
