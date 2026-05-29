/**
 * Business routes — manage tracked businesses (prospects, clients, portfolio).
 *
 * POST /api/v1/businesses               — create
 * GET  /api/v1/businesses               — list
 * GET  /api/v1/businesses/:id           — detail
 * PUT  /api/v1/businesses/:id           — update
 * POST /api/v1/businesses/:id/metrics   — merge metrics
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { asc, eq, and } from 'drizzle-orm'
import { db } from '../db/client.js'
import { businesses, events } from '../db/schema.js'

const ws = (req: unknown) => ((req as { workspaceId?: string }).workspaceId ?? 'default')

async function emit(type: string, workspaceId: string, payload: unknown): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId,
    payload: payload as Record<string, unknown>,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/businesses', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

const Stage = z.enum(['early', 'growth', 'scale', 'enterprise'])
const Health = z.enum(['green', 'yellow', 'red'])

const CreateBody = z.object({
  name: z.string().min(1).max(300),
  domain: z.string().max(500).optional(),
  industry: z.string().max(200).optional(),
  stage: Stage.optional(),
  health: Health.optional(),
  metrics: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
})

const UpdateBody = z.object({
  name: z.string().min(1).max(300).optional(),
  domain: z.string().max(500).optional(),
  industry: z.string().max(200).optional(),
  stage: Stage.optional(),
  health: Health.optional(),
  metrics: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
})

const MetricsBody = z.object({
  metrics: z.record(z.unknown()),
})

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(20),
})

export const businessesRoutes: FastifyPluginAsync = async (app) => {
  // POST / — create
  app.post('/', async (req, reply) => {
    const body = CreateBody.parse(req.body)
    const workspaceId = ws(req)
    const now = Date.now()
    const id = uuidv7()

    await db.insert(businesses).values({
      id,
      workspaceId,
      name: body.name,
      ...(body.domain !== undefined ? { domain: body.domain } : {}),
      ...(body.industry !== undefined ? { industry: body.industry } : {}),
      stage: body.stage ?? 'early',
      health: body.health ?? 'green',
      metrics: (body.metrics ?? {}) as Record<string, unknown>,
      metadata: (body.metadata ?? {}) as Record<string, unknown>,
      createdAt: now,
      updatedAt: now,
    })

    const [business] = await db.select().from(businesses).where(eq(businesses.id, id)).limit(1)
    await emit('business.created', workspaceId, { businessId: id, name: body.name })

    return reply.code(201).send({ success: true, data: business })
  })

  // GET / — list
  app.get('/', async (req, reply) => {
    const { limit } = ListQuery.parse(req.query)
    const workspaceId = ws(req)

    const rows = await db.select().from(businesses)
      .where(eq(businesses.workspaceId, workspaceId))
      .orderBy(asc(businesses.name))
      .limit(limit)

    return reply.send({ success: true, data: rows })
  })

  // GET /:id — detail
  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspaceId = ws(req)

    const [business] = await db.select().from(businesses)
      .where(and(eq(businesses.id, id), eq(businesses.workspaceId, workspaceId)))
      .limit(1)

    if (!business) return reply.code(404).send({ success: false, error: 'Business not found' })
    return reply.send({ success: true, data: business })
  })

  // PUT /:id — update
  app.put('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspaceId = ws(req)
    const body = UpdateBody.parse(req.body)

    const [existing] = await db.select().from(businesses)
      .where(and(eq(businesses.id, id), eq(businesses.workspaceId, workspaceId)))
      .limit(1)

    if (!existing) return reply.code(404).send({ success: false, error: 'Business not found' })

    const updates: Partial<typeof existing> = { updatedAt: Date.now() }
    if (body.name !== undefined) updates.name = body.name
    if (body.domain !== undefined) updates.domain = body.domain
    if (body.industry !== undefined) updates.industry = body.industry
    if (body.stage !== undefined) updates.stage = body.stage
    if (body.health !== undefined) updates.health = body.health
    if (body.metadata !== undefined) updates.metadata = body.metadata as Record<string, unknown>
    if (body.metrics !== undefined) {
      updates.metrics = Object.assign(
        {},
        existing.metrics as Record<string, unknown>,
        body.metrics,
      ) as Record<string, unknown>
    }

    await db.update(businesses).set(updates).where(eq(businesses.id, id))

    const [updated] = await db.select().from(businesses).where(eq(businesses.id, id)).limit(1)
    await emit('business.updated', workspaceId, { businessId: id, changes: Object.keys(updates) })

    return reply.send({ success: true, data: updated })
  })

  // POST /:id/metrics — merge metrics
  app.post('/:id/metrics', async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspaceId = ws(req)
    const { metrics } = MetricsBody.parse(req.body)

    const [existing] = await db.select().from(businesses)
      .where(and(eq(businesses.id, id), eq(businesses.workspaceId, workspaceId)))
      .limit(1)

    if (!existing) return reply.code(404).send({ success: false, error: 'Business not found' })

    const merged = Object.assign(
      {},
      existing.metrics as Record<string, unknown>,
      metrics,
    ) as Record<string, unknown>

    await db.update(businesses)
      .set({ metrics: merged, updatedAt: Date.now() })
      .where(eq(businesses.id, id))

    await emit('business.metrics_updated', workspaceId, { businessId: id, keys: Object.keys(metrics) })

    return reply.send({ success: true, data: { businessId: id, metrics: merged } })
  })

  // ── Live business construction ────────────────────────────────────
  // POST /api/v1/businesses/construct  — decomposes a brief into a
  //   business + departments + workflow stubs, persists everything,
  //   and emits one `business.system.spawned` event per node so the
  //   brain UI can animate the construction in real time.
  app.post('/construct', async (req, reply) => {
    const workspaceId = ws(req)
    const body = (req.body ?? {}) as { brief?: string; name?: string }
    if (!body.brief || body.brief.trim().length < 5) {
      return reply.status(400).send({ success: false, error: 'brief required (min 5 chars)' })
    }
    const { constructBusiness } = await import('../services/business-construction.js')
    const r = await constructBusiness({
      workspaceId,
      brief: body.brief.trim(),
      ...(body.name ? { name: body.name } : {}),
    })
    return reply.status(201).send({ success: true, data: r })
  })

  // ── List spatial children of a business (for the brain UI) ────────
  app.get('/:id/systems', async (req, reply) => {
    const workspaceId = ws(req)
    const { id } = req.params as { id: string }
    const { listBusinessSystems } = await import('../services/business-construction.js')
    return reply.send({ success: true, data: await listBusinessSystems(workspaceId, id) })
  })

  // ── Single-system detail (brain canvas drill-down) ─────────────────
  app.get('/:id/systems/:sid', async (req, reply) => {
    const workspaceId = ws(req)
    const { id, sid } = req.params as { id: string; sid: string }
    const { businessSystems } = await import('../db/schema.js')
    const row = await db.select().from(businessSystems)
      .where(and(
        eq(businessSystems.workspaceId, workspaceId),
        eq(businessSystems.businessId,  id),
        eq(businessSystems.id,          sid),
      ))
      .limit(1).then(r => r[0] ?? null).catch(() => null)
    if (!row) return reply.status(404).send({ success: false, error: 'system not found' })
    return reply.send({ success: true, data: row })
  })

  // ── Update a system (rename, status, summary) ──────────────────────
  app.patch('/:id/systems/:sid', async (req, reply) => {
    const workspaceId = ws(req)
    const { id, sid } = req.params as { id: string; sid: string }
    const body = (req.body ?? {}) as { name?: string; summary?: string; status?: string }
    const allowedStatus = new Set(['forming', 'active', 'paused', 'archived'])
    const patch: Record<string, unknown> = { updatedAt: Date.now() }
    if (typeof body.name    === 'string' && body.name.trim().length > 0)    patch['name']    = body.name.trim().slice(0, 200)
    if (typeof body.summary === 'string')                                    patch['summary'] = body.summary.slice(0, 500)
    if (typeof body.status  === 'string' && allowedStatus.has(body.status))  patch['status']  = body.status
    if (Object.keys(patch).length === 1) {
      return reply.status(400).send({ success: false, error: 'nothing to update' })
    }
    const { businessSystems } = await import('../db/schema.js')
    await db.update(businessSystems).set(patch)
      .where(and(
        eq(businessSystems.workspaceId, workspaceId),
        eq(businessSystems.businessId,  id),
        eq(businessSystems.id,          sid),
      )).catch(() => null)
    await emit('business.system.updated', workspaceId, { businessId: id, systemId: sid, changes: Object.keys(patch).filter(k => k !== 'updatedAt') })
    return reply.send({ success: true })
  })

  // ── Aggregate detail — everything linked to a business in one call ─
  // Used by /businesses/:id frontend so it can show all items in
  // organized sections without 5-6 separate fetches.
  app.get('/:id/full', async (req, reply) => {
    const workspaceId = ws(req)
    const { id } = req.params as { id: string }
    const [business] = await db.select().from(businesses)
      .where(and(eq(businesses.id, id), eq(businesses.workspaceId, workspaceId)))
      .limit(1)
    if (!business) return reply.code(404).send({ success: false, error: 'Business not found' })

    const { businessSystems, opportunities, risks, strategicGoals, agentDelegations, events: eventsTbl } = await import('../db/schema.js')
    const { desc, gte } = await import('drizzle-orm')

    const [systems, opps, risksList, goals, recentDelegations, recentEvents] = await Promise.all([
      db.select().from(businessSystems)
        .where(and(eq(businessSystems.workspaceId, workspaceId), eq(businessSystems.businessId, id)))
        .orderBy(businessSystems.layer, businessSystems.kind, businessSystems.name)
        .catch(() => []),
      db.select().from(opportunities)
        .where(and(eq(opportunities.workspaceId, workspaceId), eq(opportunities.businessId, id)))
        .orderBy(desc(opportunities.createdAt))
        .limit(50).catch(() => []),
      db.select().from(risks)
        .where(and(eq(risks.workspaceId, workspaceId), eq(risks.businessId, id)))
        .orderBy(desc(risks.createdAt))
        .limit(50).catch(() => []),
      db.select().from(strategicGoals)
        .where(and(eq(strategicGoals.workspaceId, workspaceId), eq(strategicGoals.businessId, id)))
        .orderBy(desc(strategicGoals.createdAt))
        .limit(50).catch(() => []),
      db.select().from(agentDelegations)
        .where(and(
          eq(agentDelegations.workspaceId, workspaceId),
          gte(agentDelegations.createdAt, Date.now() - 7 * 24 * 60 * 60_000),
        ))
        .orderBy(desc(agentDelegations.createdAt))
        .limit(50).catch(() => [])
        .then(rows => rows.filter(r => {
          const ctx = (r.context as { businessId?: string } | null) ?? {}
          return ctx.businessId === id
        })),
      db.select().from(eventsTbl)
        .where(and(
          eq(eventsTbl.workspaceId, workspaceId),
          gte(eventsTbl.createdAt, Date.now() - 24 * 60 * 60_000),
        ))
        .orderBy(desc(eventsTbl.createdAt))
        .limit(200).catch(() => [])
        .then(rows => rows.filter(e => {
          const p = e.payload as { businessId?: string } | null
          return p?.businessId === id
        })),
    ])

    return reply.send({
      success: true,
      data: {
        business,
        systems,            // 5+ rows: goals, workflows, agent slots
        opportunities: opps,
        risks: risksList,
        goals,
        delegations: recentDelegations,
        events:        recentEvents.slice(0, 50),
        counts: {
          systems: systems.length,
          opportunities: opps.length,
          risks: risksList.length,
          goals: goals.length,
          delegations: recentDelegations.length,
          events: recentEvents.length,
        },
      },
    })
  })
}
