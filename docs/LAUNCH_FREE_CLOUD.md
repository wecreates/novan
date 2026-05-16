# Novan — Free Cloud Launch (Vercel + Render + Neon + Upstash)

Total cost: **$0** on free tiers. Total time: **~20 minutes**. All steps copy-paste.

## Architecture

```
   Browser
      │
      ▼
   Vercel (frontend — static)
      │  /api proxy
      ▼
   Render (backend — Node container)
      │
      ├──▶ Neon Postgres        (free 0.5 GB)
      ├──▶ Upstash Redis        (free 10k cmds/day)
      └──▶ OpenRouter / Groq / Gemini APIs
```

`RUNTIME_MODE=cloud-api-only` → backend refuses local sandbox execution. All AI calls go through the provider router.

---

## Step 1 — Neon (Postgres)

1. Go to https://neon.tech → sign up with GitHub
2. New project → name `novan`, region close to your users
3. Copy the **pooled** connection string (ends with `-pooler.region.aws.neon.tech`). It looks like:
   ```
   postgresql://USER:PASS@ep-xxx-pooler.us-east-2.aws.neon.tech/novan?sslmode=require
   ```
4. Save as `DATABASE_URL`

## Step 2 — Upstash (Redis)

1. Go to https://upstash.com → sign up with GitHub
2. Redis → Create Database → name `novan`, region close to your Render region
3. Tab "Details" → copy the **ioredis-compatible URL** (starts with `rediss://`)
4. Save as `REDIS_URL`

## Step 3 — Generate secrets locally

```sh
openssl rand -base64 48          # → AUTH_SECRET
openssl rand -base64 32          # → VAULT_MASTER_KEY  (must be exactly 32 bytes)
```

## Step 4 — AI provider keys

You only need **one** of these to launch with real AI; the system runs without any (UI works, AI calls just fail gracefully).

| Provider | Where | Free tier |
|---|---|---|
| **OpenRouter** | https://openrouter.ai → Keys | $0 credits, pay-as-you-go |
| **Groq** | https://console.groq.com → API Keys | Free tier with rate limits |
| **Gemini** | https://aistudio.google.com → Get API key | Generous free tier |

Save the ones you have as `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`.

## Step 5 — Push Postgres schema

From your local machine (one time):

```sh
git clone <your-repo> novan && cd novan
pnpm install
DATABASE_URL="<your-neon-url>" pnpm db:push
```

This creates all 60+ tables. Idempotent — safe to re-run.

## Step 6 — Deploy backend to Render

1. Go to https://dashboard.render.com → New → Blueprint
2. Connect your GitHub repo → Render detects `render.yaml`
3. Click "Apply" → Render creates the `novan-api` service
4. After creation, click into the service → Environment tab → add the secrets marked `sync: false`:

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | Neon URL from Step 1 |
   | `REDIS_URL` | Upstash URL from Step 2 |
   | `AUTH_SECRET` | from Step 3 |
   | `VAULT_MASTER_KEY` | from Step 3 |
   | `CORS_ORIGINS` | `https://<your-vercel-app>.vercel.app` (fill after Step 7) |
   | `OPENROUTER_API_KEY` | from Step 4 (if you have it) |
   | `GROQ_API_KEY` | from Step 4 (if you have it) |
   | `GEMINI_API_KEY` | from Step 4 (if you have it) |

5. Click "Deploy latest commit". First build takes ~5 min. Watch logs.
6. When status = Live, copy the URL (e.g. `https://novan-api.onrender.com`)
7. Verify: `curl https://novan-api.onrender.com/health` → expect `{"status":"ok"}`

> Render's free tier sleeps after 15 min idle. First request after sleep takes ~30s to wake. Upgrade to Starter ($7/mo) for always-on.

## Step 7 — Deploy frontend to Vercel

1. Go to https://vercel.com → Add New → Project
2. Import your GitHub repo
3. Framework Preset: **Other** (auto-detected via `vercel.json`)
4. Root directory: leave as repo root
5. Environment Variables → add:

   | Key | Value |
   |---|---|
   | `VITE_API_BASE_URL` | `https://novan-api.onrender.com` (from Step 6) |

