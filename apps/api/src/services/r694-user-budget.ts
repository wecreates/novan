/**
 * R694 — Per-user budget caps within a workspace.
 *
 * R660 caps daily spend per workspace. R689 gave each user their own
 * workspace (1:1) so workspace-level was sufficient for solo users.
 * When teams share a workspace (future), per-user attribution + per-user
 * caps matter. R694 builds that now so the schema is ready.
 *
 * Tracking: every novan.agent run can carry a `userId` (extends r649_agent_runs).
 * Cap: r694_user_budgets table.
 * Check: assertWithinUserBudget() — called by runAgent if userId provided.
 */
import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

let ddlOk = false
async function ensureDdl(): Promise<void> {
  if (ddlOk) return
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS r694_user_budgets (
        workspace_id   TEXT NOT NULL,
        user_id        TEXT NOT NULL,
        daily_usd_cap  NUMERIC(10,4) NOT NULL,
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace_id, user_id)
      )
    `).catch(() => {})
    await db.execute(sql`ALTER TABLE r649_agent_runs ADD COLUMN IF NOT EXISTS user_id TEXT`).catch(() => {})
    await db.execute(sql`CREATE INDEX IF NOT EXISTS r649_user_id_idx ON r649_agent_runs (workspace_id, user_id, created_at)`).catch(() => {})
    ddlOk = true
  } catch { /* tolerated */ }
}

export async function getUserCap(workspaceId: string, userId: string): Promise<number> {
  await ensureDdl()
  try {
    const rows = await db.execute(sql`SELECT daily_usd_cap FROM r694_user_budgets WHERE workspace_id = ${workspaceId} AND user_id = ${userId} LIMIT 1`)
    const r = ((rows.rows ?? rows) as Array<Record<string, unknown>>)[0]
    if (r?.['daily_usd_cap']) return Number(r['daily_usd_cap'])
  } catch { /* fall through */ }
  // No per-user cap → fall back to workspace cap
  const { getDailyCap } = await import('./r660-agent-budget.js')
  return getDailyCap(workspaceId)
}

export async function setUserCap(workspaceId: string, userId: string, dailyUsdCap: number): Promise<{ ok: boolean; cap: number }> {
  await ensureDdl()
  const cap = Math.max(0, Number(dailyUsdCap))
  if (!Number.isFinite(cap)) throw new Error('dailyUsdCap must be finite ≥ 0')
  try {
    await db.execute(sql`
      INSERT INTO r694_user_budgets (workspace_id, user_id, daily_usd_cap)
      VALUES (${workspaceId}, ${userId}, ${cap})
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET daily_usd_cap = EXCLUDED.daily_usd_cap, updated_at = now()
    `)
    return { ok: true, cap }
  } catch { return { ok: false, cap } }
}

export async function getUserSpendToday(workspaceId: string, userId: string): Promise<number> {
  await ensureDdl()
  try {
    const rows = await db.execute(sql`
      SELECT COALESCE(sum(cost_usd), 0)::numeric(14,6) AS s
      FROM r649_agent_runs
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
        AND created_at >= date_trunc('day', now() at time zone 'UTC')
    `)
    return Number(((rows.rows ?? rows) as Array<Record<string, unknown>>)[0]?.['s'] ?? 0)
  } catch { return 0 }
}

export async function assertWithinUserBudget(workspaceId: string, userId: string): Promise<void> {
  const [cap, spent] = await Promise.all([getUserCap(workspaceId, userId), getUserSpendToday(workspaceId, userId)])
  if (spent >= cap) {
    throw new Error(`R694_USER_BUDGET_EXCEEDED: workspace=${workspaceId} user=${userId} spent=$${spent.toFixed(4)} cap=$${cap.toFixed(2)} (UTC day).`)
  }
}

export async function listUserBudgets(workspaceId: string): Promise<Array<Record<string, unknown>>> {
  await ensureDdl()
  try {
    const rows = await db.execute(sql`
      SELECT user_id, daily_usd_cap, updated_at FROM r694_user_budgets WHERE workspace_id = ${workspaceId}
      ORDER BY updated_at DESC
    `)
    return (rows.rows ?? rows) as Array<Record<string, unknown>>
  } catch { return [] }
}

export async function getUserSpendByDay(workspaceId: string, userId: string, days = 14): Promise<Array<{ day: string; cost: number; runs: number }>> {
  await ensureDdl()
  try {
    const rows = await db.execute(sql`
      SELECT date_trunc('day', created_at)::date AS day,
             COALESCE(sum(cost_usd), 0)::numeric(14,6) AS cost,
             count(*)::int AS runs
      FROM r649_agent_runs
      WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
        AND created_at >= now() - (${days} || ' days')::interval
      GROUP BY day ORDER BY day ASC
    `)
    return ((rows.rows ?? rows) as Array<Record<string, unknown>>).map(r => ({
      day: String(r['day']).slice(0, 10), cost: Number(r['cost']), runs: Number(r['runs']),
    }))
  } catch { return [] }
}
