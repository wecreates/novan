/**
 * issues.ts — the unified engineering issue ledger.
 *
 * One issue per discrete engineering problem. Threads symptom →
 * diagnosis → fix → verification through a single durable row.
 *
 * Lifecycle:
 *   open      — symptom captured; no diagnosis yet
 *   triaged   — severity + affected systems set; not yet root-caused
 *   diagnosed — rootCause + proposedFix + verificationPlan filled
 *   patched   — linked to a code_patches row; pending verification
 *   verified  — fix confirmed (tests passed / smoke OK / operator OK)
 *   closed    — terminal good state (verified + audit complete)
 *   rejected  — terminal bad state (won't fix; reason in rootCause)
 *
 * Dedup: callers compute a stable fingerprint per signal source. If an
 * open or triaged issue with the same fingerprint already exists, we
 * append evidence to it rather than create a duplicate.
 */
import { v7 as uuidv7 } from 'uuid'
import { createHash } from 'node:crypto'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { issues, events, incidents } from '../db/schema.js'

// ── Types ─────────────────────────────────────────────────────────────

export type IssueStatus =
  | 'open' | 'triaged' | 'diagnosed' | 'patched' | 'verified' | 'closed' | 'rejected'

export type IssueSeverity = 'info' | 'warning' | 'critical' | 'emergency'

export type IssueSource =
  | 'operator'
  | 'cron-incident'
  | 'smoke-regression'
  | 'security-scan'
  | 'cron-failure'
  | 'autonomous-mind'

export interface EvidenceItem {
  type:    'event' | 'incident' | 'file' | 'log' | 'screenshot' | 'note'
  ref:     string                 // event id, file path, etc.
  summary: string
  at:      number
}

export interface CreateIssueInput {
  workspaceId:       string
  symptom:           string
  source:            IssueSource
  severity?:         IssueSeverity
  affectedSystems?:  string[]
  rootCause?:        string
  evidence?:         EvidenceItem[]
  proposedFix?:      string
  verificationPlan?: string
  rollbackPlan?:     string
  riskLevel?:        'low' | 'medium' | 'high' | 'critical'
  sourceIncidentId?: string
  sourceEventId?:    string
  fingerprint?:      string       // if omitted, computed from symptom + source
  createdBy?:        string
}

// ── Helpers ───────────────────────────────────────────────────────────

function defaultFingerprint(symptom: string, source: string, systems: string[]): string {
  const key = `${source}::${systems.sort().join(',')}::${symptom.slice(0, 200)}`
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: (payload['issueId'] as string) ?? uuidv7(),
    causationId: null, source: 'api/issues', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

// ── Core API ──────────────────────────────────────────────────────────

/**
 * Create an issue OR append evidence to an existing open one matching
 * the fingerprint. Returns the resulting issue.
 */
export async function createOrAppendIssue(input: CreateIssueInput) {
  const now = Date.now()
  const fingerprint = input.fingerprint ??
    defaultFingerprint(input.symptom, input.source, input.affectedSystems ?? [])

  // Look for an existing open/triaged issue with the same fingerprint
  const existing = await db.select().from(issues)
    .where(and(
      eq(issues.workspaceId, input.workspaceId),
      eq(issues.fingerprint, fingerprint),
      inArray(issues.status, ['open', 'triaged', 'diagnosed', 'patched']),
    ))
    .orderBy(desc(issues.detectedAt))
    .limit(1)
    .then(r => r[0])
    .catch(() => undefined)

  if (existing) {
    // Append evidence (cap at 100 items to avoid unbounded growth)
    const newEvidence = [
      ...((existing.evidence as EvidenceItem[]) ?? []),
      ...(input.evidence ?? []),
    ].slice(-100)
    const updated = await db.update(issues)
      .set({ evidence: newEvidence, updatedAt: now })
      .where(eq(issues.id, existing.id))
      .returning()
      .then(r => r[0])
      .catch(() => existing)
    await emit(input.workspaceId, 'issue.evidence_appended', {
      issueId: existing.id, fingerprint, count: (input.evidence ?? []).length,
    })
    return { issue: updated ?? existing, deduped: true }
  }

  const row = {
    id:               uuidv7(),
    workspaceId:      input.workspaceId,
    symptom:          input.symptom,
    source:           input.source,
    severity:         input.severity ?? 'warning',
    affectedSystems:  input.affectedSystems ?? [],
    rootCause:        input.rootCause ?? null,
    evidence:         input.evidence ?? [],
    proposedFix:      input.proposedFix ?? null,
    verificationPlan: input.verificationPlan ?? null,
    rollbackPlan:     input.rollbackPlan ?? null,
    riskLevel:        input.riskLevel ?? null,
    status:           input.rootCause ? 'diagnosed' as const : 'open' as const,
    fingerprint,
    sourceIncidentId: input.sourceIncidentId ?? null,
    sourceEventId:    input.sourceEventId ?? null,
    proposalId:       null,
    patchId:          null,
    commitSha:        null,
    createdBy:        input.createdBy ?? 'system',
    diagnosedBy:      input.rootCause ? (input.createdBy ?? 'system') : null,
    closedBy:         null,
    detectedAt:       now,
    diagnosedAt:      input.rootCause ? now : null,
    closedAt:         null,
    createdAt:        now,
    updatedAt:        now,
  }
  const inserted = await db.insert(issues).values(row).returning().then(r => r[0]).catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[issues] insert failed:', (e as Error).message)
    return undefined
  })
  if (!inserted) throw new Error('failed to create issue')

  await emit(input.workspaceId, 'issue.created', {
    issueId: inserted.id, fingerprint, severity: inserted.severity,
    source: inserted.source, symptom: inserted.symptom.slice(0, 200),
  })
  return { issue: inserted, deduped: false }
}

