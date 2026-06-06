# R146.329 — items #1-#25 status

## Working code (verified)
- **#1** chat.failover_test rewritten to call streamChat (the real entry); accumulates provider chain
- **#2** Welcome page now has real input fields per step + persists via /api/v1/brain/op memory.remember
- **#3** post-deploy-smoke extended with public-route probes (mint a token, set PUBLIC_TOKEN env)
- **#4** cost.cap_enforcement_check inspects spend + kill_switch state, surfaces gap if over-cap-without-halt
- **#5** /api/v1/brain/op generic JWT-gated dispatcher (whitelisted by risk; high needs OPERATOR_APPROVED token)
- **#6** novan-chat auto-resolves pending clarify_event with the operator's next message
- **#7** workflow.attach_business + helper for setting workflow_runs.metadata.businessId
- **#8** MainPage dropdown pruned to only-existing routes
- **#9** export.all op + service: workspace_memory + relationships + businesses + earnings + setup + clarify + 30d events
- **#10** memory.promote_if_important — heuristic catches commitments/facts and auto-upserts into workspace_memory
- **#11** Welcome surfaces explicit error states with Retry button
- **#12** beforeinstallprompt captured + "Add to home screen" rendered on welcome completion
- **#13** applier postgres pool: idleTimeoutMillis=25_000 — reconnects ~30s after API restart instead of 5-15min wait
- **#14** scripts/analyze-web-bundle.sh runs vite build + lists top-10 chunks
- **#15** browserApprovalKey + signBrowserApproval + verifyBrowserApproval — HMAC-signed (domain, path-prefix) scope tokens
- **#16/17/18** test fixtures: OAuth state HMAC round-trip, approval scope rejection, entity extractor no-key path

## Scaffolds / design

- **#19 voice memo capture** — would land as new POST /api/v1/voice/memo accepting audio blob, running Whisper, classifying as chat-turn vs relationship-attached note. Multi-session work; calls into existing voice infrastructure (R131).
- **#20 inbox triage end-to-end** — requires Gmail OAuth (now scaffolded) + actual messages.list call. Service stub in r327-misc.ts has the credential-check; needs the read implementation.
- **#21 screen-share Q&A** — WebRTC display capture + frame-grab + media-analyzer. Strongest demo; reaches into chrome MCP infrastructure.
- **#22 "what should I work on next" op** — straightforward; combines goals + open approvals + cost forecast + time-of-day. One service file. Not done yet because the input data shape (goals/approvals types) needs nailing.
- **#23 Telegram/WhatsApp connector** — adds 2 entries to OAUTH_PROVIDERS map + bot-token alternative path. Mostly mechanical; deferred.
- **#24 auto-doc generation** — would replace these hand-written R-NOTES.md files. Brain op that diffs the last commit and renders. Defer until a few more rounds accumulate so the input pattern is clearer.
- **#25 CI** — `.github/workflows/ci.yml` with typecheck + lint + smoke; deferred (we're shipping changes faster than CI configuration churn justifies right now).

## Cumulative count of brain ops
~1015+ across all rounds; R329 adds 5 (cost.cap_enforcement_check, workflow.attach_business, export.all, memory.promote_if_important, browser.approval_token).

## Operator action items
- Run `bash scripts/post-deploy-smoke.sh` (admin-only) and `PUBLIC_TOKEN=<your-token> bash scripts/post-deploy-smoke.sh` (full coverage)
- Run `bash scripts/analyze-web-bundle.sh` once to capture initial bundle perf baseline
- After #5 lands: the operator UI can call ANY brain op via POST /api/v1/brain/op {op, params}. High-risk needs `highRiskConfirm: "OPERATOR_APPROVED"`.
