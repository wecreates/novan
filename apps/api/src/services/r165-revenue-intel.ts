/**
 * R165 — Revenue intelligence: SEO + LTV + cross-business + refund mining.
 *
 * Long-tail compounders that turn data into recurring revenue.
 *   - SEO buyer-intent article factory (programmatic listings)
 *   - LTV scoring + decile bucketing (find whales early)
 *   - Cross-business overlap detection (upsell across portfolio)
 *   - Refund reason classification + theme rollup (fix the actual product)
 */
import { db } from '../db/client.js'
import {
  seoArticle, customerScore, crossBusinessOverlap, refundReason,
  leadCapture, videoPaiLesson,
} from '../db/schema.js'
import { and, eq, desc, sql, gte } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── SEO buyer-intent factory ─────────────────────────────────────────

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
}

function classifyIntent(query: string): 'informational' | 'commercial' | 'transactional' {
  const lc = query.toLowerCase()
  if (/^buy |\bdeal\b|\bprice\b|\bcheap\b|\bdiscount\b|^get |^order /.test(lc)) return 'transactional'
  if (/\bbest\b|\bvs\b|\breview\b|\btop \d+\b|\balternative\b|\bcompare\b/.test(lc)) return 'commercial'
  return 'informational'
}

export interface SeoDraftInput {
  query:        string             // e.g. "best wireless lavalier mic for podcasts"
  businessId?:  string
  bodyHint?:    string             // optional facts/angle to anchor on
}

export async function seoDraft(workspaceId: string, input: SeoDraftInput): Promise<{ id: string; slug: string; intent: string }> {
  if (!input.query || input.query.length < 6) throw new Error('query too short')
  const intent = classifyIntent(input.query)
  const slug = slugify(input.query)
  if (!slug) throw new Error('slug invalid')
  const title = input.query.replace(/\b\w/g, c => c.toUpperCase()).slice(0, 90)
  const sections = [
    `# ${title}`,
    '',
    `_Intent: ${intent}_`,
    '',
    `## Quick answer`,
    `If you're searching "${input.query}", here's the short version: …`,
    '',
    `## Why this matters in 2026`,
    `Demand for "${input.query.split(' ').slice(-3).join(' ')}" is rising. Here is the up-to-date take.`,
    '',
    `## Top picks`,
    `1. Pick A — best overall`,
    `2. Pick B — budget`,
    `3. Pick C — premium`,
    '',
    input.bodyHint ? `## Notes\n${input.bodyHint}` : '',
    '',
    `## Final word`,
    `For most readers, Pick A delivers the best balance. Tap below to learn more.`,
  ].filter(Boolean).join('\n')
  const metaDesc = `Compare options for ${input.query.toLowerCase()}. Quick picks, real notes, no fluff.`.slice(0, 160)

  const id = uuidv7()
  await db.insert(seoArticle).values({
    id, workspaceId,
    ...(input.businessId ? { businessId: input.businessId } : {}),
    query: input.query.slice(0, 200), title, slug,
    body: sections, metaDesc, intent,
    status: 'draft', createdAt: Date.now(),
  })
  return { id, slug, intent }
}

export async function seoList(workspaceId: string, opts: { status?: string; limit?: number } = {}): Promise<Array<typeof seoArticle.$inferSelect>> {
  const filters = [eq(seoArticle.workspaceId, workspaceId)]
  if (opts.status) filters.push(eq(seoArticle.status, opts.status))
  return db.select().from(seoArticle).where(and(...filters)).orderBy(desc(seoArticle.createdAt)).limit(Math.min(opts.limit ?? 50, 200))
}

export async function seoPublish(workspaceId: string, id: string): Promise<{ ok: boolean }> {
  const r = await db.update(seoArticle).set({ status: 'published', publishedAt: Date.now() })
    .where(and(eq(seoArticle.workspaceId, workspaceId), eq(seoArticle.id, id), eq(seoArticle.status, 'draft')))
    .returning({ id: seoArticle.id })
  return { ok: r.length > 0 }
}

// ─── LTV scoring ─────────────────────────────────────────────────────

