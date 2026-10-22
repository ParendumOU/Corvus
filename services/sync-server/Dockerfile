# syntax=docker/dockerfile:1
# Build context: repository root (see docker-compose.yml).

FROM node:22-bookworm AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /repo
COPY . .
# Only the server and its workspace dependencies are installed; better-sqlite3 compiles here.
RUN --mount=type=cache,id=corvus-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@corvus/sync-server..." \
 && pnpm --filter "@corvus/sync-server..." run build \
 && pnpm --filter @corvus/sync-server deploy --prod /out \
 && rm -rf /out/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/deps \
           /out/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/src

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8787 CORVUS_SYNC_DB=/data/sync.db
WORKDIR /app
COPY --from=build --chown=node:node /out ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/index.js"]
