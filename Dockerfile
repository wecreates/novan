# Novan — root-level Dockerfile (Render default-path target)
# Identical to apps/api/Dockerfile. Build context = repo root.
FROM node:20-alpine

# Native build tools for any pnpm deps that need gyp
RUN apk add --no-cache python3 make g++ postgresql-client \
 && corepack enable \
 && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app

# Copy entire workspace — .dockerignore strips node_modules/dist/.git/etc
COPY . .

# Install all workspace deps (frozen lockfile, includes devDeps so tsx is available)
RUN pnpm install --frozen-lockfile --prod=false

ENV NODE_ENV=production
ENV API_HOST=0.0.0.0

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3001}/health" || exit 1

# Run API via tsx so workspace packages resolve from source
WORKDIR /app/apps/api
RUN chmod +x boot.sh
CMD ["./boot.sh"]
