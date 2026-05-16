import { db } from '../db.js'
import { queueTraces } from '@ops/db'
import { v7 as uuidv7 } from 'uuid'

export interface RecordQueueTraceInput {
  traceId:      string
  queueName:    string
  jobId:        string
  jobName:      string
  event:        string  // created|started|completed|failed|retry_scheduled|dead_lettered
  durationMs?:  number
  attempt?:     number
  error?:       string
  workspaceId?: string
}

export async function recordQueueTrace(input: RecordQueueTraceInput): Promise<string> {
  const id = uuidv7()
  await db.insert(queueTraces).values({
    id,
    traceId:   input.traceId,
    queueName: input.queueName,
    jobId:     input.jobId,
    jobName:   input.jobName,
    event:     input.event,
    createdAt: Date.now(),
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
    ...(input.durationMs  !== undefined ? { durationMs:  input.durationMs  } : {}),
    ...(input.attempt     !== undefined ? { attempt:     input.attempt     } : {}),
    ...(input.error       !== undefined ? { error:       input.error       } : {}),
  })
  return id
}
