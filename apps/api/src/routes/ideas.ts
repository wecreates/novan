/**
 * Ideas routes — /api/v1/ideas/*
 * Personal-intelligence-to-product pipeline.
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  ingestText, createOrDedupeIdea, updateIdea,
  clarifyIdea, validateIdea, blueprintIdea, archiveIdea, rejectIdea,
  promoteIdea, getIdea, listIdeas, ideaStats, extractIdeaDrafts,
  type IdeaStatus, type IdeaCategory, type IdeaSourceType,
} from '../services/ideas.js'

const ideasRoutes: FastifyPluginAsync = async (fastify) => {

  // List + filter
  fastify.get<{
    Querystring: { workspace_id?: string; status?: string; category?: string; limit?: string }
  }>('/', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await listIdeas(ws, {
      ...(req.query.status   ? { status:   req.query.status   as IdeaStatus   } : {}),
      ...(req.query.category ? { category: req.query.category as IdeaCategory } : {}),
      ...(req.query.limit    ? { limit:    Number(req.query.limit) } : {}),
    }) }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/stats', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await ideaStats(ws) }
  })

  fastify.get<{ Params: { id: string }; Querystring: { workspace_id?: string } }>('/:id', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const row = await getIdea(ws, req.params.id)
    if (!row) return reply.code(404).send({ success: false, error: 'idea not found' })
    return { success: true, data: row }
  })

  // ── Extraction + ingestion ──────────────────────────────────────────
  //
  // /preview      → dry-run: returns drafts without persisting
  // /extract      → drafts AND persists (with dedup)
  // /             → manual create (one idea, fields directly)

  fastify.post<{ Body: { text?: string } }>('/preview', async (req, reply) => {
    const text = req.body.text ?? ''
    if (!text || text.length < 20) return reply.code(400).send({ success: false, error: 'text (min 20 chars) required' })
    return { success: true, data: { drafts: extractIdeaDrafts(text) } }
  })

  fastify.post<{
    Body: {
      workspace_id?: string
      text?:        string
      source_type?: string
      source_ref?:  string
      created_by?:  string
    }
  }>('/extract', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.text || !b.source_type) {
      return reply.code(400).send({ success: false, error: 'workspace_id, text, source_type required' })
    }
    if (b.text.length < 20) {
      return reply.code(400).send({ success: false, error: 'text must be at least 20 chars' })
    }
    const r = await ingestText(b.workspace_id, b.text, {
      type: b.source_type as IdeaSourceType,
      ...(b.source_ref  ? { ref:       b.source_ref } : {}),
      ...(b.created_by  ? { createdBy: b.created_by } : {}),
    })
    return { success: true, data: r }
  })

  fastify.post<{
    Body: {
      workspace_id?: string
      title?:        string
      raw?:          string
      category?:     string
      target_user?:  string
      pain_point?:   string
      solution?:     string
      features?:     string[]
      monetization?: string
      tech_stack?:   string[]
      source_type?:  string
      source_ref?:   string
      created_by?:   string
    }
  }>('/', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.title) {
      return reply.code(400).send({ success: false, error: 'workspace_id, title required' })
    }
    const r = await createOrDedupeIdea({
      workspaceId: b.workspace_id,
      title:       b.title,
      raw:         b.raw ?? b.title,
      ...(b.category     ? { category:     b.category as IdeaCategory } : {}),
      ...(b.target_user  ? { targetUser:   b.target_user } : {}),
      ...(b.pain_point   ? { painPoint:    b.pain_point } : {}),
      ...(b.solution     ? { solution:     b.solution } : {}),
      ...(b.features     ? { features:     b.features } : {}),
      ...(b.monetization ? { monetization: b.monetization } : {}),
      ...(b.tech_stack   ? { techStack:    b.tech_stack } : {}),
      sourceType:  (b.source_type ?? 'manual') as IdeaSourceType,
      ...(b.source_ref ? { sourceRef: b.source_ref } : {}),
      ...(b.created_by ? { createdBy: b.created_by } : {}),
    })
    return reply.code(r.created ? 201 : 200).send({ success: true, data: r })
  })

  // ── Edits + status transitions ──────────────────────────────────────

  fastify.patch<{
    Params: { id: string }
    Body: Record<string, unknown> & { workspace_id?: string }
  }>('/:id', async (req, reply) => {
    const ws = req.body.workspace_id as string | undefined
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const b = req.body
    const patch: Record<string, unknown> = {}
    if (b['title']           !== undefined) patch['title']           = b['title']
    if (b['category']        !== undefined) patch['category']        = b['category']
    if (b['target_user']     !== undefined) patch['targetUser']      = b['target_user']
    if (b['pain_point']      !== undefined) patch['painPoint']       = b['pain_point']
    if (b['solution']        !== undefined) patch['solution']        = b['solution']
    if (b['features']        !== undefined) patch['features']        = b['features']
    if (b['monetization']    !== undefined) patch['monetization']    = b['monetization']
    if (b['tech_stack']      !== undefined) patch['techStack']       = b['tech_stack']
    if (b['demand_score']    !== undefined) patch['demandScore']     = b['demand_score']
    if (b['difficulty_score']!== undefined) patch['difficultyScore'] = b['difficulty_score']
    if (b['build_readiness'] !== undefined) patch['buildReadiness']  = b['build_readiness']
    if (b['upside_score']    !== undefined) patch['upsideScore']     = b['upside_score']
    if (b['risk_score']      !== undefined) patch['riskScore']       = b['risk_score']
    const row = await updateIdea(ws, req.params.id, patch)
    if (!row) return reply.code(404).send({ success: false, error: 'idea not found' })
    return { success: true, data: row }
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string } }>('/:id/clarify', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const row = await clarifyIdea(ws, req.params.id, {})
    if (!row) return reply.code(404).send({ success: false, error: 'idea not found' })
    return { success: true, data: row }
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string } }>('/:id/validate', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const row = await validateIdea(ws, req.params.id, {})
    if (!row) return reply.code(404).send({ success: false, error: 'idea not found' })
    return { success: true, data: row }
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string } }>('/:id/blueprint', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const row = await blueprintIdea(ws, req.params.id, {})
    if (!row) return reply.code(404).send({ success: false, error: 'idea not found' })
    return { success: true, data: row }
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string } }>('/:id/archive', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const row = await archiveIdea(ws, req.params.id)
    if (!row) return reply.code(404).send({ success: false, error: 'idea not found' })
    return { success: true, data: row }
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; reason?: string } }>('/:id/reject', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.reason) return reply.code(400).send({ success: false, error: 'workspace_id, reason required' })
    const row = await rejectIdea(b.workspace_id, req.params.id, b.reason)
    if (!row) return reply.code(404).send({ success: false, error: 'idea not found' })
    return { success: true, data: row }
  })

  // Promote — runs constructBusiness() and links the new business back
  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; force?: boolean } }>('/:id/promote', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    try {
      const r = await promoteIdea(b.workspace_id, req.params.id, { force: !!b.force })
      if (!r) return reply.code(404).send({ success: false, error: 'idea not found' })
      return { success: true, data: r }
    } catch (e) {
      return reply.code(409).send({ success: false, error: (e as Error).message })
    }
  })
}

export default ideasRoutes
