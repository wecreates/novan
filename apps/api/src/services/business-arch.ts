/**
 * business-arch.ts — R146.89 — business architecture extensions:
 *  SKU/product-lines, runway, competitors, customer-segments, auto-postmortem,
 *  stage-transition rules.
 */
import { db } from '../db/client.js'
import { businesses, businessRevenue, events } from '../db/schema.js'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── SKU / Product-line (stored as events for now; lightweight) ─────────────

export async function addProductLine(input: { workspaceId: string; businessId: string; sku: string; name: string; priceUsd: number; cogsUsd?: number; tags?: string[] }): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(events).values({
    id: uuidv7(), type: 'productline.created', workspaceId: input.workspaceId,
    payload: { id, businessId: input.businessId, sku: input.sku.slice(0, 60), name: input.name.slice(0, 200), priceUsd: input.priceUsd, cogsUsd: input.cogsUsd ?? 0, marginUsd: input.priceUsd - (input.cogsUsd ?? 0), tags: (input.tags ?? []).slice(0, 10) },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'business-arch', version: 1, createdAt: Date.now(),
  })
  return { id }
}

export async function listProductLines(workspaceId: string, businessId?: string): Promise<Array<Record<string, unknown>>> {
  const rows = await db.select().from(events)
    .where(and(eq(events.workspaceId, workspaceId), eq(events.type, 'productline.created')))
    .orderBy(desc(events.createdAt)).limit(200)
  const all = rows.map(r => r.payload as Record<string, unknown>)
  return businessId ? all.filter(p => p['businessId'] === businessId) : all
}

// ─── Runway (cash + burn → months) ──────────────────────────────────────────

export async function runwayForBusiness(workspaceId: string, businessId: string, opts: { cashOnHandUsd?: number } = {}): Promise<{
  businessId: string; monthlyRevenueUsd: number; monthlySpendUsd: number; netBurnUsd: number; cashOnHandUsd: number; runwayMonths: number | 'infinite'
}> {
  const since = Date.now() - 30 * 86_400_000
  const revQ = await db.select({ total: sql<number>`coalesce(sum(amount_usd_cents), 0)::bigint` })
    .from(businessRevenue)
    .where(and(eq(businessRevenue.workspaceId, workspaceId), eq(businessRevenue.businessId, businessId), gte(businessRevenue.recordedAt, since)))
  const monthlyRevenueUsd = Number(revQ[0]?.total ?? 0) / 100
  // Spend proxy: events of type spend.* tagged to this business in last 30d
  const spendQ = await db.select({ total: sql<number>`coalesce(sum((payload->>'amountUsd')::numeric), 0)` })
    .from(events)
    .where(and(eq(events.workspaceId, workspaceId), gte(events.createdAt, since),
               sql`type like 'spend.%'`, sql`payload->>'businessId' = ${businessId}`))
  const monthlySpendUsd = Number(spendQ[0]?.total ?? 0)
  const netBurnUsd = monthlySpendUsd - monthlyRevenueUsd
  const cashOnHandUsd = Math.max(0, opts.cashOnHandUsd ?? 0)
  const runwayMonths = netBurnUsd <= 0 ? 'infinite' as const : Math.round((cashOnHandUsd / netBurnUsd) * 10) / 10
  return { businessId, monthlyRevenueUsd, monthlySpendUsd, netBurnUsd, cashOnHandUsd, runwayMonths }
}

// ─── Competitors ────────────────────────────────────────────────────────────

export async function addCompetitor(input: { workspaceId: string; businessId: string; name: string; url?: string; notes?: string; threat: 'low' | 'medium' | 'high' }): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(events).values({
    id: uuidv7(), type: 'competitor.added', workspaceId: input.workspaceId,
    payload: { id, businessId: input.businessId, name: input.name.slice(0, 200), url: (input.url ?? '').slice(0, 500), notes: (input.notes ?? '').slice(0, 800), threat: input.threat },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'business-arch', version: 1, createdAt: Date.now(),
  })
  return { id }
}

export async function listCompetitors(workspaceId: string, businessId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await db.select().from(events)
    .where(and(eq(events.workspaceId, workspaceId), eq(events.type, 'competitor.added')))
    .orderBy(desc(events.createdAt)).limit(200)
  return rows.map(r => r.payload as Record<string, unknown>).filter(p => p['businessId'] === businessId)
}

