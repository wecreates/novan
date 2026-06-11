/**
 * R644d — SMS approval bridge.
 *
 * When R629 approvals.request creates a row, this poller (run every 60s
 * via learning-cron) scans for pending approvals that haven't yet been
 * SMS'd, and sends an SMS preview to TWILIO_APPROVAL_TO (operator's
 * phone) with the brief + approve/reject reply keywords. Marks the
 * approval as notified via metadata to prevent duplicate sends.
 *
 * Operator replies 'APPROVE <id>' or 'REJECT <id>' through a separate
 * Twilio webhook (not implemented here — operator-set when Twilio is
 * configured). For now the SMS just surfaces the request; operator
 * approves via /ops/approvals UI or approvals.approve brain op.
 *
 * Gated on:
 *   - Twilio configured (TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM)
 *   - TWILIO_APPROVAL_TO env set (operator's destination number, E.164)
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

async function ensureColumn(): Promise<void> {
  // r629_approvals may pre-exist without sms_notified_at; add it idempotently
  await db.execute(sql`ALTER TABLE r629_approvals ADD COLUMN IF NOT EXISTS sms_notified_at BIGINT`).catch(() => {})
  await db.execute(sql`ALTER TABLE r629_approvals ADD COLUMN IF NOT EXISTS sms_sid TEXT`).catch(() => {})
}

export async function tickApprovalSms(): Promise<{ scanned: number; sent: number; skipped: number; failed: number }> {
  await ensureColumn()
  // Cheap config probe before doing the scan
  const { smsHealth } = await import('./r643-twilio-sms.js')
  const h = smsHealth()
  if (!h.configured) return { scanned: 0, sent: 0, skipped: 0, failed: 0 }
  const to = process.env['TWILIO_APPROVAL_TO']
  if (!to) return { scanned: 0, sent: 0, skipped: 0, failed: 0 }

  const cutoff = Date.now() - 24 * 60 * 60_000
  const r = await db.execute(sql`
    SELECT id, workspace_id, op, brief, risk_level, requested_at, expires_at
    FROM r629_approvals
    WHERE status = 'pending'
      AND sms_notified_at IS NULL
      AND requested_at > ${cutoff}
      AND expires_at > ${Date.now()}
    ORDER BY risk_level DESC NULLS LAST, requested_at ASC
    LIMIT 5
  `).catch(() => [] as unknown[])

  const rows = r as Array<Record<string, unknown>>
  if (rows.length === 0) return { scanned: 0, sent: 0, skipped: 0, failed: 0 }

  const { send } = await import('./r643-twilio-sms.js')
  let sent = 0, failed = 0
  for (const row of rows) {
    const id        = String(row['id'])
    const op        = String(row['op'])
    const brief     = String(row['brief'])
    const riskLevel = String(row['risk_level'])
    const ws        = String(row['workspace_id'])
    const opsToken  = process.env['NOVAN_OPS_TOKEN'] ?? process.env['OPERATOR_TOKEN'] ?? ''
    const opsBase   = process.env['NOVAN_PUBLIC_URL'] ?? ''
    const link      = opsBase && opsToken ? `${opsBase}/ops/approvals?token=${encodeURIComponent(opsToken)}&workspace=${encodeURIComponent(ws)}` : ''
    const body = [
      `Novan approval (${riskLevel}): ${op}`,
      brief.length > 160 ? brief.slice(0, 157) + '…' : brief,
      `id: ${id.slice(0, 8)}…`,
      link ? `Decide: ${link}` : 'Decide via /ops/approvals or approvals.{approve,reject} brain op.',
    ].join('\n').slice(0, 800)

    const result = await send({ to, body })
    if (result.ok && result.sid) {
      await db.execute(sql`UPDATE r629_approvals SET sms_notified_at = ${Date.now()}, sms_sid = ${result.sid} WHERE id = ${id}`).catch(() => {})
      sent++
    } else {
      // Mark notified even on permanent failures so we don't retry forever
      if (result.errorCode && result.errorCode >= 21000 && result.errorCode < 30000) {
        await db.execute(sql`UPDATE r629_approvals SET sms_notified_at = ${Date.now()} WHERE id = ${id}`).catch(() => {})
      }
      failed++
    }
  }

  return { scanned: rows.length, sent, skipped: 0, failed }
}

export async function approvalSmsStatus(): Promise<{
  configured: boolean
  destination: string | null
  pendingNotNotified24h: number
  sentLast24h: number
}> {
  await ensureColumn()
  const { smsHealth } = await import('./r643-twilio-sms.js')
  const h = smsHealth()
  const destination = process.env['TWILIO_APPROVAL_TO'] ?? null
  const day = Date.now() - 24 * 60 * 60_000
  const pendR = await db.execute(sql`SELECT COUNT(*)::int AS n FROM r629_approvals WHERE status = 'pending' AND sms_notified_at IS NULL AND requested_at > ${day}`).catch(() => [{ n: 0 }] as unknown[])
  const sentR = await db.execute(sql`SELECT COUNT(*)::int AS n FROM r629_approvals WHERE sms_notified_at > ${day}`).catch(() => [{ n: 0 }] as unknown[])
  return {
    configured:            h.configured && !!destination,
    destination,
    pendingNotNotified24h: Number(((pendR as Array<Record<string, unknown>>)[0] ?? {})['n'] ?? 0),
    sentLast24h:           Number(((sentR as Array<Record<string, unknown>>)[0] ?? {})['n'] ?? 0),
  }
}
