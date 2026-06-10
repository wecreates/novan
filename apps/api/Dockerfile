# Novan API — production image (tsx runtime, single-stage, reliable)
# R146.327 — revert R325 #10 layer-split; the explicit COPY listed packages/shared
# which doesn't exist on this droplet. The cache benefit isn't worth a broken build.
FROM node:20-alpine

RUN apk add --no-cache python3 make g++ postgresql-client ffmpeg \
    chromium nss freetype harfbuzz ca-certificates ttf-freefont \
 && corepack enable \
 && corepack prepare pnpm@9.12.0 --activate

# R602 — point Playwright at Alpine's system chromium instead of downloading
# the Debian glibc-only headless shell (which won't run on musl).
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/lib/chromium

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
