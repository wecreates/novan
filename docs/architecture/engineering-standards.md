# Engineering Standards — Ops Platform

## Core Principles
1. **Observable**: every request has a trace ID; every job has a job ID; every failure has a root cause
2. **Recoverable**: every operation has a rollback path; every state transition is persisted before execution
3. **Replayable**: workflow runs can restart from any checkpoint; events are append-only
4. **Minimal**: no premature abstraction; merge before splitting; delete before adding

---

## Code Standards

### TypeScript
- Strict mode always: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`
- No `any` — use `unknown` + type narrowing
- No `as` casts — use type guards or explicit checks
- Brand types for all IDs: `UserId = string & { __brand: 'UserId' }`
- `void` all fire-and-forget async calls explicitly

### Naming
- Files: `camelCase.ts` for modules, `kebab-case.ts` for routes/workers
- DB tables: `snake_case` (Drizzle convention)
- API routes: `kebab-case`, versioned (`/api/v1/...`)
- Events: `domain.noun.verb` (e.g., `workflow.run.completed`)
- Queue jobs: `verb-noun` (e.g., `execute-workflow`, `index-memories`)

### Functions
- Max 40 lines per function — split at natural seams
- Max 3 parameters — use object destructuring beyond that
- No nested callbacks — async/await everywhere
- Error handling at boundaries only — don't wrap every line in try/catch

### Imports
- Absolute imports via workspace: `@ops/shared-types`, `@ops/workflow-engine`
- No circular dependencies between packages
- `packages/*` may not import from `apps/*` or `workers/*`

---

## API Standards

### Request/response shape
All responses use `ApiResponse<T> | ApiError` from `@ops/shared-types`.
Never return raw DB rows — always map to API shapes.

### Versioning
All routes are versioned: `/api/v1/...`
Breaking changes require new version prefix, not modification of existing.

### Status codes
- `200` — success
- `201` — resource created
- `202` — accepted (async operation queued)
- `400` — validation error (Zod parse failure)
- `401` — unauthenticated
- `403` — unauthorized (wrong workspace)
- `404` — resource not found
- `409` — conflict (duplicate, state violation)
- `503` — dependency unavailable

### Rate limiting
- Default: 200 req/min per IP
- Auth'd: 1000 req/min per workspace
- Expensive ops (AI inference, memory search): 30 req/min per workspace

---

## Database Standards

### Migrations
- All migrations via Drizzle Kit: `pnpm db:migrate`
- Never edit existing migration files — create new ones
- All migrations must be reversible (include down migration comment)
- Test migrations on empty DB and production-like data volume

### Query rules
- Never use `SELECT *` in production queries — always specify columns
- Always add `WHERE workspace_id = ?` on multi-tenant tables
- Pagination: cursor-based for large tables, offset for small admin queries
- N+1 prevention: use Drizzle `with` clauses for nested data

### Indexes
- Every `workspace_id` column indexed
- Every `status` column on high-volume tables indexed
- Composite indexes for common filter patterns
- Vector similarity: HNSW index (`vector_cosine_ops`)

---

## Queue Standards

### Job definitions
- Every job type has a TypeScript interface for `data`
- Jobs are idempotent — safe to run twice
- Jobs save progress to DB before long operations (checkpoint)
- Max job size: 10KB payload (move large data to DB, pass ID in job)

### Retry policy
- Default: 3 attempts, exponential backoff starting at 2s, max 30s
- Critical recovery jobs: 5 attempts, linear 5s backoff
- Dead letter: failed jobs after maxAttempts move to `{queue}:failed`

### Concurrency limits
| Queue | Concurrency | Reason |
|-------|------------|--------|
| workflow | 5 | CPU-bound step execution |
| browser | 3 | Playwright memory per session |
| memory | 10 | I/O bound, DB + embedding calls |
| analytics | 20 | Fire-and-forget aggregation |
| recovery | 3 | Careful, coordinated recovery |
| optimization | 2 | Background, low priority |

---

## Observability Standards

### Tracing
- Every API request gets `x-trace-id` header
- Every job carries `traceId` in data
- Trace ID propagated through all DB queries and downstream calls
- Use OTEL span names: `{service}.{operation}` (e.g., `workflow-worker.execute-step`)

### Logging
- Structured JSON (pino) — never `console.log` in production
- Required fields: `{ level, timestamp, service, traceId, requestId }`
- Error logs must include `{ err: Error, context: {...} }`
- Never log secrets, tokens, passwords, or PII

### Metrics (Prometheus)
Expose via `/metrics` endpoint:
- `ops_workflow_runs_total{status}` — counter
- `ops_workflow_duration_ms{quantile}` — histogram
- `ops_queue_depth{queue}` — gauge
- `ops_step_duration_ms{type,status}` — histogram
- `ops_ai_tokens_total{provider,model,type}` — counter
- `ops_ai_cost_usd_total{provider,model}` — counter

### Alerts (Prometheus AlertManager)
- Queue depth > 500 for > 5min → PagerDuty
- Workflow failure rate > 20% rolling 10min → Slack
- API p99 latency > 2000ms rolling 5min → Slack
- Redis memory > 80% → Slack

---

## Recovery Standards

### All workflows must define
- `retryPolicy` on definition
- `onFailure` per step (`fail|skip|continue`)
- Rollback instructions for destructive steps

### Recovery log (required fields)
```ts
{ runId, strategy, reason, steps[], status, startedAt, completedAt, error }
```

### Rollback execution
1. Load `RollbackInstruction[]` from `step_runs.rollback` in reverse order
2. Execute each rollback within `timeout` ms
3. Log result to `recovery_log`
4. Mark run as `failed` with rollback completion timestamp

---

## Testing Standards

### Unit tests
- Pure functions (engines, validators, transformers): 100% coverage
- No DB, no Redis, no network in unit tests
- Use `vitest` — fast, ESM-native

### Integration tests
- API routes: test against real DB + Redis (docker-compose test profile)
- Queue workers: use BullMQ `Mock` in tests, real Redis in integration
- Use `testcontainers` for DB/Redis isolation

### E2E tests
- Critical paths only: workflow trigger → completion, memory search, morning brief
- Run against staging environment (not production)
- Max 3min E2E suite duration

---

## Daily Engineering Cadence

### Morning (15 min)
1. Check Grafana: queue depths, error rates, SLO status
2. Review failed jobs in BullMQ dashboard
3. Check recovery log for overnight failures
4. Identify today's single highest-leverage build task

### During build
- Commit atomically: one logical change per commit
- Typecheck before every push: `pnpm typecheck`
- Never push to main without tests passing

### End of day (10 min)
1. `git status` — no uncommitted changes
2. Check `/health/ready` — all green
3. Note any instability or tech debt discovered
4. Update 30-day plan: mark completed items, re-prioritize tomorrow
