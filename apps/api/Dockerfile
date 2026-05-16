# Novan API — production image (tsx runtime from source)
# This avoids the @ops/* workspace-package compile pitfall by running TS directly.

FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# ─── Dependencies ─────────────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app
# Copy workspace manifest files first for better layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json                       apps/api/
COPY packages/db/package.json                    packages/db/
COPY packages/shared-types/package.json          packages/shared-types/
COPY packages/ai-router/package.json             packages/ai-router/
COPY packages/event-contracts/package.json       packages/event-contracts/
COPY packages/policy-engine/package.json         packages/policy-engine/
COPY packages/provider-router/package.json       packages/provider-router/
COPY packages/runtime-kernel/package.json        packages/runtime-kernel/
COPY packages/service-recovery/package.json      packages/service-recovery/
RUN pnpm install --frozen-lockfile --prod=false

# ─── Runtime image ────────────────────────────────────────────────────────────
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV API_PORT=3001
ENV API_HOST=0.0.0.0

# Copy installed node_modules from deps stage
COPY --from=deps /app/node_modules                ./node_modules
COPY --from=deps /app/apps/api/node_modules       ./apps/api/node_modules

# Copy source — tsx will compile TS on demand at runtime
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api      ./apps/api
COPY packages      ./packages

# Non-root user
RUN addgroup -g 1001 -S novan && adduser -u 1001 -S novan -G novan && chown -R novan:novan /app
USER novan

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/health || exit 1

# Run server with tsx so @ops/* workspace packages resolve from source
WORKDIR /app/apps/api
CMD ["node", "--import", "tsx/esm", "src/server.ts"]
