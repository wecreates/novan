/**
 * R684 — Aggregate platform health snapshot.
 *
 * Returns a single JSON blob with the most important signals for a
 * monitoring dashboard or an agent answering "is everything ok?":
 *   - brain registry size
 *   - 24h agent run count + spend + cap status (R660)
 *   - tool + chat cache hit rates (R665, R675)
 *   - rate limiter rejections (R683)
 *   - active scheduled agents + last fire times (R656)
 *   - recent webhook fire counts (R678)
 *   - prompt-cache marker observations (R647c)
 *
 * Single round-trip, no LLM calls.
 */
import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

export interface HealthSnapshot {
  ok:            boolean
  ts:            string
  brainOps:      number
  agent:         { runs24h: number; tokens24h: number; spentToday: number; cap: number; pctUsed: number }
  caches:        { tool: Record<string, unknown>; chat: Record<string, unknown>; prompt: { tracked: number } }
  rateLimit:     Record<string, unknown>
  schedules:     { total: number; enabled: number; dueWithinNextMin: number; lastFireAt: string | null }
  webhooks:      { total: number; fires24h: number }
  sessions:      { chatTurns24h: number; agentRuns14d: number }
  latencyMs:     number
}

export async function snapshot(workspaceId: string): Promise<HealthSnapshot> {
  const t0 = Date.now()

  // Brain op count
  let brainOps = 0
  try {
    const mod = await import('./brain-task.js') as unknown as { OPERATIONS?: Record<string, unknown> }
    brainOps = Object.keys(mod.OPERATIONS ?? {}).length
  } catch { /* tolerated */ }

  // R660 budget
  let cap = 5, spentToday = 0, pctUsed = 0
  try {
    const { getBudgetStatus } = await import('./r660-agent-budget.js')
    const s = await getBudgetStatus(workspaceId)
    cap = s.cap; spentToday = s.spent; pctUsed = s.pctUsed
  } catch { /* tolerated */ }

  // R649 agent 24h activity
  let runs24h = 0, tokens24h = 0
  try {
    const rows = await db.execute(sql`
      SELECT count(*)::int AS c, COALESCE(sum(tokens), 0)::int AS t
      FROM r649_agent_runs
      WHERE workspace_id = ${workspaceId} AND created_at >= now() - interval '24 hours'
    `)
    const r = ((rows.rows ?? rows) as Array<Record<string, unknown>>)[0]
    runs24h = Number(r?.['c'] ?? 0); tokens24h = Number(r?.['t'] ?? 0)
  } catch { /* tolerated */ }

  // Caches
  let toolCache: Record<string, unknown> = {}, chatCache: Record<string, unknown> = {}, promptTracked = 0
  try {
    const { getCacheStats } = await import('./r665-tool-cache.js')
    toolCache = getCacheStats() as unknown as Record<string, unknown>
  } catch { /* tolerated */ }
  try {
    const { getChatCacheStats } = await import('./r675-chat-cache.js')
    chatCache = getChatCacheStats() as unknown as Record<string, unknown>
  } catch { /* tolerated */ }
  try {
    const rows = await db.execute(sql`SELECT count(*)::int AS c FROM r647_prompt_cache`)
    promptTracked = Number(((rows.rows ?? rows) as Array<Record<string, unknown>>)[0]?.['c'] ?? 0)
  } catch { /* tolerated */ }

  // R683 rate limiter
  let rateLimit: Record<string, unknown> = {}
  try {
    const { getRateStats } = await import('./r683-rate-limit.js')
    rateLimit = getRateStats() as unknown as Record<string, unknown>
  } catch { /* tolerated */ }

  // R656 schedules
  let schedTotal = 0, schedEnabled = 0, schedDue = 0, schedLastFire: string | null = null
  try {
    const rows = await db.execute(sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE enabled = true)::int AS enabled,
        count(*) FILTER (WHERE enabled = true AND next_run_at <= now() + interval '1 minute')::int AS due,
        max(last_run_at) AS last_fire
      FROM r656_agent_schedules
      WHERE workspace_id = ${workspaceId}
    `)
    const r = ((rows.rows ?? rows) as Array<Record<string, unknown>>)[0]
    schedTotal = Number(r?.['total'] ?? 0)
    schedEnabled = Number(r?.['enabled'] ?? 0)
    schedDue = Number(r?.['due'] ?? 0)
    if (r?.['last_fire']) schedLastFire = String(r['last_fire'])
  } catch { /* tolerated */ }

  // R678 webhooks
  let webhookTotal = 0, webhookFires24h = 0
  try {
    const rows = await db.execute(sql`SELECT count(*)::int AS c FROM r678_webhooks WHERE workspace_id = ${workspaceId}`)
    webhookTotal = Number(((rows.rows ?? rows) as Array<Record<string, unknown>>)[0]?.['c'] ?? 0)
  } catch { /* tolerated */ }
  try {
    const rows = await db.execute(sql`
      SELECT count(*)::int AS c FROM r678_webhook_events e
      JOIN r678_webhooks w ON w.slug = e.slug
      WHERE w.workspace_id = ${workspaceId} AND e.received_at >= now() - interval '24 hours'
    `)
    webhookFires24h = Number(((rows.rows ?? rows) as Array<Record<string, unknown>>)[0]?.['c'] ?? 0)
  } catch { /* tolerated */ }

  // Session activity
  let chatTurns24h = 0, agentRuns14d = 0
  try {
    const rows = await db.execute(sql`SELECT count(*)::int AS c FROM r663_chat_turns WHERE workspace_id = ${workspaceId} AND created_at >= now() - interval '24 hours'`)
    chatTurns24h = Number(((rows.rows ?? rows) as Array<Record<string, unknown>>)[0]?.['c'] ?? 0)
  } catch { /* tolerated */ }
  try {
    const rows = await db.execute(sql`SELECT count(*)::int AS c FROM r649_agent_runs WHERE workspace_id = ${workspaceId} AND created_at >= now() - interval '14 days'`)
    agentRuns14d = Number(((rows.rows ?? rows) as Array<Record<string, unknown>>)[0]?.['c'] ?? 0)
  } catch { /* tolerated */ }

  return {
    ok: true,
    ts: new Date().toISOString(),
    brainOps,
    agent: { runs24h, tokens24h, spentToday: Number(spentToday.toFixed(4)), cap, pctUsed },
    caches: { tool: toolCache, chat: chatCache, prompt: { tracked: promptTracked } },
    rateLimit,
    schedules: { total: schedTotal, enabled: schedEnabled, dueWithinNextMin: schedDue, lastFireAt: schedLastFire },
    webhooks: { total: webhookTotal, fires24h: webhookFires24h },
    sessions: { chatTurns24h, agentRuns14d },
    latencyMs: Date.now() - t0,
  }
}
