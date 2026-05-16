/**
 * Runtime Registry Tests
 *
 * Tests for:
 *   A) scorer.ts pure functions — no network/DB
 *   B) runtime-registry.ts routes via Fastify inject() — db-mocked
 *   C) lease-manager.ts helpers — indirectly via routes
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
  class Worker { constructor() {} on() { return this } }
  class QueueEvents { constructor() {} on() { return this } }
  return { Queue, Worker, QueueEvents }
})

vi.mock('@ops/service-recovery', () => ({
  requestRollback:   async () => ({ success: true }),
  getLatestSnapshot: async () => null,
  createSnapshot:    async () => ({ id: 'snap' }),
  listSnapshots:     async () => [],
  createCheckpoint:  async () => ({ id: 'cp' }),
  listCheckpoints:   async () => [],
  SERVICE_NAME: 'recovery',
}))

vi.mock('../telemetry.js', () => ({}))

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, makeTestToken } from './helpers.js'
import {
  computeLatencyScore, computeSuccessRateScore, computeCostScore,
  computeCapabilityScore, computeCompositeScore,
  evaluateCircuit, nextCircuitState,
} from '@ops/ai-router'

// ─── Test app ─────────────────────────────────────────────────────────────────

let app: FastifyInstance
let token: string

beforeAll(async () => {
  app   = await buildTestApp()
  token = makeTestToken(app)
})

afterAll(async () => {
  await app.close()
})

// ─── A) Scorer unit tests ─────────────────────────────────────────────────────

describe('scorer — computeLatencyScore', () => {
  it('returns 1.0 for 0ms', () => {
    expect(computeLatencyScore(0)).toBe(1.0)
  })
  it('returns 0.0 for 5000ms', () => {
    expect(computeLatencyScore(5_000)).toBe(0.0)
  })
  it('returns 0.5 for 2500ms', () => {
    expect(computeLatencyScore(2_500)).toBeCloseTo(0.5)
  })
  it('floors at 0 for >5000ms', () => {
    expect(computeLatencyScore(10_000)).toBe(0.0)
  })
})

describe('scorer — computeSuccessRateScore', () => {
  it('returns 1.0 for 0% error rate', () => {
    expect(computeSuccessRateScore(0)).toBe(1.0)
  })
  it('returns 0.0 for 100% error rate', () => {
    expect(computeSuccessRateScore(1.0)).toBe(0.0)
  })
  it('returns 0.5 for 50% error rate', () => {
    expect(computeSuccessRateScore(0.5)).toBeCloseTo(0.5)
  })
})

describe('scorer — computeCostScore', () => {
  it('returns 1.0 for free providers', () => {
    expect(computeCostScore(0)).toBe(1.0)
  })
  it('returns 0.5 for cost equal to baseline', () => {
    expect(computeCostScore(0.01, 0.01)).toBeCloseTo(0.5)
  })
  it('low cost scores higher than high cost', () => {
    expect(computeCostScore(0.001)).toBeGreaterThan(computeCostScore(0.1))
  })
})

describe('scorer — computeCapabilityScore', () => {
  it('returns 1.0 with no requirements', () => {
    expect(computeCapabilityScore(['gpu'], [])).toBe(1.0)
  })
  it('returns 1.0 when all capabilities match', () => {
    expect(computeCapabilityScore(['gpu', 'vision'], ['gpu', 'vision'])).toBe(1.0)
  })
  it('returns 0.5 for half match', () => {
    expect(computeCapabilityScore(['gpu'], ['gpu', 'vision'])).toBeCloseTo(0.5)
  })
  it('returns 0.0 for no match', () => {
    expect(computeCapabilityScore(['cpu'], ['gpu'])).toBe(0.0)
  })
})

describe('scorer — computeCompositeScore', () => {
  it('returns 1.0 for perfect provider', () => {
    const score = computeCompositeScore({
      latencyMs: 0, errorRate: 0, costUsdPerRequest: 0,
      capabilities: ['gpu'], requiredCapabilities: [],
    })
    expect(score).toBeCloseTo(1.0)
  })
  it('returns a weighted blend', () => {
    const score = computeCompositeScore({
      latencyMs: 2500, errorRate: 0.2, costUsdPerRequest: 0.01,
      capabilities: ['gpu'], requiredCapabilities: ['gpu'],
    })
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThan(1)
  })
})

// ─── Circuit breaker unit tests ───────────────────────────────────────────────

describe('scorer — evaluateCircuit', () => {
  it('allows requests when circuit is closed', () => {
    const result = evaluateCircuit('closed', 0, null)
    expect(result.shouldAllow).toBe(true)
    expect(result.state).toBe('closed')
  })

  it('blocks requests when circuit is open', () => {
    const result = evaluateCircuit('open', 5, Date.now() - 1_000)
    expect(result.shouldAllow).toBe(false)
    expect(result.state).toBe('open')
  })

  it('transitions open → half_open after recovery period', () => {
    const openedAt = Date.now() - 70_000  // 70s ago > 60s threshold
    const result   = evaluateCircuit('open', 5, openedAt)
    expect(result.state).toBe('half_open')
    expect(result.shouldAllow).toBe(true)
  })

  it('opens circuit after 5 failures', () => {
    const result = evaluateCircuit('closed', 5, null)
    expect(result.state).toBe('open')
    expect(result.shouldAllow).toBe(false)
  })
})

describe('scorer — nextCircuitState', () => {
  it('resets to closed on success', () => {
    const result = nextCircuitState('open', true, 5)
    expect(result.state).toBe('closed')
    expect(result.failures).toBe(0)
  })

  it('increments failures on failure', () => {
    const result = nextCircuitState('closed', false, 3)
    expect(result.failures).toBe(4)
    expect(result.state).toBe('closed')
  })

  it('opens circuit when failures reach threshold', () => {
    const result = nextCircuitState('closed', false, 4)
    expect(result.state).toBe('open')
    expect(result.failures).toBe(5)
  })

  it('re-opens circuit on half_open failure', () => {
    const result = nextCircuitState('half_open', false, 0)
    expect(result.state).toBe('open')
  })
})

// ─── B) Route integration tests ───────────────────────────────────────────────

describe('POST /api/v1/runtime/workers — register worker', () => {
  it('201 with valid body', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/api/v1/runtime/workers',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspaceId:  'ws-test-001',
        workerName:   'gpu-worker-01',
        workerType:   'gpu',
        capabilities: ['gpu', 'vision'],
        maxConcurrent: 4,
      },
    })
    // The DB is mocked (returns []), so insert resolves — but the route
    // returns the constructed object directly before querying back.
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body) as { success: boolean; data: { workerName: string } }
    expect(body.success).toBe(true)
    expect(body.data.workerName).toBe('gpu-worker-01')
  })

  it('400 when workspaceId missing', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/api/v1/runtime/workers',
      headers: { authorization: `Bearer ${token}` },
      payload: { workerName: 'gpu-worker-01' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /api/v1/runtime/workers/:workspaceId — list workers', () => {
  it('200 with empty list from mocked DB', async () => {
    const res = await app.inject({
      method:  'GET',
      url:     '/api/v1/runtime/workers/ws-test-001',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { success: boolean; data: unknown[] }
    expect(body.success).toBe(true)
    expect(Array.isArray(body.data)).toBe(true)
  })
})

describe('POST /api/v1/runtime/workers/:workerId/heartbeat', () => {
  it('404 when worker not found in mocked DB', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/api/v1/runtime/workers/nonexistent-id/heartbeat',
      headers: { authorization: `Bearer ${token}` },
      payload: { workspaceId: 'ws-test-001' },
    })
    // Mocked DB update returns [], so rows.length === 0 → 404
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /api/v1/runtime/leases — create lease', () => {
  it('400 when required fields missing', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/api/v1/runtime/leases',
      headers: { authorization: `Bearer ${token}` },
      payload: { workspaceId: 'ws-test-001' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('404 when worker not found in mocked DB', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/api/v1/runtime/leases',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspaceId: 'ws-test-001',
        workerId:    'worker-123',
        jobId:       'job-abc',
        jobType:     'ai',
      },
    })
    // Mocked DB select returns [] → 404
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /api/v1/runtime/leases/:workspaceId — list leases', () => {
  it('200 with empty list from mocked DB', async () => {
    const res = await app.inject({
      method:  'GET',
      url:     '/api/v1/runtime/leases/ws-test-001',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { success: boolean; data: unknown[] }
    expect(body.success).toBe(true)
  })
})

describe('GET /api/v1/runtime/scores/:workspaceId — list provider scores', () => {
  it('200 with empty list from mocked DB', async () => {
    const res = await app.inject({
      method:  'GET',
      url:     '/api/v1/runtime/scores/ws-test-001',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as { success: boolean; data: unknown[] }
    expect(body.success).toBe(true)
  })
})

describe('POST /api/v1/runtime/scores/record', () => {
  it('400 when workspaceId missing', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/api/v1/runtime/scores/record',
      headers: { authorization: `Bearer ${token}` },
      payload: { providerId: 'groq', latencyMs: 200, success: true },
    })
    expect(res.statusCode).toBe(400)
  })

  it('200 with computed scores on mocked DB', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/api/v1/runtime/scores/record',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        workspaceId:  'ws-test-001',
        providerId:   'groq',
        latencyMs:    250,
        success:      true,
        costUsdPerRequest: 0.001,
        capabilities: ['fast_chat'],
        requiredCapabilities: [],
      },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as {
      success: boolean
      data: { compositeScore: number; shouldAllow: boolean; circuitState: string }
    }
    expect(body.success).toBe(true)
    expect(body.data.compositeScore).toBeGreaterThan(0)
    expect(body.data.shouldAllow).toBe(true)
    expect(body.data.circuitState).toBe('closed')
  })
})

describe('GET /api/v1/runtime/scores/:workspaceId/:providerId/circuit', () => {
  it('200 with default closed state when no record', async () => {
    const res = await app.inject({
      method:  'GET',
      url:     '/api/v1/runtime/scores/ws-test-001/groq/circuit',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body) as {
      success: boolean
      data: { circuitState: string; shouldAllow: boolean }
    }
    expect(body.success).toBe(true)
    expect(body.data.circuitState).toBe('closed')
    expect(body.data.shouldAllow).toBe(true)
  })
})
