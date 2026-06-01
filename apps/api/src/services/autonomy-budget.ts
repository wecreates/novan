/**
 * autonomy-budget.ts — R146.97 — operator-configurable spend autonomy.
 *
 * The brain checks against the budget BEFORE every meaningful spend op.
 * Below the period ceiling → autonomous. Above → escalates and waits for
 * OPERATOR_APPROVED. Removes the operator as the perpetual bottleneck on
 * every $5 ad-spend decision.
 */
import { db } from '../db/client.js'
import { autonomyBudgets, autonomySpendLog, events } from '../db/schema.js'
import { and, eq, gte, sql, desc } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

export type BudgetCategory = 'ads' | 'content-gen' | 'data' | 'all'
export type BudgetPeriod   = 'daily' | 'weekly' | 'monthly'

export async function setBudget(input: { workspaceId: string; businessId?: string; category: BudgetCategory; period: BudgetPeriod; ceilingUsd: number; notes?: string }): Promise<{ id: string }> {
  const id = uuidv7()
  const now = Date.now()
  await db.insert(autonomyBudgets).values({
    id,
    workspaceId: input.workspaceId,
    ...(input.businessId ? { businessId: input.businessId } : {}),
    category:    input.category,
    period:      input.period,
    ceilingUsd:  Math.max(0, input.ceilingUsd),
    enabled:     true,
    ...(input.notes ? { notes: input.notes.slice(0, 500) } : {}),
    createdAt:   now,
    updatedAt:   now,
  })
  return { id }
}

export async function listBudgets(workspaceId: string, businessId?: string): Promise<unknown[]> {
  if (businessId) {
    return db.select().from(autonomyBudgets)
      .where(and(eq(autonomyBudgets.workspaceId, workspaceId), eq(autonomyBudgets.businessId, businessId)))
      .orderBy(desc(autonomyBudgets.createdAt))
  }
  return db.select().from(autonomyBudgets)
    .where(eq(autonomyBudgets.workspaceId, workspaceId))
    .orderBy(desc(autonomyBudgets.createdAt))
}

export async function disableBudget(workspaceId: string, id: string): Promise<void> {
  await db.update(autonomyBudgets)
    .set({ enabled: false, updatedAt: Date.now() })
    .where(and(eq(autonomyBudgets.workspaceId, workspaceId), eq(autonomyBudgets.id, id)))
}

function periodWindowMs(period: BudgetPeriod): number {
  return period === 'daily' ? 86_400_000 : period === 'weekly' ? 7 * 86_400_000 : 30 * 86_400_000
}

export async function periodSpend(workspaceId: string, opts: { businessId?: string; category: BudgetCategory; period: BudgetPeriod }): Promise<number> {
  const since = Date.now() - periodWindowMs(opts.period)
  const conds = [
    eq(autonomySpendLog.workspaceId, workspaceId),
    eq(autonomySpendLog.category, opts.category),
    gte(autonomySpendLog.recordedAt, since),
  ]
  if (opts.businessId) conds.push(eq(autonomySpendLog.businessId, opts.businessId))
  const q = await db.select({ total: sql<number>`coalesce(sum(amount_usd), 0)` })
    .from(autonomySpendLog)
    .where(and(...conds))
  return Number(q[0]?.total ?? 0)
}

export interface CheckSpendInput {
  workspaceId: string
  businessId?: string
  category:    BudgetCategory
  amountUsd:   number
}

export interface CheckSpendResult {
  withinBudget:        boolean
  matchedBudget:       { id: string; ceilingUsd: number; period: BudgetPeriod; spentSoFarUsd: number; remainingUsd: number } | null
  reason:              string
}

