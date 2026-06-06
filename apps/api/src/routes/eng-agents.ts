/**
 * Engineering Agent Control Routes
 *
 * GET  /agents             — list all 7 agents for workspace
 * GET  /agents/:type       — single agent state
 * POST /agents/:type/pause  — pause agent
 * POST /agents/:type/resume — resume agent
 * POST /agents/:type/unlock — clear safety lock
 *
 * GET  /jobs               — list jobs (optional ?agentType=)
 * GET  /jobs/:id           — single job
 * POST /jobs               — create + optionally run job
 * POST /jobs/:id/approve   — approve awaiting-approval job
 * POST /jobs/:id/rollback  — rollback completed job
 * POST /jobs/:id/run       — manually trigger pipeline for queued job
 *
 * GET  /safety/limits      — safety config
 * POST /safety/check       — check a proposed patch against safety rules
 */

import type { FastifyPluginAsync } from 'fastify'
import {
  listAgents, getAgent, pauseAgent, resumeAgent, unlockAgent,
  type AgentType,
} from '../services/agent-registry.js'
import {
  createJob, getJob, listJobs, approveJob, rollbackJob,
} from '../services/agent-job-store.js'
import { runPipeline, requiresApproval }  from '../services/agent-patch-pipeline.js'
import { checkPatchSafety, getSafetyLimits } from '../services/agent-safety.js'

// ─── Constants ────────────────────────────────────────────────────────────────

const AGENT_TYPES: AgentType[] = [
  'planner', 'coder', 'reviewer', 'tester', 'security', 'reliability', 'cto',
]

function isAgentType(v: unknown): v is AgentType {
  return typeof v === 'string' && (AGENT_TYPES as string[]).includes(v)
}

