/**
 * plan-features.ts — Feature-gate accessor against existing plans table.
 *
 * Reads workspaces.plan + plans.featureFlags. Default plans seeded on first
 * call (idempotent). Treats workspaces.plan as authoritative.
 *
 * NOT a SaaS surface — no Stripe webhook, no upgrade flow. Just feature
 * accessors that match the existing schema so future monetization can be
 * layered without re-wiring callers.
 */
import { db }                          from '../db/client.js'
import { plans, workspaces }           from '../db/schema.js'
import { eq, sql }                     from 'drizzle-orm'

export type Feature =
  | 'autonomous_agents'
  | 'advanced_research'
  | 'image_generation'
  | 'replay_rollback'
  | 'remote_workers'
  | 'advanced_telemetry'

export interface PlanDef {
  id:                   string
  name:                 string
  monthlyPriceUsd:      number
  monthlySpendLimitUsd: number
  monthlyTokenLimit:    number
  workflowLimit:        number
  features:             Record<Feature, boolean>
}

const DEFAULT_PLANS: PlanDef[] = [
  {
    id: 'free', name: 'Free',
    monthlyPriceUsd: 0, monthlySpendLimitUsd: 5, monthlyTokenLimit: 200_000, workflowLimit: 10,
    features: {
      autonomous_agents: false,
      advanced_research: true,   // basic research enabled even on free
      image_generation:  true,
      replay_rollback:   false,
      remote_workers:    false,
      advanced_telemetry: false,
    },
  },
  {
    id: 'pro', name: 'Pro',
    monthlyPriceUsd: 49, monthlySpendLimitUsd: 100, monthlyTokenLimit: 10_000_000, workflowLimit: 200,
    features: {
      autonomous_agents: true,
      advanced_research: true,
      image_generation:  true,
      replay_rollback:   true,
      remote_workers:    true,
      advanced_telemetry: true,
    },
  },
  {
    id: 'enterprise', name: 'Enterprise',
    monthlyPriceUsd: 0, monthlySpendLimitUsd: 100_000, monthlyTokenLimit: 1_000_000_000, workflowLimit: 100_000,
    features: {
      autonomous_agents: true,
      advanced_research: true,
      image_generation:  true,
      replay_rollback:   true,
      remote_workers:    true,
      advanced_telemetry: true,
    },
  },
]

let SEEDED = false
async function ensurePlansSeeded(): Promise<void> {
  if (SEEDED) return
  const now = Date.now()
  for (const p of DEFAULT_PLANS) {
    await db.insert(plans).values({
      id: p.id, name: p.name,
      monthlyPriceUsd:      p.monthlyPriceUsd,
      seatLimit:            p.id === 'enterprise' ? 100 : p.id === 'pro' ? 10 : 1,
      workflowLimit:        p.workflowLimit,
      workspaceLimit:       p.id === 'enterprise' ? 100 : p.id === 'pro' ? 5 : 1,
      monthlyTokenLimit:    p.monthlyTokenLimit,
      monthlySpendLimitUsd: p.monthlySpendLimitUsd,
      featureFlags:         p.features as unknown as Record<string, unknown>,
      isActive:             true,
      createdAt:            now,
    }).onConflictDoNothing().catch(() => null)
  }
  SEEDED = true
}

export async function getWorkspacePlan(workspaceId: string): Promise<PlanDef> {
  await ensurePlansSeeded()
  const ws = await db.select({ plan: workspaces.plan }).from(workspaces)
    .where(eq(workspaces.id, workspaceId)).limit(1).then(r => r[0])
  const planId = ws?.plan ?? 'free'
  const row = await db.select().from(plans).where(eq(plans.id, planId)).limit(1).then(r => r[0])
  if (!row) return DEFAULT_PLANS[0]!   // free fallback
  return {
    id: row.id, name: row.name,
    monthlyPriceUsd:      row.monthlyPriceUsd,
    monthlySpendLimitUsd: row.monthlySpendLimitUsd,
    monthlyTokenLimit:    row.monthlyTokenLimit,
    workflowLimit:        row.workflowLimit,
    features:             (row.featureFlags as Record<Feature, boolean>) ?? DEFAULT_PLANS[0]!.features,
  }
}

export async function canUseFeature(workspaceId: string, feature: Feature): Promise<{ allowed: boolean; plan: string; reason?: string }> {
  const plan = await getWorkspacePlan(workspaceId)
  const allowed = !!plan.features[feature]
  return allowed
    ? { allowed: true, plan: plan.id }
    : { allowed: false, plan: plan.id, reason: `feature '${feature}' not enabled on plan '${plan.id}'` }
}

export async function listPlans(): Promise<PlanDef[]> {
  await ensurePlansSeeded()
  const rows = await db.select().from(plans).where(eq(plans.isActive, true)).catch(() => [])
  return rows.map(r => ({
    id: r.id, name: r.name,
    monthlyPriceUsd:      r.monthlyPriceUsd,
    monthlySpendLimitUsd: r.monthlySpendLimitUsd,
    monthlyTokenLimit:    r.monthlyTokenLimit,
    workflowLimit:        r.workflowLimit,
    features:             (r.featureFlags as Record<Feature, boolean>) ?? DEFAULT_PLANS[0]!.features,
  }))
}
