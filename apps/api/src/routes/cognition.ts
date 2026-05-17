/**
 * Cognition + Executive + Skills routes.
 * Mounted at /api/v1/cognition (cognitive state + reasoning chains)
 *            /api/v1/executive (review cycles + executive state)
 *            /api/v1/skills    (skill registry + execution)
 */
import type { FastifyPluginAsync } from 'fastify'
import { snapshot as cognitiveSnapshot } from '../services/cognitive-state.js'
import {
  record as recordChain, recentChains, reconcileRecommendationOutcomes,
  type ChainKind,
} from '../services/reasoning-chains.js'
import { accuracyReport, highConfidenceMisses } from '../services/meta-reasoning.js'
import {
  runHourlyHealthReview, runSixHourlyOperationalReview,
  runDailyStrategicReview, runWeeklyRoadmapReview,
  getExecutiveState, recentReviews, type ReviewCycle,
} from '../services/executive-loop.js'
import {
  seedBuiltinSkills, listSkills, executeSkill, detectSkillGaps,
  detectSkillGapsBySession, promoteSkill,
  type SkillCategory, type SkillStatus,
} from '../services/skills.js'
import { generateSchedule, addPredecessor } from '../services/long-horizon-planner.js'
import { checkAlignment, emitAlignmentDecision } from '../services/strategic-alignment.js'
import { evaluateOutcomes }              from '../services/outcome-evaluator.js'

export const cognitionRoutes: FastifyPluginAsync = async (fastify) => {

  fastify.get<{ Querystring: { workspace_id?: string } }>('/snapshot', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await cognitiveSnapshot(ws) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; kind?: string; limit?: string; with_outcome?: string } }>('/chains', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const opts: { kind?: ChainKind; limit?: number; withOutcomeOnly?: boolean } = {}
    if (req.query.kind)         opts.kind = req.query.kind as ChainKind
    if (req.query.limit)        opts.limit = Number(req.query.limit)
    if (req.query.with_outcome === 'true') opts.withOutcomeOnly = true
    return { success: true, data: await recentChains(ws, opts) }
  })

  fastify.post<{
    Body: { workspace_id?: string; kind?: string; subject_id?: string; decision?: string; evidence?: Array<{ type: string; id: string; extract: string }>; confidence?: number; prediction?: Record<string, unknown>; source?: string }
  }>('/chains', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.kind || !b.decision || !b.source) {
      return reply.code(400).send({ success: false, error: 'workspace_id, kind, decision, source required' })
    }
    const id = await recordChain({
      workspaceId: b.workspace_id, kind: b.kind as ChainKind, decision: b.decision,
      source: b.source,
      ...(b.subject_id !== undefined ? { subjectId: b.subject_id } : {}),
      ...(b.evidence  !== undefined ? { evidence:  b.evidence  } : {}),
      ...(b.confidence!== undefined ? { confidence: b.confidence } : {}),
      ...(b.prediction!== undefined ? { prediction: b.prediction } : {}),
    })
    return { success: true, data: { id } }
  })

  fastify.post<{ Body: { workspace_id?: string } }>('/chains/reconcile', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await reconcileRecommendationOutcomes(ws) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; window_ms?: string } }>('/accuracy', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const win = req.query.window_ms ? Number(req.query.window_ms) : undefined
    return { success: true, data: await accuracyReport(ws, win) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; limit?: string } }>('/high-confidence-misses', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await highConfidenceMisses(ws, req.query.limit ? Number(req.query.limit) : 10) }
  })

  // ── Long-horizon planner (gap #2) ─────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/schedule', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await generateSchedule(ws) }
  })

  fastify.post<{ Body: { workspace_id?: string; task_id?: string; predecessor_recommendation_id?: string } }>('/schedule/predecessor', async (req, reply) => {
    const { workspace_id, task_id, predecessor_recommendation_id } = req.body
    if (!workspace_id || !task_id || !predecessor_recommendation_id) {
      return reply.code(400).send({ success: false, error: 'workspace_id, task_id, predecessor_recommendation_id required' })
    }
    return { success: true, data: await addPredecessor(workspace_id, task_id, predecessor_recommendation_id) }
  })

  // ── Strategic alignment gate (gap #3) ─────────────────────────────────────
  fastify.post<{ Body: { workspace_id?: string; intent?: string; tags?: string[] } }>('/alignment/check', async (req, reply) => {
    const { workspace_id, intent, tags } = req.body
    if (!workspace_id || !intent || !Array.isArray(tags)) {
      return reply.code(400).send({ success: false, error: 'workspace_id, intent, tags[] required' })
    }
    const decision = await checkAlignment(workspace_id, tags)
    await emitAlignmentDecision(workspace_id, intent, decision)
    return { success: true, data: decision }
  })

  // ── Outcome evaluator (gap #4) ────────────────────────────────────────────
  fastify.post<{ Body: { workspace_id?: string } }>('/outcomes/evaluate', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await evaluateOutcomes(ws) }
  })
}

export const executiveRoutes: FastifyPluginAsync = async (fastify) => {

  fastify.get<{ Querystring: { workspace_id?: string } }>('/state', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await getExecutiveState(ws) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; limit?: string } }>('/reviews', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await recentReviews(ws, req.query.limit ? Number(req.query.limit) : 20) }
  })

  fastify.post<{ Body: { workspace_id?: string; cycle?: string } }>('/run-review', async (req, reply) => {
    const { workspace_id, cycle } = req.body
    if (!workspace_id || !cycle) return reply.code(400).send({ success: false, error: 'workspace_id, cycle required' })
    let result
    switch (cycle as ReviewCycle) {
      case 'hourly':     result = await runHourlyHealthReview(workspace_id); break
      case 'six_hourly': result = await runSixHourlyOperationalReview(workspace_id); break
      case 'daily':      result = await runDailyStrategicReview(workspace_id); break
      case 'weekly':     result = await runWeeklyRoadmapReview(workspace_id); break
      default: return reply.code(400).send({ success: false, error: `unknown cycle: ${cycle}` })
    }
    return { success: true, data: result }
  })
}

export const skillsRoutes: FastifyPluginAsync = async (fastify) => {

  fastify.post<{ Body: { workspace_id?: string } }>('/seed-builtin', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await seedBuiltinSkills(ws) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; status?: string; category?: string } }>('/', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const opts: { status?: string; category?: SkillCategory } = {}
    if (req.query.status)   opts.status = req.query.status
    if (req.query.category) opts.category = req.query.category as SkillCategory
    return { success: true, data: await listSkills(ws, opts) }
  })

  fastify.post<{ Params: { slug: string }; Body: { workspace_id?: string; inputs?: Record<string, unknown> } }>('/:slug/execute', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await executeSkill(ws, req.params.slug, req.body.inputs ?? {}) }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/gaps', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await detectSkillGaps(ws) }
  })

  // Session-correlated gap detector (gap #9)
  fastify.get<{ Querystring: { workspace_id?: string } }>('/gaps-by-session', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await detectSkillGapsBySession(ws) }
  })

  // Promotion (gap #8)
  fastify.post<{ Params: { slug: string }; Body: { workspace_id?: string; target?: string } }>('/:slug/promote', async (req, reply) => {
    const { workspace_id, target } = req.body
    if (!workspace_id || !target) return reply.code(400).send({ success: false, error: 'workspace_id, target required' })
    return { success: true, data: await promoteSkill(workspace_id, req.params.slug, target as SkillStatus) }
  })
}
