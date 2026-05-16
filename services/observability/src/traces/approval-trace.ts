import { db } from '../db.js'
import { approvalTraces } from '@ops/db'
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

export interface RecordApprovalTraceInput {
  traceId:        string
  approvalId:     string
  runId:          string
  stepId:         string
  workspaceId:    string
  status:         string
  requestedBy:    string
  requestedAt:    number
  expiresAt:      number
  operationLabel: string
  risk:           string
}

export async function recordApprovalTrace(input: RecordApprovalTraceInput): Promise<string> {
  const id = uuidv7()
  await db.insert(approvalTraces).values({
    id,
    workspaceId:    input.workspaceId,
    traceId:        input.traceId,
    approvalId:     input.approvalId,
    runId:          input.runId,
    stepId:         input.stepId,
    status:         input.status,
    requestedBy:    input.requestedBy,
    requestedAt:    input.requestedAt,
    expiresAt:      input.expiresAt,
    operationLabel: input.operationLabel,
    risk:           input.risk,
    createdAt:      Date.now(),
  })
  return id
}

export async function resolveApprovalTrace(
  approvalId: string,
  update: { status: string; resolvedBy: string; resolvedAt: number },
): Promise<void> {
  await db.update(approvalTraces)
    .set({ status: update.status, resolvedBy: update.resolvedBy, resolvedAt: update.resolvedAt })
    .where(eq(approvalTraces.approvalId, approvalId))
}
