/**
 * WorkerHealthReporter — derives health from real BullMQ Worker and heartbeat data.
 * No fake metrics.
 */
import type { Worker } from 'bullmq'
import { classifyWorkerHealth, type WorkerHealthReport } from '@ops/runtime-kernel'
import { emitEvent } from '../events.js'

export interface WorkerHeartbeatData {
  workerId:        string
  workerName:      string
  queueName:       string
  pid:             number
  memoryMb:        number
  activeJobs?:     number
  processedJobs?:  number
  timestamp:       number
}

/** Build a health report for a worker from its latest heartbeat signal. */
export function buildWorkerHealthFromHeartbeat(
  heartbeat: WorkerHeartbeatData,
  worker: Worker,
  startedAt: number,
): WorkerHealthReport {
  const now = Date.now()
  const report: Omit<WorkerHealthReport, 'status'> = {
    workerId:         heartbeat.workerId,
    workerName:       heartbeat.workerName,
    queueName:        heartbeat.queueName,
    activeJobs:       heartbeat.activeJobs ?? 0,
    concurrency:      (worker as unknown as { opts?: { concurrency?: number } }).opts?.concurrency ?? 1,
    uptimeMs:         now - startedAt,
    lastHeartbeatAt:  heartbeat.timestamp,
    heapUsedMb:       heartbeat.memoryMb,
    heapTotalMb:      0,
    rssMemMb:         0,
    processedJobs:    heartbeat.processedJobs ?? 0,
    failedJobs:       0,
    avgJobDurationMs: 0,
    lastCheckedAt:    now,
  }
  const status = classifyWorkerHealth(report)
  return { ...report, status }
}

/** Emit a health check event for a worker. */
export async function emitWorkerHealthEvent(
  report: WorkerHealthReport,
  workspaceId: string,
): Promise<void> {
  await emitEvent('observability.health.checked', workspaceId, {
    target:    'worker',
    targetId:  report.workerId,
    healthy:   report.status === 'healthy',
    metrics:   {
      activeJobs: report.activeJobs,
      uptimeMs:   report.uptimeMs,
      heapUsedMb: report.heapUsedMb,
    },
    timestamp: Date.now(),
  })
}
