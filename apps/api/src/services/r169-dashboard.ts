/**
 * R169 — Operator dashboard aggregator.
 *
 * One brain op that returns everything the operator needs to see at a
 * glance + a prioritized action queue. No new tables — pure read.
 *
 * Surface:
 *   - audience    : list size + segment breakdown + recent magnet signups
 *   - social      : open high-priority comments + pending reply drafts
 *   - funnel      : 30d view→click→signup→purchase + top sources
 *   - revenue     : whale count + top customers + cross-business overlap top
 *   - pai         : runs last 7d + win rate + active lessons
 *   - publishing  : pending publish plans + scheduled posts
 *   - issues      : refund themes + dormant captures + drift signals
 *   - actionQueue : top 10 prioritized things to do right now
 */
import { db } from '../db/client.js'
import {
  leadCapture, leadMagnet, emailCampaign,
  socialComment, socialReplyDraft, socialCommentTheme,
  funnelEvent, funnelSession,
  customerScore, crossBusinessOverlap, refundReason,
  videoPaiRun, videoPaiLesson, publishPlan, socialPosts,
} from '../db/schema.js'
import { and, eq, desc, sql, isNull, gte } from 'drizzle-orm'

export interface DashboardSummary {
  audience: {
    listSize:         number
    engagedLast14d:   number
    dormant:          number
    magnetCount:      number
    signupsLast7d:    number
  }
  social: {
    openCommentsTotal:   number
    openHighPriority:    number
    pendingReplyDrafts:  number
    sentimentAvgLast14d: number
    topThemes:           Array<{ theme: string; count: number; sentiment: number }>
  }
  funnel: {
    windowDays: number
    views: number; clicks: number; signups: number; purchases: number
    revenueCents: number
    rates: { viewToClick: number; clickToSignup: number; signupToPurchase: number; viewToPurchase: number }
    topSources: Array<{ source: string; sessions: number; purchases: number; revenueCents: number }>
  }
  revenue: {
    whaleCount: number
    top5Whales: Array<{ customerRef: string; predictedLtvCents: number; decile: number }>
    crossBusinessTopOverlap: Array<{ a: string; b: string; pct: number }>
  }
  pai: {
    runs7d:        number
    avgIscPassRate: number
    avgOutcomeScore: number | null
    activeLessons: number
    topLessons:    Array<{ topic: string; pattern: string; confidence: number }>
  }
  publishing: {
    pendingPlans:    number
    scheduledPosts:  number
    draftPosts:      number
    publishedLast7d: number
  }
  issues: {
    topRefundCategories: Array<{ category: string; count: number; refundCents: number }>
    dormantCount:        number
  }
  actionQueue: Array<{ kind: string; label: string; href?: string; priority: number; meta?: Record<string, unknown> }>
  generatedAt: number
}

