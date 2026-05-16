/**
 * Patch Approval Routes — /api/v1/patch-approvals
 *
 * GET  /                           — list approvals (workspace-scoped, ?status=pending)
 * GET  /:id                        — single approval + task context
 * POST /:id/approve                — approve (unblocks task dispatch)
 * POST /:id/reject                 — reject (blocks task permanently)
 * POST /:id/request-changes        — ask for changes (keeps pending)
 * POST /classify                   — preview risk classification without persisting
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  listApprovals, getApproval,
  approveTask, rejectTask, requestChanges,
  createApprovalForTask,
} from '../services/approval-gate.js'
import { classifyRisk }  from '../services/risk-classifier.js'
import { db }            from '../db/client.js'
import { buildTasks }    from '../db/schema.js'
import { eq }            from 'drizzle-orm'

const patchApprovalsRoutes: FastifyPluginAsync = async (fastify) => {

  // GET / — list approvals
  fastify.get<{
    Querystring: { workspace_id?: string; status?: string; limit?: string }
  }>('/', async (req, reply) => {
    const { workspace_id, status, limit } = req.query
    if (!workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const records = await listApprovals(workspace_id, status, limit ? Number(limit) : 50)
    return { success: true, data: records }
  })

  // GET /:id
  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const record = await getApproval(req.params.id)
    if (!record) return reply.code(404).send({ success: false, error: 'Approval not found' })
    return { success: true, data: record }
  })

  // POST /:id/approve
  fastify.post<{
    Params: { id: string }
    Body:   { reviewer_id?: string; note?: string }
  }>('/:id/approve', async (req, reply) => {
    const reviewerId = req.body.reviewer_id ?? 'system'
    const updated = await approveTask(req.params.id, reviewerId, req.body.note)
    if (!updated) return reply.code(409).send({ success: false, error: 'Approval not found or not in pending state' })
    return { success: true, data: updated }
  })

  // POST /:id/reject
  fastify.post<{
    Params: { id: string }
    Body:   { reviewer_id?: string; note: string }
  }>('/:id/reject', async (req, reply) => {
    const { note } = req.body
    if (!note) return reply.code(400).send({ success: false, error: 'note required for rejection' })
    const reviewerId = req.body.reviewer_id ?? 'system'
    const updated = await rejectTask(req.params.id, reviewerId, note)
    if (!updated) return reply.code(409).send({ success: false, error: 'Approval not found or not in pending state' })
    return { success: true, data: updated }
  })

  // POST /:id/request-changes
  fastify.post<{
    Params: { id: string }
    Body:   { reviewer_id?: string; note: string }
  }>('/:id/request-changes', async (req, reply) => {
    const { note } = req.body
    if (!note) return reply.code(400).send({ success: false, error: 'note required' })
    const reviewerId = req.body.reviewer_id ?? 'system'
    const updated = await requestChanges(req.params.id, reviewerId, note)
    if (!updated) return reply.code(409).send({ success: false, error: 'Approval not found or not in pending state' })
    return { success: true, data: updated }
  })

  // POST /classify — preview risk classification for a task (no DB write)
  fastify.post<{
    Body: { task_id?: string; title?: string; description?: string; file_path?: string; category?: string; severity?: string; blast_radius?: string }
  }>('/classify', async (req, reply) => {
    const { task_id } = req.body

    // If task_id provided, load from DB and classify
    if (task_id) {
      const rows = await db.select().from(buildTasks).where(eq(buildTasks.id, task_id)).limit(1)
      const task = rows[0]
      if (!task) return reply.code(404).send({ success: false, error: 'Task not found' })
      const classification = classifyRisk({
        title:       task.title,
        description: task.description,
        filePath:    task.filePath,
        category:    task.category,
        severity:    task.severity,
        blastRadius: task.blastRadius,
      })
      return { success: true, data: classification }
    }

    // Otherwise classify from inline fields
    const { title, description, file_path, category, severity, blast_radius } = req.body
    if (!title || !description) {
      return reply.code(400).send({ success: false, error: 'task_id or title+description required' })
    }
    const classification = classifyRisk({
      title,
      description,
      filePath:    file_path,
      category:    category ?? 'unknown',
      severity:    severity ?? 'medium',
      blastRadius: blast_radius ?? 'low',
    })
    return { success: true, data: classification }
  })

  // POST /tasks/:taskId/create — create approval for a task (explicit create)
  fastify.post<{
    Params: { taskId: string }
    Body:   { audit_run_id: string; workspace_id: string; diff_preview?: string }
  }>('/tasks/:taskId/create', async (req, reply) => {
    const { audit_run_id, workspace_id, diff_preview } = req.body
    if (!audit_run_id || !workspace_id) {
      return reply.code(400).send({ success: false, error: 'audit_run_id and workspace_id required' })
    }
    const record = await createApprovalForTask({
      taskId:      req.params.taskId,
      auditRunId:  audit_run_id,
      workspaceId: workspace_id,
      ...(diff_preview !== undefined ? { diffPreview: diff_preview } : {}),
    })
    if (!record) {
      return reply.code(200).send({ success: true, data: null, message: 'Task does not require approval' })
    }
    return { success: true, data: record }
  })
}

export default patchApprovalsRoutes