// ─── Customer segments ─────────────────────────────────────────────────────

export async function defineSegment(input: { workspaceId: string; businessId: string; name: string; criteria: string; estimatedSize?: number; ltvUsd?: number; cacUsd?: number }): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(events).values({
    id: uuidv7(), type: 'segment.defined', workspaceId: input.workspaceId,
    payload: { id, businessId: input.businessId, name: input.name.slice(0, 100), criteria: input.criteria.slice(0, 500),
               estimatedSize: input.estimatedSize ?? null, ltvUsd: input.ltvUsd ?? null, cacUsd: input.cacUsd ?? null,
               ltvCacRatio: (input.ltvUsd && input.cacUsd && input.cacUsd > 0) ? input.ltvUsd / input.cacUsd : null },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'business-arch', version: 1, createdAt: Date.now(),
  })
  return { id }
}

export async function listSegments(workspaceId: string, businessId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await db.select().from(events)
    .where(and(eq(events.workspaceId, workspaceId), eq(events.type, 'segment.defined')))
    .orderBy(desc(events.createdAt)).limit(200)
  return rows.map(r => r.payload as Record<string, unknown>).filter(p => p['businessId'] === businessId)
}

// ─── Stage-transition rules (read-only suggestion engine) ──────────────────

export async function suggestStageTransition(workspaceId: string, businessId: string): Promise<{
  currentStage: string; suggestedStage: string | null; reason: string; metric: Record<string, unknown>
}> {
  const [b] = await db.select().from(businesses).where(and(eq(businesses.workspaceId, workspaceId), eq(businesses.id, businessId))).limit(1)
  if (!b) return { currentStage: 'unknown', suggestedStage: null, reason: 'business not found', metric: {} }
  const r = await runwayForBusiness(workspaceId, businessId)
  const mrr = r.monthlyRevenueUsd
  const stage = b.stage
  // Rules: early → growth at $500 MRR sustained; growth → mature at $10k MRR sustained;
  // any → sunset-consider at $0 MRR with > 90 days of effort
  if (stage === 'early' && mrr >= 500) return { currentStage: stage, suggestedStage: 'growth', reason: `MRR ${mrr.toFixed(0)} ≥ $500 floor`, metric: { mrr } }
  if (stage === 'growth' && mrr >= 10_000) return { currentStage: stage, suggestedStage: 'mature', reason: `MRR ${mrr.toFixed(0)} ≥ $10k`, metric: { mrr } }
  if (mrr === 0 && (Date.now() - Number(b.createdAt)) > 90 * 86_400_000) return { currentStage: stage, suggestedStage: 'sunset-consider', reason: '$0 MRR after 90+ days', metric: { mrr, ageDays: Math.round((Date.now() - Number(b.createdAt)) / 86_400_000) } }
  return { currentStage: stage, suggestedStage: null, reason: 'no transition criteria met', metric: { mrr } }
}

// ─── Auto-postmortem on sunset ─────────────────────────────────────────────

export async function autoPostmortem(workspaceId: string, businessId: string): Promise<{ id: string; ok: boolean; sections: string[] }> {
  const [b] = await db.select().from(businesses).where(and(eq(businesses.workspaceId, workspaceId), eq(businesses.id, businessId))).limit(1)
  if (!b) return { id: '', ok: false, sections: [] }
  const r = await runwayForBusiness(workspaceId, businessId)
  const ageDays = Math.round((Date.now() - Number(b.createdAt)) / 86_400_000)
  const sections = [
    `Lifetime: ${ageDays} days`,
    `Final stage: ${b.stage}, health: ${b.health}`,
    `Trailing-30d revenue: $${r.monthlyRevenueUsd.toFixed(2)}`,
    `Trailing-30d spend: $${r.monthlySpendUsd.toFixed(2)}`,
    `Net contribution: $${(r.monthlyRevenueUsd - r.monthlySpendUsd).toFixed(2)}/mo`,
    `Recommended lessons (to be filled by brain): what worked, what failed, what to carry to next business`,
  ]
  const id = uuidv7()
  await db.insert(events).values({
    id: uuidv7(), type: 'business.postmortem', workspaceId,
    payload: { id, businessId, sections, createdAt: Date.now() },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'business-arch', version: 1, createdAt: Date.now(),
  })
  return { id, ok: true, sections }
}
