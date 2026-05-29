# Running Novan 24/7 without your laptop

The platform has two layers:

| Layer                   | Runs on                          | Always-on?       |
|-------------------------|----------------------------------|------------------|
| **Core** (API, DB, workers, chat, brain, research, scheduled production planning, publishing, analytics) | Cloud (Fly.io / VPS) | Yes — 24/7 |
| **GUI-driven ops** (CapCut, Mixcraft, ACE-Step on local GPU) | Your Windows PC | Only when that PC is on |

When the Windows PC is off, GUI ops queue cleanly in the `gui_queue` table
and resume automatically when the bridge comes back online. The brain
still runs, still researches, still chats, still produces voiceover +
captions + thumbnails + analytics — only the local-GPU and local-DAW
steps wait.

---

## 1. Cloud deployment (pick one)

### Option A — Fly.io (easiest, already configured)

```bash
fly apps create novan-api
fly secrets set -c fly.api.toml \
  DATABASE_URL='postgresql://…' \
  REDIS_URL='redis://…' \
  AUTH_SECRET=$(openssl rand -base64 48) \
  VAULT_MASTER_KEY=$(openssl rand -base64 32) \
  OPENAI_API_KEY=… ANTHROPIC_API_KEY=… GEMINI_API_KEY=… GROQ_API_KEY=… \
  PEXELS_API_KEY=… PIXABAY_API_KEY=… UNSPLASH_ACCESS_KEY=… \
  ELEVENLABS_API_KEY=… \
  YOUTUBE_ACCESS_TOKEN=… TIKTOK_ACCESS_TOKEN=… \
  CHANNEL_ENCRYPTION_KEY=$(openssl rand -base64 48)
fly deploy -c fly.api.toml
fly deploy -c fly.web.toml
```

Database: use **Neon** (free postgres) or Fly Postgres.
Redis: use **Upstash** (free tier).

### Option B — VPS via docker-compose

```bash
# On Hetzner / DigitalOcean / Linode / etc.
git clone <repo> && cd ops-platform
cp .env.production.example .env.production
# edit .env.production with your secrets
docker compose -f docker-compose.production.yml --env-file .env.production up -d
docker compose -f docker-compose.production.yml logs -f api
```

Put Caddy or Cloudflare Tunnel in front for HTTPS.

---

## 2. Windows bridge (optional — only if you want CapCut/Mixcraft/ACE-Step working)

The bridge runs on your always-on Windows PC (could be your laptop, a
mini-PC, or a Windows VM). It polls the cloud API for queued GUI jobs,
executes them locally, and posts results back.

### One-time setup

```powershell
# On the Windows box
cd C:\Users\<you>\ops-platform
pnpm install
pnpm --filter @ops/api build     # bridge imports from apps/api/dist

# Set bridge env (use System Environment Variables for persistence)
[System.Environment]::SetEnvironmentVariable('NOVAN_API_URL',      'https://api.your-host.com', 'Machine')
[System.Environment]::SetEnvironmentVariable('NOVAN_API_TOKEN',    '<workspace token from /api/v1/tokens>', 'Machine')
[System.Environment]::SetEnvironmentVariable('NOVAN_WORKSPACE_ID', 'default', 'Machine')
[System.Environment]::SetEnvironmentVariable('NOVAN_REPO_PATH',    'C:\Users\<you>\ops-platform', 'Machine')
```

### Install as a Windows service (auto-restart, runs at boot)

```powershell
# Install nssm if you don't have it (https://nssm.cc)
nssm install NovanBridge "C:\Program Files\nodejs\node.exe" `
  "C:\Users\<you>\ops-platform\apps\windows-bridge\bridge.mjs"
nssm set NovanBridge AppDirectory  "C:\Users\<you>\ops-platform\apps\windows-bridge"
nssm set NovanBridge AppStdout     "C:\Users\<you>\ops-platform\logs\bridge.out.log"
nssm set NovanBridge AppStderr     "C:\Users\<you>\ops-platform\logs\bridge.err.log"
nssm set NovanBridge Start         SERVICE_AUTO_START
# Restart on crash with 5s delay, infinite retries
nssm set NovanBridge AppExit Default Restart
nssm set NovanBridge AppRestartDelay 5000
nssm start NovanBridge
```

### Verify

```bash
# From the cloud, check if bridge is alive
curl -X POST https://api.your-host.com/api/v1/brain/task \
  -H 'authorization: Bearer <token>' \
  -d '{"plan":[{"op":"bridge.status"}]}'
# → { active: true, lastSeenMs: 4123, pendingJobs: 0 }
```

---

## 3. Mode switching

The cloud API auto-detects routing via `process.platform` + `NOVAN_GUI_REMOTE`:

| Platform                  | NOVAN_GUI_REMOTE | Behaviour                                |
|---------------------------|------------------|------------------------------------------|
| linux/darwin (cloud)      | unset            | Queue → wait for bridge                  |
| win32 (operator PC)       | unset            | Run locally (Mixcraft/CapCut/ACE-Step)   |
| win32 with NOVAN_GUI_REMOTE=1 | set         | Always queue (useful when running API + bridge on same box, but want async behaviour) |

---

## 4. What works without the bridge (cloud-only mode)

Even when the Windows PC is off, **all of this still runs 24/7**:

- ✅ Chat + brain reasoning
- ✅ Autonomous-mind research loop
- ✅ Feed ingestion (RSS)
- ✅ Music & video knowledge recall + research findings
- ✅ Video asset scraping (Pexels/Pixabay/Unsplash)
- ✅ AI b-roll generation (Runway/Luma/Replicate — all cloud APIs)
- ✅ Voiceover synthesis (ElevenLabs/OpenAI TTS)
- ✅ Captions (Whisper via Groq/OpenAI cloud)
- ✅ Color grading + brand-kit apply (ffmpeg server-side)
- ✅ Audio ducking (ffmpeg server-side)
- ✅ Mastering chain (ffmpeg server-side)
- ✅ Thumbnail generation (DALL-E + Gemini ranking, both cloud)
- ✅ Publishing to YouTube / TikTok
- ✅ Analytics snapshots
- ✅ Scheduled production planning (queues jobs to bridge)

Only these **wait** for the bridge:

- ⏳ CapCut assemble
- ⏳ Mixcraft compose
- ⏳ ACE-Step music generation (it's local GPU)

When the bridge comes back online, queued jobs auto-resume in FIFO order.

---

## 5. Health monitoring

```bash
# Bridge liveness
brain.task bridge.status

# Queue depth + recent jobs
brain.task bridge.listJobs '{"limit":20}'

# Production audit log
brain.task production.log '{"days":7}'

# TTS cost guard
brain.task tts.status

# GUI mutex (local mode)
brain.task gui.status
```

---

## 6. Backups

```bash
# Daily postgres dump → S3
0 3 * * *  docker compose exec -T postgres pg_dump -U $POSTGRES_USER $POSTGRES_DB \
              | aws s3 cp - s3://novan-backups/$(date +\%Y-\%m-\%d).sql.gz
```

---

## 7. Cost ceiling

- **Fly.io**: ~$10/mo (shared 256MB, 1 machine min)
- **Neon postgres free tier**: $0
- **Upstash Redis free tier**: $0
- **Bridge PC**: existing hardware (laptop / mini-PC / NUC)
- **API providers**: variable (TTS budget guarded at 200k chars/day ≈ $11/day cap)

Total floor: **~$10/mo cloud**, the rest is provider usage.
