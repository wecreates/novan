/**
 * Smoke tests — verifies every major route group returns expected status codes.
 * Uses Fastify inject() — no real HTTP, DB, Redis, or queues needed.
 *
 * Mocks must be declared before any imports that transitively load those modules.
 * Vitest hoists vi.mock() calls to the top of the compiled output automatically.
 */

// ── Infrastructure mocks ──────────────────────────────────────────────────────

// Prevent db/client.ts from throwing "DATABASE_URL is required" at load time
vi.mock('../db/client.js', () => {

  function makeChain(): unknown {
    return new Proxy(
      { _isChain: true },
      {
        get(_target, prop) {
          if (prop === 'then') {
            // Make the chain directly awaitable → resolves to []
            return (resolve: (v: unknown) => unknown) => resolve([])
          }
          if (typeof prop === 'symbol') return undefined
          // Any method call → returns another chain
          return () => makeChain()
        },
      }
    )
  }

  const db = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'symbol') return undefined
        return () => makeChain()
      },
    }
  )

  return { db }
})

// Prevent redis/client.ts from throwing "REDIS_URL is required" at load time
vi.mock('../redis/client.js', () => ({
  redisClient: {
    ping:          async () => 'PONG',
    quit:          async () => 'OK',
    get:           async () => null,
    set:           async () => 'OK',
    del:           async () => 1,
    on:            () => undefined,
    disconnect:    async () => undefined,
    getWaitingCount:   async () => 0,
    getActiveCount:    async () => 0,
    getCompletedCount: async () => 0,
    getFailedCount:    async () => 0,
    getDelayedCount:   async () => 0,
  },
  redisSubscriber: {
    ping:   async () => 'PONG',
    quit:   async () => 'OK',
    on:     () => undefined,
    subscribe: async () => undefined,
  },
}))

// Prevent BullMQ queues from connecting to Redis
vi.mock('../queues/index.js', () => {
  const makeQueue = () => ({
    add:               async () => ({ id: 'mock-job-id' }),
    remove:            async () => true,
    getJob:            async () => null,
    getJobs:           async () => [],
    getWaitingCount:   async () => 0,
    getActiveCount:    async () => 0,
    getCompletedCount: async () => 0,
    getFailedCount:    async () => 0,
    getDelayedCount:   async () => 0,
    waitUntilReady:    async () => undefined,
    close:             async () => undefined,
    on:                () => undefined,
  })

  const queueNames = ['workflow', 'browser', 'memory', 'analytics', 'recovery',
    'optimization', 'notifications', 'briefing'] as const

  const queues = Object.fromEntries(queueNames.map((n) => [n, makeQueue()]))

  return {
    queues,
    queueEvents:      {},
    registerQueues:   async () => undefined,
    getQueueMetrics:  async () =>
      Object.fromEntries(queueNames.map((n) => [n, { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }])),
  }
})

// Prevent BullMQ from creating real Redis connections in routes that use Queue directly
vi.mock('bullmq', () => {
  const makeQueue = () => ({
    add:               async () => ({ id: 'mock-job-id' }),
    remove:            async () => true,
    getJob:            async () => null,
    getJobs:           async () => [],
    getWaitingCount:   async () => 0,
    getActiveCount:    async () => 0,
    getCompletedCount: async () => 0,
    getFailedCount:    async () => 0,
    getDelayedCount:   async () => 0,
    waitUntilReady:    async () => undefined,
    close:             async () => undefined,
    on:                () => undefined,
    obliterate:        async () => undefined,
  })
  class Queue { constructor() { Object.assign(this, makeQueue()) } }
  class Worker { constructor() {} on() { return this } }
  class QueueEvents { constructor() {} on() { return this } }
  return { Queue, Worker, QueueEvents }
})

// Prevent @ops/service-recovery from loading its own DB client (requires DATABASE_URL)
vi.mock('@ops/service-recovery', () => ({
  requestRollback:   async () => ({ success: true }),
  getLatestSnapshot: async () => null,
  createSnapshot:    async () => ({ id: 'mock-snapshot' }),
  listSnapshots:     async () => [],
  createCheckpoint:  async () => ({ id: 'mock-checkpoint' }),
  listCheckpoints:   async () => [],
  SERVICE_NAME: 'recovery',
}))

// Prevent telemetry from connecting to OTLP collector
vi.mock('../telemetry.js', () => ({}))

