/**
 * R164 — Funnel telemetry + multi-armed bandit + cart recovery.
 *
 * Compounds existing traffic into revenue without new content:
 *   - eventTrack    — UTM-aware view/click/signup/purchase tracking, per-session
 *   - funnelSummary — view→click→signup→purchase conversion table
 *   - bandit.pick/observe — Thompson-sampling Beta bandit for any A/B/N test
 *                            (subject lines, headlines, prices, thumbnails)
 *   - cart.abandonRegister — record abandon
 *   - cart.recoverDrafts — finds >1h abandons with known email → drafts a
 *                          R162 campaign per cohort for operator approval
 *
 * Public web ingestion is at POST /t/:workspaceId/:event in server.ts.
 */
import { db } from '../db/client.js'
import {
  funnelEvent, funnelSession, banditExperiment, cartAbandonment, emailCampaign,
} from '../db/schema.js'
import { and, eq, desc, sql, gte, isNull } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── Tracking ────────────────────────────────────────────────────────

export interface TrackInput {
  sessionId:    string
  kind:         'view' | 'click' | 'signup' | 'purchase' | 'custom'
  source?:      string
  medium?:      string
  campaign?:    string
  page?:        string
  ref?:         string
  amountCents?: number
  meta?:        Record<string, unknown>
  captureId?:   string
  businessId?:  string
}

export async function eventTrack(workspaceId: string, input: TrackInput): Promise<{ id: string; sessionId: string }> {
  if (!input.sessionId || input.sessionId.length > 80) throw new Error('sessionId required ≤80 chars')
  const id = uuidv7()
  const at = Date.now()

  await db.insert(funnelEvent).values({
    id, workspaceId,
    ...(input.businessId ? { businessId: input.businessId } : {}),
    sessionId:   input.sessionId,
    kind:        input.kind,
    ...(input.source ? { source: input.source.slice(0, 120) } : {}),
    ...(input.medium ? { medium: input.medium.slice(0, 80) } : {}),
    ...(input.campaign ? { campaign: input.campaign.slice(0, 120) } : {}),
    ...(input.page ? { page: input.page.slice(0, 250) } : {}),
    ...(input.ref ? { ref: input.ref.slice(0, 250) } : {}),
    ...(input.amountCents !== undefined ? { amountCents: input.amountCents } : {}),
    meta: input.meta ?? {},
    ...(input.captureId ? { captureId: input.captureId } : {}),
    at,
  })

  // Upsert session.
  const [existing] = await db.select().from(funnelSession)
    .where(and(eq(funnelSession.workspaceId, workspaceId), eq(funnelSession.id, input.sessionId))).limit(1)
  if (!existing) {
    await db.insert(funnelSession).values({
      id: input.sessionId, workspaceId,
      ...(input.businessId ? { businessId: input.businessId } : {}),
      firstTouchAt: at, lastTouchAt: at,
      ...(input.source ? { firstSource: input.source } : {}),
      ...(input.campaign ? { firstCampaign: input.campaign } : {}),
      ...(input.captureId ? { captureId: input.captureId } : {}),
      purchased:    input.kind === 'purchase',
      revenueCents: input.kind === 'purchase' ? (input.amountCents ?? 0) : 0,
      viewCount:    input.kind === 'view' ? 1 : 0,
      clickCount:   input.kind === 'click' ? 1 : 0,
    }).onConflictDoNothing()
  } else {
    await db.update(funnelSession).set({
      lastTouchAt: at,
      ...(input.captureId && !existing.captureId ? { captureId: input.captureId } : {}),
      ...(input.kind === 'view' ? { viewCount: sql`${funnelSession.viewCount} + 1` as unknown as number } : {}),
      ...(input.kind === 'click' ? { clickCount: sql`${funnelSession.clickCount} + 1` as unknown as number } : {}),
      ...(input.kind === 'purchase' ? {
        purchased: true,
        revenueCents: sql`${funnelSession.revenueCents} + ${input.amountCents ?? 0}` as unknown as number,
      } : {}),
    }).where(eq(funnelSession.id, input.sessionId))
  }

  return { id, sessionId: input.sessionId }
}

