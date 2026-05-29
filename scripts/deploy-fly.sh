#!/usr/bin/env bash
# deploy-fly.sh — provision + deploy Novan on fly.io.
#
# Idempotent: safe to re-run. Each step checks state before acting.
#
# Prerequisites:
#   - flyctl installed:  curl -L https://fly.io/install.sh | sh
#   - fly auth login
#   - Neon account (free): https://console.neon.tech  →  copy connection string
#   - Upstash account (free): https://console.upstash.com  →  copy Redis URL
#
# Run:
#   ./scripts/deploy-fly.sh
#
# Or with explicit data store URLs:
#   DATABASE_URL=postgresql://… REDIS_URL=rediss://… ./scripts/deploy-fly.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

API_APP="${NOVAN_API_APP:-novan-api}"
WEB_APP="${NOVAN_WEB_APP:-novan-web}"
REGION="${NOVAN_REGION:-sjc}"

cyan() { printf "\033[36m%s\033[0m\n" "$1"; }
ok()   { printf "\033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "\033[33m⚠\033[0m %s\n" "$1"; }
fail() { printf "\033[31m✗\033[0m %s\n" "$1"; exit 1; }

command -v fly >/dev/null || fail "flyctl not installed. See https://fly.io/docs/hands-on/install-flyctl/"

cyan "── 1. Auth check"
fly auth whoami >/dev/null 2>&1 || fail "Not logged in. Run: fly auth login"
ok "logged in as $(fly auth whoami)"

cyan "── 2. Create apps (idempotent)"
if fly apps list 2>/dev/null | grep -qE "^$API_APP\s"; then
  ok "app '$API_APP' exists"
else
  fly apps create "$API_APP" --org personal
  ok "created app '$API_APP'"
fi
if fly apps list 2>/dev/null | grep -qE "^$WEB_APP\s"; then
  ok "app '$WEB_APP' exists"
else
  fly apps create "$WEB_APP" --org personal
  ok "created app '$WEB_APP'"
fi

cyan "── 3. Secrets — DATABASE_URL + REDIS_URL"
if [ -z "${DATABASE_URL:-}" ] || [ -z "${REDIS_URL:-}" ]; then
  warn "DATABASE_URL and/or REDIS_URL not set. Run:"
  echo
  echo "  export DATABASE_URL='postgresql://USER:PASS@HOST.neon.tech/DB?sslmode=require'"
  echo "  export REDIS_URL='rediss://default:PASS@HOST.upstash.io:PORT'"
  echo "  $0"
  echo
  warn "Then re-run this script. Or set them via the Neon + Upstash dashboards."
  exit 1
fi

# Detect if secrets are already set (don't re-stage if unchanged — secrets
# trigger a redeploy every time you set them)
existing=$(fly secrets list -a "$API_APP" 2>/dev/null | awk 'NR>1 {print $1}')
need_secrets=false
for k in DATABASE_URL REDIS_URL AUTH_SECRET VAULT_MASTER_KEY; do
  if ! echo "$existing" | grep -q "^$k$"; then
    need_secrets=true; break
  fi
done

if [ "$need_secrets" = "true" ]; then
  AUTH_SECRET="${AUTH_SECRET:-$(openssl rand -base64 48 | tr -d '\n')}"
  VAULT_MASTER_KEY="${VAULT_MASTER_KEY:-$(openssl rand -base64 32 | tr -d '\n')}"
  cyan "── Setting secrets on $API_APP (this triggers a redeploy on next deploy)"
  fly secrets set -a "$API_APP" \
    "DATABASE_URL=$DATABASE_URL" \
    "REDIS_URL=$REDIS_URL" \
    "AUTH_SECRET=$AUTH_SECRET" \
    "VAULT_MASTER_KEY=$VAULT_MASTER_KEY"
  ok "secrets staged on $API_APP"
  warn "VAULT_MASTER_KEY and AUTH_SECRET were freshly generated — save them somewhere outside fly.io for disaster recovery"
  echo "  AUTH_SECRET=$AUTH_SECRET"
  echo "  VAULT_MASTER_KEY=$VAULT_MASTER_KEY"
else
  ok "secrets already configured on $API_APP — skipping"
fi

cyan "── 4. Deploy API"
fly deploy -c fly.api.toml --remote-only \
  --primary-region "$REGION"
ok "API deployed: https://$API_APP.fly.dev"

cyan "── 5. Deploy Web (bakes API URL into bundle)"
API_URL="https://$API_APP.fly.dev/api"
fly deploy -c fly.web.toml --remote-only \
  --primary-region "$REGION" \
  --build-arg "VITE_API_BASE=$API_URL"
ok "Web deployed: https://$WEB_APP.fly.dev"

cyan "── 6. Smoke test"
sleep 5
if curl -sf "https://$API_APP.fly.dev/health" > /dev/null; then
  ok "API /health responding"
else
  warn "API /health not responding yet — check 'fly logs -a $API_APP'"
fi
if curl -sfI "https://$WEB_APP.fly.dev" > /dev/null; then
  ok "Web root responding"
else
  warn "Web root not responding yet — check 'fly logs -a $WEB_APP'"
fi

echo
cyan "── Deploy complete"
echo "  API:  https://$API_APP.fly.dev"
echo "  Web:  https://$WEB_APP.fly.dev"
echo
echo "  Next:"
echo "    fly logs -a $API_APP            # watch API live"
echo "    fly ssh console -a $API_APP     # shell in"
echo "    fly secrets list -a $API_APP    # audit"
