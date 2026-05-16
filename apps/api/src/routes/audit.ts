/**
 * Audit Routes — /api/v1/audit
 *
 * POST /runs                        — trigger full-repo audit
 * GET  /runs                        — list audit runs for workspace
 * GET  /runs/:id                    — single run + summary counts
 * GET  /runs/:id/findings           — findings list (?category=&severity=)
 * GET  /runs/:id/tasks              — prioritised build task queue
 * POST /runs/:id/tasks/:taskId/dispatch — dispatch task to autonomous queue
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  runAudit, listAuditRuns, getAuditRun,
  getAuditFindings, getBuildTasks,
}                          from '../services/repo-auditor.js'
import { createApprovalForTask, isTaskBlocked } from '../services/approval-gate.js'
import { classifyRisk }    from '../services/risk-classifier.js'
import { checkBeforePatch } from '../services/failure-memory.js'
import { reviewPatchBeforeDispatch } from '../services/security-team.js'
import { isAllowed }                 from '../services/safety-mode.js'
import { db }              from '../db/client.js'
import { buildTasks }      from '../db/schema.js'
import { eq }              from 'drizzle-orm'
import { queues }          from '../queues/index.js'

const auditRoutes: FastifyPluginAsync = async (fastify) => {

  // POST /runs — trigger audit (async: responds immediately with runId)
  fastify.post<{
    Body: { workspace_id?: string; workspaceId?: string }
  }>('/runs', async (req, reply) => {
    const workspaceId = req.body.workspace_id ?? req.body.workspaceId
    if (!workspaceId) return reply.code(400).send({ success: false, error: 'workspace_id required' })

    // Run audit asynchronously — return runId immediately
    // The audit itself is fast enough (~2–5s) to run inline for now
    const summary = await runAudit(workspaceId)
    return { success: true, data: summary }
  })

  // GET /runs
  fastify.get<{
    Querystring: { workspace_id?: string; limit?: string }
  }>('/runs', async (req, reply) => {
    const { workspace_id, limit } = req.query
    if (!workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const runs = await listAuditRuns(workspace_id, limit ? Number(limit) : 20)
    return { success: true, data: runs }
  })

  // GET /runs/:id
  fastify.get<{ Params: { id: string } }>('/runs/:id', async (req, reply) => {
    const run = await getAuditRun(req.params.id)
    if (!run) return reply.code(404).send({ success: false, error: 'Audit run not found' })
    return { success: true, data: run }
  })

  // GET /runs/:id/findings
  fastify.get<{
    Params:      { id: string }
    Querystring: { category?: string; severity?: string }
  }>('/runs/:id/findings', async (req, reply) => {
    const run = await getAuditRun(req.params.id)
    if (!run) return reply.code(404).send({ success: false, error: 'Audit run not found' })
    const filter: { category?: string; severity?: string } = {}
    if (req.query.category) filter.category = req.query.category
    if (req.query.severity)  filter.severity  = req.query.severity
    const findings = await getAuditFindings(run.id, filter)
    return { success: true, data: findings }
  })

  // GET /runs/:id/tasks
  fastify.get<{
    Params:      { id: string }
    Querystring: { limit?: string }
  }>('/runs/:id/tasks', async (req, reply) => {
    const run = await getAuditRun(req.params.id)
    if (!run) return reply.code(404).send({ success: false, error: 'Audit run not found' })
    const tasks = await getBuildTasks(run.id, req.query.limit ? Number(req.query.limit) : 100)
    return { success: true, data: tasks }
  })

  // POST /runs/:id/tasks/:taskId/dispatch — convert task to autonomous job
  // Runs risk classification first; if risky, creates an approval record instead of dispatching.
  fastify.post<{
    Params: { id: string; taskId: string }
    Body:   { workspace_id?: string; workspaceId?: string }
  }>('/runs/:id/tasks/:taskId/dispatch', async (req, reply) => {
    const rows = await db.select().from(buildTasks).where(eq(buildTasks.id, req.params.taskId)).limit(1)
    const task = rows[0]
    if (!task) return reply.code(404).send({ success: false, error: 'Task not found' })

    if (task.status === 'in_progress' || task.status === 'complete') {
      return reply.code(409).send({ success: false, error: `Task already in status: ${task.status}` })
    }

    // ── Tonight Mode safety gate ─────────────────────────────────────────────
    // Block specific high-risk categories at the safety-flag layer.
    if (task.category === 'deployment') {
      const ok = await isAllowed(task.workspaceId, 'autonomous_deploy')
      if (!ok) return reply.code(409).send({ success: false, error: 'Safety mode blocked: autonomous_deploy is disabled in Tonight Mode' })
    }
    if (task.filePath && /package(-lock)?\.json$|pnpm-lock|yarn\.lock/i.test(task.filePath)) {
      const ok = await isAllowed(task.workspaceId, 'autonomous_deps_upgrade')
      if (!ok) return reply.code(409).send({ success: false, error: 'Safety mode blocked: autonomous_deps_upgrade is disabled' })
    }
    if (task.filePath && /migrations?\/|drizzle\.config|schema\.ts$/i.test(task.filePath)) {
      const ok = await isAllowed(task.workspaceId, 'destructive_migration')
      if (!ok) return reply.code(409).send({ success: false, error: 'Safety mode blocked: destructive_migration is disabled' })
    }

    // ── Agent enforcement gate: block if an active approval exists ────────────
    const blocked = await isTaskBlocked(task.id)
    if (blocked) {
      return reply.code(409).send({ success: false, error: 'Task is blocked pending human approval — approve or reject in the Approvals queue' })
    }

    // ── Learning gate: refuse repeat-failure attempts ────────────────────────
    if (task.filePath) {
      const learningCheck = await checkBeforePatch({
        workspaceId:    task.workspaceId,
        failureType:    'patch',
        rootCauseClass: 'runtime',
        targetRef:      task.filePath,
        errorMessage:   task.title,
      })
      if (learningCheck.decision === 'block') {
        return reply.code(409).send({
          success: false,
          error:   `Learning runtime blocked this attempt: ${learningCheck.reason}`,
          data:    {
            decision:        learningCheck.decision,
            occurrenceCount: learningCheck.occurrenceCount,
            signature:       learningCheck.signature,
            successfulFix:   learningCheck.successfulFixDescription,
          },
        })
      }

      // ── Security gate: Patch Security Reviewer Agent ─────────────────────
      const patchReview = await reviewPatchBeforeDispatch({
        workspaceId: task.workspaceId,
        filePath:    task.filePath,
        description: task.description,
      })
      if (!patchReview.allowed) {
        return reply.code(409).send({
          success: false,
          error:   patchReview.reason ?? 'Patch Security Reviewer blocked this dispatch',
          data:    { findingId: patchReview.findingId },
        })
      }
    }

    // ── Risk classification ───────────────────────────────────────────────────
    const classification = classifyRisk({
      title:       task.title,
      description: task.description,
      filePath:    task.filePath,
      category:    task.category,
      severity:    task.severity,
      blastRadius: task.blastRadius,
    })

    if (classification.requiresApproval) {
      // Create approval record — do NOT dispatch to BullMQ yet
      const approval = await createApprovalForTask({
        taskId:      task.id,
        auditRunId:  task.auditRunId,
        workspaceId: task.workspaceId,
      })
      return reply.code(202).send({
        success: true,
        requiresApproval: true,
        data: {
          taskId:         task.id,
          approvalId:     approval?.id ?? null,
          riskLevel:      classification.riskLevel,
          riskCategories: classification.riskCategories,
          riskReason:     classification.riskReason,
          message:        'Task requires human approval before dispatch. Review in the Approvals queue.',
        },
      })
    }

    // ── Safe to dispatch ──────────────────────────────────────────────────────
    const bullJob = await queues.autonomous.add('audit-task', {
      runId:       task.auditRunId,
      workspaceId: task.workspaceId,
      phase:       'patch',
      taskId:      task.id,
      title:       task.title,
      filePath:    task.filePath,
    }, { priority: task.priority })

    await db.update(buildTasks).set({
      status:          'assigned',
      autonomousJobId: bullJob.id ?? null,
      updatedAt:       Date.now(),
    }).where(eq(buildTasks.id, task.id))

    return { success: true, requiresApproval: false, data: { taskId: task.id, bullmqJobId: bullJob.id } }
  })
}

export default auditRoutes
