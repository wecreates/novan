/**
 * R146.331 #1-10 — POD revenue pipeline (Printful + Etsy already wired in
 * R118/R112). These ops compose the pieces into a single first-listing
 * loop. Honest scope: ops return planning data + persist intent; the
 * actual API push needs operator-supplied Printful/Etsy creds in vault.
 */
import { db } from '../db/client.js'
import { events, connectorCredentials, businesses, workspaceMemory } from '../db/schema.js'
import { and, eq, gte } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

interface PlanShape { ok: boolean; steps: string[]; assumptions: string[]; blockers: string[]; estimatedFirstSaleDays: number }

async function hasCred(workspaceId: string, connectorId: string): Promise<boolean> {
  const [row] = await db.select({ id: connectorCredentials.id }).from(connectorCredentials)
    .where(and(
      eq(connectorCredentials.workspaceId, workspaceId),
      eq(connectorCredentials.connectorId, connectorId),
      eq(connectorCredentials.status, 'active'),
    )).limit(1).catch(() => [])
  return Boolean(row)
}

// #1 First-listing pipeline orchestrator
export async function podFirstListing(input: { workspaceId: string; niche: string }): Promise<PlanShape & { listingId?: string }> {
  const blockers: string[] = []
  if (!(await hasCred(input.workspaceId, 'printful'))) blockers.push('No Printful credential — connect via /api/v1/oauth/printful/start')
  if (!(await hasCred(input.workspaceId, 'etsy')))     blockers.push('No Etsy credential — connect via /api/v1/oauth/etsy/start')
  const listingId = blockers.length === 0 ? uuidv7() : undefined
  if (listingId) {
    await db.insert(events).values({
      id: uuidv7(), type: 'pod.listing.queued', workspaceId: input.workspaceId,
      payload: { listingId, niche: input.niche },
      traceId: uuidv7(), correlationId: listingId, causationId: null,
      source: 'r331-pod', version: 1, createdAt: Date.now(),
    } as never).catch(() => null)
  }
  return {
    ok: blockers.length === 0,
    steps: [
      'pick 3 winning design templates from library for niche',
      'generate 3 design variations via image.generate',
      'upload to Printful as products',
      'create Etsy listings with optimized title/tags',
      'publish + log listingId',
      'monitor first 7 days for sale signal',
    ],
    assumptions: ['Operator has Printful and Etsy accounts in good standing'],
    blockers, estimatedFirstSaleDays: blockers.length === 0 ? 14 : -1,
    ...(listingId ? { listingId } : {}),
  }
}

// #2 Etsy listing optimizer (A/B title/tags)
export async function etsyOptimize(input: { workspaceId: string; listingId: string; variations?: number }): Promise<PlanShape & { variants: Array<{ title: string; tags: string[] }> }> {
  const variations = Math.max(2, Math.min(5, input.variations ?? 3))
  const variants = Array.from({ length: variations }, (_, i) => ({
    title: `Variant ${i+1} (LLM-generated when run)`,
    tags:  ['niche-tag', 'trending-tag', 'long-tail-tag'],
  }))
  return {
    ok: true,
    steps: ['LLM-draft N title/tag variations', 'rotate via Etsy API', 'measure 7-day views/favs/sales per variant', 'pick winner'],
    assumptions: ['Etsy connector wired', 'prompt-evolution registry tracks variant outcomes'],
    blockers: (await hasCred(input.workspaceId, 'etsy')) ? [] : ['No Etsy credential'],
    estimatedFirstSaleDays: 14,
    variants,
  }
}

