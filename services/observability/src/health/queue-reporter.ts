/**
 * QueueHealthReporter — derives health from real BullMQ queue counts.
 * Uses live Redis/BullMQ signals only. No fake metrics.
 */
import type { Queue }       from 'bullmq'
import { classifyQueueHealth, type QueueHealthReport } from '@ops/runtime-kernel'
import { emitEvent }        from '../events.js'

/** Build a health report from a live BullMQ Queue instance. */
export async function reportQueueHealth(
  queue: Queue,
  opts: { workspaceId?: string; emitHealthEvent?: boolean } = {},
): Promise<QueueHealthReport> {
  const counts = await queue.getJobCounts(
    'waiting', 'active', 'failed', 'completed', 'delayed', 'paused',
  )

  const waiting   = counts['waiting']   ?? 0
  const active    = counts['active']    ?? 0
  const failed    = counts['failed']    ?? 0
  const completed = counts['completed'] ?? 0
  const delayed   = counts['delayed']   ?? 0
  const paused    = counts['paused']    ?? 0

  const total     = completed + failed
  const errorRate = total > 0 ? failed / total : 0

  const report: Omit<QueueHealthReport, 'status'> = {
    queueName:       queue.name,
    waitingCount:    waiting,
    activeCount:     active,
    failedCount:     failed,
    completedCount:  completed,
    delayedCount:    delayed,
    pausedCount:     paused,
    errorRate,
    throughput:      0,  // BullMQ doesn't expose throughput directly; left for external telemetry
    avgProcessingMs: 0,
    stalledCount:    0,
    deadLetterCount: 0,
    lastCheckedAt:   Date.now(),
    ...(opts.workspaceId !== undefined ? { workspaceId: opts.workspaceId } : {}),
  }

  const status = classifyQueueHealth(report)
  const full: QueueHealthReport = { ...report, status }

  if (opts.emitHealthEvent) {
    await emitEvent('observability.health.checked', opts.workspaceId ?? '', {
      target:    'queue',
      targetId:  queue.name,
      healthy:   status === 'healthy',
      metrics:   { waitingCount: waiting, activeCount: active, failedCount: failed, errorRate },
      timestamp: Date.now(),
    })
  }

  return full
}
