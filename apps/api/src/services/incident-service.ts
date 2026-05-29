/**
 * incident-service.ts — Incident lifecycle management.
 *
 * Creates, queries, transitions, and emits events for incidents.
 * NEVER creates an incident without real linkedEventIds.
 */
import { db }              from '../db/client.js'
import { incidents, incidentTimeline, events } from '../db/schema.js'
import { eq, and, desc, inArray }      from 'drizzle-orm'
import { v7 as uuidv7 }    from 'uuid'
import { detectAllIncidents } from './incident-detector.js'
import type { IncidentCandidate } from './incident-detector.js'
import { triageIncident }       from './incident-triage.js'

export type IncidentStatus = 'open' | 'acknowledged' | 'mitigating' | 'resolved' | 'escalated'

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function emitRuntimeEvent(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'incident-service', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[incident-service]', e.message); return null })
}

async function appendTimeline(
  incidentId: string, workspaceId: string,
  actionType: string, actor: string, note?: string, payload: Record<string, unknown> = {},
) {
  await db.insert(incidentTimeline).values({
    id: uuidv7(), incidentId, workspaceId, actionType, actor,
    note: note ?? null, payload, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[incident-service]', e.message); return null })
}

// ─── Dedup ────────────────────────────────────────────────────────────────────

/**
 * Build a stable signature for a candidate to dedupe against open incidents.
 * Identical type + affected primary system within 1h is treated as the same incident.
 */
function candidateSignature(c: IncidentCandidate): string {
  const sys = c.affectedSystems
  const key = sys['workflowId'] ?? sys['providerId'] ?? sys['workerId']
    ?? sys['queueName'] ?? sys['jobId'] ?? sys['alertType'] ?? ''
  return `${c.type}::${key}`
}

async function findOpenDuplicate(workspaceId: string, signature: string): Promise<string | null> {
  // Look for an open/acknowledged incident with matching type prefix
  const [type, key] = signature.split('::')
  if (!type) return null
  const rows = await db.select({ id: incidents.id, affectedSystems: incidents.affectedSystems })
    .from(incidents)
    .where(and(
      eq(incidents.workspaceId, workspaceId),
      eq(incidents.type, type),
      inArray(incidents.status, ['open', 'acknowledged', 'mitigating']),
    ))
    .limit(20)

  for (const r of rows) {
    const sys = (r.affectedSystems ?? {}) as Record<string, unknown>
    const existingKey = sys['workflowId'] ?? sys['providerId'] ?? sys['workerId']
      ?? sys['queueName'] ?? sys['jobId'] ?? sys['alertType'] ?? ''
    if (existingKey === key) return r.id
  }
  return null
}

// ─── Create / update incidents ────────────────────────────────────────────────

export interface CreatedIncident {
  id:        string
  isNew:     boolean
  signalCount: number
}

async function createOrUpdateIncident(
  workspaceId: string,
  candidate: IncidentCandidate,
): Promise<CreatedIncident> {
  const sig = candidateSignature(candidate)
  const existingId = await findOpenDuplicate(workspaceId, sig)

  // Run triage
  const triage = triageIncident(candidate)
  const now = Date.now()

  if (existingId) {
    // Merge new signals into existing incident — bump signal count, refresh updatedAt
    const existing = await db.select().from(incidents).where(eq(incidents.id, existingId)).limit(1)
    const prev = existing[0]
    if (!prev) return { id: existingId, isNew: false, signalCount: candidate.signalCount }

    const mergedIds = [...new Set([...(prev.linkedEventIds ?? []), ...candidate.linkedEventIds])]
    // R142 — also refresh summary so the operator sees current state.
    // Previously: incident opened with "1 health check reported X as
    // degraded" and summary stayed that way even after signal_count
    // climbed to 194. New candidate summaries already include the
    // latest aggregate ("N health checks..."), so adopt them.
    await db.update(incidents).set({
      signalCount:        prev.signalCount + candidate.signalCount,
      linkedEventIds:     mergedIds,
      severity:           // escalate if new candidate is more severe
            candidate.severity === 'emergency' ? 'emergency'
          : candidate.severity === 'critical' && prev.severity !== 'emergency' ? 'critical'
          : prev.severity,
      title:              candidate.title,
      summary:            candidate.summary,
      updatedAt:          now,
    }).where(eq(incidents.id, existingId))

    await appendTimeline(existingId, workspaceId, 'updated', 'detector',
      `Merged ${candidate.signalCount} new signal(s)`,
      { newSignalCount: candidate.signalCount, totalSignals: prev.signalCount + candidate.signalCount },
    )
    await emitRuntimeEvent(workspaceId, 'incident.updated', {
      incidentId: existingId, type: candidate.type, addedSignals: candidate.signalCount,
    })

    return { id: existingId, isNew: false, signalCount: prev.signalCount + candidate.signalCount }
  }

  // ── Create new incident ────────────────────────────────────────────────────
  const id = uuidv7()
  await db.insert(incidents).values({
    id,
    workspaceId,
    type:                  candidate.type,
    severity:              candidate.severity,
    status:                'open',
    title:                 candidate.title,
    summary:               candidate.summary,
    rootCauseHypothesis:   candidate.rootCauseHypothesis,
    affectedSystems:       candidate.affectedSystems as Record<string, unknown>,
    linkedEventIds:        candidate.linkedEventIds,
    signalCount:           candidate.signalCount,
    recommendedAction:     triage.recommendedAction,
    assignedAgent:         triage.assignedAgent,
    repairTaskId:          null,
    requiresApproval:      triage.requiresApproval,
    detectedAt:            candidate.detectedAt,
    createdAt:             now,
    updatedAt:             now,
  })

  await appendTimeline(id, workspaceId, 'opened', 'detector',
    `Incident created from ${candidate.signalCount} real signals`,
    { type: candidate.type, severity: candidate.severity },
  )
  await appendTimeline(id, workspaceId, 'triage_completed', 'auto-triage',
    triage.rationale,
    { ...triage },
  )

  await emitRuntimeEvent(workspaceId, 'incident.opened', {
    incidentId: id, type: candidate.type, severity: candidate.severity,
    signalCount: candidate.signalCount, requiresApproval: triage.requiresApproval,
  })
  await emitRuntimeEvent(workspaceId, 'incident.triage_completed', {
    incidentId: id, agent: triage.assignedAgent, canAutoRepair: triage.canAutoRepair,
  })

  return { id, isNew: true, signalCount: candidate.signalCount }
}

// ─── Public entrypoints ───────────────────────────────────────────────────────

export async function scanAndOpenIncidents(workspaceId: string): Promise<{
  scanned: number; opened: number; updated: number; incidentIds: string[]
}> {
  const candidates = await detectAllIncidents(workspaceId)
  let opened = 0, updated = 0
  const ids: string[] = []

  for (const c of candidates) {
    const result = await createOrUpdateIncident(workspaceId, c)
    ids.push(result.id)
    if (result.isNew) opened += 1
    else updated += 1
  }

  return { scanned: candidates.length, opened, updated, incidentIds: ids }
}

export async function listIncidents(
  workspaceId: string, status?: string, limit = 50,
) {
  if (status) {
    return db.select().from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), eq(incidents.status, status)))
      .orderBy(desc(incidents.detectedAt))
      .limit(limit)
  }
  return db.select().from(incidents)
    .where(eq(incidents.workspaceId, workspaceId))
    .orderBy(desc(incidents.detectedAt))
    .limit(limit)
}

