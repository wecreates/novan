/**
 * Approval Gate — lifecycle management for patch approvals.
 *
 * Creates, approves, rejects, and queries patchApprovals records.
 * Emits runtime events for all state transitions.
 * Agent enforcement calls `requiresApproval()` before executing jobs.
 */
import { db }             from '../db/client.js'
import { patchApprovals, buildTasks } from '../db/schema.js'
import { eq, and, desc }  from 'drizzle-orm'
import { v7 as uuidv7 }   from 'uuid'
import { classifyRisk }   from './risk-classifier.js'
import type { RiskCategory, RiskLevel } from './risk-classifier.js'

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ApprovalRecord {
  id:             string
  taskId:         string
  auditRunId:     string
  workspaceId:    string
  riskLevel:      RiskLevel
  riskCategories: RiskCategory[]
  riskReason:     string
  taskTitle:      string
  filePath:       string | null
  affectedFiles:  string[]
  diffPreview:    string | null
  status:         'pending' | 'approved' | 'rejected' | 'changes_requested'
  reviewerId:     string | null
  reviewerNote:   string | null
  reviewedAt:     number | null
  expiresAt:      number | null
  createdAt:      number
  updatedAt:      number
}

export interface CreateApprovalInput {
  taskId:        string
  auditRunId:    string
  workspaceId:   string
  diffPreview?:  string | null
}

// 7-day TTL for pending approvals
const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000

// ─── Helpers ──────────────────────────────────────────────────────────────────

function emitApprovalEvent(
  workspaceId: string,
  eventType: string,
  payload: Record<string, unknown>,
) {
  // Runtime event via global SSE emitter — best-effort, never throws
  try {
    const { sseEmitter } = require('../routes/stream.js') as { sseEmitter?: { emit: (e: string, d: unknown) => void } }
    sseEmitter?.emit('event', {
      type:        eventType,
      workspaceId,
      payload,
      timestamp:   Date.now(),
    })
  } catch { /* stream not available */ }
}

// ─── Create approval record ────────────────────────────────────────────────────

export async function createApprovalForTask(
  input: CreateApprovalInput,
): Promise<ApprovalRecord | null> {
  // Load the task
  const taskRows = await db.select().from(buildTasks)
    .where(eq(buildTasks.id, input.taskId)).limit(1)
  const task = taskRows[0]
  if (!task) return null

  // Classify risk
  const classification = classifyRisk({
    title:       task.title,
    description: task.description,
    filePath:    task.filePath,
    category:    task.category,
    severity:    task.severity,
    blastRadius: task.blastRadius,
  })

  if (!classification.requiresApproval) return null  // safe — no approval needed

  const now = Date.now()
  const id  = uuidv7()

  const row: typeof patchApprovals.$inferInsert = {
    id,
    taskId:         input.taskId,
    auditRunId:     input.auditRunId,
    workspaceId:    input.workspaceId,
    riskLevel:      classification.riskLevel,
    riskCategories: classification.riskCategories,
    riskReason:     classification.riskReason,
    taskTitle:      task.title,
    filePath:       task.filePath ?? null,
    affectedFiles:  task.filePath ? [task.filePath] : [],
    diffPreview:    input.diffPreview ?? null,
    status:         'pending',
    reviewerId:     null,
    reviewerNote:   null,
    reviewedAt:     null,
    expiresAt:      now + APPROVAL_TTL_MS,
    createdAt:      now,
    updatedAt:      now,
  }

  await db.insert(patchApprovals).values(row)

  // Mark task as requiring approval
  await db.update(buildTasks).set({
    status:           'approval_required',
    requiresApproval: true,
    updatedAt:        now,
  }).where(eq(buildTasks.id, input.taskId))

  emitApprovalEvent(input.workspaceId, 'patch_approval_created', {
    approvalId:     id,
    taskId:         input.taskId,
    riskLevel:      classification.riskLevel,
    riskCategories: classification.riskCategories,
    taskTitle:      task.title,
  })

  return row as ApprovalRecord
}

// ─── Approve ──────────────────────────────────────────────────────────────────

