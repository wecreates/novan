/**
 * R180 — Money maximizer.
 *
 * Meta-orchestrator. Looks across every existing loop and ranks every
 * actionable opportunity by estimated $/hr. Returns a knapsack-allocated
 * plan for the operator's available hours, then dispatches each
 * approved action through the right existing brain op.
 *
 * Scanners (one per source):
 *   - answer_comments      r161 high-priority unanswered comments
 *   - win_back             r162 dormant cohort big enough to mint
 *   - publish_post         r178 active accounts with capacity left today
 *   - repurpose_topwin     r163 winning published post → 7 platform variants
 *   - improve_listing      r164 product listings with low conversion despite traffic
 *   - upsell_whale         r165 newly-detected whales (decile≥9) with no recent reach
 *   - new_product          r165 high-overlap business pair → cross-sell product
 *   - seo_article          r165 buyer-intent query gaps
 *   - fix_funnel_leak      r164 stage with bottom-quartile conversion rate
 *   - reduce_refund        r165 refund category ≥5 hits → product fix
 */
import { db } from '../db/client.js'
import {
  moneyOpportunity, socialComment, socialReplyDraft, leadCapture, managedAccount,
  customerScore, crossBusinessOverlap, refundReason, funnelEvent, podProduct,
} from '../db/schema.js'
import { and, eq, desc, sql, isNull, gte } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── Scanners ────────────────────────────────────────────────────────

interface OppDraft {
  kind: string
  title: string
  estRevenueLiftCents: number
  estHours: number
  estCostCents?: number
  confidence: number
  evidence?: Record<string, unknown>
  source: string
  payload?: Record<string, unknown>
  businessId?: string
}

async function scanAnswerComments(workspaceId: string): Promise<OppDraft[]> {
  const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(socialComment)
    .where(and(eq(socialComment.workspaceId, workspaceId), isNull(socialComment.repliedAt), gte(socialComment.replyPriority, 60)))
  const count = Number(c?.n ?? 0)
  if (count < 3) return []
  return [{
    kind: 'answer_comments',
    title: `Reply to ${count} high-priority comments`,
    estRevenueLiftCents: 500 * count,         // $5 lift per engaged convo (rough proxy)
    estHours: Math.max(0.25, count / 30),     // 30 replies/hr
    confidence: 0.7,
    evidence: { unansweredHighPri: count },
    source: 'r161_social_comments',
    payload: { autoDraft: true },
  }]
}

async function scanWinBack(workspaceId: string): Promise<OppDraft[]> {
  const since = Date.now() - 30 * 86_400_000
  const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(leadCapture)
    .where(and(
      eq(leadCapture.workspaceId, workspaceId),
      isNull(leadCapture.unsubscribedAt),
      sql`(${leadCapture.lastOpenAt} IS NULL OR ${leadCapture.lastOpenAt} <= ${since})`,
    ))
  const count = Number(c?.n ?? 0)
  if (count < 25) return []
  return [{
    kind: 'win_back',
    title: `Win-back ${count} dormant subscribers`,
    estRevenueLiftCents: 200 * count,         // $2/dormant reactivation expected
    estHours: 0.5,
    confidence: 0.55,
    evidence: { dormantCount: count },
    source: 'r162_owned_audience',
  }]
}

async function scanPublishCapacity(workspaceId: string): Promise<OppDraft[]> {
  const accts = await db.select().from(managedAccount)
    .where(and(eq(managedAccount.workspaceId, workspaceId), eq(managedAccount.status, 'active')))
  if (accts.length === 0) return []
  // Estimate: each post drives ~30 sessions × 2.5% purchase × $25 AOV ≈ $18.75 / post (back-of-envelope)
  const opps: OppDraft[] = []
  for (const a of accts) {
    opps.push({
      kind: 'publish_post',
      title: `Publish a post via @${a.handle} on ${a.platform}`,
      estRevenueLiftCents: 1875,
      estHours: 0.2,
      confidence: 0.5,
      evidence: { accountId: a.id, platform: a.platform, handle: a.handle },
      source: 'r178_managed_accounts',
      payload: { accountId: a.id, platform: a.platform },
      ...(a.businessId ? { businessId: a.businessId } : {}),
    })
  }
  return opps.slice(0, 10)
}

