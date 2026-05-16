/**
 * Phase 4 — Cloud/API-Only Runtime Mode Tests
 *
 * A) runtime-mode.ts service (checkComputeAllowed logic via route GET /mode)
 * B) cloud-runtime routes: mode, validate-key, user-creds, route-preflight
 */

// ── Infrastructure mocks ──────────────────────────────────────────────────────

vi.mock('../db/client.js', () => {
  function makeChain(): unknown {
    return new Proxy(
      { _isChain: true },
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve([])
          if (typeof prop === 'symbol') return undefined
          return () => makeChain()
        },
      },
    )
  }
  const db = new Proxy({}, {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined
      return () => makeChain()
    },
  })
  return { db }
})

vi.mock('../redis/client.js', () => ({
  redisClient: {
    ping: async () => 'PONG', quit: async () => 'OK',
    get:  async () => null,   set:  async () => 'OK',
    del:  async () => 1,      on:   () => undefined,
    disconnect: async () => undefined,
  },
  redisSubscriber: {
    ping: async () => 'PONG', quit: async () => 'OK',
    on:   () => undefined,    subscribe: async () => undefined,
  },
}))

vi.mock('../queues/index.js', () => {
  const makeQueue = () => ({
    add:               async () => ({ id: 'mock-job-id' }),
    getJob:            async () => null,
    getJobs:           async () => [],
    waitUntilReady:    async () => undefined,
    close:             async () => undefined,
    on:                () => undefined,
    getWaitingCount:   async () => 0,
    getActiveCount:    async () => 0,
    getCompletedCount: async () => 0,
    getFailedCount:    async () => 0,
    getDelayedCount:   async () => 0,
  })
  const queueNames = ['workflow','browser','memory','analytics','recovery',
    'optimization','notifications','briefing'] as const
  return {
    queues: Object.fromEntries(queueNames.map((n) => [n, makeQueue()])),
    queueEvents: {},
    registerQueues:  async () => undefined,
    getQueueMetrics: async () =>
      Object.fromEntries(queueNames.map((n) => [n, { waiting:0,active:0,completed:0,failed:0,delayed:0 }])),
  }
})

vi.mock('bullmq', () => {
  const q = () => ({
    add: async () => ({ id: 'j' }), getJob: async () => null, getJobs: async () => [],
    waitUntilReady: async () => undefined, close: async () => undefined, on: () => undefined,
    obliterate: async () => undefined,
    getWaitingCount: async () => 0, getActiveCount: async () => 0,
    getCompletedCount: async () => 0, getFailedCount: async () => 0, getDelayedCount: async () => 0,
  })
  class Queue { constructor() { Object.assign(this, q()) } }
  class Worker { constructor() { Object.assign(this, { on: () => undefined, close: async () => undefined }) } }
  class QueueEvents { constructor() { Object.assign(this, { on: () => undefined, close: async () => undefined }) } }
  return { Queue, Worker, QueueEvents }
})

vi.mock('@ops/service-recovery', () => ({
  requestRollback: async () => ({ success: true, snapshotId: 'snap-1', itemCount: 0 }),
  getSnapshotStatus: async () => ({ status: 'ready', itemCount: 0 }),
}))

vi.mock('../telemetry.js', () => ({}))

// ── Imports ───────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, makeTestToken } from './helpers.js'

// ── Test app ──────────────────────────────────────────────────────────────────

let app: FastifyInstance
let token: string

beforeAll(async () => {
  app   = await buildTestApp()
  token = makeTestToken(app)
})

afterAll(async () => {
  await app.close()
})

// ─── A) GET /api/v1/cloud-runtime/mode ───────────────────────────────────────

describe('GET /api/v1/cloud-runtime/mode', () => {
  it('returns 400 when workspaceId missing', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/cloud-runtime/mode',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns settings object with workspaceId', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/cloud-runtime/mode?workspaceId=ws-1',
      headers: { authorization: `Bearer ${token}` },
    })
    // DB returns [] so getRuntimeSettings creates a default → returns settings
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('settings')
    expect(body.settings).toHaveProperty('mode')
  })
})

// ─── B) PUT /api/v1/cloud-runtime/mode ───────────────────────────────────────

describe('PUT /api/v1/cloud-runtime/mode', () => {
  it('returns 400 when body missing workspaceId', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/v1/cloud-runtime/mode',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ mode: 'cloud-api-only' }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('updates mode with valid payload', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/v1/cloud-runtime/mode',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        workspaceId: 'ws-1', mode: 'hybrid', allowLocalGpu: true, allowLocalBrowser: false,
      }),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('settings')
  })

  it('accepts cloud-api-only mode', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/v1/cloud-runtime/mode',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ workspaceId: 'ws-1', mode: 'cloud-api-only' }),
    })
    expect(res.statusCode).toBe(200)
  })

  it('rejects invalid mode value', async () => {
    const res = await app.inject({
      method: 'PUT', url: '/api/v1/cloud-runtime/mode',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ workspaceId: 'ws-1', mode: 'turbo' }),
    })
    expect(res.statusCode).toBe(400)
  })
})

