/**
 * Workflow run routes — query and manage active runs.
 *
 * GET  /api/v1/workflow-runs         — list recent runs (last 50)
 * GET  /api/v1/workflow-runs/:id     — get run detail with steps
 * POST /api/v1/workflow-runs/:id/cancel — cancel a running run
 */
import type { FastifyPluginAsync } from 'fastify'
import { db }          from '../db/client.js'
import { workflowRuns, stepRuns } from '../db/schema.js'
import { eq, and, desc, sql } from 'drizzle-orm'
import type { WorkspaceId } from '@ops/shared-types'
import { requestRollback, getLatestSnapshot } from '@ops/service-recovery'

export const workflowRunRoutes: FastifyPluginAsync = async (app) => {

  // List recent runs
  app.get('/', { onRequest: [app.authenticate] }, async (req, reply) => {
    const workspaceId = req.workspaceId as WorkspaceId
    const limit = Number((req.query as { limit?: string }).limit ?? 50)

    const runs = await db.select()
      .from(workflowRuns)
      .where(eq(workflowRuns.workspaceId, workspaceId))
      .orderBy(desc(workflowRuns.triggeredAt))
      .limit(Math.min(limit, 200))

    return reply.send({ success: true, data: runs })
  })

  // Get run detail
  app.get('/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id }      = req.params as { id: string }
    const workspaceId = req.workspaceId as WorkspaceId

    const [run] = await db.select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.id, id), eq(workflowRuns.workspaceId, workspaceId)))

    if (!run) {
      return reply.status(404).send({ success: false, error: 'Run not found', code: 'NOT_FOUND', requestId: req.id })
    }

    const steps = await db.select()
      .from(stepRuns)
      .where(eq(stepRuns.runId, id))

    return reply.send({ success: true, data: { ...run, steps } })
  })

  // Cancel a run
  app.post('/:id/cancel', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id }      = req.params as { id: string }
    const workspaceId = req.workspaceId as WorkspaceId

    const [run] = await db.update(workflowRuns)
      .set({ status: 'cancelled' })
      .where(and(
        eq(workflowRuns.id, id),
        eq(workflowRuns.workspaceId, workspaceId),
        sql`${workflowRuns.status} IN ('pending', 'running', 'paused', 'awaiting_approval')`,
      ))
      .returning()

    if (!run) {
      return reply.status(404).send({ success: false, error: 'Run not found or not cancellable', code: 'NOT_FOUND', requestId: req.id })
    }

    return reply.send({ success: true, data: { cancelled: true } })
  })

  // Rollback a run using its most recent snapshot
  app.post('/:id/rollback', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id }      = req.params as { id: string }
    const workspaceId = req.workspaceId as WorkspaceId
    const body        = (req.body ?? {}) as { reason?: string; requestedBy?: string }

    // Verify run belongs to this workspace
    const [run] = await db.select({ id: workflowRuns.id, traceId: workflowRuns.traceId })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.id, id), eq(workflowRuns.workspaceId, workspaceId)))
      .limit(1)

    if (!run) {
      return reply.status(404).send({ success: false, error: 'Run not found', code: 'NOT_FOUND', requestId: req.id })
    }

    // Find the latest active snapshot for this run
    const snapshot = await getLatestSnapshot(id)

    const result = await requestRollback({
      workspaceId,
      runId:       id,
      traceId:     run.traceId ?? id,
      reason:      body.reason ?? 'Manual rollback requested',
      requestedBy: body.requestedBy ?? 'api',
      ...(snapshot ? { snapshotId: snapshot.id } : {}),
    })

    return reply.send({ success: true, data: result })
  })

  // Stats summary (used by War Room KPIs)
  app.get('/stats/summary', { onRequest: [app.authenticate] }, async (req, reply) => {
    const workspaceId = req.workspaceId as WorkspaceId
    const since       = Date.now() - 24 * 60 * 60 * 1000  // 24h

    const rows = await db.execute<{ status: string; count: string }>(
      sql`
        SELECT status, COUNT(*)::text AS count
        FROM workflow_runs
        WHERE workspace_id = ${workspaceId}
          AND triggered_at >= ${since}
        GROUP BY status
      `
    )

    const summary: Record<string, number> = {}
    for (const row of rows) {
      summary[row.status] = Number(row.count)
    }

    return reply.send({ success: true, data: summary })
  })
}