6. **Edit `vercel.json`** in your repo: replace `https://novan-api.onrender.com` in the `rewrites` section with your actual Render URL. Commit + push.
7. Click Deploy. First build ~3 min.
8. Copy the Vercel URL (e.g. `https://novan-xxx.vercel.app`)
9. Go back to Render → update `CORS_ORIGINS` env var to include this URL → save → service auto-restarts

## Step 8 — Verify

Run the launch verifier against your live API:

```sh
DATABASE_URL=<neon-url> REDIS_URL=<upstash-url> \
OPENROUTER_API_KEY=<key> GROQ_API_KEY=<key> GEMINI_API_KEY=<key> \
AUTH_SECRET=x VAULT_MASTER_KEY=$(openssl rand -base64 32) \
PROVIDER_ROUTER_ENABLED=true BUDGET_GUARDS_ENABLED=true KILL_SWITCH_ENABLED=true \
RUNTIME_MODE=cloud-api-only \
node scripts/verify-launch.mjs https://novan-api.onrender.com
```

Expected: green pass count, zero critical failures.

Then open your Vercel URL → War Room → **Launch Tonight** page → click **Validate** for providers → confirm green dots.

## Step 9 — Confirm safety posture

War Room → **Launch Tonight** page should show:

- ✅ Tonight Mode active
- ✅ Autonomous deploy blocked
- ✅ Destructive migrations blocked
- ✅ Approval-gated patches enabled
- ✅ Failure-memory learning enabled
- ✅ Observability enabled
- ✅ Background cron scans enabled
- ✅ Incident alerts enabled

All dangerous toggles should be **OFF**.

---

## Active learning systems after launch

| System | Source | Active by default |
|---|---|---|
| Failure memory | verification-engine + patch-executor | Yes |
| Repeat-fix block (3-strike) | audit dispatch endpoint | Yes |
| Incident detector (7 detectors) | cron every 5 min | Yes |
| Improvement engine (7 analyzers) | cron every 15 min | Yes |
| Security team (10 agents) | cron every 10 min | Yes |
| Provider router | per-request gate | Yes (when keys configured) |
| Budget guards | per-request gate | Yes |
| Kill switches | per-request gate | Available, configure as needed |

## Disabled unsafe systems (Tonight Mode defaults)

| System | Default | Why |
|---|---|---|
| Autonomous deploys | OFF | No production deploy without human |
| Unrestricted patch auto-apply | OFF | All risky patches require approval |
| Autonomous dep upgrades | OFF | package.json mutations blocked |
| Auth/payment/database edits | OFF (approval-gated) | Risk classifier escalates |
| Destructive migrations | OFF | schema/migration paths blocked |
| Self-edit loops | OFF | Flag exists, no swarm code anyway |
| Internet learning swarm | OFF | Flag exists, no swarm code anyway |

---

## Common deploy issues

**`VAULT_MASTER_KEY must decode to exactly 32 bytes`** → you ran `openssl rand -base64 24` instead of `32`. Use 32.

**Render build OOMs** → free tier has 512MB. `Dockerfile` is optimized but pnpm install is heavy. If it OOMs, upgrade to Starter ($7/mo, 1GB).

**Vercel `/api` calls 404** → check `vercel.json` rewrites point to the right Render URL. Must be committed + redeployed.

**CORS errors in browser console** → `CORS_ORIGINS` on Render doesn't include your Vercel URL exactly. Must match scheme + host (no trailing slash).

**Neon "connection terminated"** → use the **pooled** connection string (URL contains `-pooler`), not the direct one. Required for serverless/short-lived processes.

**Upstash "ETIMEDOUT"** → your Render region is far from your Upstash region. Recreate Upstash in the same region as Render.

---

## Rollback

Render: dashboard → service → Manual Deploy → pick previous green build.
Vercel: dashboard → project → Deployments → Promote previous deployment to Production.
Neon: dashboard → Branches → restore from a branch checkpoint.

The repo also has `pnpm run verify:launch` which exits non-zero on critical failures — wire that as a Render pre-deploy hook for extra safety.
