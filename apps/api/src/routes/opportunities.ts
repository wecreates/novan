/**
 * Opportunity routes — full CRUD, scoring, status lifecycle, and workflow conversion.
 *
 * POST /api/v1/opportunities                         — create
 * GET  /api/v1/opportunities                         — list (filterable)
 * GET  /api/v1/opportunities/:id                     — detail
 * PATCH /api/v1/opportunities/:id                    — update fields
 * POST /api/v1/opportunities/:id/score               — recompute score
 * POST /api/v1/opportunities/:id/status              — change status (emits event)
 * POST /api/v1/opportunities/:id/convert             — convert to workflow run
 * POST /api/v1/opportunities/:id/link-memory         — attach memoryId(s)
 */
import type { FastifyPluginAsync } from 'fastify'
import { z }                       from 'zod'
import { v7 as uuidv7 }            from 'uuid'
import { desc, eq, and, inArray }  from 'drizzle-orm'
import { db }                      from '../db/client.js'
import {
  opportunities, events,
  memories, workflowDefinitions, workflowRuns,
} from '../db/schema.js'
import { queues }                  from '../queues/index.js'
import { EVENT_TYPES, EVENT_SCHEMA_VERSION } from '@ops/event-contracts'

// ─── Scoring engine ───────────────────────────────────────────────────────────

const EFFORT_SCORE: Record<string, number> = {
  low: 1.0, medium: 0.75, high: 0.50, very_high: 0.25,
}
const RISK_SCORE: Record<string, number> = {
  low: 1.0, medium: 0.70, high: 0.40, critical: 0.10,
}

function computeScore(opts: {
  estimatedROI?:       number | null
  estimatedEffort?:    string | null
  riskLevel?:          string | null
  confidence:          number
  strategicAlignment?: number | null
}): { score: number; scoreBreakdown: Record<string, number> } {
  // ROI score: sigmoid-ish on log scale; 1x=0.30, 3x=0.60, 10x=0.90
  const roi = opts.estimatedROI ?? 1
  const roiScore = Math.min(1, Math.log(Math.max(roi, 0.1) + 1) / Math.log(12))

  const effortScore  = EFFORT_SCORE[opts.estimatedEffort  ?? 'medium'] ?? 0.60
  const riskScore    = RISK_SCORE  [opts.riskLevel         ?? 'medium'] ?? 0.70
  const confScore    = opts.confidence
  const alignScore   = opts.strategicAlignment ?? 0.5

  // Weighted composite (all labeled "estimated")
  const score =
    roiScore    * 0.30 +
    effortScore * 0.20 +
    riskScore   * 0.20 +
    confScore   * 0.15 +
    alignScore  * 0.15

  return {
    score: Math.round(score * 1000) / 1000,
    scoreBreakdown: {
      roi:       Math.round(roiScore    * 1000) / 1000,
      effort:    Math.round(effortScore * 1000) / 1000,
      risk:      Math.round(riskScore   * 1000) / 1000,
      confidence: Math.round(confScore  * 1000) / 1000,
      alignment: Math.round(alignScore  * 1000) / 1000,
    },
  }
}

// ─── Shared emitter ───────────────────────────────────────────────────────────

async function emit(type: string, workspaceId: string, payload: unknown): Promise<void> {
  await db.insert(events).values({
    id:            uuidv7(),
    type,
    workspaceId,
    payload:       payload as Record<string, unknown>,
    traceId:       uuidv7(),
    correlationId: uuidv7(),
    causationId:   null,
    source:        'api/opportunities',
    version:       EVENT_SCHEMA_VERSION,
    createdAt:     Date.now(),
  }).catch((e: Error) => { console.error('[opportunities]', e.message); return null })
}

// ─── Validation schemas ───────────────────────────────────────────────────────

const OPP_TYPES = ['revenue', 'content', 'seo', 'automation', 'business', 'operational', 'strategic'] as const
const EFFORT_LEVELS = ['low', 'medium', 'high', 'very_high'] as const
const RISK_LEVELS   = ['low', 'medium', 'high', 'critical']  as const
const OPP_STATUSES  = [
  'identified', 'evaluating', 'active', 'won', 'lost', 'deferred',
  'accepted', 'rejected', 'stale', 'completed',
] as const

