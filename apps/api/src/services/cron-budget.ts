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
import { eq } from 'drizzle-orm'
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
    .where(eq(cronBudgets.cronName, cronName)).limit(1).then(r => r[0]).catch(() => null)
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
  }).onConflictDoNothing().catch(() => null)
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
    }).where(eq(cronBudgets.id, row.id)).catch(() => null)
    return {
      ok: true, blocked: false,
      remaining: { calls: row.maxCalls, tokens: row.maxTokens, costUsd: row.maxCostUsd },
    }
  }

  const overCalls  = row.callsUsed   >= row.maxCalls
  const overTokens = row.tokensUsed  >= row.maxTokens
  const overCost   = row.costUsdUsed >= row.maxCostUsd
  if (overCalls || overTokens || overCost) {
    if (!row.blocked) {
      await db.update(cronBudgets).set({ blocked: true, lastBlockedAt: now, updatedAt: now })
        .where(eq(cronBudgets.id, row.id)).catch(() => null)
    }
    return {
      ok: false, blocked: true,
      reason: overCalls ? 'calls_exceeded' : overTokens ? 'tokens_exceeded' : 'cost_exceeded',
      remaining: { calls: 0, tokens: 0, costUsd: 0 },
    }
  }

  return {
    ok: true, blocked: false,
    remaining: {
      calls:   Math.max(0, row.maxCalls   - row.callsUsed),
      tokens:  Math.max(0, row.maxTokens  - row.tokensUsed),
      costUsd: Math.max(0, Number((row.maxCostUsd - row.costUsdUsed).toFixed(4))),
    },
  }
}

/** Record consumption after the cron runs. */
export async function consume(cronName: string, used: { calls?: number; tokens?: number; costUsd?: number }): Promise<void> {
  const row = await db.select().from(cronBudgets)
    .where(eq(cronBudgets.cronName, cronName)).limit(1).then(r => r[0]).catch(() => null)
  if (!row) return
  await db.update(cronBudgets).set({
    callsUsed:   row.callsUsed   + (used.calls   ?? 1),
    tokensUsed:  row.tokensUsed  + (used.tokens  ?? 0),
    costUsdUsed: Number((row.costUsdUsed + (used.costUsd ?? 0)).toFixed(4)),
    updatedAt:   Date.now(),
  }).where(eq(cronBudgets.id, row.id)).catch(() => null)
}

export async function listBudgets() {
  return db.select().from(cronBudgets).catch(() => [])
}