// #3 Design-template library (seed list)
const TEMPLATE_LIBRARY: Array<{ niche: string; theme: string; examplePrompt: string }> = [
  { niche: 'cats',          theme: 'minimalist line art',    examplePrompt: 'minimalist single-line drawing of a sleeping cat, black on white, vector, clean' },
  { niche: 'plant lovers',  theme: 'monstera illustration',  examplePrompt: 'simple monstera leaf vector, deep green, white background, clean svg' },
  { niche: 'runners',       theme: 'mileage motivational',   examplePrompt: 'typographic poster "5am club" bold serif, off-white background' },
  { niche: 'coffee snobs',  theme: 'pour-over geometry',     examplePrompt: 'geometric pour-over drip diagram, single color, vintage poster style' },
  { niche: 'gym',           theme: 'PR celebration',         examplePrompt: 'bold "New PR" typographic shirt design, distressed font' },
  { niche: 'gamers',        theme: 'controller pixel art',   examplePrompt: '8-bit pixel art game controller, retro neon palette' },
  { niche: 'teachers',      theme: 'apple chalk',            examplePrompt: 'apple drawn in chalk on blackboard, "Mrs. ___" placeholder' },
  { niche: 'engineers',     theme: 'circuit aesthetic',      examplePrompt: 'minimalist circuit board pattern, dark blue, white traces' },
  { niche: 'dog moms',      theme: 'silhouette portrait',    examplePrompt: 'silhouette of a dog head, breed-customizable, single color' },
  { niche: 'book nerds',    theme: 'stacked books',          examplePrompt: 'illustration of stacked books with a quote, watercolor texture' },
]
export function designLibrary(): Array<{ niche: string; theme: string; examplePrompt: string }> {
  return TEMPLATE_LIBRARY
}

// #4 Auto-pricer
export function autoPrice(input: { costUsd: number; competitorMedianUsd?: number; marginPct?: number }): { suggestedUsd: number; floorUsd: number; ceilingUsd: number; reasoning: string } {
  const margin = (input.marginPct ?? 30) / 100
  const floorUsd = Number((input.costUsd * (1 + margin)).toFixed(2))
  const ceilingUsd = input.competitorMedianUsd ? Number(input.competitorMedianUsd.toFixed(2)) : Number((floorUsd * 1.5).toFixed(2))
  const suggestedUsd = Number(((floorUsd + ceilingUsd) / 2).toFixed(2))
  return {
    suggestedUsd, floorUsd, ceilingUsd,
    reasoning: `Floor = cost × (1 + ${(margin*100).toFixed(0)}%) = $${floorUsd}. Ceiling = ${input.competitorMedianUsd ? 'competitor median' : 'floor × 1.5'} = $${ceilingUsd}. Suggested midpoint = $${suggestedUsd}.`,
  }
}

// #5 Niche picker with feasibility scoring
export interface NicheScore { niche: string; competition: number; demand: number; payoutPotential: number; feasibility: number; reasoning: string }
const NICHE_SEEDS: NicheScore[] = [
  { niche: 'cat dad shirts',       competition: 7, demand: 9, payoutPotential: 6, feasibility: 0.78, reasoning: 'high demand, crowded but personalized angle works' },
  { niche: 'pickleball gear',      competition: 5, demand: 8, payoutPotential: 8, feasibility: 0.86, reasoning: 'fastest-growing sport, lower competition than tennis' },
  { niche: 'home homestead tools', competition: 3, demand: 6, payoutPotential: 7, feasibility: 0.83, reasoning: 'low competition, durable buyer intent' },
  { niche: 'nurse appreciation',   competition: 8, demand: 9, payoutPotential: 5, feasibility: 0.62, reasoning: 'high demand but saturated; need unique angle' },
  { niche: 'minimalist parenting', competition: 4, demand: 6, payoutPotential: 7, feasibility: 0.82, reasoning: 'aligns with premium pricing and clean design' },
]
export function nichePicker(): NicheScore[] {
  return NICHE_SEEDS.sort((a, b) => b.feasibility - a.feasibility)
}

// #6 Per-business inventory budget tracker
export async function setInventoryBudget(input: { workspaceId: string; businessId: string; monthlyUsd: number; allocation: Record<string, number> }): Promise<void> {
  await db.insert(workspaceMemory).values({
    workspaceId: input.workspaceId,
    key: `_invBudget.${input.businessId}`,
    value: JSON.stringify({ monthlyUsd: input.monthlyUsd, allocation: input.allocation, setAt: Date.now() }),
    scope: 'system', importance: 80, updatedAt: Date.now(),
  } as never).onConflictDoUpdate({
    target: [workspaceMemory.workspaceId, workspaceMemory.key],
    set: { value: JSON.stringify({ monthlyUsd: input.monthlyUsd, allocation: input.allocation, setAt: Date.now() }), updatedAt: Date.now() },
  }).catch(() => null)
}