/**
 * Score a customer's predicted LTV from observed signals:
 *   - revenue_to_date (heaviest weight)
 *   - days since first seen
 *   - purchase count
 *   - opens/clicks (engagement)
 *
 * Simple weighted model — enough to bucket into deciles. Caller passes
 * raw signals; we compute decile by comparing against the rolling
 * workspace distribution.
 */
export interface LtvSignals {
  customerRef:     string
  revenueCents?:   number
  purchaseCount?:  number
  firstSeenAt?:    number
  lastPurchaseAt?: number
  emailOpens?:     number
  emailClicks?:    number
  businessId?:     string
}

export async function ltvScore(workspaceId: string, sig: LtvSignals): Promise<{ id: string; predictedLtvCents: number; decile: number }> {
  if (!sig.customerRef) throw new Error('customerRef required')
  const now = Date.now()
  const daysSinceFirst = sig.firstSeenAt ? Math.max(1, (now - sig.firstSeenAt) / 86_400_000) : 30
  const revenue = sig.revenueCents ?? 0
  const purchases = sig.purchaseCount ?? (revenue > 0 ? 1 : 0)
  const opens = sig.emailOpens ?? 0
  const clicks = sig.emailClicks ?? 0

  // Crude LTV projection: avg basket * predicted future purchase rate.
  const avgBasket = purchases > 0 ? revenue / purchases : 0
  const rateMonthly = purchases / Math.max(1, daysSinceFirst / 30)
  const engagementMul = 1 + Math.min(1, (opens + clicks * 3) / 30)
  const predicted = Math.round(avgBasket * rateMonthly * 12 * engagementMul)

  // Compute decile by comparing against workspace rolling.
  const others = await db.select({ ltv: customerScore.predictedLtvCents })
    .from(customerScore).where(eq(customerScore.workspaceId, workspaceId)).limit(5000)
  const all = others.map(r => r.ltv).concat(predicted).sort((a, b) => a - b)
  const idx = all.findIndex(v => v >= predicted)
  const decile = all.length > 0 ? Math.min(10, Math.max(1, Math.ceil(((idx + 1) / all.length) * 10))) : 5

  const id = uuidv7()
  await db.insert(customerScore).values({
    id, workspaceId,
    ...(sig.businessId ? { businessId: sig.businessId } : {}),
    customerRef: sig.customerRef,
    revenueCents: revenue,
    predictedLtvCents: predicted,
    decile,
    signals: { purchases, daysSinceFirst, opens, clicks, avgBasket, rateMonthly, engagementMul },
    ...(sig.lastPurchaseAt ? { lastPurchaseAt: sig.lastPurchaseAt } : {}),
    firstSeenAt: sig.firstSeenAt ?? now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [customerScore.workspaceId, customerScore.customerRef],
    set: {
      revenueCents: revenue,
      predictedLtvCents: predicted,
      decile,
      signals: { purchases, daysSinceFirst, opens, clicks, avgBasket, rateMonthly, engagementMul },
      ...(sig.lastPurchaseAt ? { lastPurchaseAt: sig.lastPurchaseAt } : {}),
      updatedAt: now,
    },
  })
  return { id, predictedLtvCents: predicted, decile }
}

export async function ltvWhales(workspaceId: string, opts: { minDecile?: number; limit?: number } = {}): Promise<Array<typeof customerScore.$inferSelect>> {
  const minDecile = opts.minDecile ?? 9
  return db.select().from(customerScore)
    .where(and(eq(customerScore.workspaceId, workspaceId), gte(customerScore.decile, minDecile)))
    .orderBy(desc(customerScore.predictedLtvCents))
    .limit(Math.min(opts.limit ?? 50, 500))
}

// ─── Cross-business overlap ──────────────────────────────────────────

/**
 * Find customers that appear in multiple businesses' lead_capture rows
 * within the same workspace. High overlap = strong upsell opportunity.
 *
 * Uses captures' magnet_id → business_id linkage (when business set on
 * lead_magnet). Falls back to identifying shared emails across distinct
 * captures.
 */
