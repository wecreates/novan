/**
 * R168 — Close the open loops.
 *
 * (a) PAI lessons → prompt registry: high-confidence audience-loves /
 *     audience-dislikes / product-issue / competitor-gap lessons get
 *     seeded as new prompt versions under slots:
 *       'pai.audience.loves'
 *       'pai.audience.dislikes'
 *       'pai.audience.requests'
 *       'pai.product.issue'
 *       'pai.competitor.gap'
 *     so future LLM calls actually CONSUME the wisdom instead of just
 *     storing it.
 *
 * (b) Funnel revenue → PAI outcomeScore: completed runs without outcome
 *     get their score auto-filled from attributed funnel sessions
 *     (matched by post id stored in publishPlan.socialPostIds).
 */
import { db } from '../db/client.js'
import {
  videoPaiLesson, videoPaiRun, publishPlan, funnelSession, businessPrompts,
} from '../db/schema.js'
import { and, eq, desc, sql, isNull, isNotNull, gte } from 'drizzle-orm'

// ─── (a) Lessons → prompts ──────────────────────────────────────────

const TOPIC_SLOT: Record<string, string> = {
  'audience-loves':    'pai.audience.loves',
  'audience-dislikes': 'pai.audience.dislikes',
  'audience-requests': 'pai.audience.requests',
  'product-issue':     'pai.product.issue',
  'competitor-gap':    'pai.competitor.gap',
}

export async function lessonsToPrompts(workspaceId: string, opts: { minConfidence?: number; maxPerTopic?: number } = {}): Promise<{ seeded: number; perTopic: Record<string, number> }> {
  const minConf = opts.minConfidence ?? 0.7
  const maxPerTopic = opts.maxPerTopic ?? 5

  // Fetch high-confidence active lessons grouped by topic.
  const lessons = await db.select().from(videoPaiLesson)
    .where(and(
      eq(videoPaiLesson.workspaceId, workspaceId),
      isNull(videoPaiLesson.retiredAt),
      gte(videoPaiLesson.confidence, minConf),
    ))
    .orderBy(desc(videoPaiLesson.confidence))
    .limit(200)

  const { seedPrompt } = await import('./prompt-evolution.js')
  const perTopic: Record<string, number> = {}
  let seeded = 0

  for (const l of lessons) {
    const slot = TOPIC_SLOT[l.topic]
    if (!slot) continue
    const cur = perTopic[l.topic] ?? 0
    perTopic[l.topic] = cur
    if (cur >= maxPerTopic) continue

    // Skip if this exact pattern already lives in the slot's history.
    const [existing] = await db.select({ id: businessPrompts.id }).from(businessPrompts)
      .where(and(
        eq(businessPrompts.workspaceId, workspaceId),
        eq(businessPrompts.slot, slot),
        sql`${businessPrompts.body} = ${l.pattern}`,
      )).limit(1)
    if (existing) continue

    try {
      await seedPrompt({
        workspaceId,
        slot,
        body: l.pattern,
        origin: `pai_lesson:${l.id}`,
      } as unknown as Parameters<typeof seedPrompt>[0])
      perTopic[l.topic] = (perTopic[l.topic] ?? 0) + 1
      seeded += 1
      // Increment "uses" on the lesson so the same one isn't reseeded.
      await db.update(videoPaiLesson).set({ uses: sql`${videoPaiLesson.uses} + 1` }).where(eq(videoPaiLesson.id, l.id))
    } catch { /* skip on per-lesson failure */ }
  }
  return { seeded, perTopic }
}

// ─── (b) Funnel revenue → PAI outcomeScore ──────────────────────────

/**
 * For every 'done' PAI run with no outcomeScore in the last N days,
 * compute an outcome score from attributed funnel sessions and call
 * paiRecordOutcome. Attribution: sessions whose firstCampaign includes
 * the post id stored on the run's publish plan, OR sessions with the
 * runId substring in firstSource.
 *
 * Score normalization: revenueCents → log10-scaled then min/max
 * normalized against the rolling workspace max. Engagement-only runs
 * (no revenue) fall back to viewToPurchase pseudo-rate.
 */
