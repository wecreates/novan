# Novan — Production Deploy Guide

Three ways to get Novan live tonight. Pick one.

## Option 1 — Docker Compose (self-hosted, 10 minutes)

Requirements: a VM with Docker, ≥2 vCPU, ≥4 GB RAM, a domain pointed at it.

```sh
# 1. Clone + configure
git clone <your-repo> novan
cd novan
cp .env.production.example .env.production
# Fill in:
#   POSTGRES_PASSWORD     — openssl rand -base64 24
#   REDIS_PASSWORD        — openssl rand -base64 24
#   AUTH_SECRET           — openssl rand -base64 48
#   VAULT_MASTER_KEY      — openssl rand -base64 32   (MUST be 32 bytes)
#   CORS_ORIGINS          — https://your-domain
#   OPENAI_API_KEY etc.   — only what you actually have

# 2. Build + start
docker compose -f docker-compose.production.yml --env-file .env.production up -d --build

# 3. Apply DB schema
docker compose -f docker-compose.production.yml exec api \
  node -e "require('./packages/db/dist/migrate.js').migrate()" \
  || docker compose -f docker-compose.production.yml exec api \
  sh -c "cd packages/db && pnpm drizzle-kit push --config=drizzle.config.ts"

# 4. Verify
docker compose -f docker-compose.production.yml logs api | tail -20
curl http://localhost:3001/health
open http://localhost:8080
```

Reverse proxy `:8080` behind Caddy/Nginx with your TLS cert and you're live.

## Option 2 — Fly.io (managed, ~15 minutes)

```sh
# Install flyctl: curl -L https://fly.io/install.sh | sh
fly auth login

# Get free DBs first:
#   https://console.neon.tech      → copy DATABASE_URL
#   https://console.upstash.com    → copy rediss:// REDIS_URL

export DATABASE_URL='postgresql://USER:PASS@HOST.neon.tech/DB?sslmode=require'
export REDIS_URL='rediss://default:PASS@HOST.upstash.io:PORT'
./scripts/deploy-fly.sh
```

The script is idempotent (re-runnable) and handles:
- App creation (`novan-api`, `novan-web`)
- Secret staging (auto-generates `AUTH_SECRET` + `VAULT_MASTER_KEY` if absent)
- `fly deploy -c fly.api.toml` — API runs all 42 SQL migrations on first boot via `boot.sh`
- `fly deploy -c fly.web.toml --build-arg VITE_API_BASE=…` — web embeds API URL
- Smoke tests both public URLs

Committed configs: `fly.api.toml`, `fly.web.toml`, `scripts/deploy-fly.sh`.

**Validated:** both Docker images build clean locally; the API image was booted against a fresh Postgres + applied all 42 migrations including this session's `0042_session_schema.sql` (ideas, issues, connectors, entity_relationships, operator_presence, skill_library), `/health` returned 200.

## Option 3 — Render.com (managed, 1-click-ish)

1. Connect your Git repo
2. Create a **Web Service** pointing at `apps/api/Dockerfile`
3. Create a **Static Site** pointing at `apps/web` with build command `pnpm install && pnpm --filter @ops/web build`, publish dir `apps/web/dist`
4. Create a managed **PostgreSQL** + **Redis** add-on
5. Set env vars from `.env.production.example`
6. Deploy

## After deploy: Tonight-Mode launch checklist

1. **Initialize safety flags** (auto-created on first request, but verify):
   ```sh
   curl https://api.your-domain/api/v1/launch-tonight/flags?workspace_id=default
   ```
   Confirm `tonightModeActive: true` and all dangerous flags `false`.

2. **Validate providers** (real network probe, no tokens burned):
   ```sh
   curl -X POST https://api.your-domain/api/v1/launch-tonight/validate-providers \
        -H 'Content-Type: application/json' \
        -d '{"workspace_id":"default"}'
   ```

3. **Run launch checklist**:
   ```sh
   curl https://api.your-domain/api/v1/launch-tonight/checklist?workspace_id=default
   ```
   Address every `fail` in `launchBlockers` before declaring ready.

4. **Verify runtime status**:
   ```sh
   curl https://api.your-domain/api/v1/launch-tonight/runtime-status?workspace_id=default
   ```

5. **Open War Room** → `/launch-tonight` page. The big green "READY TO LAUNCH" indicator confirms.

## Safety guarantees in Tonight Mode

These actions are **automatically blocked** until you explicitly enable them:

| Action | Default | Where to flip |
|---|---|---|
| Autonomous deploys | BLOCKED | POST `/flags` `autonomousDeployAllowed=true` |
| Self-edit loops | BLOCKED | `selfEditLoopsAllowed=true` |
| Autonomous dep upgrades | BLOCKED | `autonomousDepsUpgradesAllowed=true` |
| Destructive migrations | BLOCKED | `destructiveMigrationsAllowed=true` |
| Internet-learning swarm | BLOCKED | `internetLearningSwarmAllowed=true` |

These remain **ENABLED** in Tonight Mode (and should stay on):

- Approval-gated patches
- Failure-memory learning loop
- Observability + telemetry
- Strategic War Room
- Cron scans (incident detection, improvement engine, security team)
- Incident alerts

To leave Tonight Mode (only when ready):
```sh
curl -X POST .../api/v1/launch-tonight/tonight-mode/disable \
     -H 'Content-Type: application/json' \
     -d '{"workspace_id":"default","actor":"you","confirmation_code":"I_UNDERSTAND_THE_RISK"}'
```
