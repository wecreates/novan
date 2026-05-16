/**
 * Workflow trace — persists a WorkflowTrace record for run lifecycle events.
 */
import { db } from '../db.js'
import { workflowTraces } from '@ops/db'
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

export interface OpenWorkflowTraceInput {
  traceId:     string
  runId:       string
  workflowId:  string
  workspaceId: string
  triggeredBy: string
  status:      string
}

export async function openWorkflowTrace(input: OpenWorkflowTraceInput): Promise<string> {
  const id = uuidv7()
  await db.insert(workflowTraces).values({
    id,
    workspaceId: input.workspaceId,
    traceId:     input.traceId,
    runId:       input.runId,
    workflowId:  input.workflowId,
    status:      input.status,
    triggeredBy: input.triggeredBy,
    createdAt:   Date.now(),
  })
  return id
}

export async function closeWorkflowTrace(
  runId: string,
  update: { status: string; durationMs?: number; stepCount?: number; failedAt?: number; completedAt?: number; errorMessage?: string },
): Promise<void> {
  await db.update(workflowTraces)
    .set({
      status:       update.status,
      ...(update.durationMs   !== undefined ? { durationMs:   update.durationMs   } : {}),
      ...(update.stepCount    !== undefined ? { stepCount:    update.stepCount    } : {}),
      ...(update.failedAt     !== undefined ? { failedAt:     update.failedAt     } : {}),
      ...(update.completedAt  !== undefined ? { completedAt:  update.completedAt  } : {}),
      ...(update.errorMessage !== undefined ? { errorMessage: update.errorMessage } : {}),
    })
    .where(eq(workflowTraces.runId, runId))
}
