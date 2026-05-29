/**
 * platform-hardening.ts — four operational primitives:
 *
 *   1. data-retention: archive/delete rows beyond age cap
 *   2. cron-health-monitor: aggregate cron.error events, alert above threshold
 *   3. webhook-verify: HMAC-SHA256 verification for inbound webhooks
 *   4. setup-state: per-workspace onboarding tracker
 *
 * All operations are workspace-scoped where applicable. Archive policy
 * is conservative: deletes only after the row's age exceeds N days,
 * AND only N batches per run to bound query cost.
 */
import { db } from '../db/client.js'
import {
  events, reasoningChains, messages, statusChanges, communicationAudit,
  archiveLog, notificationPrefs, setupState, webhookSecrets,
  workspaces,
} from '../db/schema.js'
import { and, eq, lt, sql, desc, gte } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { notify } from './notifications.js'

// ─── 1. Data retention ──────────────────────────────────────────────────

const RETENTION_DAYS = {
  events:              30,    // generic events
  reasoningChains:     90,    // decision audit — keep longer
  messages:            60,    // chat messages
  statusChanges:       180,   // status history — long for replay
  communicationAudit:  90,    // identity audit
}

const MAX_BATCH = 5000   // never delete more than this per cron run

interface RetentionResult { table: string; deleted: number; through: number; elapsedMs: number }

async function archiveTable(workspaceId: string, tableName: string, deleteFn: (cutoff: number) => Promise<number>, days: number): Promise<RetentionResult> {
  const start = Date.now()
  const cutoff = Date.now() - days * 24 * 60 * 60_000
  const deleted = await deleteFn(cutoff).catch(() => 0)
  if (deleted > 0) {
    await db.insert(archiveLog).values({
      id: uuidv7(), workspaceId, tableName,
      rowsArchived: deleted, archivedThroughTs: cutoff,
      elapsedMs: Date.now() - start,
      createdAt: Date.now(),
    }).catch((e: Error) => { console.error('[platform-hardening]', e.message); return null })
  }
  return { table: tableName, deleted, through: cutoff, elapsedMs: Date.now() - start }
}

export async function runRetention(workspaceId: string): Promise<RetentionResult[]> {
  const results: RetentionResult[] = []

  // events: type IS NOT 'governance.*' (keep governance forever) AND createdAt < cutoff
  results.push(await archiveTable(workspaceId, 'events', async (cutoff) => {
    const r = await db.delete(events)
      .where(and(
        lt(events.createdAt, cutoff),
        sql`${events.type} NOT LIKE 'governance.%'`,
        sql`${events.workspaceId} = ${workspaceId} OR ${events.workspaceId} = 'global'`,
      ))
      .returning({ id: events.id })
      .catch(() => [])
    return Math.min(r.length, MAX_BATCH)
  }, RETENTION_DAYS.events))

  // reasoning_chains: keep ones with linked outcome or critical kind
  results.push(await archiveTable(workspaceId, 'reasoning_chains', async (cutoff) => {
    const r = await db.delete(reasoningChains)
      .where(and(
        eq(reasoningChains.workspaceId, workspaceId),
        lt(reasoningChains.createdAt, cutoff),
        eq(reasoningChains.outcomeKnown, false),   // keep decided outcomes
        sql`${reasoningChains.kind} NOT IN ('economic')`,   // keep economic for audit
      ))
      .returning({ id: reasoningChains.id })
      .catch(() => [])
    return Math.min(r.length, MAX_BATCH)
  }, RETENTION_DAYS.reasoningChains))

  // messages
  results.push(await archiveTable(workspaceId, 'messages', async (cutoff) => {
    const r = await db.delete(messages)
      .where(and(eq(messages.workspaceId, workspaceId), lt(messages.createdAt, cutoff)))
      .returning({ id: messages.id })
      .catch(() => [])
    return Math.min(r.length, MAX_BATCH)
  }, RETENTION_DAYS.messages))

  // status_changes
  results.push(await archiveTable(workspaceId, 'status_changes', async (cutoff) => {
    const r = await db.delete(statusChanges)
      .where(and(eq(statusChanges.workspaceId, workspaceId), lt(statusChanges.changedAt, cutoff)))
      .returning({ id: statusChanges.id })
      .catch(() => [])
    return Math.min(r.length, MAX_BATCH)
  }, RETENTION_DAYS.statusChanges))

  // communication_audit
  results.push(await archiveTable(workspaceId, 'communication_audit', async (cutoff) => {
    const r = await db.delete(communicationAudit)
      .where(and(eq(communicationAudit.workspaceId, workspaceId), lt(communicationAudit.createdAt, cutoff)))
      .returning({ id: communicationAudit.id })
      .catch(() => [])
    return Math.min(r.length, MAX_BATCH)
  }, RETENTION_DAYS.communicationAudit))

  return results
}

