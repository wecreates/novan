#!/usr/bin/env bash
# R146.229 — Mirror /root/backups to an off-site target.
# Single-droplet failure currently loses backups along with the primary
# DB. This script mirrors the dump set to a remote SSH host or to an
# S3-compatible bucket, depending on which env vars the operator sets.
#
# Configure ONE of:
#   OFFSITE_SSH=user@host:/path/to/remote/backups   (rsync over SSH)
#   OFFSITE_S3_BUCKET=s3://bucket/prefix             (requires aws cli)
#
# Daily cron suggestion (after R197's 03:30 daily local dump):
#   45 3 * * * /root/novan/scripts/backup-offsite.sh >> /var/log/novan-offsite.log 2>&1
#
# The script is idempotent — re-running uploads only changed files.

set -euo pipefail

SRC=/root/backups
TS=$(date -u +%Y%m%dT%H%M%SZ)

if [[ ! -d "$SRC" ]]; then
  echo "[$TS] ERROR: $SRC does not exist; nothing to back up"
  exit 1
fi

# Count files for sanity
COUNT=$(find "$SRC" -maxdepth 1 -name 'novan-*.sql.gz' -type f | wc -l)
echo "[$TS] $COUNT *.sql.gz file(s) in $SRC"
if [[ "$COUNT" -eq 0 ]]; then
  echo "[$TS] WARN: no dumps to mirror; the daily backup-postgres.sh may have failed"
  exit 2
fi

if [[ -n "${OFFSITE_SSH:-}" ]]; then
  echo "[$TS] rsync → $OFFSITE_SSH"
  # -a archive, -z compress, -P partial+progress (rsync skips up-to-date files)
  rsync -azP --include='novan-*.sql.gz' --include='backup.log' --exclude='*' \
    "$SRC/" "$OFFSITE_SSH/"
  echo "[$TS] OK rsync complete"
elif [[ -n "${OFFSITE_S3_BUCKET:-}" ]]; then
  if ! command -v aws >/dev/null 2>&1; then
    echo "[$TS] ERROR: OFFSITE_S3_BUCKET set but aws cli is not installed"
    exit 3
  fi
  echo "[$TS] aws s3 sync → $OFFSITE_S3_BUCKET"
  aws s3 sync "$SRC/" "$OFFSITE_S3_BUCKET/" \
    --exclude '*' --include 'novan-*.sql.gz' --include 'backup.log' \
    --storage-class STANDARD_IA --no-progress
  echo "[$TS] OK s3 sync complete"
else
  echo "[$TS] ERROR: neither OFFSITE_SSH nor OFFSITE_S3_BUCKET is set"
  echo "[$TS]   Set one in /etc/environment or via systemd EnvironmentFile"
  exit 4
fi
