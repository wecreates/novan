# Novan API — production image (tsx runtime, single-stage, reliable)
FROM node:20-alpine

# pnpm + native build tools (in case any dep needs gyp)
RUN apk add --no-cache python3 make g++ postgresql-client \
 && corepack enable \
 && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app

# Copy entire workspace — .dockerignore strips node_modules/dist/.git/etc
COPY . .

# Install everything (workspace deps resolved correctly because all manifests present)
RUN pnpm install --frozen-lockfile --prod=false

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
