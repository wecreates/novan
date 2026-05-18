/**
 * Self-aware platform routes — /api/v1/self/*
 * Code proposals, introspection, git state, semantic search, alignment,
 * notification driver status, home dashboard.
 */
import type { FastifyPluginAsync } from 'fastify'
import { listProposals, setProposalStatus, persistProposal, proposeFromPlan } from '../services/code-writer.js'
import { planBuild } from '../services/self-build-planner.js'
import { introspectCode } from '../services/code-introspection.js'
import { captureGitState, recentSnapshots, snapshotAt } from '../services/git-state.js'
import { search as semanticSearch, backfillRecent } from '../services/semantic-search.js'
import { alignmentScore } from '../services/horizon-scorer.js'
import { configuredDrivers } from '../services/notifications.js'
import { homeDashboard } from '../services/home-dashboard.js'

const selfAwareRoutes: FastifyPluginAsync = async (fastify) => {

  // Code proposals
  fastify.get<{ Querystring: { workspace_id?: string; status?: string; limit?: string } }>('/proposals', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await listProposals(ws, {
      ...(req.query.status ? { status: req.query.status as 'proposed' | 'approved' | 'rejected' | 'executing' | 'shipped' } : {}),
      ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
    }) }
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; status?: string } }>('/proposals/:id/status', async (req, reply) => {
    const { workspace_id, status } = req.body
    if (!workspace_id || !status) return reply.code(400).send({ success: false, error: 'workspace_id, status required' })
    await setProposalStatus(workspace_id, req.params.id, status as 'proposed' | 'approved' | 'rejected' | 'executing' | 'shipped')
    return { success: true }
  })

  fastify.post<{ Body: { workspace_id?: string; capability_id?: string } }>('/proposals/generate', async (req, reply) => {
    const { workspace_id, capability_id } = req.body
    if (!workspace_id || !capability_id) return reply.code(400).send({ success: false, error: 'workspace_id, capability_id required' })
    const plan = await planBuild(workspace_id, capability_id)
    if (!plan) return reply.code(404).send({ success: false, error: 'no plan for capability_id' })
    const draft = proposeFromPlan(workspace_id, plan)
    const id = await persistProposal(draft)
    return { success: true, data: { id, ...draft } }
  })

  // Introspection
  fastify.get('/introspect', async () => ({ success: true, data: introspectCode() }))

  // Git state
  fastify.post<{ Body: { workspace_id?: string } }>('/git/capture', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await captureGitState(ws) }
  })
  fastify.get<{ Querystring: { workspace_id?: string; limit?: string } }>('/git/snapshots', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await recentSnapshots(ws, req.query.limit ? Number(req.query.limit) : 30) }
  })
  fastify.get<{ Querystring: { workspace_id?: string; timestamp?: string } }>('/git/at', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws || !req.query.timestamp) return reply.code(400).send({ success: false, error: 'workspace_id, timestamp required' })
    return { success: true, data: await snapshotAt(ws, Number(req.query.timestamp)) }
  })

  // Semantic search
  fastify.get<{ Querystring: { workspace_id?: string; q?: string; limit?: string } }>('/search/chains', async (req, reply) => {
    const ws = req.query.workspace_id
    const q  = req.query.q
    if (!ws || !q) return reply.code(400).send({ success: false, error: 'workspace_id, q required' })
    return { success: true, data: await semanticSearch(ws, q, { limit: req.query.limit ? Number(req.query.limit) : 20 }) }
  })
  fastify.post<{ Body: { workspace_id?: string; days?: number } }>('/search/backfill', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await backfillRecent(ws, req.body.days ?? 30) }
  })

  // Alignment scoring
  fastify.post<{ Body: { workspace_id?: string; text?: string } }>('/alignment', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws || !req.body.text) return reply.code(400).send({ success: false, error: 'workspace_id, text required' })
    return { success: true, data: await alignmentScore(ws, req.body.text) }
  })

  // Notification drivers status
  fastify.get('/notification-drivers', async () => ({
    success: true,
    data: {
      configured: configuredDrivers(),
      available: ['webhook', 'pushover', 'slack', 'discord'],
      envVars: {
        webhook:  { name: 'NOTIFY_WEBHOOK_URL', set: Boolean(process.env['NOTIFY_WEBHOOK_URL']) },
        pushover: { name: 'PUSHOVER_TOKEN + PUSHOVER_USER', set: Boolean(process.env['PUSHOVER_TOKEN'] && process.env['PUSHOVER_USER']) },
        slack:    { name: 'SLACK_WEBHOOK_URL', set: Boolean(process.env['SLACK_WEBHOOK_URL']) },
        discord:  { name: 'DISCORD_WEBHOOK_URL', set: Boolean(process.env['DISCORD_WEBHOOK_URL']) },
      },
    },
  }))

  // Home dashboard
  fastify.get<{ Querystring: { workspace_id?: string } }>('/home', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await homeDashboard(ws) }
  })
}

export default selfAwareRoutes