/** Check whether a proposed spend can proceed autonomously. */
export async function checkSpend(input: CheckSpendInput): Promise<CheckSpendResult> {
  // Find the most specific matching budget. Order of preference:
  //   1. business + category
  //   2. business + 'all'
  //   3. workspace + category
  //   4. workspace + 'all'
  const rowsRaw = await db.select().from(autonomyBudgets)
    .where(and(eq(autonomyBudgets.workspaceId, input.workspaceId), eq(autonomyBudgets.enabled, true)))
  const rows = rowsRaw as Array<{ id: string; businessId: string | null; category: string; period: string; ceilingUsd: number }>

  const candidates = [
    input.businessId ? rows.find(r => r.businessId === input.businessId && r.category === input.category) : undefined,
    input.businessId ? rows.find(r => r.businessId === input.businessId && r.category === 'all')          : undefined,
    rows.find(r => !r.businessId && r.category === input.category),
    rows.find(r => !r.businessId && r.category === 'all'),
  ].filter(Boolean) as Array<{ id: string; businessId: string | null; category: string; period: string; ceilingUsd: number }>

  if (candidates.length === 0) {
    return { withinBudget: false, matchedBudget: null, reason: 'no autonomy budget configured — operator approval required' }
  }
  const b = candidates[0]!
  const spentArgs: { businessId?: string; category: BudgetCategory; period: BudgetPeriod } = {
    category: b.category as BudgetCategory,
    period:   b.period   as BudgetPeriod,
  }
  if (b.businessId) spentArgs.businessId = b.businessId
  const spent = await periodSpend(input.workspaceId, spentArgs)
  const ceiling = Number(b.ceilingUsd)
  const remaining = Math.max(0, ceiling - spent)
  const withinBudget = (spent + input.amountUsd) <= ceiling
  const matchedBudget = { id: b.id, ceilingUsd: ceiling, period: b.period as BudgetPeriod, spentSoFarUsd: spent, remainingUsd: remaining }
  if (!withinBudget) {
    return { withinBudget, matchedBudget, reason: `proposed $${input.amountUsd} + period spend $${spent.toFixed(2)} > ceiling $${ceiling} (${b.period}). Operator approval required.` }
  }
  return { withinBudget, matchedBudget, reason: `within ${b.period} budget — $${remaining.toFixed(2)} remaining` }
}

/** Record an autonomous spend after the action succeeds. */
export async function logSpend(input: { workspaceId: string; businessId?: string; category: BudgetCategory; amountUsd: number; op: string; reason?: string }): Promise<void> {
  await db.insert(autonomySpendLog).values({
    id:          uuidv7(),
    workspaceId: input.workspaceId,
    ...(input.businessId ? { businessId: input.businessId } : {}),
    category:    input.category,
    amountUsd:   Math.max(0, input.amountUsd),
    op:          input.op.slice(0, 100),
    ...(input.reason ? { reason: input.reason.slice(0, 500) } : {}),
    recordedAt:  Date.now(),
  })
  await db.insert(events).values({
    id: uuidv7(), type: 'autonomy.spend_logged', workspaceId: input.workspaceId,
    payload: { businessId: input.businessId ?? null, category: input.category, amountUsd: input.amountUsd, op: input.op },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'autonomy-budget', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

export async function spendSummary(workspaceId: string, businessId?: string): Promise<{
  workspaceId: string; businessId: string | null
  spendByCategory: Record<string, { daily: number; weekly: number; monthly: number }>
  budgets: unknown[]
}> {
  const spendByCategory: Record<string, { daily: number; weekly: number; monthly: number }> = {}
  const cats: BudgetCategory[] = ['ads', 'content-gen', 'data', 'all']
  for (const cat of cats) {
    const dArgs: { businessId?: string; category: BudgetCategory; period: BudgetPeriod } = { category: cat, period: 'daily' }
    const wArgs: { businessId?: string; category: BudgetCategory; period: BudgetPeriod } = { category: cat, period: 'weekly' }
    const mArgs: { businessId?: string; category: BudgetCategory; period: BudgetPeriod } = { category: cat, period: 'monthly' }
    if (businessId) {
      dArgs.businessId = businessId; wArgs.businessId = businessId; mArgs.businessId = businessId
    }
    spendByCategory[cat] = {
      daily:   await periodSpend(workspaceId, dArgs),
      weekly:  await periodSpend(workspaceId, wArgs),
      monthly: await periodSpend(workspaceId, mArgs),
    }
  }
  const budgets = await listBudgets(workspaceId, businessId)
  return { workspaceId, businessId: businessId ?? null, spendByCategory, budgets }
}
