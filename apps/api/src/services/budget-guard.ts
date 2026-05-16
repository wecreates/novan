/**
 * Budget Guard Service
 *
 * Preflight cost estimation and hard-block before provider calls.
 * Records every guard decision in execution_guards for audit.
 */

import { v7 as uuidv7 }    from 'uuid'
import { and, eq, lt, sql } from 'drizzle-orm'
import { db }                from '../db/client.js'
import {
  budgetCaps, executionGuards, events,
} from '../db/schema.js'
import { checkBudgetPreflight } from '@ops/ai-router'
import type { BudgetCap }       from '@ops/ai-router'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PreflightContext {
  workspaceId:  string
  executionId:  string    // run_id / job_id being guarded
  providerId:   string
  scopeType:    string    // workspace | user | project | provider | workflow
  scopeId:      string    // entity id
  estimatedCostUsd: number
  isWorkflow?:  boolean
}

export interface GuardDecision {
  guardId:     string
  approved:    boolean
  blockReason: string | null
  capId:       string | null
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function emitGuardEvent(
  workspaceId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId,
    payload, traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/budget-guard', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

// ─── Cap management ───────────────────────────────────────────────────────────

/**
 * Load all enabled budget caps for a workspace, resetting stale daily/monthly windows.
 */
export async function loadActiveCaps(workspaceId: string): Promise<BudgetCap[]> {
  const now = Date.now()

  // Reset expired daily windows
  await db.update(budgetCaps)
    .set({ currentDailyUsd: 0, dailyResetAt: now + 86_400_000, updatedAt: now })
    .where(and(eq(budgetCaps.workspaceId, workspaceId), lt(budgetCaps.dailyResetAt, now)))
    .catch(() => null)

  // Reset expired monthly windows
  await db.update(budgetCaps)
    .set({ currentMonthlyUsd: 0, monthlyResetAt: now + 30 * 86_400_000, updatedAt: now })
    .where(and(eq(budgetCaps.workspaceId, workspaceId), lt(budgetCaps.monthlyResetAt, now)))
    .catch(() => null)

  const rows = await db.select().from(budgetCaps)
    .where(and(eq(budgetCaps.workspaceId, workspaceId), eq(budgetCaps.enabled, true)))

  return rows as BudgetCap[]
}

/** Create or upsert a budget cap. */
export async function upsertBudgetCap(
  workspaceId: string,
  scopeType:   string,
  scopeId:     string,
  limits: {
    maxDailyUsd?:         number
    maxMonthlyUsd?:       number
    maxPerExecutionUsd?:  number
    maxWorkflowUsd?:      number
  },
): Promise<typeof budgetCaps.$inferSelect> {
  const now        = Date.now()
  const dayEnd     = new Date(); dayEnd.setHours(23, 59, 59, 999); const dayEndMs = dayEnd.getTime()
  const monthEnd   = new Date(); monthEnd.setDate(1); monthEnd.setMonth(monthEnd.getMonth() + 1); const monthEndMs = monthEnd.getTime()

  const [row] = await db.insert(budgetCaps).values({
    id:                  uuidv7(),
    workspaceId,
    scopeType,
    scopeId,
    maxDailyUsd:         limits.maxDailyUsd         ?? 0,
    maxMonthlyUsd:       limits.maxMonthlyUsd        ?? 0,
    maxPerExecutionUsd:  limits.maxPerExecutionUsd   ?? 0,
    maxWorkflowUsd:      limits.maxWorkflowUsd       ?? 0,
    currentDailyUsd:     0,
    currentMonthlyUsd:   0,
    dailyResetAt:        dayEndMs,
    monthlyResetAt:      monthEndMs,
    enabled:             true,
    createdAt:           now,
    updatedAt:           now,
  }).onConflictDoUpdate({
    target: [budgetCaps.workspaceId, budgetCaps.scopeType, budgetCaps.scopeId],
    set: {
      maxDailyUsd:        limits.maxDailyUsd        ?? sql`max_daily_usd`,
      maxMonthlyUsd:      limits.maxMonthlyUsd       ?? sql`max_monthly_usd`,
      maxPerExecutionUsd: limits.maxPerExecutionUsd  ?? sql`max_per_execution_usd`,
      maxWorkflowUsd:     limits.maxWorkflowUsd      ?? sql`max_workflow_usd`,
      enabled:            true,
      updatedAt:          now,
    },
  }).returning()

  return row!
}

// ─── Preflight ────────────────────────────────────────────────────────────────

/**
 * Run preflight check. Blocks execution if any applicable cap is exceeded.
 * Persists guard decision to `execution_guards`.
 * Emits `budget.approved` or `budget.blocked` event.
 */
export async function runPreflight(ctx: PreflightContext): Promise<GuardDecision> {
  const caps   = await loadActiveCaps(ctx.workspaceId)
  const result = checkBudgetPreflight(ctx.estimatedCostUsd, caps, ctx.isWorkflow ?? false)

  const guardId = uuidv7()
  const now     = Date.now()

  await db.insert(executionGuards).values({
    id:               guardId,
    workspaceId:      ctx.workspaceId,
    executionId:      ctx.executionId,
    scopeType:        ctx.scopeType,
    scopeId:          ctx.scopeId,
    providerId:       ctx.providerId,
    estimatedCostUsd: ctx.estimatedCostUsd,
    decision:         result.approved ? 'approved' : 'blocked',
    blockReason:      result.blockReason,
    capId:            result.capId,
    actualCostUsd:    null,
    createdAt:        now,
  }).catch(() => null)

  const eventType = result.approved ? 'budget.approved' : 'budget.blocked'
  await emitGuardEvent(ctx.workspaceId, eventType, {
    guardId,
    executionId:      ctx.executionId,
    providerId:       ctx.providerId,
    estimatedCostUsd: ctx.estimatedCostUsd,
    decision:         result.approved ? 'approved' : 'blocked',
    blockReason:      result.blockReason ?? undefined,
    capId:            result.capId ?? undefined,
  })

  return { guardId, approved: result.approved, blockReason: result.blockReason, capId: result.capId }
}

/**
 * Record actual cost after execution and update cap spend counters.
 */
export async function recordGuardActualCost(
  executionId:    string,
  workspaceId:    string,
  actualCostUsd:  number,
): Promise<void> {
  const now = Date.now()

  // Update guard record
  await db.update(executionGuards)
    .set({ actualCostUsd })
    .where(and(
      eq(executionGuards.executionId, executionId),
      eq(executionGuards.workspaceId, workspaceId),
      eq(executionGuards.decision, 'approved'),
    ))
    .catch(() => null)

  // Increment cap spend counters
  await db.update(budgetCaps)
    .set({
      currentDailyUsd:   sql`${budgetCaps.currentDailyUsd} + ${actualCostUsd}`,
      currentMonthlyUsd: sql`${budgetCaps.currentMonthlyUsd} + ${actualCostUsd}`,
      updatedAt:         now,
    })
    .where(eq(budgetCaps.workspaceId, workspaceId))
    .catch(() => null)
}