/** Update diagnosis fields and transition open → diagnosed. */
export async function diagnoseIssue(
  workspaceId: string, issueId: string,
  diag: {
    rootCause: string
    proposedFix?: string
    verificationPlan?: string
    rollbackPlan?: string
    riskLevel?: 'low' | 'medium' | 'high' | 'critical'
    affectedSystems?: string[]
    diagnosedBy?: string
  },
) {
  const now = Date.now()
  const row = await db.update(issues)
    .set({
      rootCause:        diag.rootCause,
      proposedFix:      diag.proposedFix ?? null,
      verificationPlan: diag.verificationPlan ?? null,
      rollbackPlan:     diag.rollbackPlan ?? null,
      riskLevel:        diag.riskLevel ?? null,
      affectedSystems:  diag.affectedSystems ?? sql`${issues.affectedSystems}`,
      status:           'diagnosed',
      diagnosedBy:      diag.diagnosedBy ?? 'system',
      diagnosedAt:      now,
      updatedAt:        now,
    })
    .where(and(eq(issues.id, issueId), eq(issues.workspaceId, workspaceId)))
    .returning().then(r => r[0]).catch(() => undefined)
  if (!row) return null
  await emit(workspaceId, 'issue.diagnosed', { issueId, riskLevel: diag.riskLevel })
  return row
}

/** Link a code_proposals row to this issue. */
export async function linkProposal(workspaceId: string, issueId: string, proposalId: string) {
  const now = Date.now()
  const row = await db.update(issues)
    .set({ proposalId, updatedAt: now })
    .where(and(eq(issues.id, issueId), eq(issues.workspaceId, workspaceId)))
    .returning().then(r => r[0]).catch(() => undefined)
  if (!row) return null
  await emit(workspaceId, 'issue.proposal_linked', { issueId, proposalId })
  return row
}

/** Link a code_patches row + transition diagnosed → patched. */
export async function linkPatch(workspaceId: string, issueId: string, patchId: string) {
  const now = Date.now()
  const row = await db.update(issues)
    .set({ patchId, status: 'patched', updatedAt: now })
    .where(and(eq(issues.id, issueId), eq(issues.workspaceId, workspaceId)))
    .returning().then(r => r[0]).catch(() => undefined)
  if (!row) return null
  await emit(workspaceId, 'issue.patched', { issueId, patchId })
  return row
}

/** Mark verified — fix confirmed via tests / smoke / operator. */
export async function verifyIssue(
  workspaceId: string, issueId: string,
  evidence: EvidenceItem[], commitSha?: string,
) {
  const now = Date.now()
  const existing = await db.select().from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.workspaceId, workspaceId)))
    .limit(1).then(r => r[0]).catch(() => undefined)
  if (!existing) return null
  const merged = [...((existing.evidence as EvidenceItem[]) ?? []), ...evidence].slice(-100)

  const row = await db.update(issues)
    .set({
      status:    'verified',
      evidence:  merged,
      commitSha: commitSha ?? existing.commitSha,
      updatedAt: now,
    })
    .where(eq(issues.id, issueId))
    .returning().then(r => r[0]).catch(() => undefined)
  if (!row) return null
  await emit(workspaceId, 'issue.verified', { issueId, commitSha, evidenceCount: evidence.length })
  return row
}

/** Terminal close. Requires status = 'verified' OR explicit `force`. */
export async function closeIssue(
  workspaceId: string, issueId: string,
  closedBy: string, opts: { force?: boolean } = {},
) {
  const existing = await db.select().from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.workspaceId, workspaceId)))
    .limit(1).then(r => r[0]).catch(() => undefined)
  if (!existing) return null
  if (existing.status !== 'verified' && !opts.force) {
    throw new Error(`cannot close issue ${issueId}: status is '${existing.status}', not 'verified' (pass force to override)`)
  }
  const now = Date.now()
  const row = await db.update(issues)
    .set({ status: 'closed', closedBy, closedAt: now, updatedAt: now })
    .where(eq(issues.id, issueId))
    .returning().then(r => r[0]).catch(() => undefined)
  if (!row) return null
  await emit(workspaceId, 'issue.closed', { issueId, closedBy, force: !!opts.force })
  return row
}