export async function dashboardSummary(workspaceId: string): Promise<DashboardSummary> {
  const now = Date.now()
  const day = 86_400_000
  const week7 = now - 7 * day
  const week2 = now - 14 * day
  const month1 = now - 30 * day

  // ─── audience ─────────────────────────────────────────────────────
  const [audCounts] = await db.select({
    total:   sql<number>`count(*) filter (where ${leadCapture.unsubscribedAt} is null)::int`,
    engaged: sql<number>`count(*) filter (where ${leadCapture.lastOpenAt} >= ${week2})::int`,
    recent:  sql<number>`count(*) filter (where ${leadCapture.subscribedAt} >= ${week7})::int`,
  })
    .from(leadCapture).where(eq(leadCapture.workspaceId, workspaceId))

  const [magCount] = await db.select({ n: sql<number>`count(*)::int` }).from(leadMagnet)
    .where(and(eq(leadMagnet.workspaceId, workspaceId), eq(leadMagnet.status, 'active')))

  const listSize = Number(audCounts?.total ?? 0)
  const engaged  = Number(audCounts?.engaged ?? 0)

  // ─── social ───────────────────────────────────────────────────────
  const [openComments] = await db.select({
    total: sql<number>`count(*) filter (where ${socialComment.repliedAt} is null and ${socialComment.intent} <> 'spam')::int`,
    hi:    sql<number>`count(*) filter (where ${socialComment.repliedAt} is null and ${socialComment.replyPriority} >= 60)::int`,
    sentSum: sql<number>`coalesce(sum(case when ${socialComment.sentiment} = 'pos' then 1 when ${socialComment.sentiment} = 'neg' then -1 else 0 end), 0)::int`,
    sentN:   sql<number>`count(*) filter (where ${socialComment.sentiment} is not null and ${socialComment.fetchedAt} >= ${week2})::int`,
  })
    .from(socialComment).where(eq(socialComment.workspaceId, workspaceId))

  const [pendingDrafts] = await db.select({ n: sql<number>`count(*)::int` })
    .from(socialReplyDraft)
    .where(and(eq(socialReplyDraft.workspaceId, workspaceId), eq(socialReplyDraft.status, 'draft')))

  const topThemes = await db.select().from(socialCommentTheme)
    .where(eq(socialCommentTheme.workspaceId, workspaceId))
    .orderBy(desc(socialCommentTheme.count)).limit(5)

  // ─── funnel ───────────────────────────────────────────────────────
  const funnelCounts = await db.select({
    kind: funnelEvent.kind, n: sql<number>`count(*)::int`, rev: sql<number>`coalesce(sum(${funnelEvent.amountCents}), 0)::int`,
  })
    .from(funnelEvent)
    .where(and(eq(funnelEvent.workspaceId, workspaceId), gte(funnelEvent.at, month1)))
    .groupBy(funnelEvent.kind)

  const m: Record<string, number> = {}
  let revenueCents = 0
  for (const c of funnelCounts) {
    m[c.kind] = Number(c.n)
    if (c.kind === 'purchase') revenueCents = Number(c.rev)
  }
  const views = m['view'] ?? 0
  const clicks = m['click'] ?? 0
  const signups = m['signup'] ?? 0
  const purchases = m['purchase'] ?? 0
  const safeDiv = (a: number, b: number): number => b > 0 ? Math.round((a / b) * 10000) / 10000 : 0

  const srcRows = await db.select({
    source: funnelSession.firstSource,
    sessions: sql<number>`count(*)::int`,
    purchases: sql<number>`count(*) filter (where ${funnelSession.purchased} = true)::int`,
    revenueCents: sql<number>`coalesce(sum(${funnelSession.revenueCents}), 0)::int`,
  })
    .from(funnelSession)
    .where(and(eq(funnelSession.workspaceId, workspaceId), gte(funnelSession.firstTouchAt, month1)))
    .groupBy(funnelSession.firstSource)
    .orderBy(desc(sql`count(*)`))
    .limit(5)

  // ─── revenue ─────────────────────────────────────────────────────
  const whales = await db.select().from(customerScore)
    .where(and(eq(customerScore.workspaceId, workspaceId), gte(customerScore.decile, 9)))
    .orderBy(desc(customerScore.predictedLtvCents)).limit(5)
  const [whaleCount] = await db.select({ n: sql<number>`count(*)::int` }).from(customerScore)
    .where(and(eq(customerScore.workspaceId, workspaceId), gte(customerScore.decile, 9)))
  const overlaps = await db.select().from(crossBusinessOverlap)
    .where(eq(crossBusinessOverlap.workspaceId, workspaceId))
    .orderBy(desc(crossBusinessOverlap.overlapPct)).limit(5)

  // ─── pai ─────────────────────────────────────────────────────────
  const [paiAgg] = await db.select({
    n: sql<number>`count(*)::int`,
    avgIsc: sql<number>`coalesce(avg(${videoPaiRun.iscPassRate}), 0)::float`,
    avgOut: sql<number>`avg(${videoPaiRun.outcomeScore})::float`,
  })
    .from(videoPaiRun)
    .where(and(eq(videoPaiRun.workspaceId, workspaceId), gte(videoPaiRun.startedAt, week7)))

  const lessons = await db.select().from(videoPaiLesson)
    .where(and(eq(videoPaiLesson.workspaceId, workspaceId), isNull(videoPaiLesson.retiredAt)))
    .orderBy(desc(videoPaiLesson.confidence)).limit(5)
  const [lessonCount] = await db.select({ n: sql<number>`count(*)::int` })
    .from(videoPaiLesson)
    .where(and(eq(videoPaiLesson.workspaceId, workspaceId), isNull(videoPaiLesson.retiredAt)))

  // ─── publishing ──────────────────────────────────────────────────
  const [pubAgg] = await db.select({
    pending:   sql<number>`count(*) filter (where ${publishPlan.status} = 'draft')::int`,
  })
    .from(publishPlan).where(eq(publishPlan.workspaceId, workspaceId))
  const [postAgg] = await db.select({
    scheduled: sql<number>`count(*) filter (where ${socialPosts.status} = 'scheduled')::int`,
    draft:     sql<number>`count(*) filter (where ${socialPosts.status} = 'draft')::int`,
    pub7d:     sql<number>`count(*) filter (where ${socialPosts.status} = 'published' and ${socialPosts.postedAt} >= ${week7})::int`,
  })
    .from(socialPosts).where(eq(socialPosts.workspaceId, workspaceId))

  // ─── issues ──────────────────────────────────────────────────────
  const refundRows = await db.select({
    category: refundReason.category,
    n: sql<number>`count(*)::int`,
    cents: sql<number>`coalesce(sum(${refundReason.amountCents}), 0)::int`,
  })
    .from(refundReason)
    .where(and(eq(refundReason.workspaceId, workspaceId), gte(refundReason.recordedAt, now - 60 * day)))
    .groupBy(refundReason.category)
    .orderBy(desc(sql`count(*)`)).limit(5)

  const dormant = Math.max(0, listSize - engaged)

  // ─── action queue (prioritized) ──────────────────────────────────
  const queue: DashboardSummary['actionQueue'] = []
  const openHi = Number(openComments?.hi ?? 0)
  const pend   = Number(pendingDrafts?.n ?? 0)
  const pubPending = Number(pubAgg?.pending ?? 0)

  if (openHi > 0)      queue.push({ kind: 'reply', label: `${openHi} high-priority comments unanswered`, priority: 95, meta: { count: openHi }, href: '/social/comments' })
  if (pend > 0)        queue.push({ kind: 'approve_reply', label: `${pend} reply drafts ready to approve`, priority: 85, meta: { count: pend } })
  if (pubPending > 0)  queue.push({ kind: 'approve_publish', label: `${pubPending} publish plans waiting for approval`, priority: 80, meta: { count: pubPending } })
  if (whales.length > 0) queue.push({ kind: 'reach_whales', label: `${whales.length} new whales — reach out personally`, priority: 70, meta: { count: whales.length } })
  if (refundRows.length > 0 && refundRows[0] && Number(refundRows[0].n) >= 3) {
    queue.push({ kind: 'fix_product', label: `Refund category "${refundRows[0].category ?? 'other'}" hit ${Number(refundRows[0].n)}× — fix root cause`, priority: 75, meta: { category: refundRows[0].category } })
  }
  if (dormant > listSize * 0.4 && listSize > 50) queue.push({ kind: 'reengage', label: `${dormant} dormant subscribers — run a win-back`, priority: 60, meta: { count: dormant } })
  if (Number(paiAgg?.n ?? 0) === 0) queue.push({ kind: 'launch_pai', label: `No PAI runs in last 7d — ship something`, priority: 90 })
  if (Number(magCount?.n ?? 0) === 0) queue.push({ kind: 'create_magnet', label: `No lead magnets yet — create one to start the list`, priority: 65 })

  queue.sort((a, b) => b.priority - a.priority)

  return {
    audience: {
      listSize,
      engagedLast14d: engaged,
      dormant,
      magnetCount: Number(magCount?.n ?? 0),
      signupsLast7d: Number(audCounts?.recent ?? 0),
    },
    social: {
      openCommentsTotal:   Number(openComments?.total ?? 0),
      openHighPriority:    openHi,
      pendingReplyDrafts:  pend,
      sentimentAvgLast14d: Number(openComments?.sentN ?? 0) > 0 ? Number(openComments?.sentSum ?? 0) / Number(openComments?.sentN ?? 1) : 0,
      topThemes: topThemes.map(t => ({ theme: t.theme, count: t.count, sentiment: t.sentimentAvg })),
    },
    funnel: {
      windowDays: 30,
      views, clicks, signups, purchases, revenueCents,
      rates: {
        viewToClick:      safeDiv(clicks, views),
        clickToSignup:    safeDiv(signups, clicks),
        signupToPurchase: safeDiv(purchases, signups),
        viewToPurchase:   safeDiv(purchases, views),
      },
      topSources: srcRows.map(r => ({
        source: r.source ?? '(direct)',
        sessions: Number(r.sessions),
        purchases: Number(r.purchases),
        revenueCents: Number(r.revenueCents),
      })),
    },
    revenue: {
      whaleCount: Number(whaleCount?.n ?? 0),
      top5Whales: whales.map(w => ({
        customerRef: w.customerRef,
        predictedLtvCents: w.predictedLtvCents,
        decile: w.decile,
      })),
      crossBusinessTopOverlap: overlaps.map(o => ({ a: o.businessA, b: o.businessB, pct: o.overlapPct })),
    },
    pai: {
      runs7d: Number(paiAgg?.n ?? 0),
      avgIscPassRate: Number(paiAgg?.avgIsc ?? 0),
      avgOutcomeScore: paiAgg?.avgOut != null ? Number(paiAgg.avgOut) : null,
      activeLessons: Number(lessonCount?.n ?? 0),
      topLessons: lessons.map(l => ({ topic: l.topic, pattern: l.pattern, confidence: l.confidence })),
    },
    publishing: {
      pendingPlans:    pubPending,
      scheduledPosts:  Number(postAgg?.scheduled ?? 0),
      draftPosts:      Number(postAgg?.draft ?? 0),
      publishedLast7d: Number(postAgg?.pub7d ?? 0),
    },
    issues: {
      topRefundCategories: refundRows.map(r => ({
        category: r.category ?? 'other',
        count: Number(r.n),
        refundCents: Number(r.cents),
      })),
      dormantCount: dormant,
    },
    actionQueue: queue.slice(0, 10),
    generatedAt: now,
  }
}

void emailCampaign
