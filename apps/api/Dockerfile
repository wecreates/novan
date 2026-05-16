# Novan API — production image
FROM node:20-alpine AS base
RUN corepack enable

# ─── Dependencies ─────────────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json                apps/api/
COPY packages/db/package.json             packages/db/
COPY packages/shared-types/package.json   packages/shared-types/
RUN pnpm install --frozen-lockfile --prod=false

# ─── Build ────────────────────────────────────────────────────────────────────
FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules         ./node_modules
COPY . .
RUN pnpm --filter @ops/api build

# ─── Runtime ──────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV API_PORT=3001
ENV API_HOST=0.0.0.0

# Copy production dependencies + built code
COPY --from=deps  /app/node_modules         ./node_modules
COPY --from=build /app/apps/api/dist        ./apps/api/dist
COPY --from=build /app/packages             ./packages
COPY --from=build /app/apps/api/package.json ./apps/api/package.json

# Non-root user
RUN addgroup -g 1001 -S novan && adduser -u 1001 -S novan -G novan
USER novan

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/health || exit 1

CMD ["node", "apps/api/dist/server.js"]
