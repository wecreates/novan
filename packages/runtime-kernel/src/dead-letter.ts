/**
 * Dead-letter queue types and record builder.
 * Exhausted jobs are persisted to Postgres so they survive Redis flushes.
 * Pure types — no external imports.
 */

export interface DeadLetterRecord {
  id:             string
  queueName:      string
  jobId:          string
  jobName:        string
  payload:        Record<string, unknown>
  error:          string
  attempts:       number
  firstFailedAt:  number
  deadLetteredAt: number
  workspaceId:    string
  traceId?:       string | undefined
  workerId:       string
}

export interface IJobSnapshot {
  id?:          string | undefined
  name:         string
  data:         Record<string, unknown>
  timestamp:    number
  attemptsMade: number
  opts:         { attempts?: number | undefined }
}

export function buildDeadLetterRecord(
  job:       IJobSnapshot,
  err:       Error,
  queueName: string,
  workerId:  string,
): DeadLetterRecord {
  const workspaceId = (job.data['workspaceId'] as string | undefined) ?? ''
  const traceId     = (job.data['traceId']     as string | undefined)
  return {
    id:             `dlq-${job.id ?? 'unknown'}-${Date.now()}`,
    queueName,
    jobId:          job.id ?? 'unknown',
    jobName:        job.name,
    payload:        job.data,
    error:          err.message,
    attempts:       job.attemptsMade,
    firstFailedAt:  job.timestamp,
    deadLetteredAt: Date.now(),
    workspaceId,
    traceId,
    workerId,
  }
}

export function isJobExhausted(job: IJobSnapshot, defaultMaxAttempts = 3): boolean {
  return job.attemptsMade >= (job.opts.attempts ?? defaultMaxAttempts)
}
