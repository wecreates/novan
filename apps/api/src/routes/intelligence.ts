/**
 * Daily intelligence + missions + memory + research-to-action routes.
 * Mounted at /api/v1/intelligence
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  createMission, listMissions, updateMissionStatus, setMissionProgress,
  getMission, activeMissionSummary, type MissionStatus,
} from '../services/missions.js'
import { snapshot as strategicSnapshot } from '../services/strategic-memory.js'
import { runDailyReview, generateDailyReview } from '../services/daily-review.js'
import { convertFindings, recentRoadmapFromResearch } from '../services/research-to-action.js'

const intelligenceRoutes: FastifyPluginAsync = async (fastify) => {

  // ─── Daily Briefing ────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string; force?: string } }>('/briefing', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const briefing = req.query.force === 'true'
      ? await runDailyReview(ws, { force: true })
      : await generateDailyReview(ws)
    return { success: true, data: briefing }
  })

  // ─── Missions ──────────────────────────────────────────────────────────────
  fastify.post<{
    Body: {
      workspace_id?: string; title?: string; description?: string;
      horizon?: string; target_date?: number;
      key_results?: Array<{ text: string; done?: boolean }>;
      owners?: string[]; tags?: string[]; parent_goal_id?: string;
    }
  }>('/missions', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.title) {
      return reply.code(400).send({ success: false, error: 'workspace_id, title required' })
    }
    const id = await createMission({
      workspaceId: b.workspace_id,
      title:       b.title,
      ...(b.description    !== undefined ? { description:  b.description }    : {}),
      ...(b.horizon        !== undefined ? { horizon:      b.horizon as 'sprint' | 'quarter' | 'year' } : {}),
      ...(b.target_date    !== undefined ? { targetDate:   b.target_date }    : {}),
      ...(b.key_results    !== undefined ? { keyResults:   b.key_results }    : {}),
      ...(b.owners         !== undefined ? { owners:       b.owners }         : {}),
      ...(b.tags           !== undefined ? { tags:         b.tags }           : {}),
      ...(b.parent_goal_id !== undefined ? { parentGoalId: b.parent_goal_id } : {}),
    })
    return { success: true, data: { id } }
  })

  fastify.get<{ Querystring: { workspace_id?: string; status?: string } }>('/missions', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const opts: { status?: MissionStatus } = {}
    if (req.query.status) opts.status = req.query.status as MissionStatus
    return { success: true, data: await listMissions(ws, opts) }
  })

  fastify.get<{ Params: { id: string } }>('/missions/:id', async (req, reply) => {
    const m = await getMission(req.params.id)
    if (!m) return reply.code(404).send({ success: false, error: 'not found' })
    return { success: true, data: m }
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; status?: string } }>('/missions/:id/status', async (req, reply) => {
    if (!req.body.workspace_id || !req.body.status) return reply.code(400).send({ success: false, error: 'workspace_id, status required' })
    await updateMissionStatus(req.params.id, req.body.workspace_id, req.body.status as MissionStatus)
    return { success: true }
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; progress?: number } }>('/missions/:id/progress', async (req, reply) => {
    if (!req.body.workspace_id || typeof req.body.progress !== 'number') return reply.code(400).send({ success: false, error: 'workspace_id, progress required' })
    await setMissionProgress(req.params.id, req.body.workspace_id, req.body.progress)
    return { success: true }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/missions-summary', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await activeMissionSummary(ws) }
  })

  // ─── Strategic Memory ──────────────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/memory', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await strategicSnapshot(ws) }
  })

  // ─── Research → Action ─────────────────────────────────────────────────────
  fastify.post<{ Body: { workspace_id?: string; since_ms?: number; max_findings?: number } }>('/research-to-action', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const opts: { sinceMs?: number; maxFindings?: number } = {}
    if (req.body.since_ms     !== undefined) opts.sinceMs     = req.body.since_ms
    if (req.body.max_findings !== undefined) opts.maxFindings = req.body.max_findings
    return { success: true, data: await convertFindings(ws, opts) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; limit?: string } }>('/research-roadmap', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const limit = req.query.limit ? Number(req.query.limit) : 25
    return { success: true, data: await recentRoadmapFromResearch(ws, limit) }
  })
}

export default intelligenceRoutes
