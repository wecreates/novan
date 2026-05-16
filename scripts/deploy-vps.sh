#!/bin/bash
# One-command production deploy to VPS
# Usage: bash scripts/deploy-vps.sh [--with-nginx]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$REPO_DIR/infra/docker/docker-compose.prod.yml"
ENV_FILE="$REPO_DIR/.env"

WITH_NGINX=false
for arg in "$@"; do
  [ "$arg" = "--with-nginx" ] && WITH_NGINX=true
done

echo "=== ops-platform deploy ==="
echo "Repo:    $REPO_DIR"
echo "Compose: $COMPOSE_FILE"

# ─── Validate env ─────────────────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env not found at $REPO_DIR/.env"
  echo "Copy .env.example and fill in secrets."
  exit 1
fi

# ─── Pull latest ──────────────────────────────────────────────────────────────
cd "$REPO_DIR"
echo "--- git pull ---"
git pull --ff-only

# ─── Build images ─────────────────────────────────────────────────────────────
echo "--- docker compose build ---"
COMPOSE_PROFILES=""
$WITH_NGINX && COMPOSE_PROFILES="--profile production"

docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" $COMPOSE_PROFILES build \
  --parallel \
  api workflow-worker recovery-worker memory-worker analytics-worker learning-worker

# ─── Run DB migrations ────────────────────────────────────────────────────────
echo "--- DB migrations ---"
# Bring postgres up if not running
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d postgres redis
echo "Waiting for postgres..."
until docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T postgres \
  pg_isready -U ops -d ops_platform > /dev/null 2>&1; do sleep 2; done

# Apply all migration files in order
MIGRATIONS_DIR="$REPO_DIR/packages/db/migrations"
for sql_file in $(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null | sort); do
  echo "  Applying: $(basename $sql_file)"
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T postgres \
    psql -U ops -d ops_platform < "$sql_file" || echo "  (already applied or error — continuing)"
done

# ─── Rolling restart ──────────────────────────────────────────────────────────
echo "--- rolling restart ---"
SERVICES="api workflow-worker recovery-worker memory-worker analytics-worker learning-worker"
$WITH_NGINX && SERVICES="$SERVICES nginx certbot"

for svc in $SERVICES; do
  echo "  Restarting $svc..."
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" $COMPOSE_PROFILES \
    up -d --no-deps "$svc"
done

# ─── Monitoring ───────────────────────────────────────────────────────────────
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d prometheus grafana

# ─── Health check ─────────────────────────────────────────────────────────────
echo "--- health check ---"
sleep 5
MAX_RETRIES=10
for i in $(seq 1 $MAX_RETRIES); do
  if curl -sf http://localhost:3001/api/health > /dev/null 2>&1; then
    echo "✓ API healthy"
    break
  fi
  echo "  Attempt $i/$MAX_RETRIES — waiting..."
  sleep 3
  if [ "$i" -eq "$MAX_RETRIES" ]; then
    echo "ERROR: API health check failed after $MAX_RETRIES attempts"
    echo "Logs:"
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" logs --tail=50 api
    exit 1
  fi
done

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "=== Deploy complete ==="
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps
