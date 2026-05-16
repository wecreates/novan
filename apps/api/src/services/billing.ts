/**
 * billing.ts — Multi-tenant subscription + usage metering.
 *
 * Stripe integration is referenced via opaque IDs (customerId, subscriptionId) — the
 * Stripe secret key is NEVER stored in this code or DB; it lives only in env and
 * is stripped from sandboxed processes by buildSandboxEnv().
 *
 * Plan limits are enforced via `assertWithinLimit()`.
 */
import { db }              from '../db/client.js'
import {
  plans, subscriptions, usageMeters, workspaces, events,
}                          from '../db/schema.js'
import { eq, and, desc, gt } from 'drizzle-orm'
import { v7 as uuidv7 }    from 'uuid'

export type SubStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'paused' | 'expired'
export type MeterKey =
  | 'provider_spend_usd' | 'tokens' | 'workflow_runs'
  | 'remote_worker_min' | 'storage_mb' | 'replay_count' | 'autonomous_runs'

async function emitEvent(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'billing', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

// ─── Period helpers ───────────────────────────────────────────────────────────

function currentMonthPeriod(): { start: number; end: number } {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() - 1
  return { start, end }
}

// ─── Plan management ──────────────────────────────────────────────────────────

export async function listPlans() {
  return db.select().from(plans).where(eq(plans.isActive, true))
}

export async function getPlan(planId: string) {
  const rows = await db.select().from(plans).where(eq(plans.id, planId)).limit(1)
  return rows[0] ?? null
}

// Seed defaults if no plans exist
export async function ensureDefaultPlans(): Promise<void> {
  const existing = await db.select({ id: plans.id }).from(plans).limit(1)
  if (existing.length > 0) return

  const now = Date.now()
  await db.insert(plans).values([
    {
      id: 'free', name: 'Free', monthlyPriceUsd: 0, seatLimit: 1, workflowLimit: 5,
      workspaceLimit: 1, monthlyTokenLimit: 100_000, monthlySpendLimitUsd: 10,
      featureFlags: { autonomousAgents: false, remoteWorkers: false }, isActive: true, createdAt: now,
    },
    {
      id: 'starter', name: 'Starter', monthlyPriceUsd: 49, seatLimit: 5, workflowLimit: 25,
      workspaceLimit: 3, monthlyTokenLimit: 1_000_000, monthlySpendLimitUsd: 100,
      featureFlags: { autonomousAgents: true, remoteWorkers: false }, isActive: true, createdAt: now,
    },
    {
      id: 'pro', name: 'Pro', monthlyPriceUsd: 199, seatLimit: 25, workflowLimit: 100,
      workspaceLimit: 10, monthlyTokenLimit: 10_000_000, monthlySpendLimitUsd: 500,
      featureFlags: { autonomousAgents: true, remoteWorkers: true }, isActive: true, createdAt: now,
    },
    {
      id: 'enterprise', name: 'Enterprise', monthlyPriceUsd: 999, seatLimit: 999, workflowLimit: 9999,
      workspaceLimit: 100, monthlyTokenLimit: 100_000_000, monthlySpendLimitUsd: 10_000,
      featureFlags: { autonomousAgents: true, remoteWorkers: true, ssoSaml: true, auditExport: true },
      isActive: true, createdAt: now,
    },
  ])
}

// ─── Subscription management ──────────────────────────────────────────────────

export async function getSubscription(workspaceId: string) {
  const rows = await db.select().from(subscriptions)
    .where(eq(subscriptions.workspaceId, workspaceId))
    .orderBy(desc(subscriptions.createdAt)).limit(1)
  return rows[0] ?? null
}

export interface CreateSubscriptionInput {
  workspaceId:          string
  planId:               string
  stripeCustomerId?:    string
  stripeSubscriptionId?: string
  trialDays?:           number
}

export async function createSubscription(input: CreateSubscriptionInput): Promise<string> {
  const now = Date.now()
  const trialEnd = input.trialDays ? now + input.trialDays * 24 * 3600_000 : null
  const id = uuidv7()

  await db.insert(subscriptions).values({
    id,
    workspaceId:          input.workspaceId,
    planId:               input.planId,
    status:               trialEnd ? 'trialing' : 'active',
    stripeCustomerId:     input.stripeCustomerId ?? null,
    stripeSubscriptionId: input.stripeSubscriptionId ?? null,
    currentPeriodStart:   now,
    currentPeriodEnd:     now + 30 * 24 * 3600_000,
    trialEndsAt:          trialEnd,
    canceledAt:           null,
    createdAt:            now,
    updatedAt:            now,
  })

  // Update workspace plan field for fast lookup
  await db.update(workspaces).set({ plan: input.planId, updatedAt: now })
    .where(eq(workspaces.id, input.workspaceId))

  await emitEvent(input.workspaceId, 'billing.subscription_created', {
    subscriptionId: id, planId: input.planId, trial: !!trialEnd,
  })
  return id
}

export async function updateSubscriptionStatus(
  subscriptionId: string, status: SubStatus, note?: string,
): Promise<void> {
  const rows = await db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId)).limit(1)
  const sub = rows[0]
  if (!sub) return
  const now = Date.now()
  await db.update(subscriptions).set({
    status,
    canceledAt: status === 'canceled' ? now : sub.canceledAt,
    updatedAt:  now,
  }).where(eq(subscriptions.id, subscriptionId))

  await emitEvent(sub.workspaceId, 'billing.subscription_updated', {
    subscriptionId, oldStatus: sub.status, newStatus: status, note,
  })
}

export async function changePlan(workspaceId: string, newPlanId: string): Promise<void> {
  const sub = await getSubscription(workspaceId)
  if (!sub) throw new Error('No subscription to change')
  const plan = await getPlan(newPlanId)
  if (!plan) throw new Error(`Unknown plan: ${newPlanId}`)

  const now = Date.now()
  await db.update(subscriptions).set({ planId: newPlanId, updatedAt: now })
    .where(eq(subscriptions.id, sub.id))
  await db.update(workspaces).set({ plan: newPlanId, updatedAt: now })
    .where(eq(workspaces.id, workspaceId))

  await emitEvent(workspaceId, 'billing.plan_changed', {
    subscriptionId: sub.id, oldPlanId: sub.planId, newPlanId,
  })
}

// ─── Usage metering ───────────────────────────────────────────────────────────

export async function recordUsage(
  workspaceId: string, key: MeterKey, amount: number,
): Promise<void> {
  if (amount <= 0) return
  const { start, end } = currentMonthPeriod()

  const existing = await db.select().from(usageMeters)
    .where(and(
      eq(usageMeters.workspaceId, workspaceId),
      eq(usageMeters.meterKey, key),
      eq(usageMeters.periodStart, start),
    )).limit(1)

  const now = Date.now()
  if (existing[0]) {
    await db.update(usageMeters).set({
      amount: existing[0].amount + amount, updatedAt: now,
    }).where(eq(usageMeters.id, existing[0].id))
  } else {
    await db.insert(usageMeters).values({
      id: uuidv7(),
      workspaceId, meterKey: key,
      periodStart: start, periodEnd: end,
      amount, updatedAt: now,
    })
  }
}

export async function getUsage(workspaceId: string, periodStart?: number) {
  const { start } = periodStart ? { start: periodStart } : currentMonthPeriod()
  return db.select().from(usageMeters)
    .where(and(
      eq(usageMeters.workspaceId, workspaceId),
      eq(usageMeters.periodStart, start),
    ))
}

// ─── Limit enforcement ────────────────────────────────────────────────────────

export interface LimitCheck {
  allowed:    boolean
  reason?:    string
  current:    number
  limit:      number
  meter:      MeterKey
  plan:       string
}

const KEY_TO_LIMIT_FIELD: Partial<Record<MeterKey, keyof typeof plans.$inferSelect>> = {
  tokens:             'monthlyTokenLimit',
  provider_spend_usd: 'monthlySpendLimitUsd',
}

export async function assertWithinLimit(
  workspaceId: string, key: MeterKey, attempting = 0,
): Promise<LimitCheck> {
  const sub = await getSubscription(workspaceId)
  const plan = sub ? await getPlan(sub.planId) : null

  if (!plan) {
    return { allowed: true, current: 0, limit: 0, meter: key, plan: 'unknown' }
  }

  const limitField = KEY_TO_LIMIT_FIELD[key]
  if (!limitField) {
    return { allowed: true, current: 0, limit: 0, meter: key, plan: plan.id }
  }

  const limit = plan[limitField] as number
  const usage = await getUsage(workspaceId)
  const currentRow = usage.find((u) => u.meterKey === key)
  const current = currentRow?.amount ?? 0
  const projected = current + attempting

  if (projected > limit) {
    return {
      allowed: false,
      reason: `Plan '${plan.id}' limit ${limit} for ${key} would be exceeded (current ${current}, attempting ${attempting})`,
      current, limit, meter: key, plan: plan.id,
    }
  }
  return { allowed: true, current, limit, meter: key, plan: plan.id }
}

// ─── Trial expiry check ───────────────────────────────────────────────────────

export async function expireTrials(): Promise<number> {
  const now = Date.now()
  const trialing = await db.select().from(subscriptions)
    .where(and(
      eq(subscriptions.status, 'trialing'),
      gt(subscriptions.trialEndsAt, 0),
    )).limit(500)

  let expired = 0
  for (const sub of trialing) {
    if (sub.trialEndsAt && sub.trialEndsAt < now) {
      await db.update(subscriptions).set({
        status: 'expired', updatedAt: now,
      }).where(eq(subscriptions.id, sub.id))
      await emitEvent(sub.workspaceId, 'billing.trial_expired', { subscriptionId: sub.id })
      expired += 1
    }
  }
  return expired
}