export async function funnelSummary(workspaceId: string, opts: { sinceDays?: number } = {}): Promise<{
  windowDays: number; views: number; clicks: number; signups: number; purchases: number; revenueCents: number;
  rates: { viewToClick: number; clickToSignup: number; signupToPurchase: number; viewToPurchase: number }
}> {
  const days = opts.sinceDays ?? 30
  const since = Date.now() - days * 86_400_000
  const counts = await db.select({
    kind: funnelEvent.kind, n: sql<number>`count(*)::int`, rev: sql<number>`coalesce(sum(${funnelEvent.amountCents}), 0)::int`,
  })
    .from(funnelEvent)
    .where(and(eq(funnelEvent.workspaceId, workspaceId), gte(funnelEvent.at, since)))
    .groupBy(funnelEvent.kind)

  const m: Record<string, number> = {}
  let revenueCents = 0
  for (const c of counts) {
    m[c.kind] = Number(c.n)
    if (c.kind === 'purchase') revenueCents = Number(c.rev)
  }
  const views = m['view'] ?? 0
  const clicks = m['click'] ?? 0
  const signups = m['signup'] ?? 0
  const purchases = m['purchase'] ?? 0
  const safeDiv = (a: number, b: number): number => b > 0 ? Math.round((a / b) * 10000) / 10000 : 0
  return {
    windowDays: days, views, clicks, signups, purchases, revenueCents,
    rates: {
      viewToClick:      safeDiv(clicks,    views),
      clickToSignup:    safeDiv(signups,   clicks),
      signupToPurchase: safeDiv(purchases, signups),
      viewToPurchase:   safeDiv(purchases, views),
    },
  }
}

// ─── Bandit (Thompson sampling Beta) ────────────────────────────────

/**
 * Pick the next variant to show. Creates the experiment if it doesn't
 * exist. Uses Thompson sampling: draw Beta(alpha, beta) per variant,
 * return the variant with the highest sample. Self-balancing.
 */
export async function banditPick(workspaceId: string, opts: { name: string; variantLabels?: string[] }): Promise<{ id: string; variant: string }> {
  const [existing] = await db.select().from(banditExperiment)
    .where(and(eq(banditExperiment.workspaceId, workspaceId), eq(banditExperiment.name, opts.name))).limit(1)

  let variants: Array<{ id: string; label: string; alpha: number; beta: number; impressions: number; conversions: number }>
  let id: string

  if (!existing) {
    const labels = opts.variantLabels ?? ['a', 'b']
    if (labels.length < 2) throw new Error('need ≥2 variant labels on first call')
    id = uuidv7()
    variants = labels.map(l => ({ id: l, label: l, alpha: 1, beta: 1, impressions: 0, conversions: 0 }))
    await db.insert(banditExperiment).values({
      id, workspaceId, name: opts.name, variants, status: 'running', createdAt: Date.now(),
    })
  } else {
    id = existing.id
    variants = existing.variants
  }

  // Sample Beta(alpha, beta) per variant; pick max. Beta sampling via two gammas.
  const sampleBeta = (a: number, b: number): number => {
    const ga = sampleGamma(a), gb = sampleGamma(b)
    return ga / (ga + gb)
  }
  let best = variants[0]!
  let bestScore = sampleBeta(best.alpha, best.beta)
  for (let i = 1; i < variants.length; i++) {
    const v = variants[i]!
    const s = sampleBeta(v.alpha, v.beta)
    if (s > bestScore) { best = v; bestScore = s }
  }

  // Record impression.
  best.impressions += 1
  await db.update(banditExperiment).set({ variants }).where(eq(banditExperiment.id, id))
  return { id, variant: best.id }
}

/**
 * Observe outcome for a previously picked variant. won=true increments
 * alpha (success), won=false increments beta (failure).
 */
export async function banditObserve(workspaceId: string, name: string, variant: string, won: boolean): Promise<{ ok: boolean }> {
  const [exp] = await db.select().from(banditExperiment)
    .where(and(eq(banditExperiment.workspaceId, workspaceId), eq(banditExperiment.name, name))).limit(1)
  if (!exp) return { ok: false }
  const v = exp.variants.find(x => x.id === variant)
  if (!v) return { ok: false }
  if (won) { v.alpha += 1; v.conversions += 1 } else { v.beta += 1 }
  await db.update(banditExperiment).set({ variants: exp.variants }).where(eq(banditExperiment.id, exp.id))
  return { ok: true }
}

export async function banditList(workspaceId: string): Promise<Array<typeof banditExperiment.$inferSelect>> {
  return db.select().from(banditExperiment)
    .where(eq(banditExperiment.workspaceId, workspaceId))
    .orderBy(desc(banditExperiment.createdAt))
    .limit(100)
}

