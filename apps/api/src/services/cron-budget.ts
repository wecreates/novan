/**
 * cron-budget.ts — Tier-3: per-cron call/token/cost ceilings.
 *
 * Each cron task acquires budget before running heavy work. If the
 * window's budget is exceeded, the cron is blocked until the window
 * rolls over.
 *
 * Honest scope: enforces ceilings the cron declares for itself. Cannot
 * stop hard-coded loops inside services from spending — this is opt-in.
 */
import { db } from '../db/client.js'
import { cronBudgets } from '../db/schema.js'
import { eq, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

export interface BudgetCheck {
  ok:       boolean
  blocked:  boolean
  reason?:  string
  remaining: { calls: number; tokens: number; costUsd: number }
}

interface BudgetConfig {
  maxCalls?: number
  maxTokens?: number
  maxCostUsd?: number
  windowMs?: number
}

async function ensureRow(cronName: string, cfg: BudgetConfig) {
  const now = Date.now()
  const existing = await db.select().from(cronBudgets)
    .where(eq(cronBudgets.cronName, cronName)).limit(1).then(r => r[0]).catch((e: Error) => { console.error('[cron-budget]', e.message); return null })
  if (existing) return existing
  await db.insert(cronBudgets).values({
    id: uuidv7(), cronName,
    windowStart: now,
    callsUsed: 0, tokensUsed: 0, costUsdUsed: 0,
    maxCalls:    cfg.maxCalls    ?? 1000,
    maxTokens:   cfg.maxTokens   ?? 1_000_000,
    maxCostUsd:  cfg.maxCostUsd  ?? 5.0,
    windowMs:    cfg.windowMs    ?? 3_600_000,
    blocked:     false, updatedAt: now,
  }).onConflictDoNothing().catch((e: Error) => { console.error('[cron-budget]', e.message); return null })
  return db.select().from(cronBudgets).where(eq(cronBudgets.cronName, cronName)).limit(1).then(r => r[0])
}

/** Call before a cron does heavy work. Rolls the window if expired. */
export async function checkBudget(cronName: string, cfg: BudgetConfig = {}): Promise<BudgetCheck> {
  const row = await ensureRow(cronName, cfg)
  if (!row) return { ok: true, blocked: false, remaining: { calls: 0, tokens: 0, costUsd: 0 } }

  const now = Date.now()
  // Roll window if expired
  if (now - Number(row.windowStart) >= Number(row.windowMs)) {
    await db.update(cronBudgets).set({
      windowStart: now,
      callsUsed: 0, tokensUsed: 0, costUsdUsed: 0,
      blocked: false, updatedAt: now,
    }).where(eq(cronBudgets.id, row.id)).catch((e: Error) => { console.error('[cron-budget]', e.message); return null })
    return {
      ok: true, blocked: false,
      remaining: { calls: row.maxCalls, tokens: row.maxTokens, costUsd: row.maxCostUsd },
    }
  }

  // A max of 0 means "no limit on this dimension"
  const overCalls  = row.maxCalls    > 0 && row.callsUsed   >= row.maxCalls
  const overTokens = row.maxTokens   > 0 && row.tokensUsed  >= row.maxTokens
  const overCost   = row.maxCostUsd  > 0 && row.costUsdUsed >= row.maxCostUsd
  if (overCalls || overTokens || overCost) {
    if (!row.blocked) {
      await db.update(cronBudgets).set({ blocked: true, lastBlockedAt: now, updatedAt: now })
        .where(eq(cronBudgets.id, row.id)).catch((e: Error) => { console.error('[cron-budget]', e.message); return null })
    }
    return {
      ok: false, blocked: true,
      reason: overCalls ? 'calls_exceeded' : overTokens ? 'tokens_exceeded' : 'cost_exceeded',
      remaining: { calls: 0, tokens: 0, costUsd: 0 },
    }
  }

  // If we were previously blocked but no longer over, clear the flag
  if (row.blocked) {
    await db.update(cronBudgets).set({ blocked: false, updatedAt: now })
      .where(eq(cronBudgets.id, row.id)).catch((e: Error) => { console.error('[cron-budget]', e.message); return null })
  }

  return {
    ok: true, blocked: false,
    remaining: {
      calls:   row.maxCalls   > 0 ? Math.max(0, row.maxCalls   - row.callsUsed)   : Number.POSITIVE_INFINITY,
      tokens:  row.maxTokens  > 0 ? Math.max(0, row.maxTokens  - row.tokensUsed)  : Number.POSITIVE_INFINITY,
      costUsd: row.maxCostUsd > 0 ? Math.max(0, Number((row.maxCostUsd - row.costUsdUsed).toFixed(4))) : Number.POSITIVE_INFINITY,
    },
  }
}

/** Record consumption after the cron runs.
 *  Atomic SQL increment — the previous read-modify-write pattern lost
 *  one tick's consumption when two cron instances overlapped (slow exec
 *  + next-tick fire). Postgres-level `col = col + N` is concurrency-safe. */
export async function consume(cronName: string, used: { calls?: number; tokens?: number; costUsd?: number }): Promise<void> {
  const dCalls  = used.calls   ?? 1
  const dTokens = used.tokens  ?? 0
  const dCost   = used.costUsd ?? 0
  await db.update(cronBudgets).set({
    callsUsed:   sql`${cronBudgets.callsUsed}   + ${dCalls}`,
    tokensUsed:  sql`${cronBudgets.tokensUsed}  + ${dTokens}`,
    costUsdUsed: sql`ROUND((${cronBudgets.costUsdUsed} + ${dCost})::numeric, 4)`,
    updatedAt:   Date.now(),
  }).where(eq(cronBudgets.cronName, cronName)).catch((e: Error) => { console.error('[cron-budget]', e.message); return null })
}

export async function listBudgets() {
  return db.select().from(cronBudgets).catch(() => [])
}