export async function approveTask(
  approvalId: string,
  reviewerId: string,
  note?: string,
): Promise<ApprovalRecord | null> {
  const rows = await db.select().from(patchApprovals)
    .where(eq(patchApprovals.id, approvalId)).limit(1)
  const record = rows[0]
  if (!record) return null
  if (record.status !== 'pending' && record.status !== 'changes_requested') return null

  const now = Date.now()

  await db.update(patchApprovals).set({
    status:      'approved',
    reviewerId,
    reviewerNote: note ?? null,
    reviewedAt:  now,
    updatedAt:   now,
  }).where(eq(patchApprovals.id, approvalId))

  // Unblock the task
  await db.update(buildTasks).set({
    status:    'pending',
    updatedAt: now,
  }).where(eq(buildTasks.id, record.taskId))

  emitApprovalEvent(record.workspaceId, 'patch_approval_approved', {
    approvalId, taskId: record.taskId, reviewerId, taskTitle: record.taskTitle,
  })

  return { ...record, status: 'approved', reviewerId, reviewerNote: note ?? null, reviewedAt: now, updatedAt: now } as ApprovalRecord
}

// ─── Reject ───────────────────────────────────────────────────────────────────

export async function rejectTask(
  approvalId: string,
  reviewerId: string,
  note: string,
): Promise<ApprovalRecord | null> {
  const rows = await db.select().from(patchApprovals)
    .where(eq(patchApprovals.id, approvalId)).limit(1)
  const record = rows[0]
  if (!record) return null
  if (record.status !== 'pending') return null

  const now = Date.now()

  await db.update(patchApprovals).set({
    status:       'rejected',
    reviewerId,
    reviewerNote: note,
    reviewedAt:   now,
    updatedAt:    now,
  }).where(eq(patchApprovals.id, approvalId))

  // Block the task
  await db.update(buildTasks).set({
    status:    'blocked',
    updatedAt: now,
  }).where(eq(buildTasks.id, record.taskId))

  emitApprovalEvent(record.workspaceId, 'patch_approval_rejected', {
    approvalId, taskId: record.taskId, reviewerId, note, taskTitle: record.taskTitle,
  })

  return { ...record, status: 'rejected', reviewerId, reviewerNote: note, reviewedAt: now, updatedAt: now } as ApprovalRecord
}

// ─── Request changes ──────────────────────────────────────────────────────────

export async function requestChanges(
  approvalId: string,
  reviewerId: string,
  note: string,
): Promise<ApprovalRecord | null> {
  const rows = await db.select().from(patchApprovals)
    .where(eq(patchApprovals.id, approvalId)).limit(1)
  const record = rows[0]
  if (!record) return null
  if (record.status !== 'pending') return null

  const now = Date.now()

  await db.update(patchApprovals).set({
    status:       'changes_requested',
    reviewerId,
    reviewerNote: note,
    reviewedAt:   now,
    updatedAt:    now,
  }).where(eq(patchApprovals.id, approvalId))

  emitApprovalEvent(record.workspaceId, 'patch_approval_changes_requested', {
    approvalId, taskId: record.taskId, reviewerId, note, taskTitle: record.taskTitle,
  })

  return { ...record, status: 'changes_requested', reviewerId, reviewerNote: note, reviewedAt: now, updatedAt: now } as ApprovalRecord
}

// ─── Query helpers ────────────────────────────────────────────────────────────

export async function listApprovals(
  workspaceId: string,
  status?: string,
  limit = 50,
): Promise<ApprovalRecord[]> {
  if (status) {
    return db.select().from(patchApprovals)
      .where(and(eq(patchApprovals.workspaceId, workspaceId), eq(patchApprovals.status, status)))
      .orderBy(desc(patchApprovals.createdAt))
      .limit(limit) as Promise<ApprovalRecord[]>
  }
  return db.select().from(patchApprovals)
    .where(eq(patchApprovals.workspaceId, workspaceId))
    .orderBy(desc(patchApprovals.createdAt))
    .limit(limit) as Promise<ApprovalRecord[]>
}

export async function getApproval(id: string): Promise<ApprovalRecord | null> {
  const rows = await db.select().from(patchApprovals)
    .where(eq(patchApprovals.id, id)).limit(1)
  return (rows[0] as ApprovalRecord | undefined) ?? null
}

/**
 * Agent enforcement gate — returns true if agent MUST WAIT before executing.
 * Called by autonomous-orchestrator before running any patch job.
 */
export async function isTaskBlocked(taskId: string): Promise<boolean> {
  const rows = await db.select().from(patchApprovals)
    .where(and(
      eq(patchApprovals.taskId, taskId),
      eq(patchApprovals.status, 'pending'),
    )).limit(1)

  if (rows.length > 0) return true  // pending approval — BLOCKED

  // Also blocked if rejected
  const rejectedRows = await db.select().from(patchApprovals)
    .where(and(
      eq(patchApprovals.taskId, taskId),
      eq(patchApprovals.status, 'rejected'),
    )).limit(1)

  return rejectedRows.length > 0
}

export { classifyRisk } from './risk-classifier.js'