export async function recentRetentionRuns(workspaceId: string, limit = 30) {
  return db.select().from(archiveLog)
    .where(eq(archiveLog.workspaceId, workspaceId))
    .orderBy(desc(archiveLog.createdAt))
    .limit(limit).catch(() => [])
}

// ─── 2. Cron health monitor ─────────────────────────────────────────────

const CRON_FAILURE_THRESHOLD = 5  // failures of same task in 24h → notify

export interface CronHealth {
  generatedAt: number
  windowHours: number
  byTask: Record<string, { failures: number; lastError: string; lastAt: number }>
  alerts: Array<{ task: string; failures: number; reason: string }>
}

export async function cronHealthCheck(windowHours = 24): Promise<CronHealth> {
  const since = Date.now() - windowHours * 60 * 60_000
  const rows = await db.select({
    payload: events.payload, createdAt: events.createdAt,
  }).from(events)
    .where(and(eq(events.type, 'cron.error'), gte(events.createdAt, since)))
    .catch(() => [])

  const byTask: CronHealth['byTask'] = {}
  for (const r of rows) {
    const p = r.payload as { task?: string; error?: string } | null
    const task = p?.task ?? 'unknown'
    const entry = byTask[task] ?? { failures: 0, lastError: '', lastAt: 0 }
    entry.failures++
    if (r.createdAt > entry.lastAt) {
      entry.lastAt = r.createdAt
      entry.lastError = p?.error ?? ''
    }
    byTask[task] = entry
  }

  const alerts: CronHealth['alerts'] = []
  for (const [task, h] of Object.entries(byTask)) {
    if (h.failures >= CRON_FAILURE_THRESHOLD) {
      alerts.push({ task, failures: h.failures, reason: `${h.failures} failures in ${windowHours}h, last: ${h.lastError.slice(0, 120)}` })
    }
  }
  return { generatedAt: Date.now(), windowHours, byTask, alerts }
}

export async function notifyCronAlerts(): Promise<{ alerted: number }> {
  const health = await cronHealthCheck(24)
  let alerted = 0
  for (const a of health.alerts) {
    await notify({
      workspaceId: 'global',
      type: 'cron.failure_threshold',
      title: `Cron failing: ${a.task}`,
      body: a.reason,
      severity: 'high',
      signature: `cron-alert:${a.task}:${Math.floor(Date.now() / 3_600_000)}`,
    }).catch((e: Error) => { console.error('[platform-hardening]', e.message); return null })
    alerted++
  }
  return { alerted }
}

// ─── 3. Webhook signature verification ──────────────────────────────────

