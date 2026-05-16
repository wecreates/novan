# Contributing to Ops Platform

## Development Setup

**Prerequisites:** Node.js ≥ 20, pnpm 9, Docker

```bash
# Install dependencies
pnpm install

# Start infrastructure (Postgres, Redis, Prometheus, Grafana)
pnpm infra:up

# Run migrations
pnpm db:migrate

# Start all services in parallel
pnpm dev
```

Services:
- API → `http://localhost:3001`
- Web → `http://localhost:5173`
- Swagger → `http://localhost:3001/docs`
- Grafana → `http://localhost:3000`

---

## Code Style

**TypeScript strict mode** is enforced across all packages. Key tsconfig settings:

```json
{
  "strict": true,
  "exactOptionalPropertyTypes": true,
  "noUncheckedIndexedAccess": true
}
```

Rules:
- No `any` — use `unknown` with narrowing
- No optional chaining around guaranteed non-null values
- Branded types for all IDs (`UserId`, `WorkflowId`, etc.) — import from `@ops/shared-types`
- All API responses use `ApiResult<T>` from `@ops/shared-types`
- Errors are handled in `plugins/errorHandler.ts` — throw, don't catch-and-suppress

Run checks:
```bash
pnpm typecheck   # tsc --noEmit across all packages
pnpm lint        # eslint --max-warnings 0
pnpm format      # prettier --write .
```

---

## Adding a New API Route

1. **Create the route file** at `apps/api/src/routes/<resource>.ts`:

```typescript
import type { FastifyPluginAsync } from 'fastify'

export const myResourceRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    return reply.send({ success: true, data: [] })
  })

  app.post('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    // req.userId and req.workspaceId are available after authenticate
    return reply.status(201).send({ success: true, data: {} })
  })
}
```

2. **Register in `apps/api/src/server.ts`**:

```typescript
import { myResourceRoutes } from './routes/my-resource.js'

// Inside the boot sequence:
await app.register(myResourceRoutes, { prefix: '/api/v1/my-resource' })
```

3. **Add Zod schemas** for request/response validation inline or in a `schemas/` file.

4. **Add a service** in `apps/api/src/services/` for business logic — keep routes thin.

---

## Adding a New Worker

1. **Create the worker package** at `workers/<name>-worker/`:

```
workers/my-worker/
├── package.json       name: "@ops/my-worker"
├── tsconfig.json      extends: "../../tsconfig.base.json"
└── src/
    ├── worker.ts      BullMQ Worker + processor
    └── index.ts       Entry point
```

2. **`src/worker.ts` pattern:**

```typescript
import { Worker } from 'bullmq'
import { redisConnection } from '@ops/runtime-kernel'

export function startMyWorker() {
  const worker = new Worker(
    'my-queue',
    async (job) => {
      // process job.data
    },
    { connection: redisConnection, concurrency: 5 }
  )

  worker.on('failed', (job, err) => {
    console.error(`Job ${job?.id} failed:`, err)
  })

  return worker
}
```

3. **Register the queue** in `apps/api/src/queues/index.ts` and add the queue name to `QueueName` in `@ops/shared-types`.

4. **Add worker health** to the `/api/v1/workers` route.

---

## Running Tests

```bash
pnpm test              # run all tests via turbo
pnpm --filter @ops/api test   # run tests for a specific package
```

Test files live alongside source in `src/**/*.test.ts` or in a top-level `test/` directory per package.

---

## Database Changes

1. Edit schema in `packages/db/src/schema/`
2. Generate migration: `pnpm db:push` (dev) or `pnpm db:migrate` (with migration files)
3. Inspect with Drizzle Studio: `pnpm db:studio`

All schema changes must be backward-compatible or paired with a migration rollback plan.

---

## Monorepo Commands

```bash
pnpm dev             # start everything
pnpm build           # production build (turbo, cached)
pnpm typecheck       # type-check all packages
pnpm lint            # lint all packages
pnpm format          # format all files
pnpm infra:up        # start Docker services
pnpm infra:down      # stop Docker services
```

Turborepo caches build/typecheck/test outputs. Use `--force` to bypass: `turbo run build --force`.
