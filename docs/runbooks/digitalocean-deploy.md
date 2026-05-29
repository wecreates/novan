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

---

## Why DigitalOcean over Oracle Always Free

Oracle Free Tier A1.Flex ARM capacity was sold out in every region we
tried for >24h, single-AD regions like US-Sanjose have no failover, and
the wizard's hidden state made the public-IPv4 toggle un-clickable. $12/mo
on DO saves the 2–6 hours of fighting Oracle's UI. The 2-vCPU/4-GB tier is
also more honest for Novan's working set than the 4-OCPU/24-GB A1.Flex
would have been on a cold-start free tenancy.
