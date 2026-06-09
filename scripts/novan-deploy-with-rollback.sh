#!/usr/bin/env bash
# R436 — deploy + health-check + auto-rollback for the API container.
#
# Usage:  ssh root@137.184.198.2 'bash -s' < scripts/novan-deploy-with-rollback.sh
# Or:     scp this to /root/novan/deploy.sh and run it after every code change.
#
# Steps:
#   1. record current image SHA as previous
#   2. docker compose up -d api (re-reads .env + rebuilds if needed)
#   3. poll /api/v1/health up to 60s
#   4. if unhealthy, roll back to previous SHA and emit error
set -euo pipefail
cd /root/novan
PREV_SHA=$(docker compose images api --quiet 2>/dev/null || true)
echo "[deploy] previous image: $PREV_SHA"
docker compose up -d api 2>&1 | tail -3
echo "[deploy] waiting for /api/v1/health…"
DEADLINE=$(( $(date +%s) + 60 ))
HEALTHY=0
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  CODE=$(curl -sS -o /dev/null -w '%{http_code}' http://localhost:3001/api/v1/health || echo 000)
  if [ "$CODE" = "200" ]; then HEALTHY=1; break; fi
  sleep 2
done
if [ "$HEALTHY" = "1" ]; then
  echo "[deploy] ✓ healthy"
  exit 0
fi
echo "[deploy] ✗ unhealthy after 60s — rolling back"
if [ -n "$PREV_SHA" ]; then
  docker tag "$PREV_SHA" novan-api:rollback 2>/dev/null || true
  # crude rollback: stop the new container, start the previous image directly
  docker compose stop api
  docker run -d --name novan-api-rollback --network novan_default --env-file .env \
    -p 3001:3001 "$PREV_SHA" || echo "[deploy] manual rollback required"
  echo "[deploy] rolled back to $PREV_SHA"
else
  echo "[deploy] no previous image recorded — manual intervention required"
fi
exit 1
