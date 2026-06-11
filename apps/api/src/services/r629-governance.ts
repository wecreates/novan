/**
 * R629 — Governance: approval queue, spend caps, audit-log view.
 *
 *   approvals.request — risky op pauses and emits an approval row;
 *                       caller polls or operator visits /ops/approvals.
 *   approvals.list / .approve / .reject
 *   spend.cap.set / .check — per-workspace daily/monthly AI spend ceiling.
 *   audit.list — tail of brain-op invocations + hook-fired events.
 *
 * Spend cap is enforced by callers via spend.checkCap before any LLM call
 * (existing flows can be retrofitted gradually). Storage is in-DB.
 */
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'

// ─── Approval queue ─────────────────────────────────────────────────────────

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export interface ApprovalRow {
  id:           string
  workspaceId:  string
  op:           string
  brief:        string
  riskLevel:    string                // 'low' | 'medium' | 'high' | 'critical'
  payload:      Record<string, unknown>
  status:       ApprovalStatus
  requestedAt:  number
  decidedAt?:   number
  decidedBy?:   string
  expiresAt:    number
}

async function ensureTables(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS r629_approvals (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      op            TEXT NOT NULL,
      brief         TEXT NOT NULL,
      risk_level    TEXT NOT NULL,
      payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
      status        TEXT NOT NULL DEFAULT 'pending',
      requested_at  BIGINT NOT NULL,
      decided_at    BIGINT,
      decided_by    TEXT,
      expires_at    BIGINT NOT NULL
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS r629_approvals_ws_status_idx ON r629_approvals (workspace_id, status, requested_at DESC)`).catch(() => {})
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS spend_caps (
      workspace_id    TEXT PRIMARY KEY,
      daily_usd       REAL NOT NULL DEFAULT 5.0,
      monthly_usd     REAL NOT NULL DEFAULT 100.0,
      hard_stop       BOOLEAN NOT NULL DEFAULT false,
      updated_at      BIGINT NOT NULL
    )
  `).catch(() => {})
}

export interface RequestInput {
  op:        string
  brief:     string
  riskLevel?: 'low' | 'medium' | 'high' | 'critical'
  payload?:  Record<string, unknown>
  ttlMin?:   number
}

export async function requestApproval(workspaceId: string, input: RequestInput): Promise<{ id: string; expiresAt: number }> {
  await ensureTables()
  const id = uuidv7()
  const now = Date.now()
  const expiresAt = now + Math.max(1, Math.min(1440, input.ttlMin ?? 60)) * 60_000
  await db.execute(sql`
    INSERT INTO r629_approvals (id, workspace_id, op, brief, risk_level, payload, requested_at, expires_at)
    VALUES (${id}, ${workspaceId}, ${input.op}, ${input.brief}, ${input.riskLevel ?? 'medium'},
            ${JSON.stringify(input.payload ?? {})}::jsonb, ${now}, ${expiresAt})
  `)
  return { id, expiresAt }
}

function rowToApproval(r: Record<string, unknown>): ApprovalRow {
  const a: ApprovalRow = {
    id:          String(r['id']),
    workspaceId: String(r['workspace_id']),
    op:          String(r['op']),
    brief:       String(r['brief']),
    riskLevel:   String(r['risk_level']),
    payload:     (r['payload'] as Record<string, unknown>) ?? {},
    status:      String(r['status']) as ApprovalStatus,
    requestedAt: Number(r['requested_at']),
    expiresAt:   Number(r['expires_at']),
  }
  if (r['decided_at'] != null) a.decidedAt = Number(r['decided_at'])
  if (r['decided_by'] != null) a.decidedBy = String(r['decided_by'])
  return a
}

export async function listApprovals(workspaceId: string, opts: { status?: ApprovalStatus; limit?: number } = {}): Promise<ApprovalRow[]> {
  await ensureTables()
  const lim = Math.max(1, Math.min(100, opts.limit ?? 30))
  const r = opts.status
    ? await db.execute(sql`SELECT * FROM r629_approvals WHERE workspace_id = ${workspaceId} AND status = ${opts.status} ORDER BY requested_at DESC LIMIT ${lim}`).catch(() => [] as unknown[])
    : await db.execute(sql`SELECT * FROM r629_approvals WHERE workspace_id = ${workspaceId} ORDER BY requested_at DESC LIMIT ${lim}`).catch(() => [] as unknown[])
  return (r as Array<Record<string, unknown>>).map(rowToApproval)
}

export async function decide(workspaceId: string, id: string, decision: 'approved' | 'rejected', decidedBy: string): Promise<{ ok: boolean }> {
  await ensureTables()
  await db.execute(sql`
    UPDATE r629_approvals SET status = ${decision}, decided_at = ${Date.now()}, decided_by = ${decidedBy}
    WHERE id = ${id} AND workspace_id = ${workspaceId} AND status = 'pending'
  `).catch(() => {})
  return { ok: true }
}

export async function expireOld(workspaceId: string): Promise<{ expired: number }> {
  await ensureTables()
  const r = await db.execute(sql`
    UPDATE r629_approvals SET status = 'expired'
    WHERE workspace_id = ${workspaceId} AND status = 'pending' AND expires_at < ${Date.now()}
    RETURNING id
  `).catch(() => [] as unknown[])
  return { expired: (r as unknown[]).length }
}