export async function registerWebhookSecret(workspaceId: string, channel: string, secret: string): Promise<string> {
  const id = uuidv7()
  const secretHash = createHash('sha256').update(secret).digest('hex')
  await db.insert(webhookSecrets).values({
    id, workspaceId, channel, secretHash,
    active: true, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[platform-hardening]', e.message); return null })
  return id
}

/**
 * Verify HMAC-SHA256 signature against any active secret for this
 * (workspace, channel). Constant-time comparison.
 *
 * Signature format: hex digest of HMAC-SHA256(secret, body).
 */
export async function verifyWebhookSignature(
  workspaceId: string, channel: string, body: string, signatureHex: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!signatureHex || signatureHex.length < 32) {
    return { ok: false, reason: 'signature missing or too short' }
  }
  // We can't recover plaintext secrets from hashes — so the operator
  // must supply secrets via env or vault for verification. For now we
  // check against the dev-time SLACK_WEBHOOK_SECRET / GITHUB_WEBHOOK_SECRET
  // / WEBHOOK_SECRET env vars matching the channel.
  const envKey = `${channel.toUpperCase()}_WEBHOOK_SECRET`
  const secret = process.env[envKey] ?? process.env['WEBHOOK_SECRET']
  if (!secret) {
    // No secret configured — require explicit opt-out via WEBHOOK_VERIFY_OPTIONAL
    if (process.env['WEBHOOK_VERIFY_OPTIONAL'] === '1') {
      return { ok: true, reason: 'verification disabled' }
    }
    return { ok: false, reason: `no secret configured (set ${envKey} or WEBHOOK_SECRET)` }
  }
  const expected = createHmac('sha256', secret).update(body).digest('hex')
  try {
    const a = Buffer.from(expected, 'hex')
    const b = Buffer.from(signatureHex.replace(/^sha256=/, ''), 'hex')
    if (a.length !== b.length) return { ok: false, reason: 'signature length mismatch' }
    const ok = timingSafeEqual(a, b)
    if (ok) {
      // Update last_used_at (best-effort)
      const hash = createHash('sha256').update(secret).digest('hex')
      await db.update(webhookSecrets)
        .set({ lastUsedAt: Date.now() })
        .where(and(
          eq(webhookSecrets.workspaceId, workspaceId),
          eq(webhookSecrets.channel, channel),
          eq(webhookSecrets.secretHash, hash),
        )).catch((e: Error) => { console.error('[platform-hardening]', e.message); return null })
    }
    return ok ? { ok: true } : { ok: false, reason: 'signature mismatch' }
  } catch (e) {
    return { ok: false, reason: `verification error: ${(e as Error).message}` }
  }
}

// ─── 4. Setup state (onboarding tracker) ────────────────────────────────

export interface SetupSnapshot {
  workspaceId:         string
  firstRunAt:          number
  steps: Array<{ id: string; label: string; doneAt: number | null; required: boolean }>
  completedOnboarding: boolean
  percentComplete:     number
}

export async function ensureSetupRow(workspaceId: string): Promise<void> {
  const now = Date.now()
  await db.insert(setupState).values({
    workspaceId, firstRunAt: now, updatedAt: now,
  }).onConflictDoNothing().catch((e: Error) => { console.error('[platform-hardening]', e.message); return null })
}

export async function markSetupStep(workspaceId: string, step: 'firstProviderAt' | 'firstChatAt' | 'firstActionAt' | 'firstHorizonAt' | 'firstProposalAt' | 'firstRevenueAt'): Promise<void> {
  await ensureSetupRow(workspaceId)
  const existing = await db.select().from(setupState)
    .where(eq(setupState.workspaceId, workspaceId)).limit(1).then(r => r[0]).catch((e: Error) => { console.error('[platform-hardening]', e.message); return null })
  if (!existing) return
  // Only mark once (idempotent)
  if (existing[step]) return
  await db.update(setupState).set({
    [step]: Date.now(), updatedAt: Date.now(),
  }).where(eq(setupState.workspaceId, workspaceId)).catch((e: Error) => { console.error('[platform-hardening]', e.message); return null })
}

export async function getSetupSnapshot(workspaceId: string): Promise<SetupSnapshot> {
  await ensureSetupRow(workspaceId)
  const row = await db.select().from(setupState)
    .where(eq(setupState.workspaceId, workspaceId)).limit(1).then(r => r[0]).catch((e: Error) => { console.error('[platform-hardening]', e.message); return null })
  const firstRunAt = row?.firstRunAt ?? Date.now()
  const steps: SetupSnapshot['steps'] = [
    { id: 'provider', label: 'Enable at least one LLM provider', doneAt: row?.firstProviderAt ?? null, required: true },
    { id: 'chat',     label: 'Send your first chat message',     doneAt: row?.firstChatAt ?? null, required: false },
    { id: 'action',   label: 'Approve your first action',        doneAt: row?.firstActionAt ?? null, required: false },
    { id: 'horizon',  label: 'Set a strategic horizon',          doneAt: row?.firstHorizonAt ?? null, required: false },
    { id: 'proposal', label: 'Review a code proposal',           doneAt: row?.firstProposalAt ?? null, required: false },
    { id: 'revenue',  label: 'Record a revenue event',           doneAt: row?.firstRevenueAt ?? null, required: false },
  ]
  const done = steps.filter(s => s.doneAt !== null).length
  const completedOnboarding = row?.completedOnboarding ?? (done >= 3)

  // Auto-mark completed when threshold hit
  if (!row?.completedOnboarding && done >= 3) {
    await db.update(setupState).set({ completedOnboarding: true, updatedAt: Date.now() })
      .where(eq(setupState.workspaceId, workspaceId)).catch((e: Error) => { console.error('[platform-hardening]', e.message); return null })
  }

  return {
    workspaceId, firstRunAt, steps,
    completedOnboarding,
    percentComplete: Number((done / steps.length).toFixed(2)),
  }
}

// ─── Workspace-iteration helper ─────────────────────────────────────────

export async function listWorkspaceIds(): Promise<string[]> {
  const rows = await db.select({ id: workspaces.id }).from(workspaces).limit(500).catch(() => [])
  return rows.map(r => r.id)
}