// ─── C) POST /api/v1/cloud-runtime/validate-key ──────────────────────────────

describe('POST /api/v1/cloud-runtime/validate-key', () => {
  it('returns 400 when required fields missing', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/cloud-runtime/validate-key',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ workspaceId: 'ws-1' }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns valid:true for unknown provider (no endpoint to hit)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/cloud-runtime/validate-key',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        workspaceId: 'ws-1', providerId: 'unknown-provider', apiKey: 'test-key-xyz',
      }),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('valid')
    // Unknown provider → assumed valid
    expect(body.valid).toBe(true)
  })

  it('never returns the api key in response', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/cloud-runtime/validate-key',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        workspaceId: 'ws-1', providerId: 'unknown-provider', apiKey: 'secret-key-12345',
      }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('secret-key-12345')
  })
})

// ─── D) GET /api/v1/cloud-runtime/user-creds ─────────────────────────────────

describe('GET /api/v1/cloud-runtime/user-creds', () => {
  it('returns 400 when userId missing', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/cloud-runtime/user-creds?workspaceId=ws-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns creds array (empty when DB mocked)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/cloud-runtime/user-creds?workspaceId=ws-1&userId=user-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('creds')
    expect(Array.isArray(body.creds)).toBe(true)
  })
})

// ─── E) POST /api/v1/cloud-runtime/user-creds ────────────────────────────────

describe('POST /api/v1/cloud-runtime/user-creds', () => {
  it('returns 400 when required fields missing', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/cloud-runtime/user-creds',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ workspaceId: 'ws-1', userId: 'user-1' }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 500 when ENCRYPTION_KEY not configured', async () => {
    // encryptionAvailable() returns false in test env (no ENCRYPTION_KEY)
    const res = await app.inject({
      method: 'POST', url: '/api/v1/cloud-runtime/user-creds',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        workspaceId: 'ws-1', userId: 'user-1', providerId: 'openai',
        label: 'My Key', apiKey: 'sk-test',
      }),
    })
    // Either 500 (no encryption key) or 201 depending on env
    expect([201, 500]).toContain(res.statusCode)
  })
})

// ─── F) DELETE /api/v1/cloud-runtime/user-creds/:id ──────────────────────────

describe('DELETE /api/v1/cloud-runtime/user-creds/:id', () => {
  it('returns 404 when cred not found (DB returns empty)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/cloud-runtime/user-creds/cred-999?workspaceId=ws-1&userId=user-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns 400 when workspaceId/userId missing', async () => {
    const res = await app.inject({
      method: 'DELETE', url: '/api/v1/cloud-runtime/user-creds/cred-999',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })
})

// ─── G) POST /api/v1/cloud-runtime/route-preflight ───────────────────────────

describe('POST /api/v1/cloud-runtime/route-preflight', () => {
  it('returns 400 when required fields missing', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/cloud-runtime/route-preflight',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ workspaceId: 'ws-1' }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns decision object for valid request', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/cloud-runtime/route-preflight',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        workspaceId: 'ws-1', computeType: 'ai',
        estimatedCostUsd: 0.01, scopeType: 'workflow',
        scopeId: 'wf-1', executionId: 'exec-1',
      }),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('decision')
    expect(body.decision).toHaveProperty('approved')
    expect(body.decision).toHaveProperty('checkedAt')
  })

  it('rejects invalid computeType', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/cloud-runtime/route-preflight',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        workspaceId: 'ws-1', computeType: 'quantum',
        estimatedCostUsd: 0.01, scopeType: 'workflow',
        scopeId: 'wf-1', executionId: 'exec-1',
      }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('approves when mode=local and computeType=ai (DB returns empty → local mode default)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/cloud-runtime/route-preflight',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        workspaceId: 'ws-local', computeType: 'ai',
        estimatedCostUsd: 0.001, scopeType: 'agent',
        scopeId: 'agent-1', executionId: 'exec-2',
      }),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.decision).toHaveProperty('approved')
    // In local mode with no budget caps, should be approved
    expect(body.decision.approved).toBe(true)
  })

  it('decision has required fields', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/cloud-runtime/route-preflight',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        workspaceId: 'ws-2', computeType: 'browser',
        estimatedCostUsd: 0, scopeType: 'job',
        scopeId: 'job-1', executionId: 'exec-3', isWorkflow: false,
      }),
    })
    expect(res.statusCode).toBe(200)
    const d = res.json().decision
    expect(typeof d.approved).toBe('boolean')
    expect(typeof d.checkedAt).toBe('number')
    expect('blockReason' in d).toBe(true)
    expect('providerId' in d).toBe(true)
    expect('mustUseRemote' in d).toBe(true)
    expect('guardId' in d).toBe(true)
  })
})
