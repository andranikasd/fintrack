# Node's built-in SQLite avoids a database server or native npm build toolchain.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
COPY assets ./assets
COPY scripts/build-node.mjs ./scripts/build-node.mjs
RUN npm run typecheck && npm run build:node

FROM node:24-bookworm-slim AS production
ENV NODE_ENV=production DATA_DIR=/data BACKUP_DIR=/backups MIGRATIONS_DIR=/app/migrations
WORKDIR /app
# flock enforces one bot process per data volume; sqlite3 is available for admin/recovery.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates util-linux sqlite3 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data /backups \
    && chown node:node /data /backups
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["flock", "--exclusive", "--nonblock", "--no-fork", "/data/fintrack.lock"]
CMD ["node", "dist/main.mjs"]
