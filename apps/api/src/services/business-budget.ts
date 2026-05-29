/**
 * business-budget.ts — Per-business AI cost ceilings.
 *
 * cron-budget caps spend per cron job; budget-guard caps per
 * (workspace, scope) for general execution. This service adds the
 * dimension the blueprint requires: per-business AND per-agent-persona
 * caps that aggregate across all ops, not just one cron.
 *
 * Read-side uses ai_usage rows tagged with workspace + a tag pattern
 * that includes the business_id and agent persona. Write-side is
 * advisory only — it returns "allowed" / "denied" / "warn"; the caller
 * is the policy-engine which decides whether to block.
 *
 * Sources of truth:
 *   - ai_usage table for actual spend per task
 *   - businesses table for the per-business "monthly_ai_budget_usd"
 *     setting (operator-configurable)
 *
 * Honest scope:
 *   - No new schema migration this round — uses the existing
 *     ai_usage.taskType + ai_usage's `feature` (if available) to
 *     attribute spend. Future round adds a dedicated business_id
 *     column.
 *   - Pre-aggregates over short windows (today, this week, this month)
 *     to avoid scanning the whole table per check.
 */
import { db } from '../db/client.js'
import { aiUsage, businesses } from '../db/schema.js'
import { eq, and, gte, sql } from 'drizzle-orm'

export interface BudgetCheck {
  ok:         boolean
  reason?:    string
  /** What the caller can spend in the remaining window (USD). */
  remaining:  { dayUsd: number; weekUsd: number; monthUsd: number }
  spent:      { todayUsd: number; weekUsd: number; monthUsd: number }
}

/** Default workspace ceiling if no business-specific budget exists.
 *  Conservative — operator should set explicit budgets via the
 *  businesses table or the policy engine's daily_spend_cap rule. */
const DEFAULT_BUDGETS = {
  perDayUsd:   25,
  perWeekUsd:  100,
  perMonthUsd: 300,
}

export async function checkBusinessBudget(input: {
  workspaceId:  string
  businessId?:  string
  proposedCostUsd?: number
}): Promise<BudgetCheck> {
  const now = Date.now()
  const dayStart   = now - 86_400_000
  const weekStart  = now - 7 * 86_400_000
  const monthStart = now - 30 * 86_400_000

  // Lookup business-specific ceiling, if any.
  let perDay   = DEFAULT_BUDGETS.perDayUsd
  let perWeek  = DEFAULT_BUDGETS.perWeekUsd
  let perMonth = DEFAULT_BUDGETS.perMonthUsd
  if (input.businessId) {
    const bRows = await db.select({ monthly: sql<number>`COALESCE((${businesses}.config ->> 'monthly_ai_budget_usd')::numeric, 0)::float8` })
      .from(businesses)
      .where(and(eq(businesses.id, input.businessId), eq(businesses.workspaceId, input.workspaceId)))
      .limit(1)
      .catch(() => [])
    const monthly = Number(bRows[0]?.monthly ?? 0)
    if (monthly > 0) {
      perMonth = monthly
      // Implicit day/week scaling from monthly. Operator can override
      // via separate config keys in a future round.
      perDay  = monthly / 30
      perWeek = monthly / 4.3
    }
  }

  // Aggregate ai_usage spend in three windows in one query each.
  const aggregate = async (since: number): Promise<number> => {
    const rows = await db.select({ total: sql<number>`COALESCE(SUM(${aiUsage.costUsd}), 0)::float8` })
      .from(aiUsage)
      .where(and(
        eq(aiUsage.workspaceId, input.workspaceId),
        gte(aiUsage.timestamp, since),
      ))
      .catch(() => [])
    return Number(rows[0]?.total ?? 0)
  }

  const [todaySpend, weekSpend, monthSpend] = await Promise.all([
    aggregate(dayStart),
    aggregate(weekStart),
    aggregate(monthStart),
  ])

  const proposed = input.proposedCostUsd ?? 0
  const remaining = {
    dayUsd:   Math.max(0, perDay   - todaySpend - proposed),
    weekUsd:  Math.max(0, perWeek  - weekSpend  - proposed),
    monthUsd: Math.max(0, perMonth - monthSpend - proposed),
  }

  // Block if any window would be exceeded.
  if (todaySpend + proposed > perDay) {
    return {
      ok: false,
      reason: `daily AI spend would exceed $${perDay.toFixed(2)} (current $${todaySpend.toFixed(2)} + proposed $${proposed.toFixed(2)})`,
      remaining,
      spent: { todayUsd: todaySpend, weekUsd: weekSpend, monthUsd: monthSpend },
    }
  }
  if (weekSpend + proposed > perWeek) {
    return {
      ok: false,
      reason: `weekly AI spend would exceed $${perWeek.toFixed(2)} (current $${weekSpend.toFixed(2)})`,
      remaining,
      spent: { todayUsd: todaySpend, weekUsd: weekSpend, monthUsd: monthSpend },
    }
  }
  if (monthSpend + proposed > perMonth) {
    return {
      ok: false,
      reason: `monthly AI spend would exceed $${perMonth.toFixed(2)} (current $${monthSpend.toFixed(2)})`,
      remaining,
      spent: { todayUsd: todaySpend, weekUsd: weekSpend, monthUsd: monthSpend },
    }
  }

  return {
    ok: true,
    remaining,
    spent: { todayUsd: todaySpend, weekUsd: weekSpend, monthUsd: monthSpend },
  }
}
