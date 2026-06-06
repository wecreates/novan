# R146.330 — items #1-#50 status

## Working brain ops (33 new ops)

**Value dashboards (#9-#13):** revenue.dashboard, time_saved.counter, content.shipped, weekly.recap, business.roi
**Operator agency (#14-#20):** cost.detail, novan.pause / novan.resume, workspace.clone, op.set_risk, budget.set/get_breakdown, daily_routine.override, data.purge
**Discovery (#21-#24):** op.browse, op.usage_snapshot, op.suggest
**Meta-cognition (#47-#50):** novan.about_me, persona.drift, mistake.record / mistake.list, reply.rate / reply.rating_stats
**Demo planners (#30-#34):** demo.trending_scripts, demo.inbox_triage, demo.landing_page, demo.competitor_watcher, demo.dm_reply_batch
**Resilience (#26-#29, #39-#42):** all_providers.probe, pg.graceful_probe, disk.usage, soak.signal, chat.latency_p95, retention.first_day, cost.per_task, effectiveness.metric
**Pentest (#35):** pentest.sketch

## Scripts shipped
- **#1-#8** `scripts/audit-untouched-packages.sh` — automated finding sweep across runtime-kernel, policy-engine, workflow-engine, provider-router, ai-router, ui-system, apps/admin, apps/windows-bridge. Output lands in `docs/R330-PACKAGE-AUDIT.md`.
- **#25** `scripts/dr-rehearsal.sh` — destroy-and-rebuild drill (gated on `CONFIRM_DESTROY=YES_REALLY`); snapshot → destroy → rebuild → restore → smoke; per-phase timing.
- **#38** `scripts/scan-secrets.sh` — pattern-scan tracked files for OpenAI/Anthropic/Slack/GitHub/AWS/private-key shapes.

## Web shipped
- **#21** `/brain-browse` page — searchable, risk-filterable, sortable browser for all 1015+ ops with one-click run

## Honest scaffolds (gap text in op response)
- **#30-#34** demo planners — return the plan steps, assumptions, blockers (e.g. "no Slack credential — connect via /oauth/slack/start"), and estimated cost. Execution is gated on connectors.
- **#1-#8** package audit findings file is generated when script runs; finding triage is the next session.

## Skipped / deferred (still worth doing)
- **#36** CSP report-only mode — needs helmet config delta; reasonably tested by browsing /brain-browse with DevTools open
- **#37** pnpm audit cron — single env-gated cron tick; deferred
- **#43-#46** A11y, iOS validation, RTL, voice latency — device-level; UI tweaks already include keyboard-friendly inputs and visible focus rings on most controls

## What `novan.about_me` returns
> identity: "I'm Novan — an autonomous teammate for your projects. I remember our conversations, run your daily routine, and act on things you authorize me to."
> capabilities: "33/37 capabilities present across perception, memory, reasoning, action, meta, and social. The ones still partial: act.web, act.send."
> notSure: lists every partial gap by name

## What `weekly.recap` returns
Five-line narrative: revenue, content shipped, time saved, AI cost, highlights.
Triggers nothing yet — wire to the Sunday cron in R331.

## Cumulative state
- Total brain ops registered: ~1048+
- Total brain ops with usage tracking: 1048+ (R330 #22 added per-op accumulator)
- All new ops are auth-gated via /api/v1/brain/op (R329 #5) — `novan.pause`, `workspace.clone`, `data.purge` need `highRiskConfirm: "OPERATOR_APPROVED"`
