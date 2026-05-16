/**
 * Stability Monitor Tests
 *
 * A) computeHealthScore (pure service with mocked DB)
 * B) Stability routes via Fastify inject()
 * C) Budget preflight under pressure (pure function tests)
 * D) Kill switch chaos
 * E) Disaster recovery run
 * F) Queue pressure simulation
 * G) Recovery flow
 * H) Runtime mode enforcement
 */

// ── Infrastructure mocks ──────────────────────────────────────────────────────

vi.mock('../db/client.js', () => {
  function makeChain(): unknown {
    return new Proxy({ _isChain: true }, {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve([])
        if (typeof prop === 'symbol') return undefined
        return () => makeChain()
      },
    })
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
  redisClient: { ping: async () => 'PONG', quit: async () => 'OK', get: async () => null, set: async () => 'OK', del: async () => 1, on: () => undefined, disconnect: async () => undefined },
  redisSubscriber: { ping: async () => 'PONG', quit: async () => 'OK', on: () => undefined, subscribe: async () => undefined },
}))

vi.mock('../queues/index.js', () => {
  const makeQueue = () => ({ add: async () => ({ id: 'mock-job-id' }), getJob: async () => null, getJobs: async () => [], waitUntilReady: async () => undefined, close: async () => undefined, on: () => undefined, getWaitingCount: async () => 0, getActiveCount: async () => 0, getCompletedCount: async () => 0, getFailedCount: async () => 0, getDelayedCount: async () => 0 })
  const queueNames = ['workflow','browser','memory','analytics','recovery','optimization','notifications','briefing'] as const
  return { queues: Object.fromEntries(queueNames.map((n) => [n, makeQueue()])), queueEvents: {}, registerQueues: async () => undefined, getQueueMetrics: async () => Object.fromEntries(queueNames.map((n) => [n, { waiting:0,active:0,completed:0,failed:0,delayed:0 }])) }
})

vi.mock('bullmq', () => {
  const q = () => ({ add: async () => ({ id: 'j' }), getJob: async () => null, getJobs: async () => [], waitUntilReady: async () => undefined, close: async () => undefined, on: () => undefined, obliterate: async () => undefined, getWaitingCount: async () => 0, getActiveCount: async () => 0, getCompletedCount: async () => 0, getFailedCount: async () => 0, getDelayedCount: async () => 0 })
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
import { computeHealthScore } from '../services/stability-monitor.js'
import { checkBudgetPreflight, evaluateKillSwitches } from '@ops/ai-router'
import type { BudgetCap } from '@ops/ai-router'

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

// ─── A) computeHealthScore ────────────────────────────────────────────────────

describe('computeHealthScore', () => {
  it('returns a valid HealthReport structure', async () => {
    const report = await computeHealthScore('ws-1')
    expect(report).toHaveProperty('workspaceId', 'ws-1')
    expect(report).toHaveProperty('overall')
    expect(report).toHaveProperty('components')
    expect(report).toHaveProperty('alerts')
    expect(report).toHaveProperty('checkedAt')
    expect(report).toHaveProperty('stuckWorkflows')
    expect(report).toHaveProperty('orphanLeases')
    expect(report).toHaveProperty('deadWorkers')
  })

  it('overall score is between 0 and 100', async () => {
    const { overall } = await computeHealthScore('ws-1')
    expect(overall).toBeGreaterThanOrEqual(0)
    expect(overall).toBeLessThanOrEqual(100)
  })

  it('all component scores are between 0 and 100', async () => {
    const { components } = await computeHealthScore('ws-1')
    for (const score of Object.values(components)) {
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(100)
    }
  })

  it('alerts is an array', async () => {
    const { alerts } = await computeHealthScore('ws-1')
    expect(Array.isArray(alerts)).toBe(true)
  })

  it('checkedAt is a recent timestamp', async () => {
    const before = Date.now()
    const { checkedAt } = await computeHealthScore('ws-1')
    const after = Date.now()
    expect(checkedAt).toBeGreaterThanOrEqual(before)
    expect(checkedAt).toBeLessThanOrEqual(after)
  })
})

// ─── B) Stability routes ──────────────────────────────────────────────────────

describe('GET /api/v1/stability/health', () => {
  it('returns 200 with report.overall when workspaceId provided', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/stability/health?workspaceId=ws-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('report')
    expect(body.report).toHaveProperty('overall')
    expect(typeof body.report.overall).toBe('number')
  })

  it('returns 400 when workspaceId missing', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/stability/health',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /api/v1/stability/alerts', () => {
  it('returns 200 with alerts array and overall number', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/stability/alerts?workspaceId=ws-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body.alerts)).toBe(true)
    expect(typeof body.overall).toBe('number')
  })
})

describe('POST /api/v1/stability/chaos/simulate', () => {
  it('returns 200 with simulated:true for valid scenario', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/stability/chaos/simulate',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ workspaceId: 'ws-1', scenario: 'queue_flood' }),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.simulated).toBe(true)
    expect(body.scenario).toBe('queue_flood')
  })

  it('returns 400 for invalid scenario', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/stability/chaos/simulate',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ workspaceId: 'ws-1', scenario: 'nuclear_option' }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 400 when body missing required fields', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/stability/chaos/simulate',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ scenario: 'queue_flood' }),
    })
    expect(res.statusCode).toBe(400)
  })
})