// Marsaglia-Tsang gamma sampler — sufficient for Beta posterior sampling.
function sampleGamma(shape: number): number {
  if (shape < 1) return sampleGamma(shape + 1) * Math.pow(rng(), 1 / shape)
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  while (true) {
    let x: number, v: number
    do {
      x = gaussian()
      v = 1 + c * x
    } while (v <= 0)
    v = v * v * v
    const u = rng()
    if (u < 1 - 0.0331 * x * x * x * x) return d * v
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}
function rng(): number { return Math.random() }
function gaussian(): number {
  // Box-Muller. Cached spare not needed at this volume.
  let u = 0, v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// ─── Cart abandonment ────────────────────────────────────────────────

export async function cartAbandonRegister(workspaceId: string, input: {
  sessionId?: string; email?: string; cartValueCents?: number; items?: Array<Record<string, unknown>>; businessId?: string
}): Promise<{ id: string }> {
  if (!input.sessionId && !input.email) throw new Error('sessionId or email required')
  const id = uuidv7()
  await db.insert(cartAbandonment).values({
    id, workspaceId,
    ...(input.businessId ? { businessId: input.businessId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.email ? { email: input.email.toLowerCase().trim() } : {}),
    cartValueCents: input.cartValueCents ?? 0,
    items: input.items ?? [],
    abandonedAt: Date.now(),
    recoveryStatus: 'pending',
  })
  return { id }
}

export async function cartMarkRecovered(workspaceId: string, sessionId: string): Promise<{ ok: boolean }> {
  const r = await db.update(cartAbandonment).set({ recoveredAt: Date.now(), recoveryStatus: 'recovered' })
    .where(and(
      eq(cartAbandonment.workspaceId, workspaceId),
      eq(cartAbandonment.sessionId, sessionId),
      eq(cartAbandonment.recoveryStatus, 'pending'),
    )).returning({ id: cartAbandonment.id })
  return { ok: r.length > 0 }
}

/**
 * For every cart abandoned ≥1h ago and ≤48h ago with a known email and
 * no draft yet, mint a R162 campaign so the operator can send recovery.
 */
export async function cartRecoverDrafts(workspaceId: string): Promise<{ drafted: number; cohortSize: number }> {
  const now = Date.now()
  const minAge = now - 60 * 60_000
  const maxAge = now - 48 * 3_600_000

  const cohort = await db.select().from(cartAbandonment)
    .where(and(
      eq(cartAbandonment.workspaceId, workspaceId),
      eq(cartAbandonment.recoveryStatus, 'pending'),
      sql`${cartAbandonment.email} IS NOT NULL`,
      gte(cartAbandonment.abandonedAt, maxAge),
      sql`${cartAbandonment.abandonedAt} <= ${minAge}`,
      isNull(cartAbandonment.recoveryCampaignId),
    ))
    .limit(500)

  if (cohort.length === 0) return { drafted: 0, cohortSize: 0 }

  // Bucket by date to avoid sending one campaign per session.
  const today = new Date().toISOString().slice(0, 10)
  const campaignId = uuidv7()
  await db.insert(emailCampaign).values({
    id: campaignId, workspaceId,
    name: `cart-recovery ${today}`,
    subjectA: 'You left something behind',
    subjectB: 'Still thinking about it?',
    body: `<p>Hey — your cart is still here. Want to finish checking out?</p><p>If anything stopped you, just reply to this email and I'll personally help.</p>`,
    segmentFilter: { includeSegments: [] },
    status: 'draft',
    createdAt: Date.now(),
  })
  await db.update(cartAbandonment).set({ recoveryCampaignId: campaignId, recoveryStatus: 'drafted' })
    .where(and(
      eq(cartAbandonment.workspaceId, workspaceId),
      sql`${cartAbandonment.id} IN (${sql.join(cohort.map(c => sql`${c.id}`), sql`, `)})`,
    ))
  return { drafted: 1, cohortSize: cohort.length }
}

// ─── Reads ───────────────────────────────────────────────────────────

export async function sessionList(workspaceId: string, opts: { purchasedOnly?: boolean; limit?: number } = {}): Promise<Array<typeof funnelSession.$inferSelect>> {
  const filters = [eq(funnelSession.workspaceId, workspaceId)]
  if (opts.purchasedOnly) filters.push(eq(funnelSession.purchased, true))
  return db.select().from(funnelSession).where(and(...filters)).orderBy(desc(funnelSession.lastTouchAt)).limit(Math.min(opts.limit ?? 50, 200))
}

export async function topSources(workspaceId: string, opts: { sinceDays?: number; limit?: number } = {}): Promise<Array<{ source: string; sessions: number; purchases: number; revenueCents: number }>> {
  const since = Date.now() - (opts.sinceDays ?? 30) * 86_400_000
  const rows = await db.select({
    source: funnelSession.firstSource,
    sessions: sql<number>`count(*)::int`,
    purchases: sql<number>`count(*) filter (where ${funnelSession.purchased} = true)::int`,
    revenueCents: sql<number>`coalesce(sum(${funnelSession.revenueCents}), 0)::int`,
  })
    .from(funnelSession)
    .where(and(eq(funnelSession.workspaceId, workspaceId), gte(funnelSession.firstTouchAt, since)))
    .groupBy(funnelSession.firstSource)
    .orderBy(desc(sql`count(*)`))
    .limit(Math.min(opts.limit ?? 20, 100))
  return rows.map(r => ({
    source: r.source ?? '(direct)',
    sessions: Number(r.sessions),
    purchases: Number(r.purchases),
    revenueCents: Number(r.revenueCents),
  }))
}
