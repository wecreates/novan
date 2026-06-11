/**
 * R660 — Per-workspace daily budget cap for novan.agent.
 *
 * R649 + R656 can rack up real cost (esp. scheduled agents). R660 lets the
 * operator set a UTC-daily USD cap. Every novan.agent call (including
 * session.turn + schedule fires) sums today's r649_agent_runs.cost_usd and
 * refuses to start if it's over.
 *
 * Defaults to env NOVAN_AGENT_DAILY_USD_CAP or 5.00. Per-workspace override
 * via r660_agent_budgets row.
 */
import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

let ddlOk = false
async function ensureDdl(): Promise<void> {
  if (ddlOk) return
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS r660_agent_budgets (
        workspace_id    TEXT PRIMARY KEY,
        daily_usd_cap   NUMERIC(10,4) NOT NULL,
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch(() => {})
    ddlOk = true
  } catch { /* tolerated */ }
}

function defaultCap(): number {
  const env = process.env['NOVAN_AGENT_DAILY_USD_CAP']
  const n = env ? Number(env) : NaN
  return Number.isFinite(n) && n >= 0 ? n : 5.0
}

export async function getDailyCap(workspaceId: string): Promise<number> {
  await ensureDdl()
  try {
    const rows = await db.execute(sql`
      SELECT daily_usd_cap FROM r660_agent_budgets WHERE workspace_id = ${workspaceId} LIMIT 1
    `)
    const r = ((rows.rows ?? rows) as Array<Record<string, unknown>>)[0]
    if (r?.['daily_usd_cap']) return Number(r['daily_usd_cap'])
  } catch { /* fall through */ }
  return defaultCap()
}

export async function setDailyCap(workspaceId: string, usd: number): Promise<{ ok: boolean; cap: number }> {
  await ensureDdl()
  const cap = Math.max(0, Number(usd))
  if (!Number.isFinite(cap)) throw new Error('daily_usd_cap must be a finite number ≥ 0')
  try {
    await db.execute(sql`
      INSERT INTO r660_agent_budgets (workspace_id, daily_usd_cap)
      VALUES (${workspaceId}, ${cap})
      ON CONFLICT (workspace_id) DO UPDATE
      SET daily_usd_cap = EXCLUDED.daily_usd_cap, updated_at = now()
    `)
    return { ok: true, cap }
  } catch { return { ok: false, cap } }
}

export async function getSpendToday(workspaceId: string): Promise<number> {
  try {
    const rows = await db.execute(sql`
      SELECT COALESCE(sum(cost_usd), 0)::numeric(14,6) AS s
      FROM r649_agent_runs
      WHERE workspace_id = ${workspaceId}
        AND created_at >= date_trunc('day', now() at time zone 'UTC')
    `)
    const r = ((rows.rows ?? rows) as Array<Record<string, unknown>>)[0]
    return Number(r?.['s'] ?? 0)
  } catch { return 0 }
}

/** Called by runAgent before kicking off. Throws if over cap. */
export async function assertWithinBudget(workspaceId: string): Promise<void> {
  const [cap, spent] = await Promise.all([getDailyCap(workspaceId), getSpendToday(workspaceId)])
  if (spent >= cap) {
    throw new Error(`R660_BUDGET_EXCEEDED: workspace=${workspaceId} spent=$${spent.toFixed(4)} cap=$${cap.toFixed(2)} (UTC day). Raise with novan.budget.set or wait.`)
  }
}

export async function getBudgetStatus(workspaceId: string): Promise<{ workspace: string; cap: number; spent: number; remaining: number; pctUsed: number; resetsAt: string }> {
  const [cap, spent] = await Promise.all([getDailyCap(workspaceId), getSpendToday(workspaceId)])
  const tomorrowUtc = new Date()
  tomorrowUtc.setUTCHours(24, 0, 0, 0)
  return {
    workspace: workspaceId,
    cap, spent,
    remaining: Math.max(0, cap - spent),
    pctUsed: cap === 0 ? 100 : Number(((spent / cap) * 100).toFixed(1)),
    resetsAt: tomorrowUtc.toISOString(),
  }
}
