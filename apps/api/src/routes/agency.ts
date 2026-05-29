/**
 * Agency routes — agent catalog + CEO delegations.
 * Mounted at /api/v1/agency.
 *
 *   GET  /catalog/status                 catalog size + scan paths
 *   POST /catalog/sync                   import .md files from disk
 *   GET  /definitions                    list all agents (filterable)
 *   GET  /definitions/:slug              full agent (incl. system prompt)
 *   GET  /departments                    counts grouped by department
 *   POST /delegate                       CEO picks + runs an agent
 *   GET  /delegations                    recent delegations
 *   GET  /delegations/:id                delegation detail
 */
import type { FastifyPluginAsync } from 'fastify'
import path from 'node:path'
import { and, eq, desc, sql, ilike, gte } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agentDefinitions, agentDelegations } from '../db/schema.js'
import {
  syncAgentCatalog, describeCatalogRoot,
} from '../services/agency-catalog.js'
import { delegateToAgent } from '../services/ceo-orchestrator.js'

// Operator must set AGENCY_AGENTS_ROOT to the local checkout path. The
// fallback used to be a hard-coded Windows user-Downloads path, which only
// worked on the original operator's machine and silently broke on every
// other deployment.
const DEFAULT_AGENCY_ROOT = process.env['AGENCY_AGENTS_ROOT'] ?? ''

const agencyRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Catalog status ─────────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string; root?: string } }>('/catalog/status', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const rawRoot = req.query.root ?? DEFAULT_AGENCY_ROOT
    if (!rawRoot) return reply.code(400).send({ success: false, error: 'AGENCY_AGENTS_ROOT not set and no ?root= override provided' })
    const root = path.resolve(rawRoot)
    const disk = await describeCatalogRoot(root)
    const inDb = await db.select({ n: sql<number>`count(*)::int` }).from(agentDefinitions)
      .where(eq(agentDefinitions.workspaceId, ws))
      .then(r => Number(r[0]?.n ?? 0)).catch(() => 0)
    return { success: true, data: { root, ...disk, inDb } }
  })

  // ── Sync (idempotent) ──────────────────────────────────────────────
  fastify.post<{ Body: { workspace_id?: string; root?: string } }>('/catalog/sync', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const rawRoot = req.body.root ?? DEFAULT_AGENCY_ROOT
    if (!rawRoot) return reply.code(400).send({ success: false, error: 'AGENCY_AGENTS_ROOT not set and no body.root override provided' })
    const root = path.resolve(rawRoot)
    const disk = await describeCatalogRoot(root)
    if (!disk.exists) return reply.code(400).send({ success: false, error: `catalog directory not found: ${root}` })
    const result = await syncAgentCatalog(ws, root)
    return { success: true, data: result }
  })

  // ── List ───────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string; department?: string; q?: string; limit?: string } }>('/definitions', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const lim = Math.min(500, Number(req.query.limit ?? 200))
    const dept = req.query.department
    const q    = req.query.q?.trim()

    // Cheap projection — body excluded
    const filters = [eq(agentDefinitions.workspaceId, ws)]
    if (dept) filters.push(eq(agentDefinitions.department, dept))
    if (q)    filters.push(ilike(agentDefinitions.name, `%${q}%`))

    const rows = await db.select({
      id:          agentDefinitions.id,
      slug:        agentDefinitions.slug,
      department:  agentDefinitions.department,
      name:        agentDefinitions.name,
      description: agentDefinitions.description,
      color:       agentDefinitions.color,
      emoji:       agentDefinitions.emoji,
      vibe:        agentDefinitions.vibe,
      tags:        agentDefinitions.tags,
    }).from(agentDefinitions)
      .where(and(...filters))
      .orderBy(agentDefinitions.department, agentDefinitions.name)
      .limit(lim)
      .catch(() => [])
    return { success: true, data: rows }
  })

  fastify.get<{ Params: { slug: string }; Querystring: { workspace_id?: string } }>('/definitions/:slug', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const row = await db.select().from(agentDefinitions)
      .where(and(eq(agentDefinitions.workspaceId, ws), eq(agentDefinitions.slug, req.params.slug)))
      .limit(1).then(r => r[0] ?? null).catch(() => null)
    if (!row) return reply.code(404).send({ success: false, error: 'agent not found' })
    return { success: true, data: row }
  })

  // ── Department roll-up ─────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/departments', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const rows = await db.select({
      department: agentDefinitions.department,
      n:          sql<number>`count(*)::int`,
    }).from(agentDefinitions)
      .where(eq(agentDefinitions.workspaceId, ws))
      .groupBy(agentDefinitions.department)
      .orderBy(agentDefinitions.department)
      .catch(() => [])
    return { success: true, data: rows.map(r => ({ department: r.department, count: Number(r.n) })) }
  })

  // ── Delegate (the CEO acts) ────────────────────────────────────────
  fastify.post<{ Body: {
    workspace_id?:  string
    task?:          string
    hint?:          string
    context?:       Record<string, unknown>
    requested_by?:  string
  } }>('/delegate', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const r = await delegateToAgent({
      workspaceId: ws,
      task:        req.body.task ?? '',
      ...(req.body.hint        !== undefined ? { hint:         req.body.hint        } : {}),
      ...(req.body.context     !== undefined ? { context:      req.body.context     } : {}),
      ...(req.body.requested_by!== undefined ? { requestedBy:  req.body.requested_by } : {}),
    })
    if (!r.ok) return reply.code(400).send({ success: false, error: r.reason })
    return { success: true, data: r }
  })

  // ── Delegations list + detail ──────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string; limit?: string } }>('/delegations', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const limit = Math.min(200, Number(req.query.limit ?? 30))
    const rows = await db.select().from(agentDelegations)
      .where(eq(agentDelegations.workspaceId, ws))
      .orderBy(desc(agentDelegations.createdAt))
      .limit(limit)
      .catch(() => [])
    return { success: true, data: rows }
  })

  fastify.get<{ Params: { id: string }; Querystring: { workspace_id?: string } }>('/delegations/:id', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const row = await db.select().from(agentDelegations)
      .where(and(eq(agentDelegations.workspaceId, ws), eq(agentDelegations.id, req.params.id)))
      .limit(1).then(r => r[0] ?? null).catch(() => null)
    if (!row) return reply.code(404).send({ success: false, error: 'delegation not found' })
    return { success: true, data: row }
  })

  // ── CEO cycle: snapshot divisions + delegate remediation. Same cycle
  //    the cron fires every 15 min — exposed here for on-demand runs.
  fastify.post<{ Body: { workspace_id?: string } }>('/ceo/cycle', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const { runCeoCycle } = await import('../services/ceo-cycle.js')
    return { success: true, data: await runCeoCycle(ws) }
  })

  // Department roll-up — count agents + recent delegations per department
  fastify.get<{ Querystring: { workspace_id?: string } }>('/ceo/departments', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const { db: dbc } = await import('../db/client.js')
    const { agentDefinitions: defs, agentDelegations: dels } = await import('../db/schema.js')
    const since = Date.now() - 7 * 24 * 60 * 60_000
    const agents = await dbc.select().from(defs).where(eq(defs.workspaceId, ws)).catch(() => [])
    const recent = await dbc.select().from(dels)
      .where(and(eq(dels.workspaceId, ws), gte(dels.createdAt, since)))
      .catch(() => [])
    const byDept = new Map<string, { count: number; recent: number; succeeded: number; failed: number }>()
    for (const a of agents) {
      const e = byDept.get(a.department) ?? { count: 0, recent: 0, succeeded: 0, failed: 0 }
      e.count++
      byDept.set(a.department, e)
    }
    for (const d of recent) {
      const e = byDept.get(d.department) ?? { count: 0, recent: 0, succeeded: 0, failed: 0 }
      e.recent++
      if (d.status === 'succeeded') e.succeeded++
      if (d.status === 'failed')    e.failed++
      byDept.set(d.department, e)
    }
    return {
      success: true,
      data: [...byDept.entries()].map(([department, m]) => ({ department, ...m })).sort((a, b) => b.count - a.count),
    }
  })
}

export default agencyRoutes