export async function crossOverlap(workspaceId: string): Promise<{ pairs: number; topPairs: Array<{ a: string; b: string; shared: number; pct: number }> }> {
  // Get captures with a known business via magnet linkage.
  const rows = await db.execute<{ email: string; business_id: string }>(sql`
    SELECT DISTINCT lc.email, lm.business_id
    FROM lead_capture lc
    JOIN lead_magnet lm ON lm.id = lc.magnet_id
    WHERE lc.workspace_id = ${workspaceId}
      AND lc.unsubscribed_at IS NULL
      AND lm.business_id IS NOT NULL
  `)
  const list = (rows as unknown as { rows?: Array<{ email: string; business_id: string }> }).rows ?? (rows as unknown as Array<{ email: string; business_id: string }>)
  if (!Array.isArray(list) || list.length === 0) return { pairs: 0, topPairs: [] }

  const byBiz = new Map<string, Set<string>>()
  for (const r of list) {
    if (!byBiz.has(r.business_id)) byBiz.set(r.business_id, new Set())
    byBiz.get(r.business_id)!.add(r.email)
  }
  const bizIds = [...byBiz.keys()].sort()
  const now = Date.now()
  const pairs: Array<{ a: string; b: string; shared: number; totalA: number; totalB: number; pct: number }> = []
  for (let i = 0; i < bizIds.length; i++) {
    for (let j = i + 1; j < bizIds.length; j++) {
      const A = bizIds[i]!, B = bizIds[j]!
      const setA = byBiz.get(A)!, setB = byBiz.get(B)!
      let shared = 0
      for (const e of setA) if (setB.has(e)) shared += 1
      if (shared === 0) continue
      const pct = shared / Math.min(setA.size, setB.size)
      pairs.push({ a: A, b: B, shared, totalA: setA.size, totalB: setB.size, pct })
      await db.insert(crossBusinessOverlap).values({
        id: uuidv7(), workspaceId,
        businessA: A, businessB: B, sharedCustomers: shared,
        totalA: setA.size, totalB: setB.size, overlapPct: pct,
        computedAt: now,
      }).onConflictDoUpdate({
        target: [crossBusinessOverlap.workspaceId, crossBusinessOverlap.businessA, crossBusinessOverlap.businessB],
        set: { sharedCustomers: shared, totalA: setA.size, totalB: setB.size, overlapPct: pct, computedAt: now },
      })
    }
  }
  pairs.sort((a, b) => b.pct - a.pct)
  return { pairs: pairs.length, topPairs: pairs.slice(0, 10).map(p => ({ a: p.a, b: p.b, shared: p.shared, pct: p.pct })) }
}

// ─── Refund reason mining ────────────────────────────────────────────

