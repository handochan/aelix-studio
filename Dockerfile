# Build with network access, then transfer the image into the isolated network.
FROM oven/bun:1.4.4 AS bun
FROM ghcr.io/astral-sh/uv:0.11.19 AS uv
FROM node:24-bookworm-slim AS builder
WORKDIR /app
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=uv /uv /usr/local/bin/uv
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx \
    && apt-get update \
    && apt-get install -y --no-install-recommends python3 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
ENV CI=true
ENV UV_CACHE_DIR=/tmp/studio-uv-cache
# Workspace manifests and patch files must be present during installation.
COPY . .
RUN bun install --frozen-lockfile
RUN node scripts/prepareAioncore.js
RUN python3 scripts/aelix-studio/prepareRuntime.py
RUN bun run package

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libicu-dev \
    && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/resources ./resources
COPY --from=builder /app/out/renderer ./out/renderer
COPY --from=builder /app/package.json /app/bun.lock /app/tsconfig.json ./
ENV NODE_ENV=production
ENV AIONUI_PORT=3000
ENV AIONUI_ALLOW_REMOTE=1
ENV AIONUI_DATA_DIR=/data
ENV AELIX_CODING_AGENT_DIR=/data/aelix/agent
ENV AELIX_CODING_AGENT_SESSION_DIR=/data/aelix/sessions
ENV AIONUI_OPEN_BROWSER=0
ENV AIONUI_STATIC_DIR=/app/out/renderer
ENV AIONUI_NO_BUILD=1
VOLUME ["/data"]
EXPOSE 3000
CMD ["bun", "scripts/webui.ts", "--no-build"]