// ─── Spend cap ──────────────────────────────────────────────────────────────

export interface SpendCap {
  workspaceId: string
  dailyUsd:    number
  monthlyUsd:  number
  hardStop:    boolean
}

export async function getCap(workspaceId: string): Promise<SpendCap> {
  await ensureTables()
  const r = await db.execute(sql`SELECT * FROM spend_caps WHERE workspace_id = ${workspaceId}`).catch(() => [] as unknown[])
  const row = (r as Array<Record<string, unknown>>)[0]
  if (!row) return { workspaceId, dailyUsd: 5, monthlyUsd: 100, hardStop: false }
  return {
    workspaceId,
    dailyUsd:   Number(row['daily_usd']   ?? 5),
    monthlyUsd: Number(row['monthly_usd'] ?? 100),
    hardStop:   Boolean(row['hard_stop']  ?? false),
  }
}

export async function setCap(workspaceId: string, input: { dailyUsd?: number; monthlyUsd?: number; hardStop?: boolean }): Promise<SpendCap> {
  await ensureTables()
  const cur = await getCap(workspaceId)
  const next = {
    dailyUsd:   typeof input.dailyUsd   === 'number' ? input.dailyUsd   : cur.dailyUsd,
    monthlyUsd: typeof input.monthlyUsd === 'number' ? input.monthlyUsd : cur.monthlyUsd,
    hardStop:   typeof input.hardStop   === 'boolean' ? input.hardStop  : cur.hardStop,
  }
  await db.execute(sql`
    INSERT INTO spend_caps (workspace_id, daily_usd, monthly_usd, hard_stop, updated_at)
    VALUES (${workspaceId}, ${next.dailyUsd}, ${next.monthlyUsd}, ${next.hardStop}, ${Date.now()})
    ON CONFLICT (workspace_id) DO UPDATE SET
      daily_usd = EXCLUDED.daily_usd, monthly_usd = EXCLUDED.monthly_usd,
      hard_stop = EXCLUDED.hard_stop, updated_at = EXCLUDED.updated_at
  `)
  return { workspaceId, ...next }
}

export interface SpendCheckResult {
  ok:           boolean
  dailySpent:   number
  monthlySpent: number
  dailyCap:     number
  monthlyCap:   number
  hardStop:     boolean
  reason?:      string
}

export async function checkCap(workspaceId: string): Promise<SpendCheckResult> {
  await ensureTables()
  const cap = await getCap(workspaceId)
  const day = Date.now() - 24 * 60 * 60_000
  const month = Date.now() - 30 * 24 * 60 * 60_000
  const r = await db.execute(sql`
    SELECT
      COALESCE(sum(CASE WHEN timestamp > ${day}   THEN cost_usd ELSE 0 END), 0)::float AS d24,
      COALESCE(sum(CASE WHEN timestamp > ${month} THEN cost_usd ELSE 0 END), 0)::float AS d30
    FROM ai_usage WHERE workspace_id = ${workspaceId}
  `).catch(() => [{ d24: 0, d30: 0 }] as unknown[])
  const row = (r as Array<Record<string, unknown>>)[0] ?? {}
  const dailySpent = Number(row['d24'] ?? 0)
  const monthlySpent = Number(row['d30'] ?? 0)
  let ok = true
  let reason: string | undefined
  if (cap.hardStop) {
    if (dailySpent >= cap.dailyUsd)     { ok = false; reason = `daily cap reached: $${dailySpent.toFixed(2)} ≥ $${cap.dailyUsd}` }
    if (monthlySpent >= cap.monthlyUsd) { ok = false; reason = `monthly cap reached: $${monthlySpent.toFixed(2)} ≥ $${cap.monthlyUsd}` }
  }
  const result: SpendCheckResult = {
    ok, dailySpent, monthlySpent,
    dailyCap:   cap.dailyUsd,
    monthlyCap: cap.monthlyUsd,
    hardStop:   cap.hardStop,
  }
  if (reason) result.reason = reason
  return result
}

// ─── Audit log (read-only view over events table) ────────────────────────────

export interface AuditRow {
  id:          string
  type:        string
  workspaceId: string
  payload:     Record<string, unknown>
  createdAt:   number
}

export async function recentAudit(workspaceId: string, opts: { type?: string; limit?: number } = {}): Promise<AuditRow[]> {
  const lim = Math.max(1, Math.min(200, opts.limit ?? 50))
  const r = opts.type
    ? await db.execute(sql`SELECT id, type, workspace_id, payload, created_at FROM events WHERE workspace_id = ${workspaceId} AND type = ${opts.type} ORDER BY created_at DESC LIMIT ${lim}`).catch(() => [] as unknown[])
    : await db.execute(sql`SELECT id, type, workspace_id, payload, created_at FROM events WHERE workspace_id = ${workspaceId} ORDER BY created_at DESC LIMIT ${lim}`).catch(() => [] as unknown[])
  return (r as Array<Record<string, unknown>>).map(row => ({
    id:          String(row['id']),
    type:        String(row['type']),
    workspaceId: String(row['workspace_id']),
    payload:     (row['payload'] as Record<string, unknown>) ?? {},
    createdAt:   Number(row['created_at']),
  }))
}
