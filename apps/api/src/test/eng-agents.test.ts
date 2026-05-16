/**
 * Engineering Agent Control Layer Tests
 *
 * A) Agent registry — state, pause/resume/unlock, failure/success recording
 * B) Agent safety — checkPatchSafety, getSafetyLimits
 * C) Agent job store — create, approve, rollback
 * D) Agent patch pipeline — runPipeline stages
 * E) Eng-agent routes via Fastify inject()
 * F) Full job lifecycle integration
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
  redisClient:      { ping: async () => 'PONG', quit: async () => 'OK', get: async () => null, set: async () => 'OK', del: async () => 1, on: () => undefined, disconnect: async () => undefined },
  redisSubscriber:  { ping: async () => 'PONG', quit: async () => 'OK', on: () => undefined, subscribe: async () => undefined },
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
  requestRollback:    async () => ({ success: true, snapshotId: 'snap-1', itemCount: 0 }),
  getSnapshotStatus:  async () => ({ status: 'ready', itemCount: 0 }),
  getLatestSnapshot:  async () => ({ id: 'snap-1', status: 'ready', itemCount: 0 }),
}))

vi.mock('../telemetry.js', () => ({}))

// ── Imports ───────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, makeTestToken } from './helpers.js'

import {
  getAgent, listAgents, pauseAgent, resumeAgent, unlockAgent,
  recordAgentFailure, recordAgentSuccess, SAFETY_LOCK_THRESHOLD,
} from '../services/agent-registry.js'
import { checkPatchSafety, getSafetyLimits } from '../services/agent-safety.js'
import { createJob, getJob, approveJob, rollbackJob, clearJobsForTest } from '../services/agent-job-store.js'
import { runPipeline, MAX_PATCH_SIZE_LINES, MAX_FILES_CHANGED, PATCH_RETRY_LIMIT } from '../services/agent-patch-pipeline.js'

// ── Test app ──────────────────────────────────────────────────────────────────

let app: FastifyInstance
let token: string
const WS = 'ws-agents-1'

beforeAll(async () => {
  app   = await buildTestApp()
  token = makeTestToken(app)
})

afterAll(async () => {
  await app.close()
})

beforeEach(() => {
  clearJobsForTest()
})

// ─── A) Agent Registry ────────────────────────────────────────────────────────

describe('agent-registry — state management', () => {
  it('listAgents returns 7 agents', () => {
    const agents = listAgents(WS)
    expect(agents).toHaveLength(7)
    const types = agents.map(a => a.type)
    for (const t of ['planner','coder','reviewer','tester','security','reliability','cto']) {
      expect(types).toContain(t)
    }
  })

  it('getAgent creates default idle agent', () => {
    const agent = getAgent(WS, 'planner')
    expect(agent.state).toBe('idle')
    expect(agent.safetyLocked).toBe(false)
    expect(agent.consecutiveFailures).toBe(0)
    expect(agent.workspaceId).toBe(WS)
  })

  it('pauseAgent sets state to paused', async () => {
    const agent = await pauseAgent(WS, 'coder', 'maintenance')
    expect(agent.state).toBe('paused')
    expect(agent.pausedReason).toBe('maintenance')
  })

  it('resumeAgent sets state back to idle', async () => {
    await pauseAgent(WS, 'tester', 'test pause')
    const agent = await resumeAgent(WS, 'tester')
    expect(agent.state).toBe('idle')
    expect(agent.pausedReason).toBeNull()
  })

  it('recordAgentFailure increments consecutiveFailures', () => {
    recordAgentFailure(WS, 'reviewer')
    const agent = getAgent(WS, 'reviewer')
    expect(agent.consecutiveFailures).toBe(1)
    expect(agent.state).toBe('error')
    expect(agent.safetyLocked).toBe(false)
  })

  it(`recordAgentFailure safety-locks after ${SAFETY_LOCK_THRESHOLD} failures`, () => {
    for (let i = 0; i < SAFETY_LOCK_THRESHOLD; i++) {
      recordAgentFailure(WS, 'security')
    }
    const agent = getAgent(WS, 'security')
    expect(agent.safetyLocked).toBe(true)
    expect(agent.state).toBe('locked')
  })

  it('pauseAgent throws when safety-locked', async () => {
    for (let i = 0; i < SAFETY_LOCK_THRESHOLD; i++) {
      recordAgentFailure(WS, 'reliability')
    }
    await expect(pauseAgent(WS, 'reliability', 'reason')).rejects.toThrow()
  })

  it('unlockAgent clears safety lock', async () => {
    for (let i = 0; i < SAFETY_LOCK_THRESHOLD; i++) {
      recordAgentFailure(WS, 'cto')
    }
    const agent = await unlockAgent(WS, 'cto')
    expect(agent.safetyLocked).toBe(false)
    expect(agent.consecutiveFailures).toBe(0)
    expect(agent.state).toBe('idle')
  })

  it('recordAgentSuccess resets failures and increments totals', () => {
    recordAgentFailure(WS, 'planner')
    recordAgentSuccess(WS, 'planner', 'job-xyz', true)
    const agent = getAgent(WS, 'planner')
    expect(agent.consecutiveFailures).toBe(0)
    expect(agent.totalJobsRun).toBe(1)
    expect(agent.totalPatchesApplied).toBe(1)
    expect(agent.lastJobId).toBe('job-xyz')
  })
})

// ─── B) Agent Safety ─────────────────────────────────────────────────────────

describe('checkPatchSafety', () => {
  it('approves clean patch', () => {
    const r = checkPatchSafety('planner', ['src/utils.ts'], 50, 0)
    expect(r.approved).toBe(true)
    expect(r.violations).toHaveLength(0)
  })

  it('rejects oversized patch', () => {
    const r = checkPatchSafety('planner', [], MAX_PATCH_SIZE_LINES + 1, 0)
    expect(r.approved).toBe(false)
    expect(r.violations.some(v => v.includes('Patch size'))).toBe(true)
  })

  it('rejects too many files', () => {
    const files = Array.from({ length: MAX_FILES_CHANGED + 1 }, (_, i) => `src/f${i}.ts`)
    const r = checkPatchSafety('planner', files, 10, 0)
    expect(r.approved).toBe(false)
    expect(r.violations.some(v => v.includes('File count'))).toBe(true)
  })

  it('rejects at retry limit', () => {
    const r = checkPatchSafety('planner', [], 10, PATCH_RETRY_LIMIT)
    expect(r.approved).toBe(false)
  })

  it('flags high-risk auth file for approval', () => {
    const r = checkPatchSafety('planner', ['src/auth/middleware.ts'], 10, 0)
    expect(r.requiresApproval).toBe(true)
    expect(r.violations.some(v => v.includes('High-risk'))).toBe(true)
  })

  it('coder agent always requires approval for non-empty file list', () => {
    const r = checkPatchSafety('coder', ['src/feature.ts'], 10, 0)
    expect(r.requiresApproval).toBe(true)
  })

  it('getSafetyLimits returns all expected fields', () => {
    const limits = getSafetyLimits()
    expect(limits).toHaveProperty('maxPatchSizeLines', MAX_PATCH_SIZE_LINES)
    expect(limits).toHaveProperty('maxFilesChanged',   MAX_FILES_CHANGED)
    expect(limits).toHaveProperty('patchRetryLimit',   PATCH_RETRY_LIMIT)
    expect(limits).toHaveProperty('safetyLockThreshold')
    expect(limits).toHaveProperty('highRiskPatterns')
    expect(Array.isArray(limits.agentsRequiringApproval)).toBe(true)
  })
})

// ─── C) Job Store ─────────────────────────────────────────────────────────────

describe('agent-job-store', () => {
  it('createJob returns queued job', async () => {
    const job = await createJob(WS, 'planner', 'Plan sprint', [], false)
    expect(job.status).toBe('queued')
    expect(job.agentType).toBe('planner')
    expect(job.requiresApproval).toBe(false)
    expect(getJob(job.id)).toBeDefined()
  })

  it('approveJob transitions awaiting_approval → queued', async () => {
    const job = await createJob(WS, 'coder', 'Add feature', ['src/x.ts'], true)
    // manually set to awaiting_approval
    job.status = 'awaiting_approval'
    const approved = await approveJob(job.id)
    expect(approved?.status).toBe('queued')
    expect(approved?.approvedAt).toBeTypeOf('number')
  })

  it('approveJob returns null for non-awaiting job', async () => {
    const job = await createJob(WS, 'planner', 'test', [], false)
    const result = await approveJob(job.id)
    expect(result).toBeNull()
  })

  it('rollbackJob sets status to rolled_back', async () => {
    const job = await createJob(WS, 'tester', 'run tests', [], false)
    const rolled = await rollbackJob(job.id)
    expect(rolled?.status).toBe('rolled_back')
    expect(rolled?.completedAt).toBeTypeOf('number')
  })
})

// ─── D) Patch Pipeline ───────────────────────────────────────────────────────

describe('runPipeline', () => {
  it('returns failed for missing job', async () => {
    const result = await runPipeline('nonexistent-id')
    expect(result.success).toBe(false)
    expect(result.errorMessage).toContain('not found')
  })

  it('completes pipeline for simple planner job', async () => {
    const job = await createJob(WS, 'planner', 'Plan architecture review', [], false)
    const result = await runPipeline(job.id)
    expect(result.success).toBe(true)
    expect(result.applied).toBe(true)
    expect(result.stage).toBe('done')
    expect(result.patchLinesChanged).toBeGreaterThan(0)
    expect(result.validationPassed).toBe(true)
    expect(result.testsPassed).toBe(true)
  })

  it('awaiting_approval for coder job without approval', async () => {
    const job = await createJob(WS, 'coder', 'refactor auth', [], true)
    // requiresApproval=true and no approvedAt
    const result = await runPipeline(job.id)
    expect(result.success).toBe(false)
    expect(result.errorMessage).toContain('approval')
    expect(getJob(job.id)?.status).toBe('awaiting_approval')
  })

  it('runs after approval', async () => {
    const job = await createJob(WS, 'coder', 'add util', [], true)
    job.status = 'awaiting_approval'
    await approveJob(job.id)
    const result = await runPipeline(job.id)
    expect(result.success).toBe(true)
    expect(result.applied).toBe(true)
  })

  it('job record updated to completed after success', async () => {
    const job = await createJob(WS, 'reviewer', 'code review', [], false)
    await runPipeline(job.id)
    const updated = getJob(job.id)
    expect(updated?.status).toBe('completed')
    expect(updated?.patch).toContain('reviewer')
  })
})

// ─── E) Routes ───────────────────────────────────────────────────────────────

describe('GET /api/v1/eng-agents/agents', () => {
  it('returns 7 agents', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/eng-agents/agents?workspaceId=ws-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body.agents)).toBe(true)
    expect(body.agents).toHaveLength(7)
  })
})

describe('GET /api/v1/eng-agents/agents/:type', () => {
  it('returns 200 for valid type', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/eng-agents/agents/planner?workspaceId=ws-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.agent.type).toBe('planner')
  })

  it('returns 400 for unknown type', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/eng-agents/agents/unknown?workspaceId=ws-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /api/v1/eng-agents/agents/:type/pause', () => {
  it('returns 200 with paused agent', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/eng-agents/agents/tester/pause',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ workspaceId: 'ws-route-1', reason: 'upgrade' }),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.agent.state).toBe('paused')
  })
})

describe('POST /api/v1/eng-agents/agents/:type/resume', () => {
  it('returns 200 with idle agent after pause+resume', async () => {
    await app.inject({
      method: 'POST', url: '/api/v1/eng-agents/agents/reviewer/pause',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ workspaceId: 'ws-route-2', reason: 'test' }),
    })
    const res = await app.inject({
      method: 'POST', url: '/api/v1/eng-agents/agents/reviewer/resume',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ workspaceId: 'ws-route-2' }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().agent.state).toBe('idle')
  })
})

describe('POST /api/v1/eng-agents/jobs', () => {
  it('creates job and returns 201', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/eng-agents/jobs',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        workspaceId: 'ws-1', agentType: 'planner',
        description: 'Plan quarterly roadmap',
      }),
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.job.status).toBe('queued')
    expect(body.job.agentType).toBe('planner')
  })

  it('returns 400 when agentType missing', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/eng-agents/jobs',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ description: 'no agent' }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 400 for unknown agentType', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/eng-agents/jobs',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ agentType: 'ghost', description: 'x' }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('autoRun=true runs pipeline and returns pipeline result', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/eng-agents/jobs',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        workspaceId: 'ws-1', agentType: 'reliability',
        description: 'Check uptime metrics', autoRun: true,
      }),
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body).toHaveProperty('pipeline')
    expect(body.pipeline.success).toBe(true)
  })
})

describe('GET /api/v1/eng-agents/jobs', () => {
  it('returns jobs array', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/eng-agents/jobs?workspaceId=ws-1',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json().jobs)).toBe(true)
  })
})

describe('GET /api/v1/eng-agents/safety/limits', () => {
  it('returns safety limits', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/eng-agents/safety/limits',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.limits).toHaveProperty('maxPatchSizeLines')
    expect(body.limits).toHaveProperty('maxFilesChanged')
    expect(body.limits).toHaveProperty('patchRetryLimit')
  })
})

describe('POST /api/v1/eng-agents/safety/check', () => {
  it('approves clean patch', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/eng-agents/safety/check',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ agentType: 'planner', targetFiles: ['src/utils.ts'], estimatedLines: 20 }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().safety.approved).toBe(true)
  })

  it('rejects oversized patch', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/eng-agents/safety/check',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ agentType: 'planner', targetFiles: [], estimatedLines: 9999 }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().safety.approved).toBe(false)
  })

  it('returns 400 when agentType missing', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/eng-agents/safety/check',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ targetFiles: [] }),
    })
    expect(res.statusCode).toBe(400)
  })
})

// ─── F) Full lifecycle integration ───────────────────────────────────────────

describe('Full job lifecycle — create → run → rollback', () => {
  it('planner job completes and can be rolled back', async () => {
    // Create
    const createRes = await app.inject({
      method: 'POST', url: '/api/v1/eng-agents/jobs',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        workspaceId: 'ws-lifecycle', agentType: 'planner',
        description: 'Plan system upgrade', autoRun: true,
      }),
    })
    expect(createRes.statusCode).toBe(201)
    const { job } = createRes.json()
    expect(job.status).toBe('completed')

    // Rollback
    const rollbackRes = await app.inject({
      method: 'POST', url: `/api/v1/eng-agents/jobs/${job.id}/rollback`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    })
    expect(rollbackRes.statusCode).toBe(200)
    expect(rollbackRes.json().job.status).toBe('rolled_back')
  })

  it('coder job awaits approval then runs after approve', async () => {
    // Create (coder always requires approval)
    const createRes = await app.inject({
      method: 'POST', url: '/api/v1/eng-agents/jobs',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        workspaceId: 'ws-lifecycle', agentType: 'coder',
        description: 'Refactor API handlers',
        targetFiles: ['src/routes/api.ts'],
        autoRun: true,
      }),
    })
    expect(createRes.statusCode).toBe(201)
    const { job } = createRes.json()
    // After autoRun with approval gate — job should be awaiting_approval
    expect(job.status).toBe('awaiting_approval')

    // Approve
    const approveRes = await app.inject({
      method: 'POST', url: `/api/v1/eng-agents/jobs/${job.id}/approve`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    })
    expect(approveRes.statusCode).toBe(200)
    expect(approveRes.json().job.status).toBe('queued')

    // Run
    const runRes = await app.inject({
      method: 'POST', url: `/api/v1/eng-agents/jobs/${job.id}/run`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    })
    expect(runRes.statusCode).toBe(200)
    expect(runRes.json().pipeline.success).toBe(true)
  })
})
