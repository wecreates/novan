# Deploy Novan to a DigitalOcean Droplet

Tested path (verified R145 on a $12/mo droplet, 1 vCPU / 2 GB / NYC1).
Same compose stack works on any Ubuntu 24.04 host with Docker.

**Time budget:** ~15 min from clicking "Create Droplet" to a green health probe.

---

## Part A — Create the droplet

1. Console → **Droplets → Create**
2. Region: anywhere near you (NYC1, SFO3, FRA1 — all fine)
3. Image: **Ubuntu 24.04 LTS x64**
4. Size: **Basic / Regular CPU / $12/mo (1 vCPU, 2 GB, 50 GB)** minimum.
   - 1 GB is too tight — Postgres + Redis + API + cron will OOM under any load.
5. Add an SSH key (generate locally with `ssh-keygen -t ed25519`)
6. Name: `novan`
7. Create. Note the public IP.

---

## Part B — Bootstrap (one SSH session)

```bash
ssh -i ~/.ssh/novan.key root@<PUBLIC_IP>

# Prereqs
apt-get update -qq
apt-get install -y -qq curl git
curl -fsSL https://get.docker.com | sh

# Repo
git clone https://github.com/YOUR_USER/novan.git /root/novan
cd /root/novan
```

---

## Part C — `.env` (self-hosted variant)

Self-hosted means postgres + redis run **in-stack** (not Neon/Upstash).
The default `.env.production.example` is geared toward managed DBs;
override the DB/Redis URLs to point at the in-stack services.

```bash
VAULT=$(openssl rand -base64 32)
AUTH=$(openssl rand -base64 48)
CHANNEL=$(openssl rand -base64 32)        # R145 — required in prod
PGPASS=$(openssl rand -hex 16)
REDISPASS=$(openssl rand -hex 16)

cat > /root/novan/.env <<EOF
NODE_ENV=production
RUNTIME_MODE=cloud-api-only
API_PORT=3001
API_HOST=0.0.0.0
WEB_PORT=3000
LOG_LEVEL=info

POSTGRES_USER=novan
POSTGRES_PASSWORD=${PGPASS}
POSTGRES_DB=ops
DATABASE_URL=postgresql://novan:${PGPASS}@postgres:5432/ops

REDIS_PASSWORD=${REDISPASS}
REDIS_URL=redis://:${REDISPASS}@redis:6379

VITE_API_BASE_URL=http://<PUBLIC_IP>:3001
CORS_ORIGINS=http://<PUBLIC_IP>:3000

AUTH_SECRET=${AUTH}
VAULT_MASTER_KEY=${VAULT}
CHANNEL_ENCRYPTION_KEY=${CHANNEL}
EOF
chmod 600 /root/novan/.env
```

---

## Part D — Bring up the stack

`docker-compose.production.yml` is already configured for pgvector image
+ `/api/v1/health` healthcheck (both R145 fixes). Bring up postgres first
so we can create the `vector` extension before the API runs migrations:

```bash
cd /root/novan

# 1. Postgres + Redis only
docker compose -f docker-compose.production.yml --env-file .env up -d postgres redis

# 2. Wait ~6s for pg to be ready, then enable pgvector
sleep 6
docker exec novan-postgres-1 psql -U novan -d ops -c "CREATE EXTENSION IF NOT EXISTS vector;"

# 3. Now bring everything up. API will run migrations on first boot.
docker compose -f docker-compose.production.yml --env-file .env up -d

# 4. Wait for API to settle
until curl -s http://localhost:3001/api/v1/health | grep -q ok; do sleep 5; done
echo "API live"
```

---

## Part E — Add an LLM API key

```bash
nano /root/novan/.env
# uncomment + paste at least one of:
#   GROQ_API_KEY=gsk_...
#   ANTHROPIC_API_KEY=sk-ant-...
#   OPENAI_API_KEY=sk-...
#   GEMINI_API_KEY=...

# Recreate api to pick up the new env
docker compose -f docker-compose.production.yml --env-file .env up -d --force-recreate api
```

---

## Part F — Smoke test

```bash
# Health
curl http://<PUBLIC_IP>:3001/api/v1/health
# {"status":"ok",...}

# Web (Caddy + static SPA)
open http://<PUBLIC_IP>:3000

# PWA on phone
# Browser: http://<PUBLIC_IP>:3000/m/chat
# Tap menu → Add to Home Screen
```

---

## Web container redeploy (after `pnpm build`)

