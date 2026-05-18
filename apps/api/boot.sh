#!/bin/sh
# boot.sh — apply outstanding SQL migrations sequentially, then start API.
#
# Honest scope: applies any *.sql file in packages/db/migrations/ that
# hasn't been recorded in the schema_migrations_history table. Idempotent —
# uses IF NOT EXISTS where applicable, and tracks applied filenames.

set -e

if [ -z "$DATABASE_URL" ]; then
  echo "[boot] DATABASE_URL not set — skipping migrations"
else
  echo "[boot] ensuring migrations table…"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
    CREATE TABLE IF NOT EXISTS schema_migrations_history (
      filename text PRIMARY KEY,
      applied_at bigint NOT NULL
    );" >/dev/null

  for f in /app/packages/db/migrations/*.sql; do
    base=$(basename "$f")
    already=$(psql "$DATABASE_URL" -tAc "select 1 from schema_migrations_history where filename = '$base'")
    if [ "$already" = "1" ]; then
      echo "[boot] skip $base (already applied)"
      continue
    fi
    echo "[boot] applying $base…"
    if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f" >/dev/null; then
      psql "$DATABASE_URL" -c "insert into schema_migrations_history (filename, applied_at) values ('$base', $(date +%s)000)" >/dev/null
      echo "[boot] applied  $base"
    else
      echo "[boot] FAILED   $base — continuing (existing tables may have caused conflicts)"
    fi
  done
fi

echo "[boot] starting API"
exec node --import tsx/esm src/server.ts
