#!/bin/bash
# deploy-droplet.sh — roll out pre-built GHCR images WITHOUT building on the box.
#
# The droplet is 1 vCPU / 2 GB; `docker compose build` OOM-thrashes it for ~20 min
# and the self-dev applier competes for CPU. CI (.github/workflows/build-and-push.yml)
# now builds the images off-box and pushes them to GHCR, so a deploy is just a pull.
#
# One-time setup on the droplet (operator, since it needs a credential):
#   echo <GHCR_READ_TOKEN> | docker login ghcr.io -u wecreates --password-stdin
#   (a classic PAT with read:packages, or make the novan-api/novan-web packages public)
#
# Then every deploy is:  bash /root/novan/scripts/deploy-droplet.sh
set -euo pipefail

cd /root/novan
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.images.yml"

echo "[deploy] stopping self-dev applier (frees CPU, prevents races)…"
systemctl stop novan-applier.service 2>/dev/null || true

echo "[deploy] pulling latest images from GHCR…"
$COMPOSE pull api web

echo "[deploy] rolling api + web…"
$COMPOSE up -d --no-deps api web

echo "[deploy] resuming self-dev applier…"
systemctl start novan-applier.service 2>/dev/null || true

echo "[deploy] waiting for api health…"
code=000
for _ in $(seq 1 15); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:3001/health || true)
  [ "$code" = "200" ] && break
  sleep 3
done
echo "[deploy] api health=$code"

$COMPOSE ps
[ "$code" = "200" ] || { echo "[deploy] WARNING: api not healthy after rollout"; exit 1; }
echo "[deploy] done."
