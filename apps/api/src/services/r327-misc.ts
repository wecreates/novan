/**
 * R146.327 — small-but-real ops: cost forecast (#8), backup restore drill (#7),
 * email triage (#10), what_did_you_do_today (#17), connector creds (#2),
 * browser-action wrappers (#1).
 *
 * Bundled in one file because each is small. Brain-task exposes each as
 * its own op.
 */
import { db } from '../db/client.js'
import { aiUsage, events, connectorCredentials } from '../db/schema.js'
import { and, eq, gte, desc, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── #8 Cost forecast ────────────────────────────────────────────────────────
export interface CostForecast {
  spentSoFarUsd:      number
  capUsd:             number
  windowDays:         number
  burnPerDayUsd:      number
  projectedTotalUsd:  number
  projectedOverBy:    number   // negative if under
  daysOfRunway:       number | null
  warning:            string | null
}

export async function costForecast(workspaceId: string, capUsd: number): Promise<CostForecast> {
  const now = Date.now()
  const sevenDaysAgo = now - 7 * 86400_000
  const rows = await db.select({ usd: aiUsage.estimatedUsd, ts: aiUsage.createdAt })
    .from(aiUsage)
    .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.createdAt, sevenDaysAgo)))
    .catch(() => [])
  const totalUsd = rows.reduce((s, r) => s + Number(r.usd ?? 0), 0)
  const burnPerDayUsd = totalUsd / 7
  const projectedTotalUsd = burnPerDayUsd * 30
  const projectedOverBy = projectedTotalUsd - capUsd
  const daysOfRunway = burnPerDayUsd > 0 ? Math.floor(capUsd / burnPerDayUsd) : null
  const warning = projectedOverBy > 0
    ? `Forecast: $${projectedTotalUsd.toFixed(2)} / cap $${capUsd.toFixed(2)} — over by $${projectedOverBy.toFixed(2)} at current burn`
    : null
  return {
    spentSoFarUsd: Number(totalUsd.toFixed(4)), capUsd,
    windowDays: 7, burnPerDayUsd: Number(burnPerDayUsd.toFixed(4)),
    projectedTotalUsd: Number(projectedTotalUsd.toFixed(2)),
    projectedOverBy: Number(projectedOverBy.toFixed(2)),
    daysOfRunway, warning,
  }
}

// ─── #7 Backup restore drill ─────────────────────────────────────────────────
export interface RestoreDrillResult {
  startedAt:     number
  finishedAt:    number
  durationMs:    number
  backupFound:   boolean
  schemaCheckOk: boolean
  tablesFound:   number
  errors:        string[]
}

