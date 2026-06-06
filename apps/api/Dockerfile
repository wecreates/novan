# Novan API — production image
# R146.325 (#10/#11) — split install layer from source so changing a .ts
# file doesn't reinstall node_modules. Cuts ~60s off rebuild cost.
# (#11) Still tsx-on-source at runtime; compiling to dist would shave
# ~3s off boot but increases image complexity. Documented choice.
FROM node:20-alpine

# pnpm + native build tools (in case any dep needs gyp)
RUN apk add --no-cache python3 make g++ postgresql-client ffmpeg \
 && corepack enable \
 && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app

# Layer 1: lockfile + manifests only — cache-stable across source edits
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json                  apps/api/package.json
COPY apps/web/package.json                  apps/web/package.json
COPY apps/worker/package.json               apps/worker/package.json
COPY apps/browser-worker/package.json       apps/browser-worker/package.json
COPY packages/db/package.json               packages/db/package.json
COPY packages/event-contracts/package.json  packages/event-contracts/package.json
COPY packages/shared/package.json           packages/shared/package.json

# Install everything based on manifests only — this layer is reused
# whenever the lockfile/manifests haven't changed.
RUN pnpm install --frozen-lockfile --prod=false

# Layer 2: actual source. Changes here invalidate ONLY this layer.
COPY . .

# Runtime env
ENV NODE_ENV=production
ENV API_PORT=3001
ENV API_HOST=0.0.0.0

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3001/health || exit 1

WORKDIR /app/apps/api
RUN chmod +x boot.sh
CMD ["./boot.sh"]
