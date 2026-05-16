# System Architecture

## Runtime Architecture

**Stack**: Node.js + TypeScript monorepo (pnpm workspaces + turbo).
- `apps/api` — Fastify HTTP API. Entry: `apps/api/src/server.ts`
- `apps/web` — React + Vite SPA. Routes in `apps/web/src/App.tsx`
- `apps/workflow-worker` — BullMQ worker process
- `packages/db` — Drizzle schema + Postgres client
- `packages/shared-types` — cross-package types

**Persistence**: Postgres via Drizzle ORM. Schema at `packages/db/src/schema.ts`.
**Queues**: BullMQ on Redis. Queue names declared in `apps/api/src/queues/index.ts` and `packages/shared-types`.
**Auth**: Fastify JWT plugin. API tokens (prefix `ops_`).
**Observability**: OpenTelemetry initialised in `apps/api/src/telemetry.ts`. Prometheus metrics at `/metrics`.

## Provider Router

`apps/api/src/routes/ai-router.ts` + `services/ai-router/*`.
- Endpoints registered at `/api/v1/ai-router`
- Provider health logged to `provider_health_log` table
- Provider failures logged to `provider_failures` table
- Routing decisions visible via War Room → Compute → Health

## Remote Workers

`apps/api/src/routes/cloud-runtime.ts`. Remote workers register and receive jobs.
War Room: **Remote Compute** (`/compute`), **Provider Health** (`/compute/health`).

## Cloud-API-Only Mode

Sandbox executor (`apps/api/src/services/sandbox-executor.ts`) enforces:
- Command allowlist (`ALLOWED_COMMANDS`)
- Env allowlist (`SANDBOX_ENV_ALLOWLIST`) — all secret env vars stripped before child spawn
- Lease + heartbeat — one worker per execution

Use this mode when local sandboxed execution is unavailable; the system relies entirely on cloud providers + remote workers.

## Budget Guardrails

`apps/api/src/routes/cost-governor.ts` + service. Budgets recorded per workspace.
- Alerts in `budget_alerts` table
- Active enforcement at provider router level (denies AI calls when over budget)
- War Room: **Cost Governor** (`/governor`)

## Replay / Rollback

**Replay**: Dead-letter queue (`dead_letter_jobs` table). Failed jobs replayable via `/api/v1/dead-letter`.
**Rollback**: `apps/api/src/services/patch-executor.ts` stores `originalContent` for every patched file before write. `rollbackPatches()` restores originals atomically.

## Autonomous Agents

`apps/api/src/services/autonomous-orchestrator.ts` + BullMQ `autonomous` queue.
- State machine: queued → running → (paused | failed | complete | cancelled)
- Phases: scan → audit → plan → patch → verify → done
- Truth enforcement: "verified" status requires `verification_evidence.passed=true` rows

## Strategic War Room

React SPA at `apps/web`. All pages read from real Postgres tables via REST endpoints — no mock data.
Pages registered in `apps/web/src/App.tsx`.

## Production Readiness + Launch Lock

`apps/api/src/services/production-readiness.ts` audits real systems and persists results to `launch_audits`.
Launch lock in `launch_locks` table — blocks production launch until critical checks pass.
War Room: **Launch Lock** (`/launch-lock`).
