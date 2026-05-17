/**
 * enhancements.ts — Routes for items 25, 27, 28, 29, 30.
 *
 * Mounted at /api/v1/x/* (intentionally short prefix; these are utility
 * endpoints layered over existing services).
 */
import type { FastifyPluginAsync } from 'fastify'
import { db }                      from '../db/client.js'
import { events }                  from '../db/schema.js'
import { v7 as uuidv7 }            from 'uuid'
import { getPreferences, setPreferences, autoApplyConfidenceFloor, type Patch } from '../services/operator-preferences.js'
import { rewritePrompt }           from '../services/prompt-rewriter.js'
import { allDivisionsSnapshot }    from '../services/divisions.js'

const enhancementRoutes: FastifyPluginAsync = async (fastify) => {

  // ── #25 Operator preferences ────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/preferences', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await getPreferences(ws) }
  })

  fastify.post<{
    Body: { workspace_id?: string } & Patch
  }>('/preferences', async (req, reply) => {
    const { workspace_id, ...patch } = req.body
    if (!workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await setPreferences(workspace_id, patch) }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/preferences/auto-apply-floor', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: { floor: await autoApplyConfidenceFloor(ws) } }
  })

  // ── #30 Recommendation lineage ──────────────────────────────────────────
  fastify.post<{
    Body: { workspace_id?: string; recommendation_id?: string; action?: string; outcome?: string; notes?: string }
  }>('/recommendations/:id/act-on', async (req, reply) => {
    const { workspace_id, action, outcome, notes } = req.body
    const recommendation_id = (req.params as { id: string }).id
    if (!workspace_id || !action) {
      return reply.code(400).send({ success: false, error: 'workspace_id, action required' })
    }
    const id = uuidv7()
    await db.insert(events).values({
      id, type: 'recommendation.acted_on', workspaceId: workspace_id,
      payload: { recommendationId: recommendation_id, action, outcome: outcome ?? null, notes: notes ?? null },
      traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
      source: 'operator', version: 1, createdAt: Date.now(),
    }).catch(() => null)
    return { success: true, data: { eventId: id, recommendationId: recommendation_id } }
  })

  // ── #28 CSV exports ─────────────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/export/divisions.csv', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const snap = await allDivisionsSnapshot(ws)
    const lines: string[] = [
      'division,health,active_agents,active_missions,open_blockers,events_24h,missions_completed,missions_total',
    ]
    for (const [name, d] of Object.entries(snap)) {
      lines.push([
        name, d.health,
        d.metrics.activeAgents, d.metrics.activeMissions,
        d.metrics.openBlockers, d.metrics.eventsLast24h,
        d.missions.completed, d.missions.total,
      ].join(','))
    }
    reply.header('content-type', 'text/csv')
    reply.header('content-disposition', `attachment; filename="divisions-${Date.now()}.csv"`)
    return lines.join('\n')
  })

  // ── #29 Prompt-improvement assistant ────────────────────────────────────
  fastify.post<{
    Body: { workspace_id?: string; prompt?: string; purpose?: 'image' | 'research' | 'general' }
  }>('/rewrite-prompt', async (req, reply) => {
    const { workspace_id, prompt, purpose } = req.body
    if (!workspace_id || !prompt) return reply.code(400).send({ success: false, error: 'workspace_id, prompt required' })
    const result = await rewritePrompt(workspace_id, prompt, purpose ?? 'general')
    if ('error' in result) return reply.code(502).send({ success: false, error: result.error })
    return { success: true, data: result }
  })
}

export default enhancementRoutes
