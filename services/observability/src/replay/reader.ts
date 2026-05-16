/**
 * WorkflowReplayReader — read-only access to historical workflow execution data.
 * NEVER mutates state. Used to reconstruct what happened during a run.
 */
import { db } from '../db.js'
import {
  workflowRuns, stepRuns, events, approvals,
  workflowTraces, taskTraces, approvalTraces, failureLineages,
} from '@ops/db'
import { eq, and, asc } from 'drizzle-orm'

export interface WorkflowReplaySummary {
  run:            typeof workflowRuns.$inferSelect
  steps:          typeof stepRuns.$inferSelect[]
  approvals:      typeof approvals.$inferSelect[]
  traceEvents:    typeof events.$inferSelect[]
  workflowTrace:  typeof workflowTraces.$inferSelect | null
  taskTraces:     typeof taskTraces.$inferSelect[]
  approvalTraces: typeof approvalTraces.$inferSelect[]
  failureLineage: typeof failureLineages.$inferSelect | null
}

/** Load the complete execution history for a run (read-only). */
export async function readWorkflowReplay(runId: string, workspaceId: string): Promise<WorkflowReplaySummary | null> {
  const [run] = await db.select().from(workflowRuns)
    .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.workspaceId, workspaceId)))
    .limit(1)
  if (!run) return null

  const [
    steps,
    runApprovals,
    traceEvents,
    workflowTrace,
    runTaskTraces,
    runApprovalTraces,
    failureLineage,
  ] = await Promise.all([
    db.select().from(stepRuns).where(eq(stepRuns.runId, runId)).orderBy(asc(stepRuns.startedAt)),
    db.select().from(approvals).where(eq(approvals.runId, runId)),
    db.select().from(events).where(eq(events.traceId, run.traceId)).orderBy(asc(events.createdAt)),
    db.select().from(workflowTraces).where(eq(workflowTraces.runId, runId)).limit(1).then((r) => r[0] ?? null),
    db.select().from(taskTraces).where(eq(taskTraces.runId, runId)).orderBy(asc(taskTraces.createdAt)),
    db.select().from(approvalTraces).where(eq(approvalTraces.runId, runId)),
    db.select().from(failureLineages).where(eq(failureLineages.runId, runId)).limit(1).then((r) => r[0] ?? null),
  ])

  return {
    run,
    steps,
    approvals:      runApprovals,
    traceEvents,
    workflowTrace,
    taskTraces:     runTaskTraces,
    approvalTraces: runApprovalTraces,
    failureLineage,
  }
}