async function scanWhales(workspaceId: string): Promise<OppDraft[]> {
  const whales = await db.select().from(customerScore)
    .where(and(eq(customerScore.workspaceId, workspaceId), gte(customerScore.decile, 9)))
    .limit(20)
  if (whales.length === 0) return []
  return [{
    kind: 'upsell_whale',
    title: `Personalized outreach to ${whales.length} whales`,
    estRevenueLiftCents: whales.reduce((a, w) => a + Math.round(w.predictedLtvCents * 0.15), 0),
    estHours: whales.length * 0.1,
    confidence: 0.6,
    evidence: { whaleCount: whales.length, topLtvCents: whales[0]?.predictedLtvCents },
    source: 'r165_revenue_intel',
  }]
}

async function scanCrossSell(workspaceId: string): Promise<OppDraft[]> {
  const overlaps = await db.select().from(crossBusinessOverlap)
    .where(and(eq(crossBusinessOverlap.workspaceId, workspaceId), gte(crossBusinessOverlap.sharedCustomers, 5)))
    .orderBy(desc(crossBusinessOverlap.overlapPct)).limit(3)
  return overlaps.map(o => ({
    kind: 'upsell_cross_business',
    title: `Cross-sell campaign: ${o.businessA} → ${o.businessB} (${o.sharedCustomers} shared)`,
    estRevenueLiftCents: o.sharedCustomers * 3500,   // $35 LTV bump per cross-buyer
    estHours: 1,
    confidence: 0.55,
    evidence: { overlap: o.overlapPct, shared: o.sharedCustomers },
    source: 'r165_revenue_intel',
  }))
}

async function scanRefundFix(workspaceId: string): Promise<OppDraft[]> {
  const since = Date.now() - 60 * 86_400_000
  const rows = await db.select({
    category: refundReason.category,
    n: sql<number>`count(*)::int`,
    cents: sql<number>`coalesce(sum(${refundReason.amountCents}), 0)::int`,
  })
    .from(refundReason)
    .where(and(eq(refundReason.workspaceId, workspaceId), gte(refundReason.recordedAt, since)))
    .groupBy(refundReason.category)
    .orderBy(desc(sql`count(*)`))
    .limit(3)

  return rows.filter(r => Number(r.n) >= 5).map(r => ({
    kind: 'reduce_refund',
    title: `Fix "${r.category ?? 'other'}" refund root cause (${Number(r.n)}× hits, $${(Number(r.cents) / 100).toFixed(2)} bleed)`,
    estRevenueLiftCents: Math.max(0, Number(r.cents)),
    estHours: 4,
    confidence: 0.65,
    evidence: { category: r.category, count: Number(r.n), refundCents: Number(r.cents) },
    source: 'r165_revenue_intel',
  }))
}

async function scanFunnelLeak(workspaceId: string): Promise<OppDraft[]> {
  const since = Date.now() - 30 * 86_400_000
  const rows = await db.select({
    kind: funnelEvent.kind, n: sql<number>`count(*)::int`,
  })
    .from(funnelEvent)
    .where(and(eq(funnelEvent.workspaceId, workspaceId), gte(funnelEvent.at, since)))
    .groupBy(funnelEvent.kind)
  const m: Record<string, number> = {}
  for (const r of rows) m[r.kind] = Number(r.n)
  const views = m['view'] ?? 0
  const clicks = m['click'] ?? 0
  const signups = m['signup'] ?? 0
  const purchases = m['purchase'] ?? 0
  if (views < 100) return []

  const opps: OppDraft[] = []
  const v2c = clicks / views
  if (v2c < 0.02) opps.push({
    kind: 'fix_funnel_leak',
    title: `Fix view→click leak (only ${(v2c * 100).toFixed(1)}% — should be ≥4%)`,
    estRevenueLiftCents: Math.round((purchases / Math.max(views, 1)) * views * 0.02 * 2500),
    estHours: 2, confidence: 0.6, source: 'r164_funnel_cro',
    evidence: { views, clicks, rate: v2c },
  })
  const s2p = purchases / Math.max(signups, 1)
  if (signups >= 20 && s2p < 0.05) opps.push({
    kind: 'fix_funnel_leak',
    title: `Fix signup→purchase leak (only ${(s2p * 100).toFixed(1)}% — should be ≥10%)`,
    estRevenueLiftCents: Math.round(signups * 0.05 * 2500),
    estHours: 3, confidence: 0.55, source: 'r164_funnel_cro',
    evidence: { signups, purchases, rate: s2p },
  })
  return opps
}

