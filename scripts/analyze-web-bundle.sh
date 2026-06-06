#!/usr/bin/env bash
# R146.329 (#14) — frontend bundle analyzer report.
# Outputs the top-10 largest chunks after vite build.
set -euo pipefail

cd "$(dirname "$0")/../apps/web"

echo "[bundle] building production…"
pnpm exec vite build 2>&1 | tail -5

DIST=dist
if [ ! -d "$DIST" ]; then
  echo "[bundle] dist/ not found" >&2
  exit 1
fi

echo
echo "[bundle] top-10 largest chunks (uncompressed):"
find "$DIST/assets" -type f -name '*.js' -exec ls -la {} \; \
  | awk '{print $5, $9}' | sort -rn | head -10 \
  | awk '{ printf "  %8.1f KB   %s\n", $1/1024, $2 }'

echo
echo "[bundle] total size:"
du -sh "$DIST"
