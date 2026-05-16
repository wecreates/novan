# 30-Day Build Plan — Ops Platform MVP

## Prioritization Framework
P0 = blocks everything else | P1 = MVP required | P2 = MVP desirable | P3 = post-MVP

---

## Week 1 — Infrastructure Foundation (Days 1–7)

### Milestone: Local dev stack running, API boots, DB migrated

**Day 1–2: Infrastructure bootstrap**
- [ ] `pnpm install` + workspace resolution
- [ ] `pnpm infra:up` — postgres + redis containers healthy
- [ ] pgvector extension verified (`SELECT * FROM pg_extension WHERE extname='vector'`)
- [ ] Run `pnpm db:push` — all tables created
- [ ] Verify: `GET /health/ready` returns 200

**Day 3–4: API core**
- [ ] Auth plugin functional (JWT sign/verify)
- [ ] `POST /api/v1/workflows` — creates DB record
- [ ] `POST /api/v1/workflows/:id/run` — creates run + enqueues BullMQ job
- [ ] `GET /health/ready` checks DB + Redis + queue depths

**Day 5–6: Workflow worker**
- [ ] Worker boots + connects to Redis
- [ ] Dequeues test job → calls executor stub
- [ ] Job completed/failed events emitted
- [ ] Stalled job detection firing

**Day 7: Stabilization**
- [ ] E2E test: trigger workflow → worker dequeues → status updated in DB
- [ ] Checkpoint: infra restarts cleanly after `docker compose down && up`

---

## Week 2 — Execution Core (Days 8–14)

### Milestone: Step execution working, recovery functional

**Day 8–9: Step executor**
- [ ] `action` step type — executes configured HTTP call
- [ ] `ai_inference` step type — calls provider router → Anthropic/OpenAI
- [ ] Step result saved to `step_runs` table
- [ ] Dependency graph resolution (topological sort)

**Day 10–11: Recovery system**
- [ ] Recovery worker boots
- [ ] On step failure: enqueue recovery job
- [ ] Retry strategy: exponential backoff, respects RetryPolicy
- [ ] Rollback: saves RollbackInstruction, executes on full failure
- [ ] Recovery log persisted to `recovery_log`

**Day 12–13: Memory service**
- [ ] `POST /api/v1/memory` — save memory + generate embedding (Ollama local)
- [ ] `GET /api/v1/memory/search` — pgvector cosine similarity search
- [ ] `memory_worker` indexes batch memories
- [ ] HNSW index created on `memories.embedding`

**Day 14: Stabilization**
- [ ] Full workflow run with 3 steps: action → ai_inference → memory_write
- [ ] Failure injection: kill worker mid-run → verify recovery
- [ ] Checkpoint: all step results persisted correctly

---

## Week 3 — Intelligence Layer (Days 15–21)

### Milestone: War Room + Morning Brief functional via API

**Day 15–16: Provider router**
- [ ] Route by tier (heavy/medium/light)
- [ ] Circuit breaker per provider
- [ ] Fallback chain executes on failure
- [ ] Usage logged to `ai_usage` table

**Day 17–18: Strategic intelligence**
- [ ] Port `computeWarRoom` + `computeReliabilityStandardsEngine` from core-brain
- [ ] Adapt to pull state from DB (not Tauri store)
- [ ] `GET /api/v1/intelligence/warroom` — returns war room report
- [ ] `GET /api/v1/intelligence/brief` — morning executive briefing

**Day 19–20: Opportunity tracking**
- [ ] `POST /api/v1/opportunities` — create opportunity from memory
- [ ] `GET /api/v1/opportunities` — list with score sort
- [ ] Opportunity detection run via `optimization-worker` on schedule

**Day 21: Stabilization**
- [ ] Morning brief pulls from DB state → generates AI-enriched briefing
- [ ] War room returns actionable status report
- [ ] Checkpoint: intelligence reports load in <500ms

---

## Week 4 — Observability + Hardening (Days 22–30)

### Milestone: Production-ready observable runtime

**Day 22–23: Observability**
- [ ] OpenTelemetry traces on all API routes
- [ ] BullMQ job metrics exported to Prometheus
- [ ] Grafana dashboard: queue depths, job latency, API p95, DB pool
- [ ] SLO tracking: task success rate, queue depth, recovery rate

**Day 24–25: Approval system**
- [ ] `POST /api/v1/approvals/:id/approve` — approves gate, resumes run
- [ ] `POST /api/v1/approvals/:id/reject` — rejects, triggers recovery
- [ ] Approval expiry cron job
- [ ] Real-time notification via SSE (approval pending event)

**Day 26–27: Browser worker (Playwright)**
- [ ] `browser-worker` container with Playwright installed
- [ ] `browser` step type executes Playwright script from step config
- [ ] Screenshot on failure, saved to S3/R2
- [ ] Session isolation: one browser per job

**Day 28–29: Chaos + recovery testing**
- [ ] Kill postgres mid-workflow → verify graceful degradation
- [ ] Kill redis → verify queue persistence on restart
- [ ] Overload queue (1000 jobs) → verify worker stability
- [ ] Rollback: corrupt step output → verify recovery log accuracy

**Day 30: MVP release checkpoint**
- [ ] All P0+P1 items complete
- [ ] All health checks green
- [ ] Grafana dashboard showing live operational metrics
- [ ] E2E: morning brief → opportunity → workflow → approval → completion

---

## MVP V1 Scope (P0 + P1 only)

### P0 — Must ship for MVP
- [x] Repo scaffold (packages, apps, workers, infra)
- [ ] Postgres + pgvector + Redis running
- [ ] API boots with auth, health, workflow routes
- [ ] Workflow worker dequeues + executes steps
- [ ] Recovery worker with retry + rollback
- [ ] Memory service with vector search
- [ ] Provider router with circuit breaker

### P1 — MVP required
- [ ] War Room intelligence report
- [ ] Morning brief via API
- [ ] Approval system (human-in-the-loop gates)
- [ ] OpenTelemetry traces + Grafana dashboard
- [ ] Playwright browser worker

### P2 — MVP desirable
- [ ] Opportunity detection scheduled job
- [ ] SSE real-time event stream
- [ ] Web dashboard (React)
- [ ] Stripe billing integration

### P3 — Post-MVP
- [ ] Multi-region support
- [ ] Kubernetes deployment
- [ ] Enterprise RBAC
- [ ] Programmatic SEO
- [ ] Admin panel

---

## Stabilization Checkpoints (every Friday)

| Week | Checkpoint |
|------|-----------|
| 1 | Infrastructure boots, API healthy, DB migrated |
| 2 | Step execution + recovery working E2E |
| 3 | Intelligence layer functional, sub-500ms response |
| 4 | Observable, chaos-tested, MVP-complete |