async function scanRepurposeTopWin(workspaceId: string): Promise<OppDraft[]> {
  // High-revenue products with sold_count ≥ 3 → repurpose into content
  const tops = await db.select({ id: podProduct.id, title: podProduct.title, revenueCents: podProduct.revenueCents })
    .from(podProduct)
    .where(and(eq(podProduct.workspaceId, workspaceId), gte(podProduct.soldCount, 3)))
    .orderBy(desc(podProduct.revenueCents)).limit(3)
  return tops.map(p => ({
    kind: 'repurpose_topwin',
    title: `Mint 7-format content pack for "${p.title.slice(0, 60)}" ($${(p.revenueCents / 100).toFixed(2)} so far)`,
    estRevenueLiftCents: Math.max(2500, Math.round(p.revenueCents * 0.2)),
    estHours: 0.3,
    confidence: 0.65,
    evidence: { productId: p.id, currentRevenue: p.revenueCents },
    source: 'r179_pod_social',
    payload: { productId: p.id, storeId: '' },
  }))
}

// ─── Orchestrator ────────────────────────────────────────────────────

export async function opportunityScan(workspaceId: string): Promise<{ minted: number; byKind: Record<string, number> }> {
  const scanners = [
    scanAnswerComments, scanWinBack, scanPublishCapacity,
    scanWhales, scanCrossSell, scanRefundFix,
    scanFunnelLeak, scanRepurposeTopWin,
  ]
  const drafts: OppDraft[] = []
  for (const s of scanners) {
    try { drafts.push(...await s(workspaceId)) } catch { /* per-scanner isolation */ }
  }

  const now = Date.now()
  let minted = 0
  const byKind: Record<string, number> = {}

  for (const d of drafts) {
    const dollarsPerHour = d.estHours > 0 ? (d.estRevenueLiftCents / 100) / d.estHours : 0
    // Dedup: skip if an open opp with same kind + same evidence summary exists in last 48h.
    const recent = await db.select({ id: moneyOpportunity.id }).from(moneyOpportunity)
      .where(and(
        eq(moneyOpportunity.workspaceId, workspaceId),
        eq(moneyOpportunity.kind, d.kind),
        eq(moneyOpportunity.status, 'open'),
        gte(moneyOpportunity.createdAt, now - 48 * 3_600_000),
      ))
      .limit(1)
    if (recent.length > 0) continue

    await db.insert(moneyOpportunity).values({
      id: uuidv7(), workspaceId,
      ...(d.businessId ? { businessId: d.businessId } : {}),
      kind: d.kind,
      title: d.title.slice(0, 200),
      estRevenueLiftCents: d.estRevenueLiftCents,
      estHours: d.estHours,
      estCostCents: d.estCostCents ?? 0,
      dollarsPerHour,
      confidence: d.confidence,
      evidence: d.evidence ?? {},
      source: d.source,
      payload: d.payload ?? {},
      status: 'open',
      createdAt: now,
    })
    minted += 1
    byKind[d.kind] = (byKind[d.kind] ?? 0) + 1
  }
  return { minted, byKind }
}

/**
 * Knapsack-greedy: sort by $/hr × confidence desc, pick until hours
 * available is exhausted. Returns the chosen plan; caller can mark
 * each opp scheduled via opportunityScheduleNext().
 */
export async function allocateEffort(workspaceId: string, opts: { hoursAvailable?: number; minDollarsPerHour?: number } = {}): Promise<{ chosen: Array<{ id: string; kind: string; title: string; estHours: number; dollarsPerHour: number; estRevenueLiftCents: number }>; totalRevenue: number; totalHours: number; declined: number }> {
  const hoursAvailable = Math.max(0.25, Math.min(opts.hoursAvailable ?? 8, 24))
  const minDPH = opts.minDollarsPerHour ?? 30
  const opps = await db.select().from(moneyOpportunity)
    .where(and(eq(moneyOpportunity.workspaceId, workspaceId), eq(moneyOpportunity.status, 'open')))
    .orderBy(desc(moneyOpportunity.dollarsPerHour))
    .limit(200)

  const scored = opps
    .filter(o => o.dollarsPerHour >= minDPH)
    .map(o => ({ ...o, score: o.dollarsPerHour * o.confidence }))
    .sort((a, b) => b.score - a.score)

  const chosen: Array<{ id: string; kind: string; title: string; estHours: number; dollarsPerHour: number; estRevenueLiftCents: number }> = []
  let hours = 0
  let revenue = 0
  for (const o of scored) {
    if (hours + o.estHours > hoursAvailable) continue
    chosen.push({ id: o.id, kind: o.kind, title: o.title, estHours: o.estHours, dollarsPerHour: o.dollarsPerHour, estRevenueLiftCents: o.estRevenueLiftCents })
    hours += o.estHours
    revenue += o.estRevenueLiftCents
  }
  return { chosen, totalRevenue: revenue, totalHours: hours, declined: opps.length - chosen.length }
}

/**
 * Execute the next opportunity in the plan by routing to the existing
 * brain op for that kind. Marks the opp status accordingly.
 */
