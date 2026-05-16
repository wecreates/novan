/**
 * Approval routes — human-in-the-loop gate management.
 *
 * GET  /api/v1/approvals           — list pending approvals
 * GET  /api/v1/approvals/:id       — get approval detail
 * POST /api/v1/approvals/:id/approve — approve gate
 * POST /api/v1/approvals/:id/reject  — reject gate (triggers recovery)
 */
import type { FastifyPluginAsync } from 'fastify'
import { z }                from 'zod'
import { db }               from '../db/client.js'
import { approvals }        from '../db/schema.js'
import { queues }           from '../queues/index.js'
import { eq, and }          from 'drizzle-orm'
import type { WorkspaceId } from '@ops/shared-types'

const RejectSchema = z.object({
  reason: z.string().min(1).max(1000),
})

export const approvalRoutes: FastifyPluginAsync = async (app) => {

  app.get('/', { onRequest: [app.authenticate] }, async (req, reply) => {
    const workspaceId = req.workspaceId as WorkspaceId

    const pending = await db.select()
      .from(approvals)
      .where(and(
        eq(approvals.workspaceId, workspaceId),
        eq(approvals.status, 'pending'),
      ))

    return reply.send({ success: true, data: pending })
  })

  app.post('/:id/approve', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id }      = req.params as { id: string }
    const workspaceId = req.workspaceId as WorkspaceId
    const now         = Date.now()

    const [approval] = await db.update(approvals)
      .set({ status: 'approved', resolvedBy: req.userId, resolvedAt: now })
      .where(and(
        eq(approvals.id, id),
        eq(approvals.workspaceId, workspaceId),
        eq(approvals.status, 'pending'),
      ))
      .returning()

    if (!approval) {
      return reply.status(404).send({ success: false, error: 'Approval not found or already resolved', code: 'NOT_FOUND', requestId: req.id })
    }

    // Resume the workflow run
    await queues.workflow.add('resume-workflow', {
      runId:       approval.runId,
      workspaceId: approval.workspaceId,
      approvalId:  id,
      approved:    true,
      resolvedBy:  req.userId,
    }, { priority: 1 })

    return reply.send({ success: true, data: { approved: true } })
  })

  app.post('/:id/reject', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id }      = req.params as { id: string }
    const workspaceId = req.workspaceId as WorkspaceId
    const { reason }  = RejectSchema.parse(req.body)
    const now         = Date.now()

    const [approval] = await db.update(approvals)
      .set({ status: 'rejected', resolvedBy: req.userId, resolvedAt: now })
      .where(and(
        eq(approvals.id, id),
        eq(approvals.workspaceId, workspaceId),
        eq(approvals.status, 'pending'),
      ))
      .returning()

    if (!approval) {
      return reply.status(404).send({ success: false, error: 'Approval not found or already resolved', code: 'NOT_FOUND', requestId: req.id })
    }

    // Trigger recovery for the rejected run
    await queues.recovery.add('handle-rejection', {
      runId:       approval.runId,
      workspaceId: approval.workspaceId,
      approvalId:  id,
      reason,
    }, { priority: 1 })

    return reply.send({ success: true, data: { rejected: true, reason } })
  })
}
