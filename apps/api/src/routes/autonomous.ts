/**
 * Autonomous Agent Routes — /api/v1/autonomous
 *
 * POST /runs                    — start a new autonomous run
 * GET  /runs                    — list runs for workspace
 * GET  /runs/:id                — single run
 * POST /runs/:id/pause          — pause run
 * POST /runs/:id/resume         — resume paused run
 * POST /runs/:id/cancel         — cancel run
 * GET  /runs/:id/jobs           — list jobs for run
 * GET  /jobs/:id                — single job
 * GET  /jobs/:id/evidence       — verification evidence for job
 *
 * Status labels enforced:
 *   queued | running | blocked | needs_approval | verified | failed |
 *   rolled_back | unverified | paused | cancelled | complete
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  startRun, pauseRun, resumeRun, cancelRun,
  getRun, listRuns, getRunJobs, getJobEvidence,
} from '../services/autonomous-orchestrator.js'
import { db }               from '../db/client.js'
import { autonomousJobs }   from '../db/schema.js'
import { eq }               from 'drizzle-orm'

const autonomousRoutes: FastifyPluginAsync = async (fastify) => {

  // POST /runs — start a new run
  fastify.post<{
    Body: { workspace_id?: string; workspaceId?: string; masterPrompt?: string; prompt?: string }
  }>('/runs', async (req, reply) => {
    const workspaceId  = req.body.workspace_id ?? req.body.workspaceId
    const masterPrompt = req.body.masterPrompt ?? req.body.prompt ?? 'Autonomous improvement run'
    if (!workspaceId) return reply.code(400).send({ success: false, error: 'workspace_id required' })

    const run = await startRun({ workspaceId, masterPrompt })
    return { success: true, data: run }
  })

  // GET /runs — list runs
  fastify.get<{
    Querystring: { workspace_id?: string; limit?: string }
  }>('/runs', async (req, reply) => {
    const { workspace_id, limit } = req.query
    if (!workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const parsedLimit = limit ? Number(limit) : 50
    const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 500) : 50
    const runs = await listRuns(workspace_id, safeLimit)
    return { success: true, data: runs }
  })

  // GET /runs/:id
  fastify.get<{ Params: { id: string } }>('/runs/:id', async (req, reply) => {
    const run = await getRun(req.params.id)
    if (!run) return reply.code(404).send({ success: false, error: 'Run not found' })
    return { success: true, data: run }
  })

  // POST /runs/:id/pause
  fastify.post<{ Params: { id: string } }>('/runs/:id/pause', async (req, reply) => {
    const run = await getRun(req.params.id)
    if (!run) return reply.code(404).send({ success: false, error: 'Run not found' })
    if (run.status !== 'running') return reply.code(409).send({ success: false, error: `Cannot pause run in status: ${run.status}` })
    await pauseRun(run.id)
    return { success: true, data: { id: run.id, status: 'paused' } }
  })

  // POST /runs/:id/resume
  fastify.post<{ Params: { id: string } }>('/runs/:id/resume', async (req, reply) => {
    const run = await getRun(req.params.id)
    if (!run) return reply.code(404).send({ success: false, error: 'Run not found' })
    if (run.status !== 'paused') return reply.code(409).send({ success: false, error: `Cannot resume run in status: ${run.status}` })
    await resumeRun(run.id, run.workspaceId)
    return { success: true, data: { id: run.id, status: 'running' } }
  })

  // POST /runs/:id/cancel
  fastify.post<{ Params: { id: string } }>('/runs/:id/cancel', async (req, reply) => {
    const run = await getRun(req.params.id)
    if (!run) return reply.code(404).send({ success: false, error: 'Run not found' })
    if (run.status === 'complete' || run.status === 'cancelled') {
      return reply.code(409).send({ success: false, error: `Run already ${run.status}` })
    }
    await cancelRun(run.id, run.workspaceId)
    return { success: true, data: { id: run.id, status: 'cancelled' } }
  })

  // GET /runs/:id/jobs
  fastify.get<{ Params: { id: string } }>('/runs/:id/jobs', async (req, reply) => {
    const run = await getRun(req.params.id)
    if (!run) return reply.code(404).send({ success: false, error: 'Run not found' })
    const jobs = await getRunJobs(run.id)
    return { success: true, data: jobs }
  })

  // GET /jobs/:id
  fastify.get<{ Params: { id: string } }>('/jobs/:id', async (req, reply) => {
    const rows = await db.select().from(autonomousJobs)
      .where(eq(autonomousJobs.id, req.params.id)).limit(1)
    if (!rows[0]) return reply.code(404).send({ success: false, error: 'Job not found' })
    return { success: true, data: rows[0] }
  })

  // GET /jobs/:id/evidence
  fastify.get<{ Params: { id: string } }>('/jobs/:id/evidence', async (req, reply) => {
    const rows = await db.select().from(autonomousJobs)
      .where(eq(autonomousJobs.id, req.params.id)).limit(1)
    if (!rows[0]) return reply.code(404).send({ success: false, error: 'Job not found' })
    const evidence = await getJobEvidence(req.params.id)
    return { success: true, data: evidence }
  })
}

export default autonomousRoutes
