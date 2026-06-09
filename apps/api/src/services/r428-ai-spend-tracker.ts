/**
 * R428 — AI spend tracker.
 *
 * Records cost for each image-gen / LLM call so dashboard can show today's
 * spend and crons can gate work on a daily budget. Persisted in ai_spend
 * (workspace, day_yyyymmdd, source, cost_usd_cents) — bounded by day × source.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ai_spend (
      workspace_id  TEXT NOT NULL,
      day_yyyymmdd  TEXT NOT NULL,
      source        TEXT NOT NULL,        -- 'image_gen' | 'selector_improver' | 'pipeline_design' | etc.
      cost_usd_cents BIGINT NOT NULL DEFAULT 0,
      call_count    INTEGER NOT NULL DEFAULT 0,
      updated_at    BIGINT NOT NULL,
      PRIMARY KEY (workspace_id, day_yyyymmdd, source)
    )
  `).catch(() => {})
}

function todayYYYYMMDD(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
}

export async function recordSpend(workspaceId: string, source: string, costUsdCents: number): Promise<void> {
  await ensureTable()
  const day = todayYYYYMMDD()
  const cents = Math.max(0, Math.round(costUsdCents))
  await db.execute(sql`
    INSERT INTO ai_spend (workspace_id, day_yyyymmdd, source, cost_usd_cents, call_count, updated_at)
    VALUES (${workspaceId}, ${day}, ${source}, ${cents}, 1, ${Date.now()})
    ON CONFLICT (workspace_id, day_yyyymmdd, source) DO UPDATE
    SET cost_usd_cents = ai_spend.cost_usd_cents + ${cents},
        call_count = ai_spend.call_count + 1,
        updated_at = ${Date.now()}
  `).catch(() => {/* best effort */})
}

export interface SpendSnapshot {
  todayUsd:        number
  todayCallCount:  number
  bySource:        Array<{ source: string; usd: number; calls: number }>
  cap?:            { dailyUsd: number; pctUsed: number; budgetExhausted: boolean }
}

const DAILY_BUDGET_USD_ENV = 'NOVAN_DAILY_AI_BUDGET_USD'

export async function spendSnapshot(workspaceId: string): Promise<SpendSnapshot> {
  await ensureTable()
  const day = todayYYYYMMDD()
  const rows = await db.execute(sql`
    SELECT source, cost_usd_cents, call_count FROM ai_spend
    WHERE workspace_id = ${workspaceId} AND day_yyyymmdd = ${day}
  `).catch(() => [] as unknown[])
  const bySource = (rows as unknown as Array<{ source: string; cost_usd_cents: number; call_count: number }>).map(r => ({
    source: r.source,
    usd:    Math.round(Number(r.cost_usd_cents)) / 100,
    calls:  Number(r.call_count),
  }))
  const todayUsd = bySource.reduce((a, b) => a + b.usd, 0)
  const todayCallCount = bySource.reduce((a, b) => a + b.calls, 0)
  const out: SpendSnapshot = { todayUsd, todayCallCount, bySource }
  // R540 — sensible default of $10/day for a solo operator. Without this
  // the gate is a no-op (cap of $0 == unlimited) so R524's check at the
  // image-gen entry point would always pass — defeating the purpose.
  // Operator can bump via NOVAN_DAILY_AI_BUDGET_USD env or disable with 0.
  const dailyBudgetUsd = Number(process.env[DAILY_BUDGET_USD_ENV] ?? 10)
  if (dailyBudgetUsd > 0) {
    out.cap = {
      dailyUsd: dailyBudgetUsd,
      pctUsed:  Math.round((todayUsd / dailyBudgetUsd) * 100),
      budgetExhausted: todayUsd >= dailyBudgetUsd,
    }
  }
  return out
}

/** Guard: returns true if today's spend has already exceeded the daily budget.
 *  Crons should check this before firing expensive ops. */
export async function isBudgetExhausted(workspaceId: string): Promise<boolean> {
  // R540 — sensible default of $10/day for a solo operator. Without this
  // the gate is a no-op (cap of $0 == unlimited) so R524's check at the
  // image-gen entry point would always pass — defeating the purpose.
  // Operator can bump via NOVAN_DAILY_AI_BUDGET_USD env or disable with 0.
  const dailyBudgetUsd = Number(process.env[DAILY_BUDGET_USD_ENV] ?? 10)
  if (dailyBudgetUsd <= 0) return false
  const snap = await spendSnapshot(workspaceId)
  return Boolean(snap.cap?.budgetExhausted)
}

/** R488 — per-source daily cap so operator can set, e.g., max $1/day on
 *  selector_improver separately from image_gen. Looks up
 *  workspace_settings.<source>_daily_cap_usd. Returns true when exhausted. */
export async function isSourceBudgetExhausted(workspaceId: string, source: string): Promise<boolean> {
  try {
    const { getNumSetting } = await import('./r437-operator-timezone.js')
    const capUsd = await getNumSetting(workspaceId, `${source}_daily_cap_usd`, 0)
    if (capUsd <= 0) return false
    const snap = await spendSnapshot(workspaceId)
    const sourceUsd = snap.bySource.find(b => b.source === source)?.usd ?? 0
    return sourceUsd >= capUsd
  } catch { return false }
}
