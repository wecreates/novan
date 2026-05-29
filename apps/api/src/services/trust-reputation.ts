/**
 * trust-reputation.ts — score connectors, workflows, agents, ops.
 *
 * Every call records success/failure/latency. Trust is the EWMA of
 * success rate over the last N calls, weighted by recency. Used by
 * the brain to prefer high-trust paths and surface unstable ones.
 */

import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

let _ensured = false
async function ensure(): Promise<void> {
  if (_ensured) return
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS trust_ewma_scores (
      subject TEXT NOT NULL,                -- e.g. "connector:stripe", "op:capcut.assemble"
      workspace_id TEXT NOT NULL,
      total_calls INT NOT NULL DEFAULT 0,
      successes INT NOT NULL DEFAULT 0,
      failures INT NOT NULL DEFAULT 0,
      avg_latency_ms REAL NOT NULL DEFAULT 0,
      score REAL NOT NULL DEFAULT 0.5,        -- 0..1 EWMA
      last_call_at BIGINT,
      last_failure_at BIGINT,
      last_failure_reason TEXT,
      PRIMARY KEY (workspace_id, subject)
    )`)
  _ensured = true
}

export async function record(workspaceId: string, subject: string, ok: boolean, latencyMs: number, failureReason?: string): Promise<void> {
  await ensure()
  // ATOMIC EWMA upsert using arithmetic on EXCLUDED columns directly.
  // Previously: SELECT then INSERT/UPDATE was a race — concurrent records
  // on the same subject read the same prevScore, computed new from it,
  // both upserted, second clobbered first. With mass-produce launching
  // 6+ ops in parallel, failures under-recorded.
  // Also fixes the suspect ON CONFLICT template-fragment ternary that
  // may have written the literal string "trust_ewma_scores.last_failure_at"
  // on success (depending on drizzle's nested-sql binding).
  const now = Date.now()
  const success = ok ? 1 : 0
  const failure = ok ? 0 : 1
  const okFloat = ok ? 1.0 : 0.0
  await db.execute(sql`
    INSERT INTO trust_ewma_scores (
      subject, workspace_id, total_calls, successes, failures,
      avg_latency_ms, score, last_call_at, last_failure_at, last_failure_reason
    )
    VALUES (
      ${subject}, ${workspaceId}, 1, ${success}, ${failure},
      ${latencyMs}, ${0.8 * 0.5 + 0.2 * okFloat}, ${now},
      ${ok ? null : now}, ${ok ? null : (failureReason ?? null)}
    )
    ON CONFLICT (workspace_id, subject) DO UPDATE SET
      total_calls    = trust_ewma_scores.total_calls + 1,
      successes      = trust_ewma_scores.successes + ${success},
      failures       = trust_ewma_scores.failures + ${failure},
      avg_latency_ms = CASE
        WHEN trust_ewma_scores.total_calls = 0 THEN ${latencyMs}
        ELSE trust_ewma_scores.avg_latency_ms * 0.9 + ${latencyMs} * 0.1
      END,
      score          = trust_ewma_scores.score * 0.8 + ${0.2 * okFloat},
      last_call_at   = ${now},
      last_failure_at = CASE WHEN ${ok}::boolean THEN trust_ewma_scores.last_failure_at ELSE ${now} END,
      last_failure_reason = CASE WHEN ${ok}::boolean THEN trust_ewma_scores.last_failure_reason ELSE ${failureReason ?? null} END
  `)
}

export interface TrustScore {
  subject: string
  totalCalls: number
  successes: number
  failures: number
  avgLatencyMs: number
  score: number
  successRate: number
  lastCallAt?: number
  lastFailureAt?: number
  lastFailureReason?: string
  classification: 'high' | 'medium' | 'low' | 'broken' | 'unknown'
}

function classify(score: number, total: number): TrustScore['classification'] {
  if (total < 3) return 'unknown'
  if (score < 0.3) return 'broken'
  if (score < 0.6) return 'low'
  if (score < 0.85) return 'medium'
  return 'high'
}

export async function getScore(workspaceId: string, subject: string): Promise<TrustScore | null> {
  await ensure()
  const rows = await db.execute(sql`
    SELECT * FROM trust_ewma_scores WHERE workspace_id = ${workspaceId} AND subject = ${subject}`)
  const r = (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows?.[0]
  if (!r) return null
  const total = Number(r['total_calls'])
  const succ  = Number(r['successes'])
  const out: TrustScore = {
    subject, totalCalls: total, successes: succ, failures: Number(r['failures']),
    avgLatencyMs: Number(r['avg_latency_ms']), score: Number(r['score']),
    successRate: total > 0 ? succ / total : 0,
    classification: classify(Number(r['score']), total),
  }
  if (r['last_call_at'])        out.lastCallAt        = Number(r['last_call_at'])
  if (r['last_failure_at'])     out.lastFailureAt     = Number(r['last_failure_at'])
  if (r['last_failure_reason']) out.lastFailureReason = String(r['last_failure_reason'])
  return out
}

export async function listTopBroken(workspaceId: string, limit = 10): Promise<TrustScore[]> {
  await ensure()
  const rows = await db.execute(sql`
    SELECT * FROM trust_ewma_scores
    WHERE workspace_id = ${workspaceId} AND total_calls > 3
    ORDER BY score ASC LIMIT ${limit}`)
  return ((rows as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? []).map(r => {
    const total = Number(r['total_calls'])
    const succ  = Number(r['successes'])
    const out: TrustScore = {
      subject: String(r['subject']),
      totalCalls: total, successes: succ, failures: Number(r['failures']),
      avgLatencyMs: Number(r['avg_latency_ms']), score: Number(r['score']),
      successRate: total > 0 ? succ / total : 0,
      classification: classify(Number(r['score']), total),
    }
    if (r['last_call_at'])        out.lastCallAt        = Number(r['last_call_at'])
    if (r['last_failure_at'])     out.lastFailureAt     = Number(r['last_failure_at'])
    if (r['last_failure_reason']) out.lastFailureReason = String(r['last_failure_reason'])
    return out
  })
}
