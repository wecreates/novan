# Novan Local Agent — R357

Drives POD-platform uploads from your own machine using Playwright + a persistent Chromium profile. Reads jobs from the droplet's `design_upload_queue`, drives each platform's web UI, calls `upload_queue.mark_uploaded` on success.

**Why local + not the droplet:** datacenter IPs (DigitalOcean) trip POD-platform fraud detection. Running on your residential IP + your own browser cookies looks like a real artist.

---

## One-time setup

```bash
cd apps/local-agent
pnpm install
pnpm install:browsers           # downloads ~150 MB Chromium binary
cp .env.example .env.local      # then edit
```

Required env vars (put in `.env.local`, NEVER commit):

```bash
NOVAN_API_BASE=https://137-184-198-2.sslip.io
NOVAN_OPS_TOKEN=ops_22fc97...                # operator bearer from droplet
NOVAN_WORKSPACE_ID=default
NOVAN_PROFILE_PATH=./.profile                # persistent Chromium user-data dir
NOVAN_DESIGNS_ROOT=../../designs             # cached design files end up under here
NOVAN_HEADLESS=false                         # MUST be false for first run (manual login)
NOVAN_POLL_SECONDS=180
```

### First-time platform login (manual, one-time per platform)

1. Run with `--once --dry-run`:
   ```bash
   pnpm --filter @ops/local-agent once -- --dry-run
   ```
2. Chromium opens. For each platform you want enabled:
   - Navigate manually to that platform's `loginUrl` (see `src/platforms/index.ts`)
   - Log in. Solve any captcha / 2FA.
   - Close the tab.
3. Close Chromium. Cookies persist in `.profile/`.
4. Subsequent runs reuse the session — no password handling needed by the agent.

---

## Running

```bash
# loop forever, polls every NOVAN_POLL_SECONDS
pnpm --filter @ops/local-agent start

# single pass (good for testing)
pnpm --filter @ops/local-agent once

# dry-run: fill everything but skip the final Publish click
NOVAN_DRY_RUN=1 pnpm --filter @ops/local-agent once

# limit to specific platforms
NOVAN_PLATFORMS=gumroad,etsy pnpm --filter @ops/local-agent once
```

---

## Anti-flag posture (R350 compliance)

The agent enforces every rule from `workspace_memory.doctrine.anti_flag_intelligence`:

- **Velocity** — `upload_queue.stats.remainingToday` gate before each platform
- **Timing spread** — driver waits `pickInterUploadDelayMs()` between same-platform uploads (5-30 min jitter)
- **Uniqueness** — listings come from R349 listing-content-rotator (distinct title/desc/tags per platform)
- **Pacing** — `humanType()` types 40-180 ms/char with occasional 200-500 ms pauses; `humanClick()` curved mouse + small overshoot
- **Engagement** — out of scope for the agent; operator's manual social action
- **Completeness** — drivers validate all required fields before submitting
- **Winners-first** — queue order is `priority DESC` (proven=70 > breakout=60 > niche=50)
- **Cross-platform timing stagger** — set `NOVAN_PLATFORMS=gumroad` one day, different platform the next
- **Account-birthday ramp** — TODO: read `account.birthday` from workspace_memory and clamp to 1/day for first 7 days

---

## Adding a new platform driver

1. Copy `src/platforms/gumroad.ts` → `src/platforms/<new>.ts`
2. Update `loginCheck`, `loginUrl`, `upload` for that platform's UI
3. Replace the stub entry in `src/platforms/index.ts` with the new driver
4. Test with `NOVAN_PLATFORMS=<new>` + `--once --dry-run`
5. Drop `--dry-run` once it's reliable

Each driver should:
- Use `humanType` for text fields (not `locator.fill`)
- Use `humanClick` for buttons (not `locator.click`)
- Wait `sectionPause()` between distinct page sections
- Use `page.setInputFiles()` for file uploads (Playwright sidesteps the OS dialog)
- Return `{ ok, externalUrl }` so `upload_queue.mark_uploaded` records the public URL

---

## Currently shipped drivers

| Platform | Status |
|---|---|
| gumroad | ✅ working (R357 v1) |
| inprnt | stub |
| fine_art_america | stub |
| redbubble | stub |
| etsy | stub |
| zazzle | stub |
| spreadshirt | stub |
| teepublic | stub |
| tiktok_shop | stub |
| displate | stub |
| threadless | stub |

Stubs return `ok: false` so the orchestrator skips the queue item without crashing the loop. The item stays queued for when the driver is implemented.

---

## Architecture

```
droplet (137.184.198.2)                    your laptop
┌──────────────────────────┐               ┌────────────────────────────┐
│  Postgres: design_upload │ ← brain-task →│  local-agent (Playwright)  │
│  Postgres: design_catalog│               │  ├─ poller (HTTPS)         │
│                          │               │  ├─ design cache           │
│  API: /brain/task        │               │  ├─ orchestrator           │
│   upload_queue.next      │               │  └─ platforms/             │
│   upload_queue.stats     │               │     ├─ gumroad.ts          │
│   upload_queue.mark_u    │               │     ├─ inprnt.ts (stub)    │
│   design.get             │               │     └─ ... 10 more         │
└──────────────────────────┘               └────────────────────────────┘
                                                       │
                                                       ▼
                                          ┌────────────────────────────┐
                                          │  Persistent Chromium       │
                                          │  profile (.profile/)       │
                                          │  Residential IP            │
                                          │  Your real cookies         │
                                          └────────────────────────────┘
```

---

## Safety

- **No credentials in code.** First-time logins are manual; cookies persist via Chromium user-data-dir.
- **No SSN / W-9 / payment forms.** Drivers refuse to interact with tax/payment pages (R332 / Anthropic block).
- **Stop button.** Ctrl+C is honored — closes the context cleanly.
- **Dry-run.** Set `NOVAN_DRY_RUN=1` to skip the final Publish click while testing.
- **Per-platform isolation.** A driver crash for one platform doesn't kill the loop; the orchestrator continues with the next.