const createSchema = z.object({
  title:               z.string().min(1).max(255),
  description:         z.string().optional(),
  type:                z.enum(OPP_TYPES).default('operational'),
  businessId:          z.string().optional(),
  estimatedROI:        z.number().positive().optional(),
  estimatedEffort:     z.enum(EFFORT_LEVELS).optional(),
  riskLevel:           z.enum(RISK_LEVELS).optional(),
  confidence:          z.number().min(0).max(1).default(0.5),
  strategicAlignment:  z.number().min(0).max(1).optional(),
  linkedMemoryIds:     z.array(z.string()).optional().default([]),
  linkedWorkflowIds:   z.array(z.string()).optional().default([]),
  tags:                z.array(z.string()).optional().default([]),
  priority:            z.number().int().min(0).max(100).optional().default(50),
  valuePotential:      z.number().optional(),
  dueDate:             z.number().int().optional(),
})

const updateSchema = createSchema.partial()

// ─── Route plugin ─────────────────────────────────────────────────────────────

export const opportunityRoutes: FastifyPluginAsync = async (app) => {
  const ws = (req: unknown) =>
    ((req as { workspaceId?: string }).workspaceId ?? 'default')

  // ── POST /  — create ─────────────────────────────────────────────────────
  app.post('/', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message ?? 'Invalid body' })

    const d = parsed.data
    const workspaceId = ws(req)
    const { score, scoreBreakdown } = computeScore({
      estimatedROI:       d.estimatedROI      ?? null,
      estimatedEffort:    d.estimatedEffort   ?? null,
      riskLevel:          d.riskLevel         ?? null,
      confidence:         d.confidence,
      strategicAlignment: d.strategicAlignment ?? null,
    })
    const now = Date.now()
    const id  = uuidv7()

    await db.insert(opportunities).values({
      id,
      workspaceId,
      title:               d.title,
      description:         d.description ?? null,
      type:                d.type,
      businessId:          d.businessId ?? null,
      status:              'identified',
      priority:            d.priority,
      valuePotential:      d.valuePotential ?? null,
      confidence:          d.confidence,
      category:            d.type,       // category mirrors type for backwards compat
      estimatedROI:        d.estimatedROI ?? null,
      estimatedEffort:     d.estimatedEffort ?? null,
      riskLevel:           d.riskLevel ?? null,
      strategicAlignment:  d.strategicAlignment ?? null,
      score,
      scoreBreakdown,
      linkedMemoryIds:     d.linkedMemoryIds,
      linkedWorkflowIds:   d.linkedWorkflowIds,
      tags:                d.tags,
      createdAt:           now,
      updatedAt:           now,
    })

    const [row] = await db.select().from(opportunities).where(eq(opportunities.id, id)).limit(1)

    await emit(EVENT_TYPES.OPPORTUNITY_CREATED, workspaceId, {
      workspaceId, opportunityId: id,
      title: d.title, type: d.type, status: 'identified',
      confidence: d.confidence, timestamp: now,
    })

    return reply.status(201).send({ success: true, data: row })
  })

  // ── GET /  — list ────────────────────────────────────────────────────────
  app.get('/', async (req, reply) => {
    const workspaceId = ws(req)
    const q = req.query as Record<string, string>
    const limit  = Math.min(Number(q['limit'] ?? 50), 100)
    const status = q['status']
    const type   = q['type']

    const conditions = [eq(opportunities.workspaceId, workspaceId)]
    if (status && OPP_STATUSES.includes(status as typeof OPP_STATUSES[number])) {
      conditions.push(eq(opportunities.status, status as typeof OPP_STATUSES[number]))
    }
    if (type && OPP_TYPES.includes(type as typeof OPP_TYPES[number])) {
      conditions.push(eq(opportunities.type, type))
    }

    const rows = await db.select().from(opportunities)
      .where(and(...conditions))
      .orderBy(desc(opportunities.score), desc(opportunities.priority))
      .limit(limit)

    return reply.send({ success: true, data: rows, meta: { count: rows.length } })
  })

  // ── GET /:id  — detail ───────────────────────────────────────────────────
  app.get('/:id', async (req, reply) => {
    const { id }      = req.params as { id: string }
    const workspaceId = ws(req)

    const [row] = await db.select().from(opportunities)
      .where(and(eq(opportunities.id, id), eq(opportunities.workspaceId, workspaceId)))
      .limit(1)

    if (!row) return reply.status(404).send({ success: false, error: 'Opportunity not found' })

    // Attach linked memory summaries
    let linkedMemories: { id: string; content: string; confidence: number }[] = []
    if (row.linkedMemoryIds.length > 0) {
      linkedMemories = await db.select({ id: memories.id, content: memories.content, confidence: memories.confidence })
        .from(memories)
        .where(inArray(memories.id, row.linkedMemoryIds))
    }

    return reply.send({ success: true, data: { ...row, linkedMemories } })
  })

  // ── PUT /:id  — update ───────────────────────────────────────────────────
  app.put('/:id', async (req, reply) => {
    const { id }      = req.params as { id: string }
    const workspaceId = ws(req)

    const parsed = updateSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message ?? 'Invalid body' })

    const [existing] = await db.select().from(opportunities)
      .where(and(eq(opportunities.id, id), eq(opportunities.workspaceId, workspaceId)))
      .limit(1)
    if (!existing) return reply.status(404).send({ success: false, error: 'Opportunity not found' })

    const d = parsed.data
    const now = Date.now()

    // Recompute score if any scoring input changed
    const scoringChanged =
      d.estimatedROI !== undefined || d.estimatedEffort !== undefined ||
      d.riskLevel !== undefined || d.confidence !== undefined ||
      d.strategicAlignment !== undefined

    let scoreUpdate: { score: number; scoreBreakdown: Record<string, number> } | null = null
    if (scoringChanged) {
      scoreUpdate = computeScore({
        estimatedROI:       d.estimatedROI       ?? existing.estimatedROI,
        estimatedEffort:    d.estimatedEffort    ?? existing.estimatedEffort,
        riskLevel:          d.riskLevel          ?? existing.riskLevel,
        confidence:         d.confidence         ?? existing.confidence,
        strategicAlignment: d.strategicAlignment ?? existing.strategicAlignment,
      })
    }

    const updatePayload: Record<string, unknown> = { updatedAt: now }
    if (d.title               !== undefined) updatePayload['title']               = d.title
    if (d.description         !== undefined) updatePayload['description']         = d.description
    if (d.type                !== undefined) updatePayload['type']                = d.type
    if (d.businessId          !== undefined) updatePayload['businessId']          = d.businessId
    if (d.estimatedROI        !== undefined) updatePayload['estimatedROI']        = d.estimatedROI
    if (d.estimatedEffort     !== undefined) updatePayload['estimatedEffort']     = d.estimatedEffort
    if (d.riskLevel           !== undefined) updatePayload['riskLevel']           = d.riskLevel
    if (d.confidence          !== undefined) updatePayload['confidence']          = d.confidence
    if (d.strategicAlignment  !== undefined) updatePayload['strategicAlignment']  = d.strategicAlignment
    if (d.linkedMemoryIds     !== undefined) updatePayload['linkedMemoryIds']     = d.linkedMemoryIds
    if (d.linkedWorkflowIds   !== undefined) updatePayload['linkedWorkflowIds']   = d.linkedWorkflowIds
    if (d.tags                !== undefined) updatePayload['tags']                = d.tags
    if (d.priority            !== undefined) updatePayload['priority']            = d.priority
    if (d.valuePotential      !== undefined) updatePayload['valuePotential']      = d.valuePotential
    if (d.dueDate             !== undefined) updatePayload['dueDate']             = d.dueDate
    if (scoreUpdate) {
      updatePayload['score']          = scoreUpdate.score
      updatePayload['scoreBreakdown'] = scoreUpdate.scoreBreakdown
    }

    await db.update(opportunities).set(updatePayload).where(eq(opportunities.id, id))

    const [updated] = await db.select().from(opportunities).where(eq(opportunities.id, id)).limit(1)

    await emit(EVENT_TYPES.OPPORTUNITY_UPDATED, workspaceId, {
      workspaceId, opportunityId: id,
      fields: Object.keys(updatePayload).filter((k) => k !== 'updatedAt'),
      timestamp: now,
    })

    if (scoreUpdate) {
      await emit(EVENT_TYPES.OPPORTUNITY_SCORED, workspaceId, {
        workspaceId, opportunityId: id,
        score: scoreUpdate.score, scoreBreakdown: scoreUpdate.scoreBreakdown,
        timestamp: now,
      })
    }

    return reply.send({ success: true, data: updated })
  })

  // ── POST /:id/score  — force rescore ─────────────────────────────────────
  app.post('/:id/score', async (req, reply) => {
    const { id }      = req.params as { id: string }
    const workspaceId = ws(req)

    const [existing] = await db.select().from(opportunities)
      .where(and(eq(opportunities.id, id), eq(opportunities.workspaceId, workspaceId)))
      .limit(1)
    if (!existing) return reply.status(404).send({ success: false, error: 'Opportunity not found' })

    const { score, scoreBreakdown } = computeScore({
      estimatedROI:       existing.estimatedROI,
      estimatedEffort:    existing.estimatedEffort,
      riskLevel:          existing.riskLevel,
      confidence:         existing.confidence,
      strategicAlignment: existing.strategicAlignment,
    })
    const now = Date.now()

    await db.update(opportunities).set({ score, scoreBreakdown, updatedAt: now }).where(eq(opportunities.id, id))

    await emit(EVENT_TYPES.OPPORTUNITY_SCORED, workspaceId, {
      workspaceId, opportunityId: id, score, scoreBreakdown, timestamp: now,
    })

    return reply.send({ success: true, data: { score, scoreBreakdown } })
  })

  // ── POST /:id/status  — change status ────────────────────────────────────
  app.post('/:id/status', async (req, reply) => {
    const { id }      = req.params as { id: string }
    const workspaceId = ws(req)

    const schema = z.object({
      status:    z.enum(OPP_STATUSES),
      changedBy: z.string().optional().default('user'),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ success: false, error: 'Invalid status' })

    const [existing] = await db.select({ status: opportunities.status })
      .from(opportunities)
      .where(and(eq(opportunities.id, id), eq(opportunities.workspaceId, workspaceId)))
      .limit(1)
    if (!existing) return reply.status(404).send({ success: false, error: 'Opportunity not found' })

    const { status, changedBy } = parsed.data
    const now = Date.now()

    const patch: Record<string, unknown> = { status, updatedAt: now }
    if (status === 'accepted') patch['acceptedAt'] = now
    if (status === 'rejected') patch['rejectedAt'] = now
    if (status === 'completed' || status === 'won') patch['closedAt'] = now
    if (status === 'stale' || status === 'deferred') patch['closedAt'] = now

    await db.update(opportunities).set(patch).where(eq(opportunities.id, id))

    await emit(EVENT_TYPES.OPPORTUNITY_STATUS_CHANGED, workspaceId, {
      workspaceId, opportunityId: id,
      fromStatus: existing.status, toStatus: status,
      changedBy, timestamp: now,
    })

    return reply.send({ success: true, data: { id, status, changedBy } })
  })

  // ── POST /:id/convert  — convert to workflow run ──────────────────────────
  app.post('/:id/convert', async (req, reply) => {
    const { id }      = req.params as { id: string }
    const workspaceId = ws(req)

    const schema = z.object({
      workflowId:  z.string().optional(),
      convertedBy: z.string().optional().default('user'),
      context:     z.record(z.unknown()).optional().default({}),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ success: false, error: 'Invalid body' })

    const [opp] = await db.select().from(opportunities)
      .where(and(eq(opportunities.id, id), eq(opportunities.workspaceId, workspaceId)))
      .limit(1)
    if (!opp) return reply.status(404).send({ success: false, error: 'Opportunity not found' })
    if (opp.convertedRunId) return reply.status(409).send({ success: false, error: 'Already converted to a workflow run' })

    const { workflowId: requestedWorkflowId, convertedBy, context } = parsed.data

    // Resolve or create a generic opportunity-action workflow definition
    let resolvedWorkflowId = requestedWorkflowId
    if (!resolvedWorkflowId) {
      const [existing] = await db.select({ id: workflowDefinitions.id })
        .from(workflowDefinitions)
        .where(and(
          eq(workflowDefinitions.workspaceId, workspaceId),
          eq(workflowDefinitions.name, 'opportunity-action'),
        ))
        .limit(1)

      if (existing) {
        resolvedWorkflowId = existing.id
      } else {
        resolvedWorkflowId = uuidv7()
        await db.insert(workflowDefinitions).values({
          id:          resolvedWorkflowId,
          workspaceId,
          name:        'opportunity-action',
          description: 'Auto-created workflow for opportunity conversion',
          version:     1,
          steps:       [{ id: 'execute', type: 'action', name: 'Execute opportunity' }],
          triggers:    [],
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
          tags:        ['opportunity', 'auto'],
          isActive:    true,
          createdAt:   Date.now(),
          updatedAt:   Date.now(),
        })
      }
    }

    const runId   = uuidv7()
    const traceId = uuidv7()
    const now     = Date.now()

    await db.insert(workflowRuns).values({
      id:          runId,
      workspaceId,
      workflowId:  resolvedWorkflowId,
      triggeredAt: now,
      triggeredBy: convertedBy,
      traceId,
      context: {
        ...context,
        opportunityId: id,
        opportunityTitle: opp.title,
        opportunityType:  opp.type,
        score:            opp.score,
      },
    })

    await queues.workflow.add('execute-workflow', {
      runId, workflowId: resolvedWorkflowId, workspaceId, traceId,
    }, { jobId: runId })

    // Mark opportunity as active + record conversion
    await db.update(opportunities)
      .set({
        status:              'active',
        convertedRunId:      runId,
        convertedWorkflowId: resolvedWorkflowId,
        convertedAt:         now,
        updatedAt:           now,
      })
      .where(eq(opportunities.id, id))

    await emit(EVENT_TYPES.OPPORTUNITY_CONVERTED, workspaceId, {
      workspaceId, opportunityId: id, title: opp.title,
      runId, workflowId: resolvedWorkflowId, convertedBy, timestamp: now,
    })

    await emit(EVENT_TYPES.OPPORTUNITY_STATUS_CHANGED, workspaceId, {
      workspaceId, opportunityId: id,
      fromStatus: opp.status, toStatus: 'active',
      changedBy: convertedBy, timestamp: now,
    })

    return reply.send({
      success: true,
      data: { runId, workflowId: resolvedWorkflowId, status: 'pending', traceId },
    })
  })

  // ── POST /:id/link-memory  — attach memories ─────────────────────────────
  app.post('/:id/link-memory', async (req, reply) => {
    const { id }      = req.params as { id: string }
    const workspaceId = ws(req)

    const schema = z.object({ memoryIds: z.array(z.string()).min(1) })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ success: false, error: 'Invalid body' })

    const [opp] = await db.select({ linkedMemoryIds: opportunities.linkedMemoryIds })
      .from(opportunities)
      .where(and(eq(opportunities.id, id), eq(opportunities.workspaceId, workspaceId)))
      .limit(1)
    if (!opp) return reply.status(404).send({ success: false, error: 'Opportunity not found' })

    const merged = [...new Set([...opp.linkedMemoryIds, ...parsed.data.memoryIds])]
    await db.update(opportunities)
      .set({ linkedMemoryIds: merged, updatedAt: Date.now() })
      .where(eq(opportunities.id, id))

    return reply.send({ success: true, data: { linkedMemoryIds: merged } })
  })
}