// ── Test imports (after mocks) ─────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, makeTestToken } from './helpers.js'

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('API Smoke Tests', () => {
  let app: FastifyInstance
  let authHeader: string

  beforeAll(async () => {
    app = await buildTestApp()
    authHeader = `Bearer ${makeTestToken(app)}`
  })

  afterAll(async () => {
    await app.close()
  })

  // ── Health ───────────────────────────────────────────────────────────────

  describe('Health', () => {
    it('GET /health → 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ status: 'ok' })
    })

    it('GET /health/live → 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/health/live' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ status: 'live' })
    })

    it('GET /health/ready → 200 or 503 (deps mocked)', async () => {
      const res = await app.inject({ method: 'GET', url: '/health/ready' })
      // Redis mock returns PONG; DB mock may return [] for execute → status depends on implementation
      expect([200, 503]).toContain(res.statusCode)
    })
  })

  // ── Workflows ─────────────────────────────────────────────────────────────

  describe('Workflows', () => {
    it('GET /api/v1/workflows → 200 (auth required)', async () => {
      const res = await app.inject({
        method: 'GET', url: '/api/v1/workflows',
        headers: { authorization: authHeader },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ success: true, data: expect.any(Array) })
    })

    it('GET /api/v1/workflows → 401 without token', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/workflows' })
      expect(res.statusCode).toBe(401)
    })

    it('POST /api/v1/workflows with valid body → 201', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/workflows',
        headers: { authorization: authHeader, 'content-type': 'application/json' },
        payload: {
          name: 'Smoke Test Workflow',
          steps: [{ id: 'step-1', name: 'Step 1', type: 'action', config: {}, dependsOn: [], timeout: null, onFailure: 'fail' }],
        },
      })
      expect(res.statusCode).toBe(201)
    })

    it('POST /api/v1/workflows with invalid body → 400 or 500', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/workflows',
        headers: { authorization: authHeader, 'content-type': 'application/json' },
        payload: { name: '' }, // fails zod: name min(1) + missing steps
      })
      expect([400, 422, 500]).toContain(res.statusCode)
    })
  })

  // ── Memory ────────────────────────────────────────────────────────────────

  describe('Memory', () => {
    it('GET /api/v1/memory → 200 (auth required)', async () => {
      const res = await app.inject({
        method: 'GET', url: '/api/v1/memory',
        headers: { authorization: authHeader },
      })
      expect(res.statusCode).toBe(200)
    })

    it('GET /api/v1/memory → 401 without token', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/memory' })
      expect(res.statusCode).toBe(401)
    })
  })

  // ── Opportunities ─────────────────────────────────────────────────────────

  describe('Opportunities', () => {
    it('GET /api/v1/opportunities → 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/opportunities' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ success: true })
    })
  })

  // ── Risks ─────────────────────────────────────────────────────────────────

  describe('Risks', () => {
    it('GET /api/v1/risks → 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/risks' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ success: true })
    })
  })

  // ── Insights ──────────────────────────────────────────────────────────────

  describe('Insights', () => {
    it('GET /api/v1/insights → 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/insights' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ success: true })
    })
  })

  // ── Goals ─────────────────────────────────────────────────────────────────

  describe('Goals', () => {
    it('GET /api/v1/goals → 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/goals' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ success: true })
    })
  })

  // ── Agents ────────────────────────────────────────────────────────────────

  describe('Agents', () => {
    it('GET /api/v1/agents → 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/agents' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ success: true })
    })
  })

  // ── Businesses ────────────────────────────────────────────────────────────

  describe('Businesses', () => {
    it('GET /api/v1/businesses → 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/businesses' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ success: true })
    })
  })

  // ── Analytics ─────────────────────────────────────────────────────────────

  describe('Analytics', () => {
    it('GET /api/v1/analytics/summary → 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/analytics/summary' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ success: true })
    })

    it('GET /api/v1/analytics/ai-usage → 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/analytics/ai-usage' })
      expect(res.statusCode).toBe(200)
    })

    it('GET /api/v1/analytics/ai-usage/history → 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/analytics/ai-usage/history' })
      expect(res.statusCode).toBe(200)
    })
  })

  // ── Notifications ─────────────────────────────────────────────────────────

  describe('Notifications', () => {
    it('GET /api/v1/notifications → 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/notifications' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ success: true })
    })
  })

  // ── Search ────────────────────────────────────────────────────────────────

  describe('Search', () => {
    it('GET /api/v1/search?q=test → 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/search?q=test' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ success: true, data: expect.any(Array) })
    })

    it('GET /api/v1/search?q=x (< 2 chars) → 200 empty', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/search?q=x' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ success: true, data: [] })
    })
  })

  // ── Workers ───────────────────────────────────────────────────────────────

  describe('Workers', () => {
    it('GET /api/v1/workers/health → 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/workers/health' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ success: true })
    })

    it('GET /api/v1/workers/queues → 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/workers/queues' })
      expect(res.statusCode).toBe(200)
    })
  })

  // ── Dead Letter ───────────────────────────────────────────────────────────

  describe('Dead Letter', () => {
    it('GET /api/v1/dead-letter → 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/dead-letter' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ success: true })
    })

    it('GET /api/v1/dead-letter/stats → 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/dead-letter/stats' })
      expect(res.statusCode).toBe(200)
    })
  })

  // ── Scheduler ─────────────────────────────────────────────────────────────

  describe('Scheduler', () => {
    it('GET /api/v1/scheduler → 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/scheduler' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ success: true })
    })
  })

  // ── Workspaces ────────────────────────────────────────────────────────────

  describe('Workspaces', () => {
    it('GET /api/v1/workspaces → 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/workspaces' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ success: true })
    })

    it('GET /api/v1/workspaces/current → 200 or 404 (no rows in mock DB)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/workspaces/current' })
      // Mock DB returns [] so the route will 404 (workspace not found) — that's expected behaviour
      expect([200, 404]).toContain(res.statusCode)
    })
  })

  // ── Auth ──────────────────────────────────────────────────────────────────

  describe('Auth', () => {
    it('GET /api/v1/auth/tokens → 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/auth/tokens' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ success: true, data: expect.any(Array) })
    })

    it('POST /api/v1/auth/tokens with valid body → 201', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/auth/tokens',
        headers: { 'content-type': 'application/json' },
        payload: { name: 'Smoke Test Token' },
      })
      expect(res.statusCode).toBe(201)
    })

    it('POST /api/v1/auth/verify → 200', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/auth/verify',
        headers: { 'content-type': 'application/json' },
        payload: { token: 'ops_abc123def456ghi789' },
      })
      expect(res.statusCode).toBe(200)
    })
  })

  // ── Export ────────────────────────────────────────────────────────────────

  describe('Export', () => {
    it('GET /api/v1/export/events → 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/export/events' })
      expect(res.statusCode).toBe(200)
    })

    it('GET /api/v1/export/risks → 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/export/risks' })
      expect(res.statusCode).toBe(200)
    })

    it('GET /api/v1/export/goals → 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/export/goals' })
      expect(res.statusCode).toBe(200)
    })

    it('GET /api/v1/export/insights → 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/export/insights' })
      expect(res.statusCode).toBe(200)
    })

    it('GET /api/v1/export/opportunities → 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/export/opportunities' })
      expect(res.statusCode).toBe(200)
    })
  })

  // ── Briefings ─────────────────────────────────────────────────────────────

  describe('Briefings', () => {
    it('GET /api/v1/briefings → 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/briefings' })
      expect(res.statusCode).toBe(200)
    })
  })

  // ── Workflow Runs ─────────────────────────────────────────────────────────

  describe('Workflow Runs', () => {
    it('GET /api/v1/workflow-runs → 200 (auth required)', async () => {
      const res = await app.inject({
        method: 'GET', url: '/api/v1/workflow-runs',
        headers: { authorization: authHeader },
      })
      expect(res.statusCode).toBe(200)
    })

    it('GET /api/v1/workflow-runs → 401 without token', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/workflow-runs' })
      expect(res.statusCode).toBe(401)
    })
  })

  // ── Events ────────────────────────────────────────────────────────────────

  describe('Events', () => {
    it('GET /api/v1/events → 200 (auth required)', async () => {
      const res = await app.inject({
        method: 'GET', url: '/api/v1/events',
        headers: { authorization: authHeader },
      })
      expect(res.statusCode).toBe(200)
    })
  })

  // ── Approvals ─────────────────────────────────────────────────────────────

  describe('Approvals', () => {
    it('GET /api/v1/approvals → 200 (auth required)', async () => {
      const res = await app.inject({
        method: 'GET', url: '/api/v1/approvals',
        headers: { authorization: authHeader },
      })
      expect(res.statusCode).toBe(200)
    })
  })

  // ── AI Usage ──────────────────────────────────────────────────────────────

  describe('AI Usage', () => {
    // Route only defines POST / and GET /summary — no bare GET /
    it('GET /api/v1/ai-usage/summary → 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/ai-usage/summary' })
      expect(res.statusCode).toBe(200)
    })

    it('POST /api/v1/ai-usage with valid body → 200 or 201', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/ai-usage',
        headers: { 'content-type': 'application/json' },
        payload: {
          provider: 'anthropic', model: 'claude-sonnet-4-6',
          promptTokens: 100, outputTokens: 50,
          costUsd: 0.001, latencyMs: 500, taskType: 'smoke-test',
        },
      })
      expect([200, 201]).toContain(res.statusCode)
    })
  })

  // ── Metrics (Prometheus) ──────────────────────────────────────────────────

  describe('Metrics', () => {
    it('GET /metrics → 200 or 404 (depending on impl)', async () => {
      const res = await app.inject({ method: 'GET', url: '/metrics' })
      // metrics endpoint may return text/plain; just assert it doesn't crash
      expect([200, 204, 404]).toContain(res.statusCode)
    })
  })

  // ── 404 handling ──────────────────────────────────────────────────────────

  describe('404 handling', () => {
    it('GET /api/v1/nonexistent → 404', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/nonexistent' })
      expect(res.statusCode).toBe(404)
    })
  })
})
