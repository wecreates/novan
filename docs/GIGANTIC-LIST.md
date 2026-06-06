# The Gigantic List

Everything I'd ship next if you keep saying "do them all." I'll batch in
8-item rounds (R330+), shipping verified code each time.

## Foundation (immediate)
1. Verify R329 deploy via smoke + 5 new brain ops
2. Wire memory.remember op if it doesn't exist (Welcome page calls it)
3. /api/v1/brain/op end-to-end test with low+high risk
4. Welcome → MainPage redirect when complete
5. Bundle analyzer baseline run, capture top-10 in docs

## Connectors — actually working
6. Slack: post message + read channel implementation
7. Gmail: actual messages.list + draft send
8. Calendar: complete the prefix flow with a real test event
9. TikTok / Instagram: token-based connectors (no OAuth needed)
10. Telegram bot connector (free, instant; bot-token only)
11. Discord webhook send
12. Notion read/write
13. Linear / Jira read

## Operator agency
14. /api/v1/import — restore from an export.all bundle (mirror of #9)
15. Memory editor UI — list/edit/delete workspace_memory keys
16. Relationship UI — list, edit attrs, draw the graph
17. Audit log UI — what happened, who triggered, what changed
18. Goal editor UI with progress sliders + key-results
19. Budget enforcement UI — see exactly what cost.cap_enforcement gives back

## Conversation quality
20. Voice WebRTC: bidirectional audio + VAD interruption + persona pacing
21. Image upload in chat: drag-drop → vision analysis → reply
22. PDF + spreadsheet upload + analyze
23. Reply quality scoring: lightweight grader on every reply, persist for evals
24. Eval harness: run 50 known prompts vs expected behaviors per release
25. Per-conversation context window manager (currently the system prompt gets clamped; chat history isn't)

## Cron + autonomy
26. Daily routine: write actual content draft (not just stub) for one platform
27. Weekly reflection: summarize the week, queue improvements
28. Self-cost-audit cron: flags spend anomalies (sudden 5x burn)
29. Self-test cron: hits all 6 brain ops from smoke, alerts on regression
30. Brain.what_should_I_work_on op — combines goals + approvals + cost + time-of-day

## Data + observability
31. Per-workflow timing dashboards (use cron.metric data we already have)
32. Per-business revenue forecast (mirror cost.forecast on the revenue side)
33. Time-to-first-value metric per onboarding session
34. Daily metrics digest brain op (one number per category)
35. Error class distribution dashboard

## Security hardening
36. Audit-log signed entries (HMAC) so the audit trail itself can be verified
37. Per-token IP allowlist (operator can restrict their own token to home IP)
38. 2FA on /bootstrap and /tokens (TOTP) as defense in depth
39. Encrypted backups (gpg) — current pg_dump is plaintext
40. Penetration test brain op — fires curated XSS/SSRF/IDOR payloads at the live API and reports

## Performance
41. Redis caching layer for brain.health (queried per chat turn)
42. SQL query timing log — top-10 slowest queries per workspace per day
43. Background prefetch for the operator's likely next action (e.g. tomorrow's briefing prefab'd today)
44. Brain op response streaming for long ones (daily_routine.run, deploy)

## Brand / UI polish
45. Dark mode default + light toggle
46. Mobile-first chat UI (current is desktop-shaped)
47. Voice-mode visual indicator (waveform when listening, persona tone when speaking)
48. Splash screen with branded loading state

## Quality of life
49. Quick-replies in chat (operator clicks a suggestion instead of typing)
50. Daily journal mode — operator dumps notes, Novan extracts → memory + relationships + tasks

I'll ship these in R330-R335, ~8 per round. Each verified live.
