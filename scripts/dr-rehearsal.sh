#!/usr/bin/env bash
# R146.330 #25 — disaster-recovery rehearsal sketch.
#
# DO NOT RUN IN PROD without operator sign-off. This destroys and rebuilds.
# Designed to run against a STAGING droplet identical to prod.
#
# Steps performed + timed:
#   1. pg_dump current state to /tmp/dr-snapshot.sql.gz
#   2. docker compose down -v (delete volumes)
#   3. docker compose up -d --build (full rebuild)
#   4. apply migrations
#   5. restore from snapshot
#   6. run post-deploy-smoke
#   7. report TTR (time-to-recovery) per phase
set -euo pipefail

LOG=/tmp/dr-rehearsal-$(date +%s).log
echo "[dr] log: $LOG"

phase() {
  local name="$1"; shift
  local start=$(date +%s)
  echo "[dr] phase: $name" | tee -a "$LOG"
  "$@" 2>&1 | tee -a "$LOG"
  local end=$(date +%s)
  echo "[dr] phase $name took $((end - start))s" | tee -a "$LOG"
}

phase 'snapshot' bash -c 'docker exec novan-postgres-1 pg_dump -U novan -d ops | gzip > /tmp/dr-snapshot.sql.gz; ls -la /tmp/dr-snapshot.sql.gz'

# Operator-confirmation gate
if [ "${CONFIRM_DESTROY:-}" != "YES_REALLY" ]; then
  echo "[dr] CONFIRM_DESTROY=YES_REALLY required to proceed — exit safe at this point"
  exit 0
fi

phase 'destroy'  docker compose down -v
phase 'rebuild'  docker compose up -d --build
phase 'wait-db'  bash -c 'for i in 1 2 3 4 5 6 7 8 9 10; do docker exec novan-postgres-1 pg_isready -U novan && break; sleep 5; done'
phase 'restore'  bash -c 'gunzip -c /tmp/dr-snapshot.sql.gz | docker exec -i novan-postgres-1 psql -U novan -d ops'
phase 'wait-api' bash -c 'for i in 1 2 3 4 5 6 7 8 9 10; do curl -fs http://localhost:3001/health && break; sleep 10; done'
phase 'smoke'    bash scripts/post-deploy-smoke.sh

echo "[dr] complete — review $LOG for timing"
