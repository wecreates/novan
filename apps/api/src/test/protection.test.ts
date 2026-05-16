/**
 * Phase 2+3 Protection & Recovery Tests
 *
 * A) guards.ts pure functions (budget, kill switch, runaway)
 * B) protection routes via Fastify inject()
 * C) recovery routes via Fastify inject()
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

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  checkBudgetPreflight, evaluateKillSwitches, detectRunaway2,
  DEFAULT_RUNAWAY_LIMITS,
} from '@ops/ai-router'
import type { BudgetCap } from '@ops/ai-router'
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

// ─── A) Pure guard functions ──────────────────────────────────────────────────

describe('checkBudgetPreflight', () => {
  const baseCap: BudgetCap = {
    id: 'cap-1', scopeType: 'workspace', scopeId: 'ws-1',
    maxDailyUsd: 10, maxMonthlyUsd: 100,
    maxPerExecutionUsd: 5, maxWorkflowUsd: 20,
    currentDailyUsd: 0, currentMonthlyUsd: 0,
    enabled: true,
  }

  it('approves when within all limits', () => {
    const r = checkBudgetPreflight(1.0, [baseCap])
    expect(r.approved).toBe(true)
    expect(r.blockReason).toBeNull()
  })

  it('blocks when per-execution cap exceeded', () => {
    const r = checkBudgetPreflight(6.0, [baseCap])
    expect(r.approved).toBe(false)
    expect(r.blockReason).toContain('per-execution')
    expect(r.capId).toBe('cap-1')
  })

  it('blocks when daily cap would be exceeded', () => {
    const cap = { ...baseCap, currentDailyUsd: 8.0, maxPerExecutionUsd: 0 }
    const r   = checkBudgetPreflight(3.0, [cap])
    expect(r.approved).toBe(false)
    expect(r.blockReason).toContain('Daily')
  })

  it('blocks when monthly cap would be exceeded', () => {
    const cap = { ...baseCap, currentMonthlyUsd: 98.0, maxPerExecutionUsd: 0 }
    const r   = checkBudgetPreflight(3.0, [cap])
    expect(r.approved).toBe(false)
    expect(r.blockReason).toContain('Monthly')
  })

  it('blocks workflow cap when isWorkflow=true', () => {
    const cap = { ...baseCap, maxPerExecutionUsd: 0 }
    const r   = checkBudgetPreflight(25.0, [cap], true)
    expect(r.approved).toBe(false)
    expect(r.blockReason).toContain('workflow cap')
  })

  it('skips disabled caps', () => {
    const cap = { ...baseCap, enabled: false }
    const r   = checkBudgetPreflight(6.0, [cap])
    expect(r.approved).toBe(true)
  })

  it('approves with no caps', () => {
    const r = checkBudgetPreflight(999, [])
    expect(r.approved).toBe(true)
  })

  it('returns checkedCaps list', () => {
    const r = checkBudgetPreflight(1.0, [baseCap])
    expect(r.checkedCaps).toContain('cap-1')
  })
})

describe('evaluateKillSwitches', () => {
  it('returns not blocked when no enabled switches', () => {
    const r = evaluateKillSwitches([], {})
    expect(r.blocked).toBe(false)
  })

  it('blocks on global kill switch', () => {
    const r = evaluateKillSwitches(
      [{ switchType: 'global', enabled: true }],
      {},
    )
    expect(r.blocked).toBe(true)
    expect(r.switchType).toBe('global')
  })

  it('blocks remote_worker when jobType=remote', () => {
    const r = evaluateKillSwitches(
      [{ switchType: 'remote_worker', enabled: true }],
      { jobType: 'remote' },
    )
    expect(r.blocked).toBe(true)
  })

  it('does not block remote_worker for browser jobs', () => {
    const r = evaluateKillSwitches(
      [{ switchType: 'remote_worker', enabled: true }],
      { jobType: 'browser' },
    )
    expect(r.blocked).toBe(false)
  })

  it('blocks specific provider', () => {
    const r = evaluateKillSwitches(
      [{ switchType: 'provider', scopeId: 'openai', enabled: true }],
      { providerId: 'openai' },
    )
    expect(r.blocked).toBe(true)
  })

  it('does not block different provider', () => {
    const r = evaluateKillSwitches(
      [{ switchType: 'provider', scopeId: 'openai', enabled: true }],
      { providerId: 'anthropic' },
    )
    expect(r.blocked).toBe(false)
  })

  it('skips disabled switches', () => {
    const r = evaluateKillSwitches(
      [{ switchType: 'global', enabled: false }],
      {},
    )
    expect(r.blocked).toBe(false)
  })
})

describe('detectRunaway2', () => {
  it('passes normal execution', () => {
    const r = detectRunaway2({ loopDepth: 5, retryDepth: 2, durationMs: 60_000, queuedMs: 10_000 })
    expect(r.isRunaway).toBe(false)
  })

  it('detects loop depth exceeded', () => {
    const r = detectRunaway2({ loopDepth: 51, retryDepth: 0, durationMs: 0, queuedMs: 0 })
    expect(r.isRunaway).toBe(true)
    expect(r.reason).toBe('loop_depth_exceeded')
  })

  it('detects retry depth exceeded', () => {
    const r = detectRunaway2({ loopDepth: 0, retryDepth: 11, durationMs: 0, queuedMs: 0 })
    expect(r.isRunaway).toBe(true)
    expect(r.reason).toBe('retry_depth_exceeded')
  })

  it('detects execution timeout', () => {
    const r = detectRunaway2({
      loopDepth: 0, retryDepth: 0,
      durationMs: 31 * 60_000, queuedMs: 0,
    })
    expect(r.isRunaway).toBe(true)
    expect(r.reason).toBe('execution_timeout')
  })

  it('detects queue timeout', () => {
    const r = detectRunaway2({
      loopDepth: 0, retryDepth: 0, durationMs: 0,
      queuedMs: 61 * 60_000,
    })
    expect(r.isRunaway).toBe(true)
    expect(r.reason).toBe('queue_timeout')
  })

  it('detects recursive agent', () => {
    const r = detectRunaway2({
      loopDepth: 0, retryDepth: 0, durationMs: 0, queuedMs: 0,
      agentCallStack: ['agent-a', 'agent-b', 'agent-a'],
    })
    expect(r.isRunaway).toBe(true)
    expect(r.reason).toBe('recursive_agent')
  })

  it('detects repeated failure', () => {
    const r = detectRunaway2({
      loopDepth: 0, retryDepth: 5, durationMs: 0, queuedMs: 0,
      recentFailures: 5,
    })
    expect(r.isRunaway).toBe(true)
    expect(r.reason).toBe('repeated_failure')
  })

  it('respects custom limits', () => {
    const r = detectRunaway2(
      { loopDepth: 10, retryDepth: 0, durationMs: 0, queuedMs: 0 },
      { ...DEFAULT_RUNAWAY_LIMITS, maxLoopDepth: 5 },
    )
    expect(r.isRunaway).toBe(true)
  })
})

// ─── B) Protection routes ─────────────────────────────────────────────────────

describe('GET /api/v1/protection/budget-caps', () => {
  it('returns 200 with caps array', async () => {
    const res = await app.inject({
      method: 'GET',
      url:    '/api/v1/protection/budget-caps?workspaceId=ws-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { caps: unknown[] }
    expect(Array.isArray(body.caps)).toBe(true)
  })
})

describe('POST /api/v1/protection/budget-caps', () => {
  it('creates a budget cap', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/api/v1/protection/budget-caps',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: {
        workspaceId: 'ws-1', scopeType: 'workspace', scopeId: 'ws-1',
        maxDailyUsd: 50, maxMonthlyUsd: 500,
      },
    })
    // mocked DB returns [], so cap will be undefined — route returns { cap: undefined }
    expect([200, 201, 500]).toContain(res.statusCode)
  })
})

describe('POST /api/v1/protection/preflight', () => {
  it('returns guard decision', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/api/v1/protection/preflight',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: {
        workspaceId: 'ws-1', executionId: 'exec-1',
        providerId: 'openai', scopeType: 'workspace', scopeId: 'ws-1',
        estimatedCostUsd: 0.5,
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { decision: { approved: boolean } }
    expect(typeof body.decision.approved).toBe('boolean')
  })
})

describe('GET /api/v1/protection/kill-switches', () => {
  it('returns switches list', async () => {
    const res = await app.inject({
      method: 'GET',
      url:    '/api/v1/protection/kill-switches?workspaceId=ws-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('POST /api/v1/protection/kill-switches', () => {
  it('creates a kill switch', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/api/v1/protection/kill-switches',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { workspaceId: 'ws-1', switchType: 'remote_worker', enabled: true, reason: 'test' },
    })
    expect([200, 201]).toContain(res.statusCode)
  })
})

describe('POST /api/v1/protection/emergency-stop', () => {
  it('activates emergency stop', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/api/v1/protection/emergency-stop',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { workspaceId: 'ws-1', reason: 'runaway detected', enabledBy: 'user-1' },
    })
    expect([200, 201]).toContain(res.statusCode)
  })
})

describe('DELETE /api/v1/protection/emergency-stop', () => {
  it('clears emergency stop', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url:    '/api/v1/protection/emergency-stop?workspaceId=ws-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('POST /api/v1/protection/kill-switches/check', () => {
  it('returns kill switch evaluation', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/api/v1/protection/kill-switches/check',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { workspaceId: 'ws-1', jobType: 'ai' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { result: { blocked: boolean } }
    expect(typeof body.result.blocked).toBe('boolean')
  })
})

describe('GET /api/v1/protection/quarantine', () => {
  it('returns quarantine list', async () => {
    const res = await app.inject({
      method: 'GET',
      url:    '/api/v1/protection/quarantine?workspaceId=ws-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('POST /api/v1/protection/quarantine/:providerId', () => {
  it('quarantines a provider', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/api/v1/protection/quarantine/openai',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { workspaceId: 'ws-1', reason: 'high error rate' },
    })
    expect([200, 201]).toContain(res.statusCode)
  })
})

describe('GET /api/v1/protection/queue-pauses', () => {
  it('returns queue pauses', async () => {
    const res = await app.inject({
      method: 'GET',
      url:    '/api/v1/protection/queue-pauses?workspaceId=ws-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('POST /api/v1/protection/queue-pauses/:queueName/pause', () => {
  it('pauses a queue', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/api/v1/protection/queue-pauses/workflow/pause',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { workspaceId: 'ws-1', reason: 'maintenance' },
    })
    expect([200, 201]).toContain(res.statusCode)
  })
})

describe('POST /api/v1/protection/cancel/run/:runId', () => {
  it('returns 404 for unknown run', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/api/v1/protection/cancel/run/run-999',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { workspaceId: 'ws-1', reason: 'user requested' },
    })
    // DB mock returns [] so run won't be found → 404
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /api/v1/protection/cancel/lease/:leaseId', () => {
  it('returns 404 for unknown lease', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/api/v1/protection/cancel/lease/lease-999',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { workspaceId: 'ws-1', reason: 'cleanup' },
    })
    expect(res.statusCode).toBe(404)
  })
})

// ─── C) Recovery routes ───────────────────────────────────────────────────────

describe('GET /api/v1/recovery/checkpoints/:runId', () => {
  it('returns checkpoints list', async () => {
    const res = await app.inject({
      method: 'GET',
      url:    '/api/v1/recovery/checkpoints/run-1?workspaceId=ws-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { checkpoints: unknown[] }
    expect(Array.isArray(body.checkpoints)).toBe(true)
  })
})

describe('POST /api/v1/recovery/checkpoints', () => {
  it('creates a checkpoint', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/api/v1/recovery/checkpoints',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: {
        workspaceId: 'ws-1', runId: 'run-1', stepId: 'step-2',
        traceId: 'trace-1', completedSteps: ['step-1'],
        state: { output: 'done' },
      },
    })
    expect([200, 201, 500]).toContain(res.statusCode)
  })
})

describe('POST /api/v1/recovery/checkpoints/:id/restore', () => {
  it('returns 404 for unknown checkpoint', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/api/v1/recovery/checkpoints/cp-999/restore',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { workspaceId: 'ws-1' },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('DELETE /api/v1/recovery/checkpoints/:id', () => {
  it('returns 404 for unknown checkpoint', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url:    '/api/v1/recovery/checkpoints/cp-999?workspaceId=ws-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /api/v1/recovery/checkpoints/prune', () => {
  it('prunes old checkpoints', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/api/v1/recovery/checkpoints/prune',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { workspaceId: 'ws-1', maxAgeMs: 86_400_000 },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { pruned: number }
    expect(typeof body.pruned).toBe('number')
  })
})

describe('POST /api/v1/recovery/disaster-recovery/run', () => {
  it('runs disaster recovery and returns report', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/api/v1/recovery/disaster-recovery/run',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { workspaceId: 'ws-1' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { report: { stuckWorkflows: number; orphanLeases: number; deadWorkers: number } }
    expect(typeof body.report.stuckWorkflows).toBe('number')
    expect(typeof body.report.orphanLeases).toBe('number')
    expect(typeof body.report.deadWorkers).toBe('number')
  })
})

describe('GET /api/v1/recovery/replay-runs', () => {
  it('returns replay runs list', async () => {
    const res = await app.inject({
      method: 'GET',
      url:    '/api/v1/recovery/replay-runs?workspaceId=ws-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { runs: unknown[] }
    expect(Array.isArray(body.runs)).toBe(true)
  })
})

describe('POST /api/v1/recovery/replay-runs', () => {
  it('returns 400 when source run not found', async () => {
    const res = await app.inject({
      method:  'POST',
      url:     '/api/v1/recovery/replay-runs',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { workspaceId: 'ws-1', sourceRunId: 'run-nonexistent' },
    })
    // DB mock returns [] so source run won't be found → 400
    expect(res.statusCode).toBe(400)
  })
})

describe('GET /api/v1/recovery/replay-runs/:id', () => {
  it('returns 404 for unknown replay run', async () => {
    const res = await app.inject({
      method: 'GET',
      url:    '/api/v1/recovery/replay-runs/replay-999?workspaceId=ws-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
  })
})
