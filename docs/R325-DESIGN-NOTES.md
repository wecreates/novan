# R146.325 — design notes for items needing follow-up

This file tracks the audit recommendations that landed as scaffolds in
R325 but need follow-up implementation work. Each section names the
audit item, the scaffold file, and the remaining work.

## #15 — Per-type events retention

**Scaffold:** `apps/api/src/services/r325-events-retention-policy.ts`

Wire `runEventsRetention()` into the platform-hardening cron schedule
once the operator approves the per-type cutoffs. Replace the single
30-day blanket sweep in `platform-hardening.ts` with this policy.

## #16 — Schema split

**Status:** not yet done. `packages/db/src/schema.ts` is still a single
~2k-line file. Splitting requires:

1. Identify domain boundaries (agents, events, businesses, learning,
   governance, …).
2. Move table declarations into `packages/db/src/schema/<domain>.ts`.
3. Re-export from `packages/db/src/schema.ts` so consumers don't break.
4. Run `pnpm typecheck` per package.

Mechanical but high blast radius if a path import goes missing. Best
done in a dedicated session with a tight verification loop.

## #22 — Sandboxed media worker

**Status:** documented, not implemented. yt-dlp/ffmpeg/playwright currently
run inside the API container as root. To sandbox:

1. New service in `docker-compose.yml`: `media-worker` based on
   `node:20-alpine` with only ffmpeg + yt-dlp + playwright.
2. BullMQ queue `media-jobs`. API publishes job, worker consumes.
3. seccomp profile blocking `mount`, `ptrace`, `clone3`.
4. Worker runs as non-root user, read-only filesystem except `/tmp`.

Effort: 1-2 days. Cost: an extra container. Benefit: yt-dlp/ffmpeg/playwright
exploits no longer compromise the API.

## #25 — XSS regression coverage

**Scaffold:** `apps/api/src/test/xss-regression.test.ts`

Extends with real route-level tests using a shared Fastify test
instance. Currently checks the encoding helper + grep-scans
`novan-console.ts` for raw interpolation. Both keep R294 from
regressing.

## #9 — Cost reconciliation

**Scaffold:** `apps/api/src/services/r325-cost-reconciliation.ts`

Wire to a monthly cron once the operator sets
`ANTHROPIC_USAGE_API_KEY` (billing read-only scope). Update
`fetchAnthropicInvoiced()` with the correct endpoint shape and
authorization header. OpenAI doesn't expose a programmatic billing
endpoint — for OpenAI, accept a manual CSV upload through the operator
UI and reconcile from that.

## #13 — SPEC verify

**Scaffold:** `scripts/spec-verify.mjs`

Add to CI as `pnpm spec:verify`. Add `LOCKED:` markers to SPEC.md for:

- every table referenced by an external contract
- every route documented in the operator API guide
- every env var required at boot

## #23 — Workspace soft-delete

**Migration:** `packages/db/migrations/0118_workspace_soft_delete.sql`

Add `archived_at` column. To finish:

1. Update the workspaces route to set `archived_at` instead of
   `DELETE`.
2. Add helper `excludeArchived()` to every query that lists workspaces.
3. Add a 90-day hard-delete sweep that runs after archival, gated by
   an `--allow-hard-delete` operator confirmation.

## #3 — Advisory locks (broader rollout)

**Helper:** `apps/api/src/util/advisory-lock.ts`

R325 wires it into `scheduled-production.tick`. Roll out to the rest
of the in-process flags found in the audit: `connector-oauth` reaper,
`brain-task-browser` reaper, learning-cron tick. Each gets a unique
`tick:<name>` lock key.

## #16/#22/#25/#9/#13/#23 escalation path

When any of these need to ship to live, run them through a workflow:
parallel agents per file/migration with verification, then a final
typecheck + smoke run.
