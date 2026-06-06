/**
 * Deployment Guard
 *
 * Orchestrates pre/post-deploy validation with automatic rollback.
 * Deployment state is kept in-memory (production: use Redis/DB).
 * All transitions emit events to the DB events table.
 */

import { v7 as uuidv7 }             from 'uuid'
import { db }                        from '../db/client.js'
import { events }                    from '../db/schema.js'
import { checkReadiness }            from './launch-gate.js'
import type { ReadinessReport }      from './launch-gate.js'
import { requestRollback }           from '@ops/service-recovery'

export type { ReadinessReport }

// ─── Types ────────────────────────────────────────────────────────────────────

export type DeployStatus =
  | 'pending_approval'
  | 'pre_validating'
  | 'deploying'
  | 'post_validating'
  | 'completed'
  | 'failed'
  | 'rolled_back'

export interface DeployConfig {
  id:               string
  workspaceId:      string
  description:      string
  requiresApproval: boolean
  triggeredBy:      string
}

export interface DeploymentRecord {
  id:                string
  workspaceId:       string
  description:       string
  status:            DeployStatus
  readinessReport:   ReadinessReport
  triggeredBy:       string
  approvedBy?:       string
  rollbackReason?:   string
  startedAt:         number
  completedAt?:      number
  rollbackTriggered: boolean
}

// ─── In-memory store ──────────────────────────────────────────────────────────

const store = new Map<string, DeploymentRecord>()

// R146.323 — deployment records accumulate forever in memory. Bounded
// in practice by deploy frequency, but unbounded over years.
// Soft-cap by dropping the oldest entry when over 5000.
function capStore(): void {
  if (store.size < 5000) return
  const oldest = store.keys().next().value
  if (oldest) store.delete(oldest)
}

// ─── Event emitter ────────────────────────────────────────────────────────────

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await db.insert(events).values({
    id:            uuidv7(),
    type,
    workspaceId,
    payload,
    traceId:       uuidv7(),
    correlationId: uuidv7(),
    causationId:   null,
    source:        'api/deploy-guard',
    version:       1,
    createdAt:     Date.now(),
  }).catch((e: Error) => { console.error('[deploy-guard]', e.message); return null })
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export async function startDeployment(config: DeployConfig): Promise<DeploymentRecord> {
  const report = await checkReadiness(config.workspaceId)

  if (report.blockers.length > 0) {
    const record: DeploymentRecord = {
      id:                config.id,
      workspaceId:       config.workspaceId,
      description:       config.description,
      status:            'failed',
      readinessReport:   report,
      triggeredBy:       config.triggeredBy,
      rollbackTriggered: false,
      startedAt:         Date.now(),
    }
    capStore(); store.set(record.id, record)
    await emit(config.workspaceId, 'deploy.blocked', {
      deploymentId: record.id,
      blockers: report.blockers.map(b => b.message),
    })
    return record
  }

  if (config.requiresApproval) {
    const record: DeploymentRecord = {
      id:                config.id,
      workspaceId:       config.workspaceId,
      description:       config.description,
      status:            'pending_approval',
      readinessReport:   report,
      triggeredBy:       config.triggeredBy,
      rollbackTriggered: false,
      startedAt:         Date.now(),
    }
    capStore(); store.set(record.id, record)
    await emit(config.workspaceId, 'deploy.pending_approval', { deploymentId: record.id })
    return record
  }

  const record: DeploymentRecord = {
    id:                config.id,
    workspaceId:       config.workspaceId,
    description:       config.description,
    status:            'deploying',
    readinessReport:   report,
    triggeredBy:       config.triggeredBy,
    rollbackTriggered: false,
    startedAt:         Date.now(),
  }
  capStore(); store.set(record.id, record)
  await emit(config.workspaceId, 'deploy.started', { deploymentId: record.id })
  return record
}

export async function approveDeployment(
  deploymentId: string,
  workspaceId: string,
  approvedBy: string,
): Promise<DeploymentRecord | null> {
  const record = store.get(deploymentId)
  if (!record || record.status !== 'pending_approval') return null

  record.status = 'deploying'
  record.approvedBy = approvedBy
  await emit(workspaceId, 'deploy.approved', { deploymentId, approvedBy })
  return record
}

export async function completeDeployment(
  deploymentId: string,
  workspaceId: string,
  success: boolean,
): Promise<DeploymentRecord | null> {
  const record = store.get(deploymentId)
  if (!record) return null

  record.status = 'post_validating'

  if (!success) {
    return rollbackDeployment(deploymentId, workspaceId, 'Post-deploy validation failed')
  }

  const postReport = await checkReadiness(workspaceId)
  if (postReport.blockers.length > 0) {
    return rollbackDeployment(deploymentId, workspaceId, 'Post-deploy readiness check failed')
  }

  record.status = 'completed'
  record.completedAt = Date.now()
  await emit(workspaceId, 'deploy.completed', { deploymentId })
  return record
}

export async function rollbackDeployment(
  deploymentId: string,
  workspaceId: string,
  reason: string,
): Promise<DeploymentRecord | null> {
  const record = store.get(deploymentId)
  if (!record) return null

  await requestRollback({
    workspaceId,
    runId:       deploymentId,
    traceId:     uuidv7(),
    reason,
    requestedBy: 'deploy-guard',
  }).catch((e: Error) => { console.error('[deploy-guard]', e.message); return null })

  record.status = 'rolled_back'
  record.rollbackTriggered = true
  record.rollbackReason = reason
  record.completedAt = Date.now()
  await emit(workspaceId, 'deploy.rolled_back', { deploymentId, reason })
  return record
}

export function getDeployment(id: string): DeploymentRecord | undefined {
  return store.get(id)
}

export function listDeployments(workspaceId: string): DeploymentRecord[] {
  return [...store.values()]
    .filter(r => r.workspaceId === workspaceId)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 20)
}