/** Reject — terminal bad state ("won't fix"). */
export async function rejectIssue(workspaceId: string, issueId: string, reason: string, by: string) {
  const now = Date.now()
  const row = await db.update(issues)
    .set({
      status: 'rejected',
      rootCause: reason,
      closedBy: by, closedAt: now, updatedAt: now,
    })
    .where(and(eq(issues.id, issueId), eq(issues.workspaceId, workspaceId)))
    .returning().then(r => r[0]).catch(() => undefined)
  if (!row) return null
  await emit(workspaceId, 'issue.rejected', { issueId, reason })
  return row
}

// ── Queries ───────────────────────────────────────────────────────────

export async function getIssue(workspaceId: string, id: string) {
  return db.select().from(issues)
    .where(and(eq(issues.id, id), eq(issues.workspaceId, workspaceId)))
    .limit(1).then(r => r[0] ?? null).catch(() => null)
}

export async function listIssues(
  workspaceId: string,
  opts: { status?: IssueStatus; severity?: IssueSeverity; source?: IssueSource; limit?: number } = {},
) {
  const conds = [eq(issues.workspaceId, workspaceId)]
  if (opts.status)   conds.push(eq(issues.status,   opts.status))
  if (opts.severity) conds.push(eq(issues.severity, opts.severity))
  if (opts.source)   conds.push(eq(issues.source,   opts.source))
  return db.select().from(issues)
    .where(and(...conds))
    .orderBy(desc(issues.detectedAt))
    .limit(Math.min(opts.limit ?? 50, 200))
    .catch(() => [])
}

export async function issueStats(workspaceId: string) {
  const rows = await db.select({
    status:   issues.status,
    severity: issues.severity,
    count:    sql<number>`COUNT(*)`,
  })
    .from(issues)
    .where(eq(issues.workspaceId, workspaceId))
    .groupBy(issues.status, issues.severity)
    .catch(() => [])
  return rows.map(r => ({ status: r.status, severity: r.severity, count: Number(r.count) }))
}

// ── Auto-ingest from existing signal sources ──────────────────────────

/**
 * Scan recent runtime signals and create/append issues. Designed to run
 * on a cron schedule (~5 min). Idempotent via fingerprint dedup.
 *
 * Sources:
 *   - incidents created in the last hour without a linked issue
 *   - cron.error events in the last hour
 *   - platform-smoke regressions in the last sweep
 *
 * Returns counts so the caller can log/emit.
 */
export async function autoIngestSignals(workspaceId: string) {
  const since = Date.now() - 60 * 60_000  // last hour
  let created = 0
  let appended = 0

  // 1. Incidents → issues (one per incident, fingerprinted by type+id)
  const newIncidents = await db.select().from(incidents)
    .where(and(
      eq(incidents.workspaceId, workspaceId),
      sql`${incidents.detectedAt} > ${since}`,
    ))
    .limit(50)
    .catch(() => [])

  for (const inc of newIncidents) {
    const r = await createOrAppendIssue({
      workspaceId,
      source:           'cron-incident',
      severity:         inc.severity as IssueSeverity,
      symptom:          inc.title,
      ...(inc.rootCauseHypothesis ? { rootCause: inc.rootCauseHypothesis } : {}),
      affectedSystems:  Object.keys(inc.affectedSystems as Record<string, unknown> ?? {}),
      evidence:         [{ type: 'incident', ref: inc.id, summary: inc.summary, at: inc.detectedAt }],
      sourceIncidentId: inc.id,
      fingerprint:      `incident:${inc.type}:${inc.id}`,
    }).catch(() => null)
    if (r?.deduped) appended++
    else if (r)     created++
  }

  // 2. cron.error events → issues (fingerprinted by task+truncated error)
  const cronErrors = await db.select().from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      eq(events.type, 'cron.error'),
      sql`${events.createdAt} > ${since}`,
    ))
    .limit(100)
    .catch(() => [])

  for (const e of cronErrors) {
    const p = (e.payload as { task?: string; error?: string } | null) ?? {}
    const task = p.task ?? 'unknown'
    const err  = (p.error ?? '').slice(0, 200)
    const r = await createOrAppendIssue({
      workspaceId,
      source:          'cron-failure',
      severity:        'warning',
      symptom:         `Cron task '${task}' failed: ${err.slice(0, 80)}`,
      affectedSystems: [task],
      evidence:        [{ type: 'event', ref: e.id, summary: err, at: e.createdAt }],
      sourceEventId:   e.id,
      fingerprint:     `cron-error:${task}:${createHash('sha256').update(err).digest('hex').slice(0, 8)}`,
    }).catch(() => null)
    if (r?.deduped) appended++
    else if (r)     created++
  }

  return { created, appended, scanned: newIncidents.length + cronErrors.length }
}
