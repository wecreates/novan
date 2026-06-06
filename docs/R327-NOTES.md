# R146.327 — items #1-#17 shipping notes

## Shipped fully working
- **#3 relationship.upsert / .recall** — DB-backed graph with auto-extraction from chat turns
- **#4 clarify.assess** — heuristic decision layer, persists clarify_events for learning
- **#5 setup.state / setup.mark** — 5-step onboarding tracker
- **#6 daily_routine.run** — feed scan + ideas + approval triage + push notify; wired to hourly cron with 06:00 UTC window gate
- **#7 backup.restore_drill** — lightweight drill (verifies newest backup event + schema sanity); full ephemeral-restore script remains operator-runnable
- **#8 cost.forecast** — 30-day projection at 7-day burn rate + days-of-runway
- **#10 email.triage** — wired to connector_credentials; honest about Gmail-not-implemented gap with workarounds
- **#11** R326 keyword regex now allows ≤3 filler words between verb and noun
- **#12** novan-chat auto-calls task.honest_assess + clarify.assess; injects honest text + question into system prompt when needed
- **#13a** events retention per-type policy wired into the retention sweeps tick
- **#13e** `pnpm spec:verify` script added to root package.json
- **#16** worker container audit — no SSRF/IDOR/eval patterns found in workers/*; clean
- **#17 brain.what_did_you_do_today** — narrative timeline with category counts, filters noise

## Partial — solid scaffold, needs more work
- **#1 browser.action** — SSRF-guarded, operator-approval-per-domain gate, emits browser.action.requested event. Browser-worker container consumer not yet implemented (worker reads the event but no Playwright executor wired).
- **#2 connector_cred.create/list/revoke** — table + brain ops shipped. OAuth handshake flow (UI walking operator through providers) still owed.
- **#9 voice quality** — persona energy detection already integrated; TTS pacing/pauses + WebRTC interruption are separate sessions.
- **#13b/c/d/f** R325 scaffold items still pending (schema split / sandboxed worker / XSS expansion / Anthropic billing API). See `R325-DESIGN-NOTES.md`.

## Skipped intentionally
- **#14 /today minimal audit** — MainPage already shipped at `/`; routing through /today via sessionStorage works. Deeper TodayPage minimization is its own UX session.
- **#15 PWA install banner verification** — requires real device testing; out of scope.

## Operator action items
- Set `PERSONA_OPERATOR_NAME` env so the greeting addresses you.
- Set `ANTHROPIC_USAGE_API_KEY` (billing read-only) for #9 cost reconciliation.
- Hit `task.honest_assess` once via chat to confirm the workaround text reads naturally.
- After first deploy: run `db:migrate` to apply 0119_r327_layer.sql (or restart API container — boot.sh handles it).
