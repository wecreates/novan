/**
 * Workflow routes — CRUD + execution control.
 *
 * POST /api/v1/workflows            — create definition
 * GET  /api/v1/workflows            — list definitions
 * GET  /api/v1/workflows/:id        — get definition
 * POST /api/v1/workflows/:id/run    — trigger a run
 * GET  /api/v1/workflows/runs       — list runs (with filter)
 * GET  /api/v1/workflows/runs/:id   — get run detail
 * POST /api/v1/workflows/runs/:id/cancel  — cancel run
 * POST /api/v1/workflows/runs/:id/pause   — pause run
 * POST /api/v1/workflows/runs/:id/resume  — resume run
 * POST /api/v1/workflows/runs/:id/replay  — replay from checkpoint
 */
import type { FastifyPluginAsync } from 'fastify'
import { z }                from 'zod'
import { v7 as uuidv7 }     from 'uuid'
import { db }               from '../db/client.js'
import { queues }           from '../queues/index.js'
import {
  workflowDefinitions,
  workflowRuns,
} from '../db/schema.js'
import { eq, and, desc }    from 'drizzle-orm'
import type { WorkspaceId } from '@ops/shared-types'
import { DEFAULT_RETRY_POLICY } from '@ops/runtime-kernel'

const CreateWorkflowSchema = z.object({
  name:        z.string().min(1).max(200),
  description: z.string().max(2000).nullable().default(null),
  steps:       z.array(z.object({
    id:        z.string(),
    name:      z.string(),
    type:      z.string(),
    config:    z.record(z.unknown()).default({}),
    dependsOn: z.array(z.string()).default([]),
    timeout:   z.number().nullable().default(null),
    onFailure: z.enum(['fail', 'skip', 'continue']).default('fail'),
  })),
  triggers:    z.array(z.object({
    type:   z.enum(['manual', 'cron', 'event', 'webhook']),
    config: z.record(z.unknown()).default({}),
  })).default([]),
  timeout:     z.number().default(300_000),
  tags:        z.array(z.string()).default([]),
})

const TriggerRunSchema = z.object({
  context:    z.record(z.unknown()).default({}),
  triggeredBy: z.string().default('api'),
})

export const workflowRoutes: FastifyPluginAsync = async (app) => {

  // Create workflow definition
  app.post('/', { onRequest: [app.authenticate] }, async (req, reply) => {
    const workspaceId = req.workspaceId as WorkspaceId
    const body = CreateWorkflowSchema.parse(req.body)
    const now  = Date.now()
    const id   = uuidv7()

    const [definition] = await db.insert(workflowDefinitions).values({
      id,
      workspaceId,
      name:        body.name,
      description: body.description,
      steps:       body.steps,
      triggers:    body.triggers,
      retryPolicy: DEFAULT_RETRY_POLICY,
      timeout:     body.timeout,
      tags:        body.tags,
      createdAt:   now,
      updatedAt:   now,
    }).returning()

    return reply.status(201).send({ success: true, data: definition })
  })

  // List workflow definitions
  app.get('/', { onRequest: [app.authenticate] }, async (req, reply) => {
    const workspaceId = req.workspaceId as WorkspaceId
    const definitions = await db.select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.workspaceId, workspaceId))
      .orderBy(desc(workflowDefinitions.updatedAt))
      .limit(100)

    return reply.send({ success: true, data: definitions })
  })

  // Trigger a workflow run — enqueues a job that may run LLM calls,
  // browser sessions, or code execution. Per-IP cap of 30/min prevents
  // accidental flood from a runaway client.
  app.post('/:id/run', {
    onRequest: [app.authenticate],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { id }      = req.params as { id: string }
    const workspaceId = req.workspaceId as WorkspaceId
    const body        = TriggerRunSchema.parse(req.body)
    const now         = Date.now()
    const runId       = uuidv7()
    const traceId     = uuidv7()

    const [definition] = await db.select()
      .from(workflowDefinitions)
      .where(and(
        eq(workflowDefinitions.id, id),
        eq(workflowDefinitions.workspaceId, workspaceId),
      ))
      .limit(1)

    if (!definition) return reply.status(404).send({ success: false, error: 'Workflow not found', code: 'NOT_FOUND', requestId: req.id })

    const [run] = await db.insert(workflowRuns).values({
      id:          runId,
      workflowId:  id,
      workspaceId,
      status:      'pending',
      triggeredBy: body.triggeredBy,
      triggeredAt: now,
      context:     body.context,
      traceId,
    }).returning()

    // Enqueue for worker processing
    await queues.workflow.add('execute-workflow', {
      runId,
      workflowId: id,
      workspaceId,
      traceId,
    }, {
      jobId:    runId,
      priority: 2,
    })

    return reply.status(202).send({ success: true, data: run })
  })

  // Get run detail
  app.get('/runs/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id }      = req.params as { id: string }
    const workspaceId = req.workspaceId as WorkspaceId

    const [run] = await db.select()
      .from(workflowRuns)
      .where(and(
        eq(workflowRuns.id, id),
        eq(workflowRuns.workspaceId, workspaceId),
      ))
      .limit(1)

    if (!run) return reply.status(404).send({ success: false, error: 'Run not found', code: 'NOT_FOUND', requestId: req.id })
    return reply.send({ success: true, data: run })
  })

  // Cancel run
  app.post('/runs/:id/cancel', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id }      = req.params as { id: string }
    const workspaceId = req.workspaceId as WorkspaceId

    await db.update(workflowRuns)
      .set({ status: 'cancelled', completedAt: Date.now() })
      .where(and(
        eq(workflowRuns.id, id),
        eq(workflowRuns.workspaceId, workspaceId),
      ))

    // Remove from queue if still pending
    await queues.workflow.remove(id).catch(() => null)

    return reply.send({ success: true, data: { cancelled: true } })
  })
}