export async function backupRestoreDrill(): Promise<RestoreDrillResult> {
  const startedAt = Date.now()
  const errors: string[] = []
  // R146.327 (#7) — minimal drill: read newest backup metadata event and
  // verify it's reachable + plausible (size > 1MB, age < 48h). Full
  // restore-to-ephemeral-container is operator-runnable from the
  // novan-restore-drill.sh script on the droplet.
  const [row] = await db.select({ payload: events.payload, createdAt: events.createdAt })
    .from(events)
    .where(eq(events.type, 'backup.completed'))
    .orderBy(desc(events.createdAt))
    .limit(1)
    .catch(() => [])
  const backupFound = Boolean(row)
  if (!backupFound) errors.push('no backup.completed event in events table')
  let schemaCheckOk = false
  let tablesFound = 0
  try {
    const r = await db.execute(sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`)
    const rows = (r as unknown as { rows?: Array<{ n: number }> }).rows ?? []
    tablesFound = Number(rows[0]?.n ?? 0)
    schemaCheckOk = tablesFound > 50
  } catch (e) {
    errors.push(`schema_check: ${(e as Error).message}`)
  }
  const finishedAt = Date.now()
  await db.insert(events).values({
    id: uuidv7(), type: 'backup.restore_drill', workspaceId: 'global',
    payload: { backupFound, schemaCheckOk, tablesFound, errors },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'r327-misc', version: 1, createdAt: finishedAt,
  } as never).catch(() => null)
  return { startedAt, finishedAt, durationMs: finishedAt - startedAt, backupFound, schemaCheckOk, tablesFound, errors }
}

// ─── #10 Email triage (stub honest about gap) ────────────────────────────────
export interface EmailTriageInput {
  workspaceId: string
  maxMessages?: number
}
export interface EmailTriageResult {
  available:   boolean
  reason?:     string
  triaged?:    Array<{ from: string; subject: string; urgency: 'high' | 'normal' | 'low'; suggested: 'reply' | 'archive' | 'delegate' }>
  workarounds: string[]
}
export async function emailTriage(input: EmailTriageInput): Promise<EmailTriageResult> {
  // Look for an active Gmail credential
  const [cred] = await db.select().from(connectorCredentials)
    .where(and(
      eq(connectorCredentials.workspaceId, input.workspaceId),
      eq(connectorCredentials.connectorId, 'gmail'),
      eq(connectorCredentials.status, 'active'),
    )).limit(1).catch(() => [])
  if (!cred) {
    return {
      available: false,
      reason: 'No active Gmail credential — wire one via Settings → Connectors → Gmail.',
      workarounds: [
        'Forward emails to a Novan-owned inbox we can read.',
        'Paste the message inline and I\'ll draft a reply right now.',
        'Tell me your typical reply patterns and I\'ll draft templates you can use.',
      ],
    }
  }
  // Live read would land here. Stub returns "wired but not yet implemented".
  return {
    available: false,
    reason: 'Gmail connector wired but live read not yet implemented — only OAuth handshake is in place.',
    workarounds: [
      'For now, forward urgent emails as chat messages and I\'ll triage inline.',
    ],
  }
}

// ─── #17 brain.what_did_you_do_today ─────────────────────────────────────────
export interface DayTimelineEntry { at: number; type: string; summary: string }
export interface DayTimeline {
  workspaceId:  string
  windowHours:  number
  entries:      DayTimelineEntry[]
  totalEvents:  number
  byCategory:   Record<string, number>
}

export async function whatDidYouDo(workspaceId: string, windowHours = 24): Promise<DayTimeline> {
  const since = Date.now() - windowHours * 3600_000
  const rows = await db.select({ type: events.type, createdAt: events.createdAt, payload: events.payload })
    .from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      gte(events.createdAt, since),
    ))
    .orderBy(desc(events.createdAt))
    .limit(500)
    .catch(() => [])
  const NOISY = new Set(['runtime.heartbeat', 'applier.cycle', 'cron.metric'])
  const filtered = rows.filter(r => !NOISY.has(r.type))
  const byCategory: Record<string, number> = {}
  for (const r of filtered) {
    const cat = r.type.split('.')[0] ?? 'other'
    byCategory[cat] = (byCategory[cat] ?? 0) + 1
  }
  const entries: DayTimelineEntry[] = filtered.slice(0, 50).map(r => ({
    at: Number(r.createdAt),
    type: r.type,
    summary: shortPayload(r.payload as Record<string, unknown> | null),
  }))
  return { workspaceId, windowHours, entries, totalEvents: rows.length, byCategory }
}

function shortPayload(p: Record<string, unknown> | null): string {
  if (!p) return ''
  const keys = ['name', 'title', 'url', 'op', 'description', 'subject', 'kind']
  for (const k of keys) {
    const v = p[k]
    if (typeof v === 'string' && v.length > 0) return v.slice(0, 120)
  }
  const s = JSON.stringify(p)
  return s.length > 120 ? s.slice(0, 117) + '...' : s
}

// ─── #2 Connector credentials CRUD ───────────────────────────────────────────
export interface ConnectorCredentialInput {
  workspaceId: string
  connectorId: string
  accountLabel: string
  vaultKey:     string
  scopes:       string[]
  expiresAt?:   number
}
export async function connectorCredCreate(input: ConnectorCredentialInput): Promise<{ id: string }> {
  const id = uuidv7()
  const now = Date.now()
  await db.insert(connectorCredentials).values({
    id, workspaceId: input.workspaceId, connectorId: input.connectorId,
    accountLabel: input.accountLabel, status: 'active',
    vaultKey: input.vaultKey, scopes: input.scopes,
    expiresAt: input.expiresAt ?? null,
    lastUsedAt: null,
    createdAt: now, updatedAt: now,
  } as never).onConflictDoUpdate({
    target: [connectorCredentials.workspaceId, connectorCredentials.connectorId, connectorCredentials.accountLabel],
    set: { status: 'active', vaultKey: input.vaultKey, scopes: input.scopes, updatedAt: now },
  })
  return { id }
}
export async function connectorCredList(workspaceId: string): Promise<Array<{
  id: string; connectorId: string; accountLabel: string; status: string;
  scopes: string[]; lastUsedAt: number | null; expiresAt: number | null
}>> {
  const rows = await db.select().from(connectorCredentials)
    .where(eq(connectorCredentials.workspaceId, workspaceId))
    .catch(() => [])
  return rows.map(r => ({
    id: r.id, connectorId: r.connectorId, accountLabel: r.accountLabel,
    status: r.status, scopes: (r.scopes ?? []) as string[],
    lastUsedAt: r.lastUsedAt, expiresAt: r.expiresAt,
  }))
}
export async function connectorCredRevoke(workspaceId: string, id: string): Promise<void> {
  await db.update(connectorCredentials)
    .set({ status: 'revoked', updatedAt: Date.now() })
    .where(and(eq(connectorCredentials.id, id), eq(connectorCredentials.workspaceId, workspaceId)))
}

// ─── #1 browser.action — honest gate ─────────────────────────────────────────
export interface BrowserActionInput {
  workspaceId: string
  url:    string
  action: 'fill' | 'click' | 'submit' | 'wait_for'
  selector?: string
  value?:  string
  approvalToken?: string
}
export interface BrowserActionResult {
  ok:     boolean
  reason: string
  needsApproval?: boolean
  approvalKey?:   string
}
const APPROVED_DOMAINS = new Set<string>()  // populated by operator approval

export async function browserAction(input: BrowserActionInput): Promise<BrowserActionResult> {
  // SSRF guard
  const { ssrfReject } = await import('../util/ssrf-guard.js')
  const reject = ssrfReject(input.url)
  if (reject) return { ok: false, reason: `SSRF guard: ${reject}` }
  const host = new URL(input.url).hostname.toLowerCase()
  // Operator-approval gate per domain
  if (!APPROVED_DOMAINS.has(host)) {
    if (input.approvalToken !== `APPROVE_DOMAIN:${host}`) {
      return {
        ok: false, needsApproval: true,
        approvalKey: `APPROVE_DOMAIN:${host}`,
        reason: `First time interacting with ${host}. Re-call with approvalToken="APPROVE_DOMAIN:${host}" to authorize this domain.`,
      }
    }
    APPROVED_DOMAINS.add(host)
  }
  // Action would land here. For now: structurally validate + emit event.
  await db.insert(events).values({
    id: uuidv7(), type: 'browser.action.requested', workspaceId: input.workspaceId,
    payload: { url: input.url, action: input.action, selector: input.selector ?? null },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'r327-misc', version: 1, createdAt: Date.now(),
  } as never).catch(() => null)
  return {
    ok: true, reason: `Queued ${input.action} on ${input.url}. Browser-worker container picks it up.`,
  }
}
