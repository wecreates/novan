# @ops/api

Fastify 5 REST API for Novan. Handles authentication, workspace scoping, business logic, and queue dispatch.

**Port:** `3001` (default) · **Swagger UI:** `http://localhost:3001/docs`

---

## Authentication

All `/api/v1/*` routes require a JWT `Authorization: Bearer <token>` header, except auth endpoints.

**JWT payload:**
```json
{ "sub": "<userId>", "wid": "<workspaceId>", "exp": 1234567890, "iat": 1234567890 }
```

The `authenticate` Fastify decorator verifies the token and attaches `req.userId` and `req.workspaceId` to every request.

**Obtain a token:**
```http
POST /api/v1/auth/login
Content-Type: application/json

{ "email": "user@example.com", "password": "..." }
```

**Response:**
```json
{ "success": true, "data": { "token": "eyJ...", "refreshToken": "..." } }
```

---

## Rate Limiting

Global rate limit enforced via `@fastify/rate-limit`. Defaults: **1 000 req / 1 min** per IP. Responses include standard `RateLimit-*` headers.

---

## Key Endpoints

### Workflows

```http
GET    /api/v1/workflows                   # list all definitions
POST   /api/v1/workflows                   # create definition
GET    /api/v1/workflows/:id               # get definition
PATCH  /api/v1/workflows/:id               # update definition
DELETE /api/v1/workflows/:id               # delete definition

POST   /api/v1/workflow-runs               # start a run
GET    /api/v1/workflow-runs/:id           # get run status
POST   /api/v1/workflow-runs/:id/pause     # pause
POST   /api/v1/workflow-runs/:id/resume    # resume
POST   /api/v1/workflow-runs/:id/cancel    # cancel
```

### Memory

```http
POST   /api/v1/memory                      # write memory entry
GET    /api/v1/memory/search?q=...         # semantic search
DELETE /api/v1/memory/:id                  # delete entry
```

### Approvals

```http
GET    /api/v1/approvals                   # pending approvals
POST   /api/v1/approvals/:id/approve       # approve a step
POST   /api/v1/approvals/:id/reject        # reject a step
```

### Real-time Stream

```http
GET    /api/v1/stream                      # SSE stream (run events, system events)
```

Connect with `EventSource`. Events are JSON with `type`, `payload`, and `traceId`.

### Search

```http
GET    /api/v1/search?q=...&types=risks,opportunities
```

Cross-entity semantic search. `types` is optional comma-separated filter.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | Postgres connection string |
| `REDIS_URL` | Yes | — | Redis connection string (`redis://...`) |
| `JWT_SECRET` | Yes | — | HMAC secret for JWT signing |
| `API_PORT` | No | `3001` | Port to listen on |
| `API_HOST` | No | `0.0.0.0` | Host to bind |
| `ANTHROPIC_API_KEY` | No | — | Anthropic Claude API key |
| `OPENAI_API_KEY` | No | — | OpenAI API key |
| `GEMINI_API_KEY` | No | — | Google Gemini API key |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | — | OpenTelemetry collector endpoint |
| `NODE_ENV` | No | `development` | `development` \| `production` |

---

## Request/Response Shape

All responses use `ApiResult<T>`:

```typescript
// Success
{ "success": true,  "data": T, "requestId": "..." }

// Error
{ "success": false, "error": "message", "code": "ERROR_CODE", "requestId": "..." }
```

---

## Project Structure

```
src/
├── server.ts          Entry point — Fastify app, plugin registration, route mounting
├── telemetry.ts       OpenTelemetry bootstrap (must be first import)
├── plugins/
│   ├── auth.ts        JWT verification decorator
│   ├── audit.ts       Audit log plugin
│   ├── errorHandler.ts Centralized error formatting
│   └── requestContext.ts Request ID + trace propagation
├── routes/            One file per route group
├── services/          Business logic layer
├── queues/            BullMQ queue clients
├── redis/             ioredis client
└── db/                Drizzle instance + query helpers
```