export async function getIncident(id: string) {
  const rows = await db.select().from(incidents).where(eq(incidents.id, id)).limit(1)
  return rows[0] ?? null
}

export async function getIncidentTimeline(incidentId: string) {
  return db.select().from(incidentTimeline)
    .where(eq(incidentTimeline.incidentId, incidentId))
    .orderBy(desc(incidentTimeline.createdAt))
    .limit(100)
}

export async function acknowledgeIncident(id: string, actor: string, note?: string) {
  const inc = await getIncident(id)
  if (!inc) return null
  if (inc.status !== 'open') return inc
  const now = Date.now()
  await db.update(incidents).set({
    status: 'acknowledged',
    acknowledgedBy: actor,
    acknowledgedAt: now,
    updatedAt: now,
  }).where(eq(incidents.id, id))
  await appendTimeline(id, inc.workspaceId, 'acknowledged', actor, note)
  await emitRuntimeEvent(inc.workspaceId, 'incident.acknowledged', { incidentId: id, actor })
  return { ...inc, status: 'acknowledged' as IncidentStatus, acknowledgedBy: actor, acknowledgedAt: now }
}

export async function resolveIncident(id: string, actor: string, note: string) {
  const inc = await getIncident(id)
  if (!inc) return null
  const now = Date.now()
  await db.update(incidents).set({
    status: 'resolved',
    resolvedBy: actor,
    resolvedAt: now,
    resolutionNote: note,
    updatedAt: now,
  }).where(eq(incidents.id, id))
  await appendTimeline(id, inc.workspaceId, 'resolved', actor, note)
  await emitRuntimeEvent(inc.workspaceId, 'incident.resolved', { incidentId: id, actor })
  return { ...inc, status: 'resolved' as IncidentStatus, resolvedBy: actor, resolvedAt: now }
}

export async function escalateIncident(id: string, actor: string, reason: string) {
  const inc = await getIncident(id)
  if (!inc) return null
  const now = Date.now()
  await db.update(incidents).set({
    status: 'escalated',
    escalatedAt: now,
    escalationReason: reason,
    severity: inc.severity === 'critical' ? 'emergency' : inc.severity,
    updatedAt: now,
  }).where(eq(incidents.id, id))
  await appendTimeline(id, inc.workspaceId, 'escalated', actor, reason)
  await emitRuntimeEvent(inc.workspaceId, 'incident.escalated', { incidentId: id, actor, reason })
  return { ...inc, status: 'escalated' as IncidentStatus, escalatedAt: now }
}

/**
 * Create a repair task linked to this incident.
 * Refuses if incident requires approval and approval has not been granted.
 */
export async function createRepairTaskForIncident(
  id: string, actor: string, taskRef: string, approvalGranted: boolean,
): Promise<{ ok: true; incidentId: string } | { ok: false; reason: string }> {
  const inc = await getIncident(id)
  if (!inc) return { ok: false, reason: 'Incident not found' }
  if (inc.requiresApproval && !approvalGranted) {
    return { ok: false, reason: 'Incident requires approval before repair task can be created' }
  }

  const now = Date.now()
  await db.update(incidents).set({
    status: 'mitigating',
    repairTaskId: taskRef,
    updatedAt: now,
  }).where(eq(incidents.id, id))

  await appendTimeline(id, inc.workspaceId, 'repair_task_created', actor,
    `Repair task ${taskRef} created`,
    { taskRef, approvalGranted },
  )
  await emitRuntimeEvent(inc.workspaceId, 'incident.repair_task_created', {
    incidentId: id, taskRef, actor, approvalGranted,
  })

  return { ok: true, incidentId: id }
}