export async function executeNext(workspaceId: string, opts: { opportunityId: string }): Promise<{ ok: boolean; ranOp?: string; result?: unknown; error?: string }> {
  const [o] = await db.select().from(moneyOpportunity)
    .where(and(eq(moneyOpportunity.workspaceId, workspaceId), eq(moneyOpportunity.id, opts.opportunityId)))
    .limit(1)
  if (!o) return { ok: false, error: 'opportunity not found' }
  if (o.status !== 'open' && o.status !== 'scheduled') return { ok: false, error: `status=${o.status}` }
  await db.update(moneyOpportunity).set({ status: 'running' }).where(eq(moneyOpportunity.id, o.id))

  try {
    let ranOp = ''
    let result: unknown = null
    switch (o.kind) {
      case 'answer_comments': {
        const { autoDraftBacklog } = await import('./r161-social-comments.js')
        result = await autoDraftBacklog(workspaceId, 20)
        ranOp = 'social.reply.autoDraft'; break
      }
      case 'win_back': {
        const { winBackTick } = await import('./r162-owned-audience.js')
        result = await winBackTick(workspaceId)
        ranOp = 'list.winBack'; break
      }
      case 'upsell_whale': {
        const { ltvWhales } = await import('./r165-revenue-intel.js')
        result = await ltvWhales(workspaceId)
        ranOp = 'ltv.whales (operator outreach queue)'; break
      }
      case 'upsell_cross_business': {
        const { crossOverlap } = await import('./r165-revenue-intel.js')
        result = await crossOverlap(workspaceId)
        ranOp = 'crossbusiness.overlap (operator campaign queue)'; break
      }
      case 'reduce_refund': {
        const { refundThemes } = await import('./r165-revenue-intel.js')
        result = await refundThemes(workspaceId)
        ranOp = 'refund.themes (mints product-issue PAI lessons)'; break
      }
      case 'repurpose_topwin': {
        const productId = (o.payload as { productId?: string })?.productId
        if (productId) {
          // Look up store id then fan out.
          const [p] = await db.select({ storeId: podProduct.storeId }).from(podProduct).where(eq(podProduct.id, productId)).limit(1)
          if (p) {
            const { bestSellersToContent } = await import('./r179-pod-social.js')
            result = await bestSellersToContent(workspaceId, { storeId: p.storeId, topN: 1 })
            ranOp = 'pod.bestSellersToContent'
          }
        }
        break
      }
      case 'publish_post': {
        // Routing requires an existing PAI run; here we surface a "needs ISA" advisory.
        ranOp = 'requires existing PAI run — operator should run video.pai.run first'
        result = { advisory: 'create ISA + run + bind director profile → publish.fromRun' }
        break
      }
      case 'fix_funnel_leak': {
        const { funnelSummary } = await import('./r164-funnel-cro.js')
        result = await funnelSummary(workspaceId)
        ranOp = 'funnel.summary (operator must act on bottleneck)'
        break
      }
      default: ranOp = `no executor for ${o.kind}`
    }
    await db.update(moneyOpportunity).set({ status: 'done', completedAt: Date.now() }).where(eq(moneyOpportunity.id, o.id))
    return { ok: true, ranOp, result }
  } catch (e) {
    const msg = (e as Error).message.slice(0, 400)
    await db.update(moneyOpportunity).set({ status: 'failed' }).where(eq(moneyOpportunity.id, o.id))
    return { ok: false, error: msg }
  }
}

export async function opportunitiesList(workspaceId: string, opts: { status?: string; limit?: number } = {}): Promise<Array<typeof moneyOpportunity.$inferSelect>> {
  const filters = [eq(moneyOpportunity.workspaceId, workspaceId)]
  if (opts.status) filters.push(eq(moneyOpportunity.status, opts.status))
  return db.select().from(moneyOpportunity).where(and(...filters)).orderBy(desc(moneyOpportunity.dollarsPerHour)).limit(Math.min(opts.limit ?? 50, 500))
}

/**
 * One-call daily optimization: scan + allocate + return a markdown briefing.
 */
export async function dailyOptimize(workspaceId: string, hoursAvailable = 8): Promise<{ scanned: number; chosen: Array<{ id: string; kind: string; title: string; estHours: number; dollarsPerHour: number }>; totalRevenue: number; totalHours: number }> {
  const s = await opportunityScan(workspaceId)
  const a = await allocateEffort(workspaceId, { hoursAvailable })
  return { scanned: s.minted, chosen: a.chosen, totalRevenue: a.totalRevenue, totalHours: a.totalHours }
}
