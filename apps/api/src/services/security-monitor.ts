/**
 * security-monitor.ts — Security audit log queries + abuse detection + export.
 *
 * All writes append-only. Reads filter by workspace/user/event/severity.
 * Compliance export generates a download ref, never a raw URL.
 */
import { db }              from '../db/client.js'
import { securityAudits, auditExports, events } from '../db/schema.js'
import { eq, and, desc, gt, inArray } from 'drizzle-orm'
import { v7 as uuidv7 }    from 'uuid'

async function emitEvent(workspaceId: string | null, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId: workspaceId ?? 'global', payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'security-monitor', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

// ─── Recording ────────────────────────────────────────────────────────────────

export async function recordSecurityEvent(input: {
  workspaceId?: string | null
  userId?:      string | null
  eventType:    string
  severity:     'info' | 'warning' | 'critical'
  resource?:    string
  action?:      string
  outcome:      'allowed' | 'denied' | 'recorded'
  context?:     Record<string, unknown>
  ipAddress?:   string
  userAgent?:   string
}): Promise<string> {
  const id = uuidv7()
  await db.insert(securityAudits).values({
    id,
    workspaceId: input.workspaceId ?? null,
    userId:      input.userId ?? null,
    eventType:   input.eventType,
    severity:    input.severity,
    resource:    input.resource ?? null,
    action:      input.action ?? null,
    outcome:     input.outcome,
    context:     input.context ?? {},
    ipAddress:   input.ipAddress ?? null,
    userAgent:   input.userAgent ?? null,
    immutable:   true,
    createdAt:   Date.now(),
  })

  if (input.severity === 'critical' || input.outcome === 'denied') {
    await emitEvent(input.workspaceId ?? null, `security.${input.eventType}`, {
      severity: input.severity, outcome: input.outcome, resource: input.resource,
    })
  }
  return id
}

// ─── Abuse detection ──────────────────────────────────────────────────────────

/**
 * Detect suspicious patterns within recent window. Each detection records a new
 * security audit row with severity=critical to make abuse visible.
 */
export async function detectSuspiciousActivity(workspaceId: string): Promise<{
  authFailureSpike: number
  permissionDenialSpike: number
  secretAbuseSpike: number
}> {
  const since = Date.now() - 60 * 60_000  // 1h window
  const rows = await db.select({
    eventType: securityAudits.eventType,
    outcome: securityAudits.outcome,
    userId: securityAudits.userId,
  }).from(securityAudits)
    .where(and(
      eq(securityAudits.workspaceId, workspaceId),
      gt(securityAudits.createdAt, since),
    )).limit(1000)

  const authFailures      = rows.filter((r) => r.eventType === 'auth_failure' && r.outcome === 'denied').length
  const permissionDenials = rows.filter((r) => r.eventType === 'permission_denied' && r.outcome === 'denied').length
  const secretAccess      = rows.filter((r) => r.eventType === 'secret_accessed').length

  // Record suspicious activity events for spikes
  if (authFailures >= 5) {
    await recordSecurityEvent({
      workspaceId, eventType: 'suspicious_activity', severity: 'critical',
      action: 'auth_failure_spike', outcome: 'recorded',
      context: { count: authFailures, windowMs: 60 * 60_000 },
    })
  }
  if (permissionDenials >= 10) {
    await recordSecurityEvent({
      workspaceId, eventType: 'suspicious_activity', severity: 'critical',
      action: 'permission_denial_spike', outcome: 'recorded',
      context: { count: permissionDenials, windowMs: 60 * 60_000 },
    })
  }
  if (secretAccess >= 20) {
    await recordSecurityEvent({
      workspaceId, eventType: 'suspicious_activity', severity: 'warning',
      action: 'secret_access_spike', outcome: 'recorded',
      context: { count: secretAccess, windowMs: 60 * 60_000 },
    })
  }

  return {
    authFailureSpike:      authFailures,
    permissionDenialSpike: permissionDenials,
    secretAbuseSpike:      secretAccess,
  }
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function listSecurityEvents(
  workspaceId: string,
  opts: { severity?: string; eventType?: string; limit?: number } = {},
) {
  const conditions = [eq(securityAudits.workspaceId, workspaceId)]
  if (opts.severity)  conditions.push(eq(securityAudits.severity, opts.severity))
  if (opts.eventType) conditions.push(eq(securityAudits.eventType, opts.eventType))
  return db.select().from(securityAudits)
    .where(and(...conditions))
    .orderBy(desc(securityAudits.createdAt))
    .limit(opts.limit ?? 100)
}

export async function getSecurityStats(workspaceId: string) {
  const since = Date.now() - 7 * 24 * 3600_000
  const rows = await db.select({
    eventType: securityAudits.eventType,
    severity:  securityAudits.severity,
    outcome:   securityAudits.outcome,
  }).from(securityAudits)
    .where(and(
      eq(securityAudits.workspaceId, workspaceId),
      gt(securityAudits.createdAt, since),
    )).limit(2000)

  return {
    total7d:          rows.length,
    critical7d:       rows.filter((r) => r.severity === 'critical').length,
    deniedActions7d:  rows.filter((r) => r.outcome === 'denied').length,
    authFailures7d:   rows.filter((r) => r.eventType === 'auth_failure').length,
    permissionDenied7d: rows.filter((r) => r.eventType === 'permission_denied').length,
    secretAccess7d:   rows.filter((r) => r.eventType === 'secret_accessed').length,
    suspiciousEvents7d: rows.filter((r) => r.eventType === 'suspicious_activity').length,
    unsafePatchBlocked7d: rows.filter((r) => r.eventType === 'unsafe_patch_blocked').length,
  }
}

// ─── Audit export ─────────────────────────────────────────────────────────────

export async function requestAuditExport(input: {
  workspaceId: string
  requestedBy: string
  fromTs:      number
  toTs:        number
  format?:     'json' | 'csv'
}): Promise<string> {
  const id = uuidv7()
  const now = Date.now()

  await db.insert(auditExports).values({
    id,
    workspaceId: input.workspaceId,
    requestedBy: input.requestedBy,
    format:      input.format ?? 'json',
    fromTs:      input.fromTs,
    toTs:        input.toTs,
    recordCount: 0,
    status:      'pending',
    downloadRef: null,
    createdAt:   now,
    completedAt: null,
  })

  // Synchronously compute the export — for small windows, this is fine.
  // For large windows, this should be moved to a worker.
  try {
    const records = await db.select().from(securityAudits).where(and(
      eq(securityAudits.workspaceId, input.workspaceId),
      gt(securityAudits.createdAt, input.fromTs),
    )).limit(10_000)

    const filtered = records.filter((r) => r.createdAt <= input.toTs)

    await db.update(auditExports).set({
      status:      'complete',
      recordCount: filtered.length,
      downloadRef: `export:${id}`,  // opaque ref, never a real URL
      completedAt: Date.now(),
    }).where(eq(auditExports.id, id))

    await recordSecurityEvent({
      workspaceId: input.workspaceId, userId: input.requestedBy,
      eventType: 'audit_exported', severity: 'info',
      action: 'export', outcome: 'allowed',
      context: { exportId: id, recordCount: filtered.length, fromTs: input.fromTs, toTs: input.toTs },
    })
  } catch (e) {
    await db.update(auditExports).set({
      status: 'failed', completedAt: Date.now(),
    }).where(eq(auditExports.id, id))
    await recordSecurityEvent({
      workspaceId: input.workspaceId, userId: input.requestedBy,
      eventType: 'audit_exported', severity: 'warning',
      action: 'export', outcome: 'denied',
      context: { exportId: id, error: (e as Error).message },
    })
  }

  return id
}

export async function listAuditExports(workspaceId: string) {
  return db.select().from(auditExports)
    .where(eq(auditExports.workspaceId, workspaceId))
    .orderBy(desc(auditExports.createdAt)).limit(50)
}

// ─── Immutability guard ───────────────────────────────────────────────────────

/**
 * Compliance check — verify no audit rows have been mutated.
 * In Postgres, we don't enforce true immutability at DB level here, but the
 * service layer NEVER calls UPDATE/DELETE on securityAudits. This function
 * documents the invariant and checks the immutable flag.
 */
export async function verifyAuditIntegrity(workspaceId: string): Promise<{
  total: number; immutable: number; mutable: number
}> {
  const rows = await db.select({ immutable: securityAudits.immutable })
    .from(securityAudits)
    .where(eq(securityAudits.workspaceId, workspaceId)).limit(10_000)

  return {
    total:     rows.length,
    immutable: rows.filter((r) => r.immutable).length,
    mutable:   rows.filter((r) => !r.immutable).length,
  }
}

/** Surface a single helper for query convenience */
export { inArray }
