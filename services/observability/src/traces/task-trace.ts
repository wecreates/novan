/**
 * Task trace — persists a TaskTrace record per step execution.
 */
import { db } from '../db.js'
import { taskTraces } from '@ops/db'
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

export interface OpenTaskTraceInput {
  traceId:     string
  runId:       string
  stepId:      string
  stepType:    string
  workspaceId: string
  attempt?:    number
}

export async function openTaskTrace(input: OpenTaskTraceInput): Promise<string> {
  const id = uuidv7()
  await db.insert(taskTraces).values({
    id,
    workspaceId: input.workspaceId,
    traceId:     input.traceId,
    runId:       input.runId,
    stepId:      input.stepId,
    stepType:    input.stepType,
    status:      'running',
    attempt:     input.attempt ?? 1,
    startedAt:   Date.now(),
    createdAt:   Date.now(),
  })
  return id
}

export async function closeTaskTrace(
  id: string,
  update: { status: string; durationMs?: number; output?: Record<string, unknown>; error?: string; completedAt?: number },
): Promise<void> {
  await db.update(taskTraces)
    .set({
      status:      update.status,
      completedAt: update.completedAt ?? Date.now(),
      ...(update.durationMs !== undefined ? { durationMs: update.durationMs } : {}),
      ...(update.output     !== undefined ? { output:     update.output     } : {}),
      ...(update.error      !== undefined ? { error:      update.error      } : {}),
    })
    .where(eq(taskTraces.id, id))
}
