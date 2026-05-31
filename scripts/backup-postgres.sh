#!/bin/bash
# R146.79 — nightly pg_dump with 14-day retention.
# Lives outside docker volumes so even `docker volume prune` can't touch it.
set -euo pipefail

BACKUP_DIR=/root/backups
RETAIN_DAYS=14
TS=$(date -u +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/novan-$TS.sql.gz"

cd /root/novan
POSTGRES_USER=$(grep ^POSTGRES_USER= .env | cut -d= -f2-)
POSTGRES_DB=$(grep ^POSTGRES_DB= .env | cut -d= -f2-)

mkdir -p "$BACKUP_DIR"
docker exec novan-postgres-1 pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-acl 2>>"$BACKUP_DIR/backup.log" | gzip > "$OUT"

SIZE=$(stat -c%s "$OUT")
if [ "$SIZE" -lt 10000 ]; then
  echo "[$TS] FAIL: backup too small ($SIZE bytes) — likely empty dump" >> "$BACKUP_DIR/backup.log"
  rm -f "$OUT"
  exit 1
fi

# Prune anything older than retention window.
find "$BACKUP_DIR" -maxdepth 1 -name 'novan-*.sql.gz' -mtime +$RETAIN_DAYS -delete

echo "[$TS] OK $(du -h "$OUT" | cut -f1) $OUT" >> "$BACKUP_DIR/backup.log"