R146.26 — `tar -xzf` does NOT remove pre-existing files in the target
directory. Without a `rm -rf` first, each deploy stacks new asset chunks
on top of the old ones in `apps/web/dist/`, and `docker cp` then copies
the bloated directory into the web container. Eight deploys had grown
`/srv` to 27 MB / 1060 files with 508 source maps shipped. Clean ritual:

```bash
# Local: build with NODE_ENV=production so source maps are dropped
cd apps/web && NODE_ENV=production pnpm build
tar -czf /tmp/web-dist.tar.gz dist

# Copy to droplet + atomic swap
scp /tmp/web-dist.tar.gz root@<droplet>:/tmp/
ssh root@<droplet> '
  cd /root/novan
  rm -rf apps/web/dist                     # ← critical: clear staging
  tar -xzf /tmp/web-dist.tar.gz
  docker cp apps/web/dist novan-web-1:/srv-new
  docker exec novan-web-1 sh -c "rm -rf /srv-old; mv /srv /srv-old && mv /srv-new /srv && rm -rf /srv-old"
'
```

Healthy size = ~3.5 MB / ~177 files / 0 maps.

## Maintenance

```bash
# Update Novan
cd /root/novan && git pull
docker compose -f docker-compose.production.yml --env-file .env up -d --build

# Logs
docker compose -f docker-compose.production.yml logs -f api

# DB backup
docker exec novan-postgres-1 pg_dump -U novan ops | gzip > novan-$(date +%F).sql.gz

# Full restart
cd /root/novan && docker compose -f docker-compose.production.yml restart

# Nuke and start over
docker compose -f docker-compose.production.yml down -v
# then re-run Part D
```

---

## Gotchas observed in the first deploy

These are all fixed in the repo now; documented for next time.

1. **`vanilla postgres:16-alpine` lacks `vector` extension** → migration 0000 fails at `vector(768)` column type → schema partial → `workspaces` and `memories` missing → API crashes on every endpoint. Fix: `pgvector/pgvector:pg16` image + manual `CREATE EXTENSION` before API runs migrations.

2. **`CHANNEL_ENCRYPTION_KEY` is required in production** by `validateEnvOrThrow()`. Without it, API exits with FATAL before binding any port → container is "unhealthy" → web's `depends_on: api { service_healthy }` never satisfied → web stays in `Created` state forever.

3. **Healthcheck path was `/health`** but Fastify mounts at `/api/v1/health`. Same downstream symptom as #2 (api always unhealthy, web never starts).

4. **Env vars in `.env` aren't automatically forwarded** to the container. Compose only passes vars listed under each service's `environment:` block. New env vars need an entry there OR `env_file: - .env` (latter passes everything but loses visibility).

5. **No Oracle iptables workaround needed.** DigitalOcean droplets ship with permissive iptables by default. The `deploy-oracle.sh` script's iptables-fixing step is Oracle-specific.

6. **Caddyfile directive order** (fixed R146.2). The web container's Caddyfile had `file_server` + `try_files {path} /index.html` declared above the `handle /api/*` reverse-proxy block. In Caddy that means try_files runs first and rewrites `/api/v1/*` to `/index.html` before the proxy can match — so the PWA, which calls relative `/api/v1/chat/stream`, got the SPA HTML back instead of the SSE stream. The fix wraps try_files + file_server in a default `handle {}` so they only fire when no upstream-prefix handle matched.

7. **Stale provider defaults** (fixed R146 / R146.3). Two model IDs in `chat-providers.ts` had aged out of validity since the codebase was last reviewed:
   - `gemini-2.0-flash` is listed in `:listModels` but `:streamGenerateContent` returns 404 on current Generative Language API keys. Replaced with `gemini-2.5-flash`.
   - `claude-3-5-sonnet-latest` no longer resolves — Anthropic retired Sonnet 3.5 in Jan 2026 and dropped the `-latest` alias convention at the 4.6 generation. Replaced with `claude-sonnet-4-6`.

8. **streamChat fallback chain swallowed the diagnostic** (fixed R146 / R146.3). When every configured provider failed, the loop nulled `provider` and yielded a generic `_(No LLM provider configured)_` tail message — hiding the real upstream HTTP statuses (e.g. groq 429 + gemini 404). Now: each failed iteration's error marker is accumulated into a `failureMarkers` list, and the fallback-exhausted branch flushes the entire chain so the operator sees every provider's failure.

9. **Groq free-tier rate limits.** Groq's free tier is ~30 RPM / ~14.4k TPM on `llama-3.3-70b-versatile`. A single multi-turn PWA chat with the playbook system prompt blasts past that and 429s into the gemini fallback. If you want chat to stay on groq, either add a paid Groq tier key or set `prefer_provider: "groq"` only after the rate window resets. Watching the api logs for `_(groq error: 429 ...)_` markers is the diagnostic.