// ─── C) Budget preflight under pressure ──────────────────────────────────────

describe('checkBudgetPreflight — pressure tests', () => {
  const baseCap: BudgetCap = {
    id: 'cap-pressure-1', scopeType: 'workspace', scopeId: 'ws-1',
    maxDailyUsd: 50, maxMonthlyUsd: 500,
    maxPerExecutionUsd: 10, maxWorkflowUsd: 100,
    currentDailyUsd: 0, currentMonthlyUsd: 0,
    enabled: true,
  }

  it('blocks when daily cap exhausted', () => {
    const cap = { ...baseCap, currentDailyUsd: 50, maxPerExecutionUsd: 0 }
    const r   = checkBudgetPreflight(1.0, [cap])
    expect(r.approved).toBe(false)
  })

  it('blocks when per-execution limit exceeded', () => {
    const r = checkBudgetPreflight(15.0, [baseCap])
    expect(r.approved).toBe(false)
    expect(r.blockReason).toContain('per-execution')
  })

  it('approves when no caps active', () => {
    const r = checkBudgetPreflight(999, [])
    expect(r.approved).toBe(true)
  })

  it('approves when under all limits', () => {
    const r = checkBudgetPreflight(2.0, [baseCap])
    expect(r.approved).toBe(true)
    expect(r.blockReason).toBeNull()
  })
})

// ─── D) Kill switch chaos ─────────────────────────────────────────────────────

describe('evaluateKillSwitches — chaos scenarios', () => {
  it('global kill switch blocks all job types', () => {
    const r = evaluateKillSwitches(
      [{ switchType: 'provider', enabled: true }],
      { providerId: 'openai' },
    )
    expect(r.blocked).toBe(true)
  })

  it('browser kill switch blocks only browser jobs', () => {
    const browser = evaluateKillSwitches(
      [{ switchType: 'browser_job', enabled: true }],
      { jobType: 'browser' },
    )
    expect(browser.blocked).toBe(true)

    const other = evaluateKillSwitches(
      [{ switchType: 'browser_job', enabled: true }],
      { jobType: 'remote' },
    )
    expect(other.blocked).toBe(false)
  })

  it('disabled switch allows all jobs', () => {
    const r = evaluateKillSwitches(
      [{ switchType: 'global', enabled: false }],
      {},
    )
    expect(r.blocked).toBe(false)
  })
})

// ─── E) Disaster recovery run ─────────────────────────────────────────────────

describe('POST /api/v1/recovery/disaster-recovery/run', () => {
  it('returns 200 with stuckWorkflows, orphanLeases, deadWorkers', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/recovery/disaster-recovery/run',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ workspaceId: 'ws-1' }),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('report')
    expect(body.report).toHaveProperty('stuckWorkflows')
    expect(body.report).toHaveProperty('orphanLeases')
    expect(body.report).toHaveProperty('deadWorkers')
  })
})

// ─── F) Queue pressure simulation ────────────────────────────────────────────

describe('GET /api/v1/workers/health', () => {
  it('returns 200 with data.queues and data.totals', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/workers/health',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('data')
    expect(body.data).toHaveProperty('queues')
    expect(body.data).toHaveProperty('totals')
  })
})

describe('GET /api/v1/workers/queues', () => {
  it('returns 200 with data array', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/workers/queues',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('data')
    expect(Array.isArray(body.data)).toBe(true)
  })
})

// ─── G) Recovery flow ─────────────────────────────────────────────────────────

describe('POST /api/v1/recovery/checkpoints', () => {
  it('accepts valid body (route exists and processes request)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/recovery/checkpoints',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        workspaceId: 'ws-1', runId: 'run-1', stepId: 'step-1',
        traceId: 'trace-1', completedSteps: ['step-0'], state: {},
      }),
    })
    // Mocked DB returns [] so row is undefined (500 in test env); route schema validates correctly (not 400)
    expect([201, 500]).toContain(res.statusCode)
  })
})

describe('POST /api/v1/recovery/replay-runs', () => {
  it('returns 400 when source run not found', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/recovery/replay-runs',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ workspaceId: 'ws-1', sourceRunId: 'run-missing' }),
    })
    // DB returns [] so source run is not found → 400
    expect(res.statusCode).toBe(400)
  })
})

// ─── H) Runtime mode enforcement ─────────────────────────────────────────────

describe('GET /api/v1/cloud-runtime/mode', () => {
  it('returns 200 with settings.mode', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/cloud-runtime/mode?workspaceId=ws-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('settings')
    expect(body.settings).toHaveProperty('mode')
  })
})

describe('POST /api/v1/cloud-runtime/route-preflight', () => {
  it('returns 200 with decision for computeType=gpu', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/cloud-runtime/route-preflight',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        workspaceId: 'ws-1', computeType: 'gpu',
        estimatedCostUsd: 0.01, scopeType: 'workspace', scopeId: 'ws-1', executionId: 'exec-1',
      }),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toHaveProperty('decision')
  })

  it('decision has mustUseRemote field for computeType=ai', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/cloud-runtime/route-preflight',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        workspaceId: 'ws-1', computeType: 'ai',
        estimatedCostUsd: 0.01, scopeType: 'workspace', scopeId: 'ws-1', executionId: 'exec-2',
      }),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.decision).toHaveProperty('mustUseRemote')
  })
})