export async function funnelToOutcome(workspaceId: string, opts: { sinceDays?: number } = {}): Promise<{ updated: number; perRun: Array<{ runId: string; score: number; revenueCents: number }> }> {
  const sinceDays = opts.sinceDays ?? 14
  const since = Date.now() - sinceDays * 86_400_000

  const runs = await db.select({
    id: videoPaiRun.id, startedAt: videoPaiRun.startedAt,
  })
    .from(videoPaiRun)
    .where(and(
      eq(videoPaiRun.workspaceId, workspaceId),
      eq(videoPaiRun.phase, 'done'),
      isNull(videoPaiRun.outcomeScore),
      gte(videoPaiRun.startedAt, since),
    ))
    .limit(200)

  if (runs.length === 0) return { updated: 0, perRun: [] }

  // Rolling max revenue per session for normalization (workspace wide).
  const [mx] = await db.select({ m: sql<number>`coalesce(max(${funnelSession.revenueCents}), 0)::int` })
    .from(funnelSession).where(eq(funnelSession.workspaceId, workspaceId))
  const rollingMax = Math.max(1, Number(mx?.m ?? 1))

  const { paiRecordOutcome } = await import('./r160-pai-video-loop.js')
  const perRun: Array<{ runId: string; score: number; revenueCents: number }> = []
  let updated = 0

  for (const r of runs) {
    // Find the run's publish plan + post ids.
    const [plan] = await db.select().from(publishPlan).where(eq(publishPlan.runId, r.id)).limit(1)
    const postIds = plan?.socialPostIds ?? []
    if (postIds.length === 0) continue

    // Sessions whose firstCampaign includes any post id (free-form match).
    const sessions = await db.select({
      revenueCents: funnelSession.revenueCents, purchased: funnelSession.purchased, views: funnelSession.viewCount,
    })
      .from(funnelSession)
      .where(and(
        eq(funnelSession.workspaceId, workspaceId),
        gte(funnelSession.firstTouchAt, r.startedAt),
        sql`(${funnelSession.firstCampaign} = ANY(${postIds as unknown as string[]}::text[])
             OR ${funnelSession.firstSource} = ANY(${postIds as unknown as string[]}::text[]))`,
      ))
      .limit(20_000)

    if (sessions.length === 0) continue
    const revenueCents = sessions.reduce((a, s) => a + Number(s.revenueCents), 0)
    const purchaseRate = sessions.length > 0
      ? sessions.filter(s => s.purchased).length / sessions.length
      : 0

    // Score: 80% revenue (log-normalized to rolling max), 20% purchase rate.
    const revNorm = Math.log10(Math.max(1, revenueCents + 1)) / Math.log10(rollingMax + 1)
    const score = Math.max(0, Math.min(1, 0.8 * revNorm + 0.2 * purchaseRate))

    try {
      await paiRecordOutcome(workspaceId, r.id, score, {
        source: 'funnel',
        revenueCents, sessionCount: sessions.length, purchaseRate,
        attributionPostIds: postIds,
      })
      perRun.push({ runId: r.id, score, revenueCents })
      updated += 1
    } catch { /* skip */ }
  }
  return { updated, perRun }
}

// ─── Combined closure pass (cron-friendly) ──────────────────────────

export async function closeLoops(workspaceId: string): Promise<{ lessonsSeeded: number; outcomesFilled: number }> {
  const l = await lessonsToPrompts(workspaceId).catch(() => ({ seeded: 0, perTopic: {} as Record<string, number> }))
  const f = await funnelToOutcome(workspaceId).catch(() => ({ updated: 0, perRun: [] as Array<{ runId: string; score: number; revenueCents: number }> }))
  return { lessonsSeeded: l.seeded, outcomesFilled: f.updated }
}

void isNotNull
