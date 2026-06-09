# Novan operator setup

One-time configuration to activate the autonomous loop. After this everything runs without you.

## 1. Dashboard

Open on phone or desktop:

```
https://137-184-198-2.sslip.io/ops/dashboard?token=<NOVAN_OPS_TOKEN>
```

Token is in `/root/novan/.env` on the droplet (env var `NOVAN_OPS_TOKEN` or `OPERATOR_TOKEN`). Bookmark this URL.

The dashboard shows: next-action banner · sparkline trends · MRR projection · goal-ladder tier · top designs · top niches · queue per platform · cron health · disabled platforms · failure patterns · stuck items · activity stream · 8 quick-action buttons.

## 2. Gumroad real-time webhook

Get the token:

```bash
ssh -i ~/.ssh/novan.key root@137.184.198.2 'grep GUMROAD_WEBHOOK_TOKEN /root/novan/.env'
```

Paste this URL into **Gumroad → Settings → Advanced → Ping URL** (replace `<token>`):

```
https://137-184-198-2.sslip.io/api/v1/webhooks/gumroad/sale?token=<token>
```

Optional security: set `GUMROAD_SELLER_ID=<your-gumroad-id>` in `.env` and the webhook will reject requests from other sellers.

When a sale lands: variant generation fires instantly · variants get queued on every platform parent shipped on · Pinterest pins get auto-created · tier-transition push fires if MRR crosses a threshold.

## 3. Web Push (mobile notifications)

Install the PWA on your phone:

1. Open `https://137-184-198-2.sslip.io/` in mobile browser
2. "Add to Home Screen"
3. Open the installed app and accept notification permission

Pushes you'll receive after subscribing:
- **Top next-action changes** (R386, 4h dedup)
- **First sale on each platform** (R403, one per platform)
- **Tier crosses threshold** (R397)
- **Daily morning summary** at 14:00 UTC (R398)
- **Sunday weekly recap** at 14:00 UTC Sun (R413)
- **Platform auto-disabled** (R412)
- **Platform re-enabled probe** (R422)

## 4. Local agent (queue drainage)

The droplet generates designs + tops up the queue daily at 13:00 UTC. The browser-half (actually uploading) still runs on your laptop:

```bash
cd C:/Users/19496/ops-platform/apps/local-agent
pnpm daily
```

The persistent Playwright session in `.profile/` holds your platform logins. Run this when convenient; queue drains a few items at a time respecting R378 pacing.

## 5. Bulk-importing sales from non-webhook platforms

Etsy, INPRNT, FAA, Redbubble don't have webhooks. Monthly, paste sales via brain-task `sales.bulk_import`:

```bash
TOKEN=ops_22fc...
curl -X POST https://137-184-198-2.sslip.io/api/v1/brain/task \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"workspace_id":"default","plan":[{"op":"sales.bulk_import","params":{"csv":"sale_id,source,net_usd,permalink\netsy-001,etsy,12.50,https://etsy.com/listing/123"}}]}'
```

R374 variant generation fires for any row with a `permalink` that matches an `external_url` we uploaded.

## 6. Chat status injection

Open the chat (PWA or `/console.html`). When you ask about MRR, status, queue, winners, pacing, etc., R425 splices a live dashboard JSON snapshot into the LLM's system prompt so it answers with real numbers.

Examples that trigger injection:
- "what's my MRR"
- "show me top winners"
- "queue status"
- "how am I doing"

## Env vars reference

Required for full functionality:

```
NOVAN_OPS_TOKEN=ops_...                # dashboard + action endpoint
GUMROAD_WEBHOOK_TOKEN=gh_...           # real-time sale push
GUMROAD_SELLER_ID=...                  # optional, hardens webhook
GUMROAD_ACCESS_TOKEN=...               # R367 hourly poll backup
VAPID_PUBLIC_KEY=...                   # web push (R129)
VAPID_PRIVATE_KEY=...                  # web push
INPRNT_SELLER_URL=https://inprnt.com/profile/...  # capability self-test (R376)
```

## Cron schedule (everything runs without you)

| When (UTC) | What |
|---|---|
| every 15 min | Top-action push if changed (R386) |
| every hour | Queue replenish if <30 (R400) |
| every hour | Auto-variants for proven winners (R401) |
| every hour | Auto-cross-list winners (R411) |
| every hour | Failed-upload requeue (R402) |
| every hour | First-sale-per-platform detector (R403) |
| every hour | Platform auto-disable (R412) |
| every 6h | Platform auto-re-enable probe (R422) |
| 13:00 UTC | Droplet daily cron — sales sync + pipeline + self-test (R382) |
| 14:00 UTC | Daily morning summary push (R398) |
| 14:00 UTC | Pacing auto-loosen (R387) |
| 15:00 UTC | Zero-sale listing refresh (R417) |
| Sun 14:00 UTC | Weekly recap push (R413) |

## Troubleshooting

**Dashboard 401**: token wrong or `.env` not picked up. `docker compose up -d api` (not just restart) re-reads `.env`.

**No pushes arriving**: open PWA, hit subscribe again. Check VAPID keys in `.env`.

**Cron health row red on dashboard**: check the `lastError` column or ssh + `docker compose logs api --tail=200 | grep <cronName>`.

**Webhook returns 503**: `GUMROAD_WEBHOOK_TOKEN` not set in `.env`. Add it and `docker compose up -d api`.

**Webhook returns 403**: `GUMROAD_SELLER_ID` mismatch — either remove the env var or set the correct id.

**Stuck queue items**: check `/ops/dashboard` "Stuck queue items" card. Usually pacing-gated or a disabled platform. Run "Force replenish" quick-action button.

**Auto-disabled platform recovering**: it'll auto-probe in 72h. To force-enable now:

```bash
curl -X POST https://137-184-198-2.sslip.io/api/v1/brain/task \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"workspace_id":"default","plan":[{"op":"platforms.enable","params":{"platform":"etsy"}}]}'
```
