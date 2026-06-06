#!/usr/bin/env bash
# R146.328 (#2) — confirm the just-built image actually contains the
# commit you just pushed. Catches the R325 silent layer-cache failure
# where the build "succeeded" but reused a stale layer with missing
# new files.
#
# Usage:  ./scripts/verify-image-fresh.sh <container_name> <expected_R_marker>
# e.g.,   ./scripts/verify-image-fresh.sh novan-api-1 R146.328
set -euo pipefail

CONTAINER="${1:-novan-api-1}"
MARKER="${2:-}"

if [ -z "$MARKER" ]; then
  # Default: the highest R-prefix in the last 3 commits
  MARKER=$(git log -n 3 --format=%s | grep -oE 'R(146\.)?[0-9]+' | head -1 || echo '')
fi

if [ -z "$MARKER" ]; then
  echo "[verify-image] no R-marker found in recent commits; skipping check" >&2
  exit 0
fi

echo "[verify-image] checking container $CONTAINER for marker $MARKER"

# Look for the marker string in any source file the API actually loads.
HIT=$(docker exec "$CONTAINER" sh -c "grep -rlF '$MARKER' /app/apps/api/src/services 2>/dev/null | head -1" || true)

if [ -z "$HIT" ]; then
  echo "[verify-image] STALE — marker $MARKER not found in container source." >&2
  echo "[verify-image] The build cached an old layer. Rebuild with --no-cache." >&2
  exit 1
fi

echo "[verify-image] ok — $MARKER present at $HIT"
