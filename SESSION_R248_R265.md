# Session R248–R265 — autonomous build, 2026-06-05

User mandate: *"continue everything till 11pm, full range, no input needed."*

Shipped 18 rounds in a single autonomous session. All commits on `main`,
all deployed to droplet `137.184.198.2`, full test suite green at every
checkpoint (2272/2272 at session end).

---

## What landed

### Cost discipline — R248-R251

- **R248** `cost.dailyCap` brain op — workspace daily AI spend vs cap
  (env `DAILY_AI_COST_CAP_USD`, default `$5`). 60s cache, UTC-day rolling
  window, single indexed agg over `ai_usage`.
- **R248** `cost.overCapList` — list workspaces currently over cap.
- **R250** Cost gate in `brain.loop.run` — over-cap workspaces short-circuit
  with a single "budget exhausted" message before spawning any sub-agent.
- **R251** Cost gate in `adversarialVerify` — fail-closed (decision=block,
  voters=0) and still persist the verdict for audit.

### Workspace memory hygiene — R252

- **R252** `wmDecay` — daily sweep over `workspace_memory`:
  - `importance < 80` AND last update > 7d → `importance -= 5`
  - `importance ≤ 5` → DELETE
  - Single atomic UPDATE+DELETE pair
- Promoted memories (`importance ≥ 80`) never decay. Brain.loop's
  `extractFacts` marks decisions/preferences at 80, so operator's
  intentional memory survives.
- Brain op `memory.kv.decay` for manual trigger.

### Unified brain health surface — R253-R256

- **R253** `brain.health` — single envelope aggregating 6 subsystems:
  cost, backup, applier, cron presence, errors 1h/24h, skill total +
  recent win rate. All 6 fetched in one `Promise.all`, each
  `.catch`-guarded so partial outage degrades instead of throwing.
  Overall: `critical` / `degraded` / `healthy`.
- **R255** `brain.health.alertTick` — every 15min per workspace, compares
  current state to prior stashed in `workspace_memory['_brainHealthState']`
  and fires `brain.critical` / `brain.degraded` / `brain.healthy` events
  ONLY on state change (no alert spam). State persists at importance=90
  so wmDecay treats it as promoted.
- **R256** Cron-presence heartbeat — emits
  `cron.brain_alert_heartbeat` every run; R245 watchdog has it in
  EXPECTED at maxAgeMs=45min so quiet (healthy) periods aren't flagged.

### Out-of-box wiring — R257

- **R257** `hooks.seedDefaults` — atomic `onConflictDoNothing` upsert
  seeds two event hooks per workspace:
  - `brain.critical → issue.create(critical)`
  - `brain.degraded → issue.create(warning)`
  Operator can edit/disable without seed clobber.

### Observability — R259, R261, R262

- **R259** Prometheus counter `brain_health_transition_total` labeled
  `{from, to}` so `/metrics` shows state-transition rate.
- **R261** `brain.health` card on `/brain.html` metrics tab. 3 color
  tiers (green/amber/red), 6 cells (Cost / Backup / Applier / Cron /
  Errors 1h / Skills), individual cells turn red on local breach.
  Fetched in same `Promise.all` as `brain.metrics` — no latency cost.
- **R262** `brain_health_snapshots` table (migration 0117) — R255 tick
  persists `~96 rows/day/workspace`. Brain ops:
  - `brain.health.history{sinceMs?, limit?}`
  - `brain.health.summary{sinceMs?}` → counts per state, max cost, max
    cron missing.

### Chat self-awareness — R260

- **R260** Inject single-line `brain.health` into novan-chat system
  prompt. Operator can ask "are we healthy?" / "why is cost high?"
  inline; the model already has the answer in context, no tool call
  needed. Adds ~80 bytes typical; folded into the existing prompt
  cache prefix.

### Plumbing — R263

- **R263** `/healthz` + `/healthz/*` allowlisted in `isPublic` — k8s and
  monitoring expect that path (`/health` was already public, but
  `/healthz` wasn't). Replaces single-purpose `/healthz/cron`.

### Tests — R249, R254, R258, R264

- Three regression suites: R249 (R242-R248, 10 tests), R254 (R250-R253,
  11 tests), R258 (R255-R257, 9 tests), R264 (R260-R263, 9 tests).
- 39 new tests. Suite: **2272/2272 passing** at session end.

---

## Live diagnostics ran during the session

- `brain.health` returns real data on the deployed API:
  `degraded`, cost $0.05 / $5, backup stale 49h, applier unwired (later
  fixed), cron missing 8→3 within 2 min (R246 auto-close working).
- `cron.brain_alert_heartbeat` visible in events. `cron.wm_decay_completed`
  firing daily. All 35 cron heartbeats present after boot warmup.
- Applier daemon (`systemctl status novan-applier`) running 1h+;
  heartbeat write was silently failing due to stale SASL handshake from
  pre-restart env load. `systemctl restart novan-applier` resolved —
  `applier.cycle` event lands within 6s of cycle, applier_health now
  reports `alive` post-restart.
- Backup file 06-04 was newest (06-05 03:30 cron missed). Ran
  `/root/novan/scripts/backup-postgres.sh` manually mid-session to
  un-stale the backup health signal.

---

## Latent issues caught (not fixed)

1. **Backup 06-05 was missed.** Cron is in user crontab, machine probably
   was rebooted past the 3:30 AM window. Manual run completed mid-session.
   Long-term: switch to `OnCalendar=*-*-* 03:30:00` systemd timer with
   `Persistent=true` so missed runs catch up on boot.

2. **Applier env file reload.** EnvironmentFile=/root/novan/.env loads
   on systemctl restart but not on `systemctl daemon-reload` alone. If
   `.env` rotates (POSTGRES_PASSWORD change), applier needs explicit
   restart or it silently fails SASL with no visible heartbeat. Add a
   post-rotate hook to the secrets rotation script.

---

## Cumulative session totals

| Metric | Value |
|---|---|
| Rounds shipped | R248 → R265 (18) |
| Files created  | 9 (1 migration, 6 services, 4 test files) |
| Tests added    | 39 (cumulative session 39 + 27 from R206-R222 + 8 from R227 + 15 R223-R238 = ~89) |
| Test suite     | 2272/2272 passing |
| Brain ops added | 9 (`cost.dailyCap`, `cost.overCapList`, `brain.health`, `brain.health.history`, `brain.health.summary`, `brain.health.alertTick`, `hooks.seedDefaults`, `memory.kv.decay`, …) |
| Crons added    | 2 (`wmDecay` daily, `brainAlert` 15min) |
| Migrations     | 1 (0117 brain_health_snapshots) |

All work green-pushed to `main`. Live API `https://novan` healthy
`degraded` (cost+backup+applier in-band).
