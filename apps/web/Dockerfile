# Novan Web — production static build served by Caddy
FROM node:20-alpine AS deps
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --prod=false

FROM deps AS build
WORKDIR /app
COPY . .
ARG VITE_API_BASE=/api
ENV VITE_API_BASE=$VITE_API_BASE
RUN pnpm --filter @ops/web build

# ─── Static server ────────────────────────────────────────────────────────────
FROM caddy:2-alpine AS runtime
COPY --from=build /app/apps/web/dist  /srv
COPY apps/web/Caddyfile               /etc/caddy/Caddyfile
EXPOSE 8080
