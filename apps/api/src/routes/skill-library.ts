/**
 * Skill library routes — /api/v1/skill-library/*
 * Browse + search imported instructional knowledge.
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  ingestSkillsFromDirectory, getSkill, listSkills,
  skillCategoryCounts, recordSkillUsage,
} from '../services/skill-library.js'

const skillLibraryRoutes: FastifyPluginAsync = async (fastify) => {

  fastify.get<{ Querystring: { category?: string; q?: string; sort?: string; limit?: string } }>('/', async (req) => {
    return { success: true, data: await listSkills({
      ...(req.query.category ? { category: req.query.category } : {}),
      ...(req.query.q        ? { q:        req.query.q } : {}),
      ...(req.query.sort     ? { sort:     req.query.sort as 'used'|'name'|'recent' } : {}),
      ...(req.query.limit    ? { limit:    Number(req.query.limit) } : {}),
    }) }
  })

  fastify.get('/categories', async () => ({
    success: true, data: await skillCategoryCounts(),
  }))

  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = await getSkill(req.params.id)
    if (!row) return reply.code(404).send({ success: false, error: 'skill not found' })
    return { success: true, data: row }
  })

  fastify.post<{ Params: { id: string } }>('/:id/use', async (req, reply) => {
    const row = await recordSkillUsage(req.params.id)
    if (!row) return reply.code(404).send({ success: false, error: 'skill not found' })
    return { success: true, data: row }
  })

  /**
   * Trigger ingestion from a directory. The path is provided by the
   * caller — there's no environment-default to prevent accidental
   * re-ingest of stale content. Idempotent: same hashes = no-op.
   */
  fastify.post<{ Body: { root_dir?: string; source_repo?: string } }>('/ingest', async (req, reply) => {
    const dir = req.body.root_dir
    if (!dir) return reply.code(400).send({ success: false, error: 'root_dir required' })
    const out = await ingestSkillsFromDirectory(dir, {
      ...(req.body.source_repo ? { sourceRepo: req.body.source_repo } : {}),
    })
    return { success: true, data: out }
  })
}

export default skillLibraryRoutes
