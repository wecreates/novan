#!/usr/bin/env bash
# R505 — Restore Novan from R429 nightly backup.
#
# Usage: bash scripts/novan-restore.sh /var/lib/novan/backups/novan-20260609.sql.gz
#
# Restores Novan-owned tables only. Leaves other tables alone. If the
# corresponding design-files tarball exists, restores those too.
set -euo pipefail
SQL_GZ="${1:-}"
if [ -z "$SQL_GZ" ] || [ ! -f "$SQL_GZ" ]; then
  echo "[restore] usage: $0 <novan-YYYYMMDD.sql.gz>" >&2
  echo "[restore] available backups:" >&2
  ls -lh /var/lib/novan/backups/ 2>/dev/null || echo "  (none — backup dir empty)" >&2
  exit 1
fi
cd /root/novan
DBURL=$(grep '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)
if [ -z "$DBURL" ]; then echo "[restore] DATABASE_URL not in .env" >&2; exit 1; fi

# Backup is --data-only — DDL must already match. If schema diverged since
# the dump, drizzle migrations need to run first.
echo "[restore] piping $SQL_GZ into psql…"
gzip -cd "$SQL_GZ" | psql "$DBURL" -v ON_ERROR_STOP=1

# Restore design files if the matching tarball exists
DATE_TAG=$(basename "$SQL_GZ" .sql.gz | sed 's/^novan-//')
DESIGN_TAR=$(dirname "$SQL_GZ")/novan-designs-"$DATE_TAG".tar.gz
if [ -f "$DESIGN_TAR" ]; then
  echo "[restore] extracting $DESIGN_TAR → /var/lib/novan/"
  tar -xzf "$DESIGN_TAR" -C /var/lib/novan/
fi
echo "[restore] ✓ done. Restart api: cd /root/novan && docker compose restart api"