10. **HTTPS / TLS not configured.** This runbook stops at raw HTTP on `:3000` / `:3001` over Tailscale. That's fine for the Tailscale-only PWA install, BUT iOS Safari refuses to install service workers (and therefore Web Push from R129) without HTTPS. If you want push notifications on iPhone, add a domain + auto-TLS via Caddy (uncomment `:443` block + add an `A` record) or front the droplet with a Cloudflare Tunnel.

11. **API auth coverage is partial — Tailscale is the security boundary.** A scan of `apps/api/src/routes/*.ts` found **93 of 93 route files have ZERO `preHandler: app.authenticate`**. The auth plugin only decorates `app.authenticate` — it never registers as a global `onRequest` hook. Routes that don't opt in explicitly are wide open. In the current Tailscale-only deploy this is safe because port `3001` is bound to `100.116.59.64` (the Tailscale IP) and Docker doesn't expose it on the public internet, so only devices on your Tailnet can reach the API. **BEFORE you add a public domain + HTTPS (gotcha #10), wire global auth** — either an `app.addHook('onRequest', app.authenticate)` in `server.ts` with an explicit allowlist for `/api/v1/health`, `/docs`, `/metrics`, `/api/v1/webhooks/*`, OR add `preHandler: app.authenticate` to every route file individually. NODE_ENV=production already makes `devAutoAuthActive()` return false, but with no `preHandler` calling `authenticate`, the auth plugin never runs at all on those routes.

    **R146.23 attempted + reverted — read before retrying.** I added the global `onRequest` hook with the obvious public-prefix allowlist. Tests passed (2061/2061; they use dev-mode auto-auth). Droplet deploy succeeded: `/api/v1/health` returned 200, `/api/v1/agents` correctly returned 401. **BUT chat broke** — the PWA frontend doesn't send a `Bearer` token (the operator never logs in; it relies on the unauthenticated path that Tailscale gates externally). Every `/api/v1/chat/...` request returned `{"error":"Unauthorized"}`. The hook was reverted in the same session.

    What's actually needed before re-enabling global auth:
    1. **Operator-side auth source.** Either issue a long-lived API token + bake it into the PWA `localStorage` (need a "first-login on Tailnet sets the token" flow), OR set up a session cookie via `/api/v1/auth/login` + `credentials: 'include'` on every `fetch`.
    2. **Frontend `api.ts` must send the token.** Currently it doesn't — `apps/web/src/api.ts` has no `Authorization` header injection.
    3. **The web-push / QR-quicklink flows already have their own pre-auth bootstrap paths** — they go through `/api/v1/auth/quick-link` (already in the planned allowlist).

    Mark this as the next major hardening step. Until then: keep ports bound to `100.116.59.64` (Tailscale IP), do NOT add the public-IP listener in docker-compose, do NOT expose via Cloudflare Tunnel to the open internet.

    **R146.24 — bootstrap endpoint shipped.** Frontend now has `/setup` page. Backend has `POST /api/v1/auth/bootstrap` (rate-limited 3/min, requires `OPERATOR_BOOTSTRAP_SECRET` env match). To mint the first operator token:
    1. Generate a strong secret: `openssl rand -base64 48`
    2. Add to `/root/novan/.env`: `OPERATOR_BOOTSTRAP_SECRET=<that-value>`
    3. Restart the api: `docker compose -f docker-compose.production.yml --env-file .env up -d --force-recreate api`
    4. From the laptop/phone on Tailnet, open `http://novan.tail0a7ab4.ts.net:3000/setup` and paste the secret + workspace_id (default = `default`)
    5. Token lands in browser `localStorage['ops_auth_token']`; `api.ts` already attaches `Authorization: Bearer <token>` on every fetch
    6. Once you have a token in the PWA, you can re-enable R146.23 global auth (uncomment the `app.addHook('onRequest', ...)` block in server.ts) without breaking chat

    The bootstrap secret is single-purpose: anyone with it can mint a `default`-workspace token, so it's equivalent in trust to `.env` itself. Rotate it after first use by setting a new value + restarting.

---

## Why DigitalOcean over Oracle Always Free

Oracle Free Tier A1.Flex ARM capacity was sold out in every region we
tried for >24h, single-AD regions like US-Sanjose have no failover, and
the wizard's hidden state made the public-IPv4 toggle un-clickable. $12/mo
on DO saves the 2–6 hours of fighting Oracle's UI. The 2-vCPU/4-GB tier is
also more honest for Novan's working set than the 4-OCPU/24-GB A1.Flex
would have been on a cold-start free tenancy.
