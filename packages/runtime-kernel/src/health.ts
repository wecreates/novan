/**
 * Health signal types for queue and worker health reporting.
 * Pure types and utilities — no external runtime dependencies.
 */

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown'

export interface HealthSignal {
  status:    HealthStatus
  message?:  string
  timestamp: number
  metrics:   Record<string, number>
}

export interface QueueHealthReport {
  queueName:       string
  workspaceId?:    string
  status:          HealthStatus
  waitingCount:    number
  activeCount:     number
  failedCount:     number
  completedCount:  number
  delayedCount:    number
  pausedCount:     number
  errorRate:       number    // 0-1: failed / (completed + failed) over window
  throughput:      number    // jobs/minute over last observation window
  avgProcessingMs: number
  stalledCount:    number
  deadLetterCount: number
  lastCheckedAt:   number
}

export interface WorkerHealthReport {
  workerId:         string
  workerName:       string
  queueName:        string
  workspaceId?:     string
  status:           HealthStatus
  activeJobs:       number
  concurrency:      number
  uptimeMs:         number
  lastHeartbeatAt:  number
  heapUsedMb:       number
  heapTotalMb:      number
  rssMemMb:         number
  processedJobs:    number
  failedJobs:       number
  avgJobDurationMs: number
  lastCheckedAt:    number
}

export interface SystemHealthSnapshot {
  timestamp:     number
  queues:        QueueHealthReport[]
  workers:       WorkerHealthReport[]
  overallStatus: HealthStatus
}

/** Derive overall status from a list of component statuses — worst wins. */
export function deriveOverallStatus(statuses: HealthStatus[]): HealthStatus {
  if (statuses.includes('unhealthy')) return 'unhealthy'
  if (statuses.includes('degraded'))  return 'degraded'
  if (statuses.includes('unknown'))   return 'unknown'
  return 'healthy'
}

/** Thresholds used to classify health from real runtime signals. */
export const HEALTH_THRESHOLDS = {
  ERROR_RATE_DEGRADED:    0.05,   // 5%  error rate → degraded
  ERROR_RATE_UNHEALTHY:   0.20,   // 20% error rate → unhealthy
  STALL_COUNT_DEGRADED:   3,
  STALL_COUNT_UNHEALTHY:  10,
  HEARTBEAT_STALE_MS:     60_000, // 1 min without heartbeat → degraded
  HEARTBEAT_DEAD_MS:      300_000, // 5 min → unhealthy
} as const

/** Classify queue health from metrics. */
export function classifyQueueHealth(report: Omit<QueueHealthReport, 'status'>): HealthStatus {
  if (report.errorRate >= HEALTH_THRESHOLDS.ERROR_RATE_UNHEALTHY)  return 'unhealthy'
  if (report.stalledCount >= HEALTH_THRESHOLDS.STALL_COUNT_UNHEALTHY) return 'unhealthy'
  if (report.errorRate >= HEALTH_THRESHOLDS.ERROR_RATE_DEGRADED)   return 'degraded'
  if (report.stalledCount >= HEALTH_THRESHOLDS.STALL_COUNT_DEGRADED)  return 'degraded'
  return 'healthy'
}

/** Classify worker health from heartbeat freshness. */
export function classifyWorkerHealth(report: Omit<WorkerHealthReport, 'status'>): HealthStatus {
  const staleness = Date.now() - report.lastHeartbeatAt
  if (staleness >= HEALTH_THRESHOLDS.HEARTBEAT_DEAD_MS)  return 'unhealthy'
  if (staleness >= HEALTH_THRESHOLDS.HEARTBEAT_STALE_MS) return 'degraded'
  return 'healthy'
}
