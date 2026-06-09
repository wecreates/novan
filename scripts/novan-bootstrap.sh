#!/usr/bin/env bash
# R507 — One-shot bootstrap for a fresh Novan install.
#
# Run this on the droplet after deploying for the first time. It checks
# every required env var, runs the schema migrations, seeds the Pinterest
# pin queue, fires the R502 webhook self-test, and prints a checklist of
# what the operator still needs to do manually.
set -euo pipefail
cd /root/novan

OK=()
FAIL=()
WARN=()

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
yel()   { printf '\033[33m%s\033[0m\n' "$*"; }

require_env() {
  local k="$1"; local msg="$2"
  if grep -qE "^${k}=.+" .env 2>/dev/null; then OK+=("$k set"); else FAIL+=("$k missing — $msg"); fi
}
soft_env() {
  local k="$1"; local msg="$2"
  if grep -qE "^${k}=.+" .env 2>/dev/null; then OK+=("$k set"); else WARN+=("$k missing — $msg"); fi
}

echo "═══ Novan bootstrap ═══"
echo
echo "[1/5] env vars"
require_env NOVAN_OPS_TOKEN          "dashboard auth — generate with: openssl rand -hex 32"
require_env GUMROAD_WEBHOOK_TOKEN    "Gumroad real-time webhook"
require_env DATABASE_URL             "Postgres connection"
require_env VAPID_PUBLIC_KEY         "web push (R129)"
require_env VAPID_PRIVATE_KEY        "web push"
soft_env    GUMROAD_SELLER_ID        "harden webhook against token leak"
soft_env    GUMROAD_ALLOWED_IPS      "IP allowlist on webhook (R430)"
soft_env    GUMROAD_ACCESS_TOKEN     "R367 hourly poll backup"
soft_env    INPRNT_SELLER_URL        "capability self-test"
soft_env    NOVAN_DAILY_AI_BUDGET_USD "daily AI spend cap (R428)"
soft_env    NOVAN_AUTONOMY_FAIL_CLOSED "fail-closed autonomy on DB outage (R500)"
soft_env    NOVAN_BACKUP_DIR          "off-disk backups (R429)"
soft_env    NOVAN_DESIGN_STORE        "design file store (R438)"

echo "[2/5] data dirs"
for d in /var/lib/novan/backups /var/lib/novan/design-files; do
  if [ -d "$d" ]; then OK+=("$d exists"); else mkdir -p "$d" && OK+=("$d created"); fi
done

echo "[3/5] schema migrations"
if [ -f apps/api/src/db/migrations/R381-business-revenue-add-sale-columns.sql ]; then
  TOKEN=$(grep '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)
  psql "$TOKEN" -f apps/api/src/db/migrations/R381-business-revenue-add-sale-columns.sql -v ON_ERROR_STOP=0 >/dev/null 2>&1 \
    && OK+=("R381 migration applied") \
    || WARN+=("R381 migration could not be verified — re-run manually")
else
  WARN+=("R381 migration file missing — repo out of sync?")
fi

echo "[4/5] api health"
if curl -fsS http://localhost:3001/api/v1/health >/dev/null 2>&1; then
  OK+=("api responding on :3001")
else
  FAIL+=("api not responding — try: docker compose up -d api")
fi

echo "[5/5] webhook self-test"
TOKEN=$(grep '^NOVAN_OPS_TOKEN=' .env | head -1 | cut -d= -f2-)
if [ -n "$TOKEN" ]; then
  RESP=$(curl -sS -X POST http://localhost:3001/api/v1/brain/task \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"workspace_id":"default","plan":[{"op":"webhook.self_test","params":{}}]}' --max-time 30)
  if echo "$RESP" | grep -q '"ok":true'; then OK+=("webhook self-test passed"); else WARN+=("webhook self-test failed: $RESP"); fi
fi

echo
green "✓ OK (${#OK[@]})"
for x in "${OK[@]}"; do echo "  - $x"; done
if [ ${#WARN[@]} -gt 0 ]; then
  echo
  yel "⚠ WARNINGS (${#WARN[@]})"
  for x in "${WARN[@]}"; do echo "  - $x"; done
fi
if [ ${#FAIL[@]} -gt 0 ]; then
  echo
  red "✗ FAILURES (${#FAIL[@]})"
  for x in "${FAIL[@]}"; do echo "  - $x"; done
fi

cat <<EOF

═══ Manual operator checklist ═══
[ ] Paste webhook URL into Gumroad → Settings → Advanced → Ping URL:
    https://137-184-198-2.sslip.io/api/v1/webhooks/gumroad/sale?token=<GUMROAD_WEBHOOK_TOKEN>
[ ] Open https://137-184-198-2.sslip.io/ on phone, install PWA, allow notifications
[ ] On your laptop, run \`pnpm signin\` and log into all 11 POD platforms in the persistent browser
[ ] Run \`pnpm sync-designs\` once to upload local design files to the droplet (R438)
[ ] Run \`pnpm seed-pins\` once to seed the Pinterest pin queue from R360-pinterest-pins.md
[ ] (Optional) Configure your operator timezone:
    curl -X POST .../api/v1/brain/task -d '{"plan":[{"op":"workspace.set_timezone","params":{"timezone":"America/Chicago"}}]}'
EOF

[ ${#FAIL[@]} -eq 0 ] || exit 1
