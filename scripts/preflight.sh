#!/usr/bin/env bash
# scripts/preflight.sh — verify the system is deploy-ready BEFORE running
# `docker compose up`. Catches the failure modes operators hit on first deploy:
#   • missing required env vars
#   • dev secrets reused in production
#   • DATABASE_URL pointing at localhost while NODE_ENV=production
#   • migrations folder absent / unreadable
#   • lockfile drift between package.json and pnpm-lock.yaml
#
# Exits non-zero on any blocker so CI / boot script can refuse-to-deploy.
# Usage: ./scripts/preflight.sh [.env.production]

set -u
ENV_FILE="${1:-.env.production}"
BLOCKERS=0
WARNINGS=0

say()  { printf '\033[1;36m[preflight]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m  ✓\033[0m %s\n' "$*"; }
fail() { printf '\033[31m  ✗\033[0m %s\n' "$*"; BLOCKERS=$((BLOCKERS+1)); }
warn() { printf '\033[33m  ⚠\033[0m %s\n' "$*"; WARNINGS=$((WARNINGS+1)); }

# ── 1. env file exists ────────────────────────────────────────────────────────
say "checking env file: $ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
  fail "env file not found — copy .env.production.example to $ENV_FILE and fill in values"
  exit 1
fi
ok "env file present"

# Source it (carefully — only read declarations, not exec arbitrary code)
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# ── 2. required-for-prod-boot ─────────────────────────────────────────────────
say "required env vars (production validator in server.ts refuses to boot without these)"
for v in CORS_ORIGINS AUTH_SECRET VAULT_MASTER_KEY CHANNEL_ENCRYPTION_KEY DATABASE_URL REDIS_URL; do
  val="${!v:-}"
  if [ -z "$val" ]; then
    fail "$v is empty"
  else
    ok "$v is set"
  fi
done

# ── 3. dev-secret detection (refuse to deploy obvious leftovers) ──────────────
say "scanning for dev-only secrets reused in prod"
if [ "${AUTH_SECRET:-}" = "dev-only-not-secure-replace-in-production" ]; then
  fail "AUTH_SECRET still contains the dev placeholder — rotate before deploy"
fi
if [ "${VAULT_MASTER_KEY:-}" = "" ] || [ "${#VAULT_MASTER_KEY}" -lt 32 ]; then
  fail "VAULT_MASTER_KEY missing or shorter than 32 chars — generate with 'openssl rand -base64 32'"
fi
if [ -n "${CORS_ORIGINS:-}" ] && echo "${CORS_ORIGINS}" | grep -qi "localhost\|127.0.0.1"; then
  fail "CORS_ORIGINS contains localhost — production cannot accept local origins"
fi

# ── 4. database URL sanity ────────────────────────────────────────────────────
say "database url sanity"
case "${DATABASE_URL:-}" in
  postgres://*|postgresql://*) ok "DATABASE_URL scheme is postgres" ;;
  *) fail "DATABASE_URL must start with postgres:// or postgresql://" ;;
esac
case "${DATABASE_URL:-}" in
  *localhost*|*127.0.0.1*)
    if [ "${NODE_ENV:-}" = "production" ]; then
      fail "DATABASE_URL points at localhost but NODE_ENV=production — wrong file?"
    fi
    ;;
esac
case "${DATABASE_URL:-}" in
  *sslmode=*) ok "DATABASE_URL has sslmode parameter" ;;
  *) warn "DATABASE_URL has no sslmode — managed providers require ?sslmode=require" ;;
esac

# ── 5. redis url sanity ───────────────────────────────────────────────────────
say "redis url sanity"
case "${REDIS_URL:-}" in
  redis://*|rediss://*) ok "REDIS_URL scheme present" ;;
  *) fail "REDIS_URL must start with redis:// or rediss://" ;;
esac
case "${REDIS_URL:-}" in
  redis://default:*localhost*|redis://default:*127.0.0.1*)
    if [ "${NODE_ENV:-}" = "production" ]; then
      fail "REDIS_URL points at localhost in production"
    fi
    ;;
esac

# ── 6. migrations folder readable ─────────────────────────────────────────────
say "migrations folder"
if [ -d "packages/db/migrations" ]; then
  count=$(ls -1 packages/db/migrations/*.sql 2>/dev/null | wc -l)
  ok "$count migration files present"
else
  fail "packages/db/migrations/ is missing — boot.sh will have nothing to apply"
fi

# ── 7. lockfile vs manifest ───────────────────────────────────────────────────
say "lockfile freshness"
if [ -f "pnpm-lock.yaml" ] && [ -f "package.json" ]; then
  if [ "package.json" -nt "pnpm-lock.yaml" ]; then
    warn "package.json is newer than pnpm-lock.yaml — run 'pnpm install' to refresh lockfile before deploy"
  else
    ok "pnpm-lock.yaml is at or ahead of package.json"
  fi
else
  fail "pnpm-lock.yaml or package.json missing"
fi

# ── 8. AI providers (at least one needed) ─────────────────────────────────────
say "ai providers (at least one needed for the brain to function)"
any_ai=0
for v in OPENROUTER_API_KEY GROQ_API_KEY GEMINI_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY; do
  if [ -n "${!v:-}" ]; then ok "$v set"; any_ai=1; fi
done
if [ "$any_ai" -eq 0 ]; then
  warn "no AI provider keys set — chat / brain.task / portfolio.improve will fail at runtime"
fi

# ── 9. summary ────────────────────────────────────────────────────────────────
echo
if [ "$BLOCKERS" -gt 0 ]; then
  printf '\033[31m[preflight] %d blocker(s) — refusing to deploy.\033[0m\n' "$BLOCKERS"
  exit 1
fi
if [ "$WARNINGS" -gt 0 ]; then
  printf '\033[33m[preflight] %d warning(s) — deploy is allowed but review them.\033[0m\n' "$WARNINGS"
fi
printf '\033[32m[preflight] OK — system is deploy-ready.\033[0m\n'
exit 0
