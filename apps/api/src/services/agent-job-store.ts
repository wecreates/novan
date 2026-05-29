/**
 * Engineering Agent Job Store
 *
 * In-memory job queue + event persistence.
 * Jobs ephemeral (restart clears queue) — events table is audit trail.
 */

import { v7 as uuidv7 } from 'uuid'
import { db }           from '../db/client.js'
import { events }       from '../db/schema.js'
import type { AgentType } from './agent-registry.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export type JobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'rolled_back'
  | 'awaiting_approval'

export interface AgentJob {
  id:               string
  workspaceId:      string
  agentType:        AgentType
  status:           JobStatus
  description:      string
  targetFiles:      string[]
  patch:            string | null
  rollbackPatch:    string | null
  requiresApproval: boolean
  approvedAt:       number | null
  startedAt:        number | null
  completedAt:      number | null
  errorMessage:     string | null
  stage:            string
  createdAt:        number
  // internal — tracks retries
  _retryCount:      number
}

// ─── In-memory store ──────────────────────────────────────────────────────────

const jobs = new Map<string, AgentJob>()

/** Bound the in-memory store. Without this, a long-lived API process that
 *  drives many eng-agent jobs grows the map unboundedly because completed/
 *  failed/rolled_back jobs are never deleted (the events table is the
 *  durable audit trail; the map is just live status). Evict terminal jobs
 *  older than the TTL whenever the map exceeds the soft cap. */
const JOB_RETENTION_MS = 24 * 60 * 60 * 1000  // 24h
const JOB_SOFT_CAP     = 5_000

function evictStale(): void {
  if (jobs.size < JOB_SOFT_CAP) return
  const cutoff = Date.now() - JOB_RETENTION_MS
  const terminal = new Set<JobStatus>(['completed', 'failed', 'rolled_back'])
  for (const [id, j] of jobs) {
    const finishedAt = j.completedAt ?? j.createdAt
    if (terminal.has(j.status) && finishedAt < cutoff) jobs.delete(id)
  }
}

// ─── Event helper ─────────────────────────────────────────────────────────────

async function emit(
  workspaceId: string, type: string, payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/eng-agents', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[agent-job-store]', e.message); return null })
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function createJob(
  workspaceId: string,
  agentType:   AgentType,
  description: string,
  targetFiles: string[],
  requiresApproval: boolean,
  patch:         string | null = null,
  rollbackPatch: string | null = null,
): Promise<AgentJob> {
  const job: AgentJob = {
    id: uuidv7(),
    workspaceId, agentType,
    status: 'queued',
    description, targetFiles,
    patch, rollbackPatch,
    requiresApproval,
    approvedAt: null, startedAt: null, completedAt: null,
    errorMessage: null,
    stage: 'queued',
    createdAt: Date.now(),
    _retryCount: 0,
  }
  evictStale()
  jobs.set(job.id, job)
  await emit(workspaceId, 'eng_job.created', {
    jobId: job.id, agentType, description, requiresApproval,
  })
  return job
}

export function getJob(id: string): AgentJob | undefined {
  return jobs.get(id)
}

export function listJobs(workspaceId: string, agentType?: AgentType): AgentJob[] {
  const all = [...jobs.values()].filter(j => j.workspaceId === workspaceId)
  return agentType ? all.filter(j => j.agentType === agentType) : all
}

export async function updateJob(
  id: string, updates: Partial<AgentJob>,
): Promise<AgentJob | null> {
  const job = jobs.get(id)
  if (!job) return null
  Object.assign(job, updates)
  return job
}

export async function approveJob(id: string): Promise<AgentJob | null> {
  const job = jobs.get(id)
  if (!job || job.status !== 'awaiting_approval') return null
  job.status = 'queued'
  job.approvedAt = Date.now()
  await emit(job.workspaceId, 'eng_job.approved', { jobId: id })
  return job
}

export async function rollbackJob(id: string): Promise<AgentJob | null> {
  const job = jobs.get(id)
  if (!job) return null
  job.status = 'rolled_back'
  job.completedAt = Date.now()
  await emit(job.workspaceId, 'eng_job.rolled_back', {
    jobId: id, agentType: job.agentType,
  })
  return job
}

export function clearJobsForTest(): void {
  jobs.clear()
}
