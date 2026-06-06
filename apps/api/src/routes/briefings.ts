/**
 * Briefing routes — executive briefing generation and management.
 *
 * POST /api/v1/briefings                            — request briefing generation
 * GET  /api/v1/briefings                            — list recent briefings
 * GET  /api/v1/briefings/:id                        — get briefing + items
 * POST /api/v1/briefings/:id/items/:itemId/convert  — convert item → workflow run
 */
import type { FastifyPluginAsync } from 'fastify'
import { z }                       from 'zod'
import { v7 as uuidv7 }            from 'uuid'
import { desc, eq, and }           from 'drizzle-orm'
import { db }                      from '../db/client.js'
import {
  briefings, briefingItems, events,
  workflowDefinitions, workflowRuns,
} from '../db/schema.js'
import { queues }                  from '../queues/index.js'
import { EVENT_TYPES, EVENT_SCHEMA_VERSION } from '@ops/event-contracts'

// ─── Route plugin ─────────────────────────────────────────────────────────────

export const briefingRoutes: FastifyPluginAsync = async (app) => {

  // ── POST /  — request briefing generation ─────────────────────────────────
  // Briefings enqueue a job that runs an LLM analysis across recent events.
  // Per-IP cap of 10/min prevents storm-of-jobs DoS.
  app.post('/', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const schema = z.object({
      windowMs:    z.number().int().positive().optional().default(86_400_000),
      requestedBy: z.string().optional().default('user'),
    })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ success: false, error: 'Invalid request body' })

    const workspaceId = (req as unknown as { workspaceId: string }).workspaceId ?? 'default'
    const { windowMs, requestedBy } = parsed.data
    const traceId    = uuidv7()
    const briefingId = uuidv7()
    const now        = Date.now()

    // R146.279 — the briefing queue has NO worker (no `new Worker('briefing', ...)`
    // exists in the codebase). Enqueueing a job here left the row sitting at
    // status='generating' forever; producer + DB row + redis job all dead. We
    // ack the request with a placeholder marked status='unimplemented' so the
    // operator sees the right state immediately instead of fake-progress, and
    // skip the queue.add() entirely so we don't keep accumulating zombie jobs
    // in the briefing wait list.
    await db.insert(briefings).values({
      id:          briefingId,
      workspaceId,
      status:      'unimplemented',
      requestedBy,
      traceId,
      windowMs,
      createdAt:   now,
    })

    void windowMs; void queues  // keep imports referenced for future re-wiring

    return reply.status(501).send({
      success: false,
      error:   'briefing-generator-not-wired',
      message: 'No briefing worker exists. Enqueue path retired; ' +
               'placeholder row stored as status=unimplemented for visibility.',
      data:    { briefingId, status: 'unimplemented', traceId },
    })
  })

  // ── GET /  — list recent briefings ────────────────────────────────────────
  app.get('/', async (req, reply) => {
    const workspaceId = (req as unknown as { workspaceId: string }).workspaceId ?? 'default'
    const limit = Number((req.query as Record<string, string>)['limit'] ?? '10')

    const rows = await db.select({
      id:          briefings.id,
      status:      briefings.status,
      requestedBy: briefings.requestedBy,
      summary:     briefings.summary,
      generatedAt: briefings.generatedAt,
      createdAt:   briefings.createdAt,
      errorMessage: briefings.errorMessage,
    })
      .from(briefings)
      .where(eq(briefings.workspaceId, workspaceId))
      .orderBy(desc(briefings.createdAt))
      .limit(Math.min(limit, 50))

    return reply.send({ success: true, data: rows })
  })

  // ── GET /:id  — briefing detail with items ────────────────────────────────
  app.get('/:id', async (req, reply) => {
    const { id }      = req.params as { id: string }
    const workspaceId = (req as unknown as { workspaceId: string }).workspaceId ?? 'default'

    const [briefing] = await db.select()
      .from(briefings)
      .where(and(eq(briefings.id, id), eq(briefings.workspaceId, workspaceId)))
      .limit(1)

    if (!briefing) return reply.status(404).send({ success: false, error: 'Briefing not found' })

    const items = await db.select()
      .from(briefingItems)
      .where(eq(briefingItems.briefingId, id))
      .orderBy(desc(briefingItems.priority))

    return reply.send({ success: true, data: { ...briefing, items } })
  })

  // ── POST /:id/items/:itemId/convert  — convert item to workflow run ───────
  app.post('/:id/items/:itemId/convert', async (req, reply) => {
    const { id, itemId } = req.params as { id: string; itemId: string }
    const workspaceId    = (req as unknown as { workspaceId: string }).workspaceId ?? 'default'

    const schema = z.object({
      workflowId:  z.string().optional(),
      title:       z.string().optional(),
      context:     z.record(z.unknown()).optional().default({}),
      convertedBy: z.string().optional().default('user'),
    })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ success: false, error: 'Invalid request body' })
    const { workflowId, context, convertedBy } = parsed.data

    // Fetch item — verify ownership
    const [item] = await db.select()
      .from(briefingItems)
      .where(and(
        eq(briefingItems.id, itemId),
        eq(briefingItems.briefingId, id),
        eq(briefingItems.workspaceId, workspaceId),
      ))
      .limit(1)

    if (!item) return reply.status(404).send({ success: false, error: 'Briefing item not found' })
    if (item.converted) return reply.status(409).send({ success: false, error: 'Item already converted to a task' })

    // Resolve workflow definition — use provided or find/create a generic one
    let resolvedWorkflowId = workflowId

    if (!resolvedWorkflowId) {
      // Look for existing generic briefing-action workflow
      const [existing] = await db.select({ id: workflowDefinitions.id })
        .from(workflowDefinitions)
        .where(and(
          eq(workflowDefinitions.workspaceId, workspaceId),
          eq(workflowDefinitions.name, 'briefing-action'),
        ))
        .limit(1)

      if (existing) {
        resolvedWorkflowId = existing.id
      } else {
        // Create a minimal workflow definition for briefing-sourced tasks
        resolvedWorkflowId = uuidv7()
        await db.insert(workflowDefinitions).values({
          id:          resolvedWorkflowId,
          workspaceId,
          name:        'briefing-action',
          description: 'Auto-created workflow for briefing item conversion',
          version:     1,
          steps:       [{ id: 'action', type: 'action', name: 'Execute action' }],
          triggers:    [],
          retryPolicy: { maxAttempts: 1, backoffMs: 0 },
          tags:        ['briefing', 'auto'],
          isActive:    true,
          createdAt:   Date.now(),
          updatedAt:   Date.now(),
        })
      }
    }

    // Create the workflow run
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
      context:     {
        ...context,
        briefingId:   id,
        briefingItem: itemId,
        section:      item.section,
        title:        item.title,
        source:       item.source,
        sourceRef:    item.sourceRef,
      },
    })

    // Enqueue the workflow run
    await queues.workflow.add('execute-workflow', {
      runId,
      workflowId: resolvedWorkflowId,
      workspaceId,
      traceId,
    }, { jobId: runId })

    // Mark item as converted
    await db.update(briefingItems)
      .set({
        converted:           true,
        convertedAt:         now,
        convertedRunId:      runId,
        convertedWorkflowId: resolvedWorkflowId,
      })
      .where(eq(briefingItems.id, itemId))

    // Emit conversion event
    await db.insert(events).values({
      id:            uuidv7(),
      type:          EVENT_TYPES.BRIEFING_ITEM_CONVERTED,
      workspaceId,
      payload: {
        workspaceId,
        briefingId:  id,
        itemId,
        section:     item.section,
        title:       item.title,
        runId,
        workflowId:  resolvedWorkflowId,
        convertedBy,
        timestamp:   now,
      },
      traceId,
      correlationId: uuidv7(),
      causationId:   null,
      source:        'api',
      version:       EVENT_SCHEMA_VERSION,
      createdAt:     now,
    }).catch((e: Error) => { console.error('[briefings]', e.message); return null })

    return reply.send({
      success: true,
      data: {
        runId,
        workflowId: resolvedWorkflowId,
        status:     'pending',
        traceId,
      },
    })
  })
}