// #7 Etsy review monitor (planning op until Etsy review API wired)
export async function etsyReviewMonitor(input: { workspaceId: string }): Promise<PlanShape & { unresolvedLowStars: number }> {
  const since = Date.now() - 30 * 86400_000
  const rows = await db.select().from(events)
    .where(and(eq(events.workspaceId, input.workspaceId), eq(events.type, 'etsy.review.low_star'), gte(events.createdAt, since)))
    .catch(() => [])
  return {
    ok: true,
    steps: ['Poll Etsy reviews API daily', 'Filter ≤2-star', 'Draft response per review', 'Surface in operator approval queue'],
    assumptions: ['Etsy connector w/ reviews scope'],
    blockers: (await hasCred(input.workspaceId, 'etsy')) ? [] : ['No Etsy credential'],
    estimatedFirstSaleDays: -1,
    unresolvedLowStars: rows.length,
  }
}

// #8 Shopify as secondary surface (wired in R117 — just enumerates options)
export async function shopifyPath(input: { workspaceId: string }): Promise<PlanShape> {
  return {
    ok: true,
    steps: ['list products in primary Shop', 'sync to Etsy as fulfillment', 'unified inventory + pricing'],
    assumptions: ['Both Shopify and Etsy creds active'],
    blockers: [
      ...((await hasCred(input.workspaceId, 'shopify')) ? [] : ['No Shopify credential']),
      ...((await hasCred(input.workspaceId, 'etsy'))    ? [] : ['No Etsy credential']),
    ],
    estimatedFirstSaleDays: 21,
  }
}

// #9 First-sale notification flow (push + chat + memory bridge)
export async function recordFirstSale(input: { workspaceId: string; businessId: string; amountUsd: number; source: string }): Promise<{ ok: boolean; notified: boolean }> {
  await db.insert(events).values({
    id: uuidv7(), type: 'sale.first', workspaceId: input.workspaceId,
    payload: { businessId: input.businessId, amountUsd: input.amountUsd, source: input.source },
    traceId: uuidv7(), correlationId: input.businessId, causationId: null,
    source: 'r331-pod', version: 1, createdAt: Date.now(),
  } as never).catch(() => null)
  // Push notify (best-effort)
  let notified = false
  try {
    const mod = await import('./web-push.js') as { broadcastPush?: (ws: string, p: { title: string; body: string; tag?: string }) => Promise<{ sent: number }> }
    if (mod.broadcastPush) {
      const r = await mod.broadcastPush(input.workspaceId, {
        title: '🎉 First sale!',
        body: `$${input.amountUsd.toFixed(2)} from ${input.source}`,
        tag: 'first-sale',
      })
      notified = r.sent > 0
    }
  } catch { /* */ }
  return { ok: true, notified }
}

// #10 Daily revenue digest
export async function dailyRevenueDigest(workspaceId: string): Promise<{ yesterdayUsd: number; trend7d: number[]; topBusiness: string | null }> {
  const since1d = Date.now() - 86400_000
  const since7d = Date.now() - 7 * 86400_000
  const rows = await db.select().from(events)
    .where(and(eq(events.workspaceId, workspaceId), eq(events.type, 'sale.recorded'), gte(events.createdAt, since7d)))
    .catch(() => [])
  let yesterdayUsd = 0
  const trend7d = Array(7).fill(0) as number[]
  const byBiz = new Map<string, number>()
  for (const r of rows) {
    const amount = Number((r.payload as { amountUsd?: number } | null)?.amountUsd ?? 0)
    const ts = Number(r.createdAt)
    const dayIdx = Math.floor((ts - since7d) / 86400_000)
    if (dayIdx >= 0 && dayIdx < 7) {
      const slot = trend7d[dayIdx]
      if (slot !== undefined) trend7d[dayIdx] = slot + amount
    }
    if (ts >= since1d) yesterdayUsd += amount
    const bid = (r.payload as { businessId?: string } | null)?.businessId ?? 'unattributed'
    byBiz.set(bid, (byBiz.get(bid) ?? 0) + amount)
  }
  const top = Array.from(byBiz.entries()).sort((a, b) => b[1] - a[1])[0] ?? null
  return {
    yesterdayUsd: Number(yesterdayUsd.toFixed(2)),
    trend7d: trend7d.map(v => Number(v.toFixed(2))),
    topBusiness: top ? top[0] : null,
  }
}

void businesses
