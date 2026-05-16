import type { BudgetState, BudgetLimits } from './types.js'

// ─── In-memory budget tracker (reset daily/monthly) ──────────────────────────
// For production: back this with Redis or Postgres. For now, process-level.

const DEFAULT_LIMITS: BudgetLimits = {
  dailyUsd:   parseFloat(process.env['AI_BUDGET_DAILY_USD']   ?? '10'),
  monthlyUsd: parseFloat(process.env['AI_BUDGET_MONTHLY_USD'] ?? '100'),
}

const budgets = new Map<string, BudgetState>()

function getDay():   string { return new Date().toISOString().slice(0, 10) }
function getMonth(): string { return new Date().toISOString().slice(0, 7) }

function getOrCreate(workspaceId: string): BudgetState {
  let b = budgets.get(workspaceId)
  const now = Date.now()
  if (!b) {
    b = { workspaceId, dailySpendUsd: 0, monthlySpendUsd: 0, lastReset: now }
    budgets.set(workspaceId, b)
  }
  // Daily reset
  const day = new Date(b.lastReset).toISOString().slice(0, 10)
  if (day !== getDay()) {
    b.dailySpendUsd = 0
    b.lastReset = now
  }
  // Monthly reset
  const month = new Date(b.lastReset).toISOString().slice(0, 7)
  if (month !== getMonth()) {
    b.monthlySpendUsd = 0
  }
  return b
}

export function checkBudget(workspaceId: string, estimatedCostUsd: number, limits?: BudgetLimits): boolean {
  const lim = limits ?? DEFAULT_LIMITS
  const b   = getOrCreate(workspaceId)
  return (
    b.dailySpendUsd   + estimatedCostUsd <= lim.dailyUsd &&
    b.monthlySpendUsd + estimatedCostUsd <= lim.monthlyUsd
  )
}

export function recordSpend(workspaceId: string, costUsd: number): void {
  const b = getOrCreate(workspaceId)
  b.dailySpendUsd   += costUsd
  b.monthlySpendUsd += costUsd
}

export function getBudgetState(workspaceId: string): BudgetState {
  return getOrCreate(workspaceId)
}

export function getBudgetLimits(): BudgetLimits {
  return { ...DEFAULT_LIMITS }
}
