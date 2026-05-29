# Deploy Novan

The system has 4 supported deployment targets. Pick one. **You** run the deploy — the brain prepares the artifacts.

## TL;DR

| Target | Best for | Cost floor | One-line |
|---|---|---|---|
| **Render + Neon + Upstash** | Solo operator, fastest path | ~$25/mo | Push to GitHub, click Render Blueprint, paste secrets |
| **Fly.io + managed Postgres** | $-conscious, global edge | ~$15/mo | `fly launch` + manual env-var setup |
| **Self-hosted Docker** | Operator owns infra | hardware only | `docker compose -f docker-compose.production.yml up -d` |
| **Local-only (laptop brain)** | Pre-revenue testing | $0 | `pnpm dev`; no public surface |

Before any of these, run the pre-flight (catches the failure modes most first-time deployers hit):

```sh
cp .env.production.example .env.production
# Fill in EVERY required value — see comments in the file
./scripts/preflight.sh .env.production
```

Pre-flight exits non-zero on any blocker so you don't waste time chasing it after `up -d`.

---

## 1. Render + Neon + Upstash (recommended)

### Why
- Render auto-deploys on git push, runs the Dockerfile we ship, applies migrations via `boot.sh` on every boot, exposes `/health` for liveness
- Neon Postgres has a free tier with autoscaling + branching (useful for staging)
- Upstash Redis has a free tier sufficient for the BullMQ queues at solo-operator volume

### Steps

1. **Postgres**: create a Neon project → copy the `postgresql://...?sslmode=require` connection string
2. **Redis**: create an Upstash database → copy the `rediss://...` connection string
3. **Secrets**: generate the four production-required secrets:
   ```sh
   openssl rand -base64 48   # AUTH_SECRET
   openssl rand -base64 32   # VAULT_MASTER_KEY
   openssl rand -base64 32   # CHANNEL_ENCRYPTION_KEY
   ```
4. **Render**: New → Blueprint → select your GitHub repo → it reads `render.yaml`
5. **Fill in Dashboard secrets** for every `sync: false` env var
6. **Deploy**: Render builds the Dockerfile, runs `boot.sh` (applies migrations), starts the API

### Verify

```sh
curl https://your-render-app.onrender.com/health
# → { "status": "ok", "timestamp": 1716... }

curl https://your-render-app.onrender.com/api/v1/health/ready
# → checks Postgres + Redis connections
```

If `/health/ready` returns `503`, check the Render logs — `boot.sh` will have printed which migration failed.

### Frontend

The frontend is a static Vite build. Deploy separately:
- **Vercel**: import the repo, set root to `apps/web`, set `VITE_API_BASE_URL` to your Render API URL
- **Cloudflare Pages**: same idea
- **Render Static Site**: same

Update `CORS_ORIGINS` on the API to allowlist your frontend's domain.

---

## 2. Fly.io

```sh
fly launch --no-deploy        # generates fly.toml; edit to add a [build] section
fly secrets set AUTH_SECRET=... VAULT_MASTER_KEY=... CHANNEL_ENCRYPTION_KEY=... DATABASE_URL=... REDIS_URL=... CORS_ORIGINS=...
fly deploy
```

Fly's volumes can host Postgres+Redis but it's simpler to use external managed providers.

---

## 3. Self-hosted Docker (full stack on your hardware)

```sh
cp .env.production.example .env.production
# Fill in POSTGRES_USER/PASSWORD/DB, REDIS_PASSWORD, AUTH_SECRET, VAULT_MASTER_KEY,
# CHANNEL_ENCRYPTION_KEY, CORS_ORIGINS, AI provider keys
./scripts/preflight.sh .env.production
docker compose -f docker-compose.production.yml --env-file .env.production up -d
docker compose -f docker-compose.production.yml logs -f api
```

The compose stack brings up postgres + redis + api + (optionally) the workers. Migrations run on every API boot — idempotent via `schema_migrations_history` table.

**You're responsible** for:
- SSL termination (put Caddy or Nginx in front, or use Cloudflare Tunnel)
- Backups (`pg_dump` on a cron; volume snapshot is not enough)
- OS-level firewalling
- Monitoring (the API ships pino structured logs; pipe to Loki/Grafana or Datadog)

---

## 4. Local-only (no internet exposure)

```sh
pnpm install
docker compose -f docker-compose.local.yml up -d  # local Postgres + Redis
pnpm --filter @ops/api dev                        # API in dev mode
pnpm --filter @ops/web dev                        # Vite dev server
```

This is the right mode for testing the brain on a sample workspace before you commit revenue tracking to a real one.

---

## Post-deploy checklist

After the API is healthy:

1. **Create your first workspace**: `POST /api/v1/workspaces` (operator endpoint)
2. **Verify the production-readiness self-check**: `POST /api/v1/launch/audit` — every check should be `passed` or `unverified` (unverified is honest; `failed` blocks production)
3. **Connect at least one AI provider**: settings → providers → paste key → enable
4. **Set the operator's monthly target floor**: it defaults to $10,000/business (the platform floor); cannot go lower
5. **Connect at least one channel/shop** via `business.attach` so revenue auto-rolls
6. **Walk the operator-runbook.md** (Daily / Weekly / Monthly routines)

## Rollback

```sh
# Docker stack
docker compose -f docker-compose.production.yml down
docker compose -f docker-compose.production.yml up -d --no-build  # uses last good image

# Render
Dashboard → Deploys → "Rollback to this deploy"

# Database (if a migration went bad)
# Migrations are idempotent and CREATE-IF-NOT-EXISTS, so re-applying old state is safe.
# Destructive changes are gated — if you need to roll back data, restore from pg_dump.
```

## Honest limits

- **You** sign the cloud-provider TOS, pay the bill, hold the OAuth credentials, and own every operator action the system takes
- **You** decide whether to enable autonomy flags (Tomorrow Mode / self-edit-loops / autonomous_writes) — they default OFF
- **You** verify your domain's email/SPF/DKIM if you wire up notification webhooks
- **The brain** prepares plans + drafts content + records revenue; **money flow is always operator-confirmed**

If a deploy fails, the failure mode the API exhibits is "refuse to boot with explicit error" — it doesn't half-boot. Read the logs from the failed boot; the production validator names every missing env var.