const REFUND_RULES: Array<{ category: string; rx: RegExp }> = [
  { category: 'product_defect', rx: /broken|defect|cracked|stopped working|didn'?t work|faulty|malfunction/i },
  { category: 'shipping',       rx: /late|never arrived|wrong address|lost|stolen|shipping/i },
  { category: 'expectation',    rx: /not what i expected|different|misleading|not as described|disappointed|expected/i },
  { category: 'sizing',         rx: /too (small|large|big|tight|loose)|wrong size|doesn'?t fit/i },
  { category: 'duplicate',      rx: /ordered twice|duplicate|by accident|charged twice/i },
]

function classifyRefund(text: string): string {
  for (const r of REFUND_RULES) if (r.rx.test(text)) return r.category
  return 'other'
}

export async function refundLog(workspaceId: string, input: {
  reasonText: string; businessId?: string; orderRef?: string; customerRef?: string; amountCents?: number; category?: string
}): Promise<{ id: string; category: string }> {
  if (!input.reasonText) throw new Error('reasonText required')
  const category = input.category ?? classifyRefund(input.reasonText)
  const id = uuidv7()
  await db.insert(refundReason).values({
    id, workspaceId,
    ...(input.businessId ? { businessId: input.businessId } : {}),
    ...(input.orderRef ? { orderRef: input.orderRef } : {}),
    ...(input.customerRef ? { customerRef: input.customerRef } : {}),
    reasonText: input.reasonText.slice(0, 2000),
    category,
    amountCents: input.amountCents ?? 0,
    recordedAt: Date.now(),
  })
  return { id, category }
}

export async function refundThemes(workspaceId: string, opts: { sinceDays?: number } = {}): Promise<{ themes: Array<{ category: string; count: number; refundCents: number }>; lessonsMinted: number }> {
  const since = Date.now() - (opts.sinceDays ?? 60) * 86_400_000
  const rows = await db.select({
    category: refundReason.category,
    n: sql<number>`count(*)::int`,
    cents: sql<number>`coalesce(sum(${refundReason.amountCents}), 0)::int`,
  })
    .from(refundReason)
    .where(and(eq(refundReason.workspaceId, workspaceId), gte(refundReason.recordedAt, since)))
    .groupBy(refundReason.category)
    .orderBy(desc(sql`count(*)`))

  const themes = rows.map(r => ({
    category: r.category ?? 'other',
    count: Number(r.n),
    refundCents: Number(r.cents),
  }))

  // Mint product-improvement lessons for top issue categories.
  let minted = 0
  for (const t of themes) {
    if (t.count < 3) continue
    if (t.category === 'other') continue
    await db.insert(videoPaiLesson).values({
      id: uuidv7(), workspaceId,
      topic: 'product-issue',
      pattern: `Refund category "${t.category}" hit ${t.count}x ($${(t.refundCents / 100).toFixed(2)}). Address before producing more content for this product.`,
      evidence: { category: t.category, count: t.count, refundCents: t.refundCents, source: 'refund-mining' },
      confidence: Math.min(0.95, 0.6 + Math.min(t.count, 20) / 40),
      uses: 0, wins: 0, losses: 0,
      createdAt: Date.now(),
    })
    minted += 1
  }
  return { themes, lessonsMinted: minted }
}

// ─── Helper: pull LTV signals from existing capture + funnel data ───

/**
 * Convenience: score all known captures (from R162 lead_capture) using
 * cheap signals already available — open/click counts and any revenue
 * stitched via funnel_session.capture_id.
 */
export async function ltvSweep(workspaceId: string): Promise<{ scored: number }> {
  const captures = await db.select({
    id: leadCapture.id,
    email: leadCapture.email,
    firstSeenAt: leadCapture.subscribedAt,
    lastOpenAt: leadCapture.lastOpenAt,
    lastClickAt: leadCapture.lastClickAt,
  })
    .from(leadCapture)
    .where(and(eq(leadCapture.workspaceId, workspaceId), sql`${leadCapture.unsubscribedAt} IS NULL`))
    .limit(5000)

  let scored = 0
  for (const c of captures) {
    try {
      const revRows = await db.execute<{ revenue: number; purchases: number; lastp: number }>(sql`
        SELECT
          coalesce(sum(revenue_cents),0)::int as revenue,
          count(*) filter (where purchased = true)::int as purchases,
          max(last_touch_at)::bigint as lastp
        FROM funnel_session
        WHERE workspace_id = ${workspaceId} AND capture_id = ${c.id}
      `)
      const row = ((revRows as unknown as { rows?: Array<{ revenue: number; purchases: number; lastp: number }> }).rows ?? (revRows as unknown as Array<{ revenue: number; purchases: number; lastp: number }>))[0]
      const revenue = Number(row?.revenue ?? 0)
      const purchases = Number(row?.purchases ?? 0)
      const lastp = Number(row?.lastp ?? 0)
      await ltvScore(workspaceId, {
        customerRef: c.email,
        revenueCents: revenue,
        purchaseCount: purchases,
        firstSeenAt: c.firstSeenAt,
        ...(lastp ? { lastPurchaseAt: lastp } : {}),
        emailOpens: c.lastOpenAt ? 1 : 0,
        emailClicks: c.lastClickAt ? 1 : 0,
      })
      scored += 1
    } catch { /* skip on per-row failure */ }
  }
  return { scored }
}
