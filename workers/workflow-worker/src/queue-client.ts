/**
 * Queue client — typed job submission for all queues.
 * Workers use this to enqueue new jobs and emit queue.job.created events.
 */
import { Queue }           from 'bullmq'
import { createRedisFromEnv, QUEUE_NAMES, QUEUE_CONFIG } from '@ops/runtime-kernel'
import type {
  WorkflowQueueJobData, RecoveryQueueJobData,
  MemoryQueueJobData, AnalyticsQueueJobData,
} from '@ops/runtime-kernel'

const connection = createRedisFromEnv()

const defaultJobOptions = {
  attempts:    QUEUE_CONFIG.DEFAULT_MAX_ATTEMPTS,
  backoff:     { type: 'exponential' as const, delay: QUEUE_CONFIG.DEFAULT_BACKOFF_DELAY_MS },
  removeOnComplete: { count: 1_000 },
  removeOnFail:     { count: 5_000 },
}

export const workflowQueue  = new Queue<WorkflowQueueJobData>(QUEUE_NAMES.WORKFLOW,  { connection, defaultJobOptions })
export const recoveryQueue  = new Queue<RecoveryQueueJobData>(QUEUE_NAMES.RECOVERY,  { connection, defaultJobOptions })
export const memoryQueue    = new Queue<MemoryQueueJobData>(QUEUE_NAMES.MEMORY,    { connection, defaultJobOptions })
export const analyticsQueue = new Queue<AnalyticsQueueJobData>(QUEUE_NAMES.ANALYTICS, { connection, defaultJobOptions })