// R146.318/R325 — moved to util/ws-of.ts (single canonical helper).
import { wsOf as _wsOf } from '../util/ws-of.js'
function wsOf(req: unknown, body?: { workspaceId?: string }): string {
  return _wsOf(req, body?.workspaceId)
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

const engAgentsRoutes: FastifyPluginAsync = async (app) => {

  // ── Agent state ────────────────────────────────────────────────────────────

  app.get('/agents', async (req, reply) => {
    const workspaceId = wsOf(req, { workspaceId: (req.query as Record<string, string>)['workspaceId'] })
    return reply.send({ success: true, data: { agents: listAgents(workspaceId) } })
  })

  app.get('/agents/:type', async (req, reply) => {
    const { type } = req.params as { type: string }
    const workspaceId = wsOf(req, { workspaceId: (req.query as Record<string, string>)['workspaceId'] })
    if (!isAgentType(type)) return reply.status(400).send({ success: false, error: `Unknown agent type: ${type}` })
    return reply.send({ success: true, data: { agent: getAgent(workspaceId, type) } })
  })

  app.post('/agents/:type/pause', async (req, reply) => {
    const { type } = req.params as { type: string }
    const body = req.body as { workspaceId?: string; reason?: string }
    if (!isAgentType(type)) return reply.status(400).send({ success: false, error: `Unknown agent type: ${type}` })
    const workspaceId = wsOf(req, body)
    const reason      = body.reason ?? 'manual pause'
    try {
      const agent = await pauseAgent(workspaceId, type, reason)
      return reply.send({ success: true, data: { agent } })
    } catch (err) {
      return reply.status(409).send({ success: false, error: (err as Error).message })
    }
  })

  app.post('/agents/:type/resume', async (req, reply) => {
    const { type } = req.params as { type: string }
    const body = req.body as { workspaceId?: string }
    if (!isAgentType(type)) return reply.status(400).send({ success: false, error: `Unknown agent type: ${type}` })
    const workspaceId = wsOf(req, body)
    try {
      const agent = await resumeAgent(workspaceId, type)
      return reply.send({ success: true, data: { agent } })
    } catch (err) {
      return reply.status(409).send({ success: false, error: (err as Error).message })
    }
  })

  app.post('/agents/:type/unlock', async (req, reply) => {
    const { type } = req.params as { type: string }
    const body = req.body as { workspaceId?: string }
    if (!isAgentType(type)) return reply.status(400).send({ success: false, error: `Unknown agent type: ${type}` })
    const workspaceId = wsOf(req, body)
    try {
      const agent = await unlockAgent(workspaceId, type)
      return reply.send({ success: true, data: { agent } })
    } catch (err) {
      return reply.status(409).send({ success: false, error: (err as Error).message })
    }
  })

  // ── Jobs ───────────────────────────────────────────────────────────────────

  app.get('/jobs', async (req, reply) => {
    const q           = req.query as Record<string, string>
    const workspaceId = wsOf(req, { workspaceId: q['workspaceId'] })
    const agentType   = q['agentType']
    const list        = listJobs(
      workspaceId,
      isAgentType(agentType) ? agentType : undefined,
    )
    return reply.send({ success: true, data: { jobs: list } })
  })

  app.get('/jobs/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const job = getJob(id)
    if (!job) return reply.status(404).send({ success: false, error: 'Job not found' })
    return reply.send({ success: true, data: { job } })
  })

  app.post('/jobs', async (req, reply) => {
    const body = req.body as {
      workspaceId?: string
      agentType:    string
      description:  string
      targetFiles?: string[]
      autoRun?:     boolean
    }

    if (!body.agentType || !body.description) {
      return reply.status(400).send({ success: false, error: 'agentType and description are required' })
    }
    if (!isAgentType(body.agentType)) {
      return reply.status(400).send({ success: false, error: `Unknown agent type: ${body.agentType}` })
    }

    const workspaceId  = wsOf(req, body)
    const targetFiles  = body.targetFiles ?? []
    const needApproval = requiresApproval(body.agentType, targetFiles)
    // Optional unified-diff patch + rollback content supplied by caller
    const patch         = (body as { patch?: string }).patch         ?? null
    const rollbackPatch = (body as { rollbackPatch?: string }).rollbackPatch ?? null

    const job = await createJob(
      workspaceId, body.agentType, body.description, targetFiles, needApproval,
      patch, rollbackPatch,
    )

    if (body.autoRun) {
      const result = await runPipeline(job.id)
      return reply.status(201).send({ success: true, data: { job: getJob(job.id) ?? job, pipeline: result } })
    }

    return reply.status(201).send({ success: true, data: { job } })
  })

  app.post('/jobs/:id/approve', async (req, reply) => {
    const { id } = req.params as { id: string }
    const job = await approveJob(id)
    if (!job) {
      return reply.status(404).send({ success: false, error: 'Job not found or not awaiting approval' })
    }
    return reply.send({ success: true, data: { job } })
  })

  app.post('/jobs/:id/rollback', async (req, reply) => {
    const { id } = req.params as { id: string }
    const job = await rollbackJob(id)
    if (!job) return reply.status(404).send({ success: false, error: 'Job not found' })
    return reply.send({ success: true, data: { job } })
  })

  app.post('/jobs/:id/run', async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = getJob(id)
    if (!existing) return reply.status(404).send({ success: false, error: 'Job not found' })
    const result = await runPipeline(id)
    return reply.send({ success: true, data: { job: getJob(id) ?? existing, pipeline: result } })
  })

  // ── Safety ─────────────────────────────────────────────────────────────────

  app.get('/safety/limits', async (_req, reply) => {
    return reply.send({ success: true, data: { limits: getSafetyLimits() } })
  })

  app.post('/safety/check', async (req, reply) => {
    const body = req.body as {
      agentType:      string
      targetFiles?:   string[]
      estimatedLines?: number
      retryCount?:    number
    }

    if (!body.agentType) {
      return reply.status(400).send({ success: false, error: 'agentType is required' })
    }
    if (!isAgentType(body.agentType)) {
      return reply.status(400).send({ success: false, error: `Unknown agent type: ${body.agentType}` })
    }

    const result = checkPatchSafety(
      body.agentType,
      body.targetFiles ?? [],
      body.estimatedLines ?? 0,
      body.retryCount ?? 0,
    )

    return reply.send({ success: true, data: { safety: result } })
  })
}

export default engAgentsRoutes
