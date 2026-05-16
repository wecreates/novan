# Ops Platform

**AI-powered operational intelligence runtime** — a multi-agent workflow engine with semantic memory, real-time event bus, risk/opportunity tracking, and automated briefing generation.

---

## What It Does

| Capability | Description |
|---|---|
| **Multi-agent workflows** | Define, schedule, and execute multi-step workflows with policy-gated autonomy |
| **Semantic memory** | pgvector-backed memory with workspace-scoped retrieval |
| **Real-time event bus** | BullMQ-backed event ingestion, routing, and fan-out |
| **Risk & opportunity tracking** | Structured tracking of business risks and opportunities with AI-generated insights |
| **Briefing generation** | Automated daily/on-demand briefings synthesized from live operational data |
| **Policy engine** | Fine-grained autonomy control (`observe_only` → `restricted_supervised_orchestration`) |
| **AI provider routing** | Multi-provider routing (Anthropic, OpenAI, Gemini, Ollama, Groq) with circuit breakers |

---

## Architecture

```
ops-platform/
├── apps/
│   ├── api/          Fastify REST API (port 3001)
│   └── web/          React + Vite dashboard (port 5173)
├── packages/
│   ├── db/           Drizzle ORM schema + migrations
│   ├── shared-types/ Branded types and domain interfaces
│   ├── workflow-engine/  Workflow state machine + step executor registry
│   ├── policy-engine/    Autonomy and approval policy evaluation
│   ├── provider-router/  AI provider routing, fallback, cost governance
│   ├── runtime-kernel/   In-process event bus and checkpoint utilities
│   └── event-contracts/  Typed event definitions shared across services
├── workers/
│   ├── workflow-worker/    Step execution and run coordination
│   ├── memory-worker/      Vector embedding and retrieval jobs
│   ├── analytics-worker/   Metrics aggregation
│   ├── briefing-worker/    Briefing generation
│   ├── browser-worker/     Playwright browser automation
│   ├── recovery-worker/    Failed run recovery and rollback
│   └── optimization-worker/ AI cost and latency optimization
└── infra/
    └── docker/             docker-compose with Postgres, Redis, Prometheus, Grafana, OTEL
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| API | Fastify 5, @fastify/jwt, @fastify/swagger, Zod |
| Database | PostgreSQL 17 + pgvector, Drizzle ORM |
| Queue | BullMQ + Redis 7 |
| Observability | OpenTelemetry, Prometheus, Grafana, pino |
| Frontend | React, Vite, Tailwind CSS |
| Language | TypeScript 5.6 (strict + exactOptionalPropertyTypes) |
| Runtime | Node.js ≥ 20, pnpm 9, Turborepo |

---

## Quick Start

```bash
# 1. Start infrastructure
pnpm infra:up

# 2. Run database migrations
pnpm db:migrate

# 3. Start all services
pnpm dev
```

API available at `http://localhost:3001` · Web at `http://localhost:5173` · Swagger UI at `http://localhost:3001/docs`

---

## Apps

### `apps/api` — `@ops/api`

Fastify REST API. Handles authentication, workspace scoping, queue dispatch, and all business logic. Exposes ~27 route groups under `/api/v1/`.

### `apps/web` — React Dashboard

Vite + React SPA. Provides the operational dashboard including war room, workflow builder, memory browser, analytics, and settings.

---

## Packages

| Package | Description |
|---|---|
| `@ops/db` | Drizzle ORM schema, migrations, and typed query helpers |
| `@ops/shared-types` | Branded ID types, domain interfaces (`WorkflowDefinition`, `StepDefinition`, `MemoryEntry`, etc.), and `ApiResult<T>` |
| `@ops/workflow-engine` | Workflow state machine, `StepExecutor` interface, executor registry, retry backoff, checkpoint/replay |
| `@ops/policy-engine` | Autonomy level definitions, `evaluatePolicy()`, approval request lifecycle, blocked-action logging |
| `@ops/provider-router` | AI provider health tracking, routing tiers (`heavy`/`medium`/`light`/`local`), circuit breakers, cost logging |
| `@ops/runtime-kernel` | In-process typed event bus, state transition helpers, checkpoint primitives, dead-letter handling |
| `@ops/event-contracts` | Canonical typed event definitions consumed by API, workers, and the event bus |

---

## Workers

| Worker | Queue | Responsibility |
|---|---|---|
| `workflow-worker` | `workflow` | Execute workflow step-by-step, coordinate state transitions |
| `memory-worker` | `memory` | Generate and store vector embeddings, handle retrieval jobs |
| `analytics-worker` | `analytics` | Aggregate metrics and KPIs from operational data |
| `briefing-worker` | `briefing` | Generate AI-synthesized briefings from risks, opportunities, and events |
| `browser-worker` | `browser` | Run Playwright automation jobs in isolated sandboxes |
| `recovery-worker` | `recovery` | Detect failed runs, execute rollback and compensating actions |
| `optimization-worker` | `optimization` | Tune AI routing and cache hit rates, surface cost anomalies |

---

## API Routes

| Prefix | Description |
|---|---|
| `GET /health` | Liveness and readiness probe |
| `GET /metrics` | Prometheus metrics endpoint |
| `/api/v1/auth` | Login, token refresh, API key management |
| `/api/v1/workspaces` | Workspace CRUD and member management |
| `/api/v1/workflows` | Workflow definition CRUD |
| `/api/v1/workflow-runs` | Run lifecycle: start, pause, resume, cancel |
| `/api/v1/approvals` | Approval queue: list, approve, reject |
| `/api/v1/memory` | Semantic memory: write, search, delete |
| `/api/v1/events` | Event ingestion and query |
| `/api/v1/stream` | SSE stream for real-time run/event updates |
| `/api/v1/agents` | Agent registry and status |
| `/api/v1/risks` | Risk tracking: CRUD + AI analysis |
| `/api/v1/opportunities` | Opportunity tracking: CRUD + AI analysis |
| `/api/v1/insights` | AI-generated insights from operational data |
| `/api/v1/goals` | Goal tracking and progress |
| `/api/v1/businesses` | Business entity management |
| `/api/v1/briefings` | Briefing generation and history |
| `/api/v1/analytics` | Aggregated metrics and dashboards |
| `/api/v1/notifications` | Notification delivery and preferences |
| `/api/v1/search` | Cross-entity semantic search |
| `/api/v1/scheduler` | Cron-based workflow scheduling |
| `/api/v1/webhooks` | Inbound webhook registration and dispatch |
| `/api/v1/browser` | Browser automation job submission |
| `/api/v1/workers` | Worker health and queue depth |
| `/api/v1/dead-letter` | Dead-letter queue inspection and replay |
| `/api/v1/ai-usage` | AI token consumption and cost tracking |
| `/api/v1/export` | Data export (JSON/CSV) |

---

## Web Pages

| Page | Path |
|---|---|
| War Room | `/` |
| Workflows | `/workflows` |
| Agents | `/agents` |
| Risks | `/risks` |
| Memory Browser | `/memory` |
| Approvals | `/approvals` |
| Analytics | `/analytics` |
| Businesses | `/businesses` |
| Goals | `/goals` |
| Insights | `/insights` |
| Notifications | `/notifications` |
| Dead Letter Queue | `/dead-letter` |
| Timeline | `/timeline` |
| Settings | `/settings` |
