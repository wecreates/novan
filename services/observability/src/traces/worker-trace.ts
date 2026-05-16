import { db } from '../db.js'
import { workerTraces } from '@ops/db'
import { v7 as uuidv7 } from 'uuid'

export interface RecordWorkerTraceInput {
  traceId:        string
  workerId:       string
  workerName:     string
  queueName:      string
  event:          string  // started | heartbeat | stopped
  heapUsedMb?:    number
  rssMemMb?:      number
  activeJobs?:    number
  processedJobs?: number
  workspaceId?:   string
}

export async function recordWorkerTrace(input: RecordWorkerTraceInput): Promise<string> {
  const id = uuidv7()
  await db.insert(workerTraces).values({
    id,
    traceId:    input.traceId,
    workerId:   input.workerId,
    workerName: input.workerName,
    queueName:  input.queueName,
    event:      input.event,
    createdAt:  Date.now(),
    ...(input.workspaceId   !== undefined ? { workspaceId:   input.workspaceId   } : {}),
    ...(input.heapUsedMb    !== undefined ? { heapUsedMb:    input.heapUsedMb    } : {}),
    ...(input.rssMemMb      !== undefined ? { rssMemMb:      input.rssMemMb      } : {}),
    ...(input.activeJobs    !== undefined ? { activeJobs:    input.activeJobs    } : {}),
    ...(input.processedJobs !== undefined ? { processedJobs: input.processedJobs } : {}),
  })
  return id
}
