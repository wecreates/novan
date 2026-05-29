/**
 * routes/prompts.ts — R146.22
 *
 * Operator-facing API for the prompt-evolution registry. The brain
 * silently mutates / retires / promotes prompts on a weekly cron with
 * no UI surface — this route gives the operator visibility + manual
 * controls (trigger evolve, list versions, seed, retire).
 *
 *   GET  /api/v1/prompts                      → list slots in workspace
 *   GET  /api/v1/prompts/:slot                → all versions for a slot
 *   POST /api/v1/prompts/:slot/evolve         → manually trigger evolvePrompt
 *   POST /api/v1/prompts/:slot/seed           → seed a new version
 *   POST /api/v1/prompts/:id/retire           → disable a version
 *   POST /api/v1/prompts/:id/enable           → re-enable a version
 */
import type { FastifyPluginAsync } from 'fastify'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { businessPrompts } from '../db/schema.js'
import {
  listSlots, evolvePrompt, seedPrompt,
} from '../services/prompt-evolution.js'

const promptsRoutes: FastifyPluginAsync = async (fastify) => {
  // List all slots in workspace with aggregate stats
  fastify.get<{ Querystring: { workspace_id?: string } }>('/', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const data = await listSlots(ws)
      .catch((e: Error) => { console.error('[prompts] list failed:', e.message); return [] })
    return { success: true, data }
  })

  // List every version for a given slot, ordered by version desc. Includes
  // disabled rows so the operator can see retirement history and re-enable.
  fastify.get<{ Params: { slot: string }; Querystring: { workspace_id?: string } }>('/:slot', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const rows = await db.select().from(businessPrompts)
      .where(and(eq(businessPrompts.workspaceId, ws), eq(businessPrompts.slot, req.params.slot)))
      .orderBy(desc(businessPrompts.version))
      .catch((e: Error) => { console.error('[prompts] version list failed:', e.message); return [] })
    // Derive mean score per row for UI sort
    const enriched = rows.map(r => ({
      ...r,
      meanScore: r.uses > 0 ? Number((r.scoreSum / r.uses).toFixed(4)) : null,
    }))
    return { success: true, data: enriched }
  })

  // Manually trigger evolvePrompt for a slot. Same op the weekly cron
  // runs, but on-demand. evolvePrompt itself is idempotent in a 24h
  // window so spam-clicking won't proliferate variants.
  fastify.post<{ Params: { slot: string }; Body: { workspace_id?: string } }>('/:slot/evolve', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    try {
      const result = await evolvePrompt(ws, req.params.slot)
      return { success: true, data: result }
    } catch (e) {
      return reply.code(500).send({ success: false, error: (e as Error).message })
    }
  })

  // Seed a new version with manually-supplied body. Origin=manual_edit.
  fastify.post<{ Params: { slot: string }; Body: { workspace_id?: string; body?: string; parentId?: string } }>('/:slot/seed', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const body = req.body.body
    if (!body || body.length < 10) return reply.code(400).send({ success: false, error: 'body required (>=10 chars)' })
    if (body.length > 32_000) return reply.code(400).send({ success: false, error: 'body too long (max 32k chars)' })
    try {
      const result = await seedPrompt({
        workspaceId: ws,
        slot:        req.params.slot,
        body,
        origin:      'manual_edit',
        ...(req.body.parentId ? { parentId: req.body.parentId } : {}),
      })
      return { success: true, data: result }
    } catch (e) {
      return reply.code(500).send({ success: false, error: (e as Error).message })
    }
  })

  // Retire (disable) a specific version. Soft-delete; row stays for audit.
  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string } }>('/:id/retire', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const r = await db.update(businessPrompts)
      .set({ enabled: false, updatedAt: Date.now() })
      .where(and(eq(businessPrompts.id, req.params.id), eq(businessPrompts.workspaceId, ws)))
      .returning()
      .catch((e: Error) => { console.error('[prompts] retire failed:', e.message); return [] })
    if (r.length === 0) return reply.code(404).send({ success: false, error: 'not found' })
    return { success: true, data: r[0] }
  })

  // Re-enable a retired version.
  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string } }>('/:id/enable', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const r = await db.update(businessPrompts)
      .set({ enabled: true, updatedAt: Date.now() })
      .where(and(eq(businessPrompts.id, req.params.id), eq(businessPrompts.workspaceId, ws)))
      .returning()
      .catch((e: Error) => { console.error('[prompts] enable failed:', e.message); return [] })
    if (r.length === 0) return reply.code(404).send({ success: false, error: 'not found' })
    return { success: true, data: r[0] }
  })
}

export default promptsRoutes
