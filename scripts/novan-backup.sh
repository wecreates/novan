#!/usr/bin/env bash
# R146.128 — Nightly database backup.
#
# Usage: novan-backup.sh <destination-url>
#   destination-url: s3://bucket/prefix OR /local/path
#
# Env required for S3-compatible (DO Spaces, AWS):
#   BACKUP_S3_ACCESS_KEY, BACKUP_S3_SECRET_KEY, BACKUP_S3_ENDPOINT (optional for AWS)
#
# Reads DB creds from env (POSTGRES_USER, POSTGRES_DB, POSTGRES_HOST=postgres, POSTGRES_PASSWORD).
# Writes pg_dump.gz to destination. Outputs JSON {"sizeBytes":N} on success.

set -euo pipefail

DEST="${1:?destination URL required}"
PG_USER="${POSTGRES_USER:-novan}"
PG_DB="${POSTGRES_DB:-ops}"
PG_HOST="${POSTGRES_HOST:-postgres}"
PG_PASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD required}"

TS=$(date -u +%Y%m%dT%H%M%SZ)
TMP="/tmp/novan-${TS}.sql.gz"

# Dump + compress
PGPASSWORD="$PG_PASSWORD" pg_dump -h "$PG_HOST" -U "$PG_USER" -d "$PG_DB" --no-owner --no-privileges \
  | gzip -9 > "$TMP"
SIZE=$(stat -c%s "$TMP" 2>/dev/null || stat -f%z "$TMP")

# Upload
case "$DEST" in
  s3://*|spaces://*)
    # s3cmd or aws cli — use whichever is available
    KEY="${DEST#s3://}"; KEY="${KEY#spaces://}"
    BUCKET="${KEY%%/*}"
    PREFIX="${KEY#*/}"
    REMOTE="s3://${BUCKET}/${PREFIX%/}/novan-${TS}.sql.gz"
    if command -v aws >/dev/null 2>&1; then
      AWS_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY:?required}" \
      AWS_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_KEY:?required}" \
      aws s3 cp "$TMP" "$REMOTE" \
        ${BACKUP_S3_ENDPOINT:+--endpoint-url "$BACKUP_S3_ENDPOINT"} \
        --no-progress >&2
    else
      echo "neither aws nor s3cmd present" >&2
      exit 1
    fi
    ;;
  /*)
    mkdir -p "$DEST"
    cp "$TMP" "$DEST/novan-${TS}.sql.gz"
    ;;
  *)
    echo "unsupported destination: $DEST" >&2
    exit 1
    ;;
esac

rm -f "$TMP"

# Output the size for the api to log
printf '{"sizeBytes":%d,"timestamp":"%s"}\n' "$SIZE" "$TS"
