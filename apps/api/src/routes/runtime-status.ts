/**
 * Runtime status routes — /api/v1/runtime/*
 * Exposes the 24/7 self-monitoring surface.
 */
import type { FastifyPluginAsync } from 'fastify'
import { getRuntimeStatus }         from '../services/runtime-heartbeat.js'
import { learningCronHandleCount }  from '../services/learning-cron.js'
import { recentMindChains, runMindCycle } from '../services/autonomous-mind.js'
import { calibratePerSource, recordCalibrationFindings } from '../services/meta-learning.js'
import { listBudgets }              from '../services/cron-budget.js'
import { getSupervisorStatus }      from '../services/supervisor-status.js'
import { fabricSnapshot, routeJob } from '../services/execution-fabric.js'

const runtimeStatusRoutes: FastifyPluginAsync = async (fastify) => {

  fastify.get('/status', async () => {
    const runtime = getRuntimeStatus()
    return {
      success: true,
      data: {
        ...runtime,
        learningCronActive: learningCronHandleCount(),
        liveness: runtime.lastHeartbeatAgoMs < 120_000 ? 'live' : 'stale',
      },
    }
  })

  fastify.get<{ Querystring: { workspace_id?: string; limit?: string } }>('/mind/recent', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await recentMindChains(ws, req.query.limit ? Number(req.query.limit) : 20) }
  })

  fastify.post<{ Body: { workspace_id?: string } }>('/mind/cycle', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await runMindCycle(ws) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; window_days?: string } }>('/calibration', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await calibratePerSource(ws, req.query.window_days ? Number(req.query.window_days) : 30) }
  })

  fastify.post<{ Body: { workspace_id?: string } }>('/calibration/record', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await recordCalibrationFindings(ws) }
  })

  fastify.get('/budgets', async () => ({ success: true, data: await listBudgets() }))

  // Supervisor snapshot — what's actually alive on the host.
  fastify.get('/supervisor', async () => ({ success: true, data: await getSupervisorStatus() }))

  // Execution fabric snapshot — local hw + worker pool + capability coverage.
  fastify.get<{ Querystring: { workspace_id?: string } }>('/fabric', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await fabricSnapshot(ws) }
  })

  // Routing probe — answer "if I submitted this job, where would it run?"
  // Does not enqueue or execute anything. Pure decision endpoint.
  fastify.post<{ Body: { workspace_id?: string; kind?: string; capability?: string } }>('/route', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws || !req.body.kind) {
      return reply.code(400).send({ success: false, error: 'workspace_id, kind required' })
    }
    const decision = await routeJob({
      workspaceId: ws,
      kind:        req.body.kind,
      ...(req.body.capability ? { capability: req.body.capability } : {}),
    })
    return { success: true, data: decision }
  })
}

export default runtimeStatusRoutes
