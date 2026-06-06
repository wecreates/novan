# Novan API — production image (tsx runtime, single-stage, reliable)
# R146.327 — revert R325 #10 layer-split; the explicit COPY listed packages/shared
# which doesn't exist on this droplet. The cache benefit isn't worth a broken build.
FROM node:20-alpine

RUN apk add --no-cache python3 make g++ postgresql-client ffmpeg \
 && corepack enable \
 && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app

# Copy entire workspace — .dockerignore strips node_modules/dist/.git/etc
COPY . .

RUN pnpm install --frozen-lockfile --prod=false

ENV NODE_ENV=production
ENV API_PORT=3001
ENV API_HOST=0.0.0.0

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3001/health || exit 1

WORKDIR /app/apps/api
RUN chmod +x boot.sh
CMD ["./boot.sh"]
