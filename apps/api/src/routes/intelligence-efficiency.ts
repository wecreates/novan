/**
 * Intelligence efficiency routes — /api/v1/intel-eff
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  runCompression, listLessons, archiveLesson, staleCandidates,
} from '../services/knowledge-compression.js'
import {
  detectDuplicates, listSuggestions, decideSuggestion,
} from '../services/intelligence-dedup.js'
import { extractPatterns }            from '../services/pattern-extractor.js'
import { evolveConfidence }           from '../services/confidence-evolution.js'

const intelEffRoutes: FastifyPluginAsync = async (fastify) => {

  // ── Compression ────────────────────────────────────────────────────────
  fastify.post<{ Body: { workspace_id?: string } }>('/compress', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await runCompression(ws) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; kind?: string; archived?: string; limit?: string } }>('/lessons', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const opts: { kind?: string; archived?: boolean; limit?: number } = {}
    if (req.query.kind)            opts.kind = req.query.kind
    if (req.query.archived === 'true')  opts.archived = true
    if (req.query.archived === 'false') opts.archived = false
    if (req.query.limit)           opts.limit = Number(req.query.limit)
    return { success: true, data: await listLessons(ws, opts) }
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string } }>('/lessons/:id/archive', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await archiveLesson(ws, req.params.id) }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/lessons/stale', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await staleCandidates(ws) }
  })

  // ── Dedup ─────────────────────────────────────────────────────────────
  fastify.post<{ Body: { workspace_id?: string } }>('/dedup/scan', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await detectDuplicates(ws) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; status?: 'suggested' | 'merged' | 'dismissed' } }>('/dedup/suggestions', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await listSuggestions(ws, req.query.status ?? 'suggested') }
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; decision?: 'merged' | 'dismissed'; actor?: string } }>('/dedup/suggestions/:id/decide', async (req, reply) => {
    const { workspace_id, decision, actor } = req.body
    if (!workspace_id || !decision) return reply.code(400).send({ success: false, error: 'workspace_id, decision required' })
    return { success: true, data: await decideSuggestion(workspace_id, req.params.id, decision, actor ?? 'operator') }
  })

  // ── Pattern extraction ────────────────────────────────────────────────
  fastify.post<{ Body: { workspace_id?: string } }>('/patterns/extract', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await extractPatterns(ws) }
  })

  // ── Confidence evolution ──────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/confidence/evolution', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await evolveConfidence(ws) }
  })
}

export default intelEffRoutes
