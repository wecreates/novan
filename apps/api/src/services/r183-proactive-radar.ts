/**
 * R183 — Proactive interruption ("Sir, you have…") + live threat radar.
 *
 * proactiveScan sweeps for things that warrant butting in:
 *   urgent_dm          unanswered DM from existing whale
 *   whale_active       a decile-9+ customer just made a purchase
 *   crash              new high-severity incident
 *   funnel_drop        rate-quartile slip vs trailing 7d
 *   comment_high_pri   unanswered comment with reply_priority ≥80
 *   opportunity_30dph  money_opportunity ≥$100/hr just minted
 *   pentest_critical   new critical/high pentest finding
 *
 * Each fires a R129 push (if voice persona has proactive_enabled).
 *
 * radarScan rolls up CURRENT open threats from pentest_finding +
 * stability/drift events + incidents → one snapshot row that the
 * /radar/:ws/stream SSE endpoint streams as a ticker.
 */
import { db } from '../db/client.js'
import {
  proactiveSignal, threatRadarSnapshot, voicePersona, pentestFinding, moneyOpportunity,
  socialComment, customerScore, events, funnelEvent,
} from '../db/schema.js'
import { and, eq, desc, sql, isNull, gte } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── Proactive scanners ─────────────────────────────────────────────

interface SignalDraft { kind: string; severity: 'low' | 'normal' | 'high' | 'urgent'; summary: string; payload?: Record<string, unknown> }

async function scanCommentHighPri(workspaceId: string): Promise<SignalDraft[]> {
  const rows = await db.select({ id: socialComment.id, body: socialComment.body, platform: socialComment.platform })
    .from(socialComment)
    .where(and(
      eq(socialComment.workspaceId, workspaceId), isNull(socialComment.repliedAt),
      gte(socialComment.replyPriority, 80), gte(socialComment.fetchedAt, Date.now() - 6 * 60 * 60_000),
    ))
    .limit(3)
  return rows.map(r => ({
    kind: 'comment_high_pri', severity: 'high',
    summary: `New high-priority ${r.platform} comment: "${r.body.slice(0, 80)}…"`,
    payload: { commentId: r.id },
  }))
}

async function scanWhaleActive(workspaceId: string): Promise<SignalDraft[]> {
  const since = Date.now() - 60 * 60_000
  const rows = await db.select().from(customerScore)
    .where(and(
      eq(customerScore.workspaceId, workspaceId), gte(customerScore.decile, 9),
      gte(customerScore.lastPurchaseAt, since),
    ))
    .limit(3)
  return rows.map(r => ({
    kind: 'whale_active', severity: 'high',
    summary: `Whale ${r.customerRef} just bought — predicted LTV $${(r.predictedLtvCents / 100).toFixed(0)}`,
    payload: { customerRef: r.customerRef, ltv: r.predictedLtvCents },
  }))
}

async function scanCrash(workspaceId: string): Promise<SignalDraft[]> {
  const since = Date.now() - 30 * 60_000
  const rows = await db.select({ id: events.id, type: events.type })
    .from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      sql`${events.type} IN ('cron.error', 'incident.critical', 'deployment.failed')`,
      gte(events.createdAt, since),
    ))
    .limit(3)
  return rows.map(r => ({
    kind: 'crash', severity: 'urgent',
    summary: `${r.type} fired in the last 30 minutes`,
    payload: { eventId: r.id },
  }))
}

async function scanPentestCritical(workspaceId: string): Promise<SignalDraft[]> {
  const since = Date.now() - 24 * 60 * 60_000
  const rows = await db.select({ id: pentestFinding.id, title: pentestFinding.title, severity: pentestFinding.severity })
    .from(pentestFinding)
    .where(and(
      eq(pentestFinding.workspaceId, workspaceId), eq(pentestFinding.status, 'open'),
      sql`${pentestFinding.severity} IN ('critical', 'high')`, gte(pentestFinding.foundAt, since),
    ))
    .limit(3)
  return rows.map(r => ({
    kind: 'pentest_critical', severity: r.severity === 'critical' ? 'urgent' : 'high',
    summary: `${r.severity.toUpperCase()} pentest finding: ${r.title.slice(0, 100)}`,
    payload: { findingId: r.id },
  }))
}

async function scanFunnelDrop(workspaceId: string): Promise<SignalDraft[]> {
  const dayAgo = Date.now() - 24 * 60 * 60_000
  const weekAgo = Date.now() - 7 * 24 * 60 * 60_000
  const [day] = await db.select({ kind: funnelEvent.kind, n: sql<number>`count(*)::int` })
    .from(funnelEvent).where(and(eq(funnelEvent.workspaceId, workspaceId), gte(funnelEvent.at, dayAgo)))
    .groupBy(funnelEvent.kind)
  const [week] = await db.select({ kind: funnelEvent.kind, n: sql<number>`count(*)::int` })
    .from(funnelEvent).where(and(eq(funnelEvent.workspaceId, workspaceId), gte(funnelEvent.at, weekAgo)))
    .groupBy(funnelEvent.kind)
  if (!day || !week) return []
  const dailyAvg = Number(week.n) / 7
  if (dailyAvg > 10 && Number(day.n) < dailyAvg * 0.5) {
    return [{ kind: 'funnel_drop', severity: 'high', summary: `Funnel volume dropped ${Math.round((1 - Number(day.n) / dailyAvg) * 100)}% below trailing 7d average` }]
  }
  return []
}

async function scanBigOpportunity(workspaceId: string): Promise<SignalDraft[]> {
  const since = Date.now() - 60 * 60_000
  const rows = await db.select().from(moneyOpportunity)
    .where(and(
      eq(moneyOpportunity.workspaceId, workspaceId), eq(moneyOpportunity.status, 'open'),
      gte(moneyOpportunity.dollarsPerHour, 100), gte(moneyOpportunity.createdAt, since),
    ))
    .orderBy(desc(moneyOpportunity.dollarsPerHour)).limit(3)
  return rows.map(r => ({
    kind: 'opportunity_30dph', severity: 'normal',
    summary: `$${Math.round(r.dollarsPerHour)}/hr opportunity: ${r.title.slice(0, 100)}`,
    payload: { opportunityId: r.id },
  }))
}

export async function proactiveScan(workspaceId: string): Promise<{ minted: number; fired: number }> {
  const scanners = [scanCommentHighPri, scanWhaleActive, scanCrash, scanPentestCritical, scanFunnelDrop, scanBigOpportunity]
  const drafts: SignalDraft[] = []
  for (const s of scanners) try { drafts.push(...await s(workspaceId)) } catch { /* isolate */ }

  let minted = 0, fired = 0
  // Persona controls whether to actually push.
  const [persona] = await db.select().from(voicePersona)
    .where(and(eq(voicePersona.workspaceId, workspaceId), eq(voicePersona.name, 'novan'))).limit(1)
  const proactiveOk = persona ? persona.proactiveEnabled : true

  for (const d of drafts) {
    // Dedup: same kind in last 4h.
    const recent = await db.select({ id: proactiveSignal.id }).from(proactiveSignal)
      .where(and(
        eq(proactiveSignal.workspaceId, workspaceId), eq(proactiveSignal.kind, d.kind),
        gte(proactiveSignal.createdAt, Date.now() - 4 * 60 * 60_000),
      )).limit(1)
    if (recent.length > 0) continue

    const id = uuidv7()
    await db.insert(proactiveSignal).values({
      id, workspaceId, kind: d.kind, severity: d.severity, summary: d.summary.slice(0, 500),
      payload: d.payload ?? {}, createdAt: Date.now(),
    })
    minted += 1

    if (proactiveOk && (d.severity === 'high' || d.severity === 'urgent')) {
      try {
        const { broadcastPush } = await import('./web-push.js')
        await broadcastPush(workspaceId, {
          title: d.severity === 'urgent' ? '⚠ Novan · urgent' : 'Novan',
          body: d.summary, url: '/', icon: '/icons/icon-192.png', tag: `proactive-${d.kind}`,
        } as Parameters<typeof broadcastPush>[1]).catch(() => null)
        await db.update(proactiveSignal).set({ firedAt: Date.now() }).where(eq(proactiveSignal.id, id))
        fired += 1
      } catch { /* push best-effort */ }
    }
  }
  return { minted, fired }
}

export async function proactiveAck(workspaceId: string, id: string): Promise<{ ok: boolean }> {
  const r = await db.update(proactiveSignal).set({ ackedAt: Date.now() })
    .where(and(eq(proactiveSignal.workspaceId, workspaceId), eq(proactiveSignal.id, id)))
    .returning({ id: proactiveSignal.id })
  return { ok: r.length > 0 }
}

export async function proactiveList(workspaceId: string, opts: { unackedOnly?: boolean; limit?: number } = {}): Promise<Array<typeof proactiveSignal.$inferSelect>> {
  const filters = [eq(proactiveSignal.workspaceId, workspaceId)]
  if (opts.unackedOnly) filters.push(isNull(proactiveSignal.ackedAt))
  return db.select().from(proactiveSignal).where(and(...filters)).orderBy(desc(proactiveSignal.createdAt)).limit(Math.min(opts.limit ?? 30, 200))
}

// ─── Threat radar ────────────────────────────────────────────────────

export async function radarScan(workspaceId: string): Promise<typeof threatRadarSnapshot.$inferSelect> {
  // Pentest open by severity.
  const pen = await db.select({ severity: pentestFinding.severity, n: sql<number>`count(*)::int` })
    .from(pentestFinding)
    .where(and(eq(pentestFinding.workspaceId, workspaceId), eq(pentestFinding.status, 'open')))
    .groupBy(pentestFinding.severity)
  const penCat = await db.select({ category: pentestFinding.category, n: sql<number>`count(*)::int` })
    .from(pentestFinding)
    .where(and(eq(pentestFinding.workspaceId, workspaceId), eq(pentestFinding.status, 'open')))
    .groupBy(pentestFinding.category)

  const since24 = Date.now() - 24 * 60 * 60_000
  const [recentCrash] = await db.select({ n: sql<number>`count(*)::int` })
    .from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      sql`${events.type} IN ('cron.error', 'incident.critical', 'deployment.failed')`,
      gte(events.createdAt, since24),
    ))

  let critical = 0, high = 0, openTotal = 0
  const bySource: Record<string, number> = { pentest: 0, incidents: Number(recentCrash?.n ?? 0) }
  for (const r of pen) {
    const n = Number(r.n)
    bySource['pentest'] = (bySource['pentest'] ?? 0) + n
    openTotal += n
    if (r.severity === 'critical') critical += n
    if (r.severity === 'high')     high     += n
  }
  openTotal += Number(recentCrash?.n ?? 0)
  const byCategory: Record<string, number> = {}
  for (const r of penCat) byCategory[r.category ?? 'other'] = Number(r.n)
  const crashN = Number(recentCrash?.n ?? 0)
  if (crashN > 0) byCategory['runtime_crash'] = crashN

  const id = uuidv7()
  await db.insert(threatRadarSnapshot).values({
    id, workspaceId, scanAt: Date.now(),
    openTotal, criticalCount: critical, highCount: high,
    bySource, byCategory,
  })
  const [snap] = await db.select().from(threatRadarSnapshot).where(eq(threatRadarSnapshot.id, id)).limit(1)
  return snap!
}

export async function radarLatest(workspaceId: string): Promise<typeof threatRadarSnapshot.$inferSelect | null> {
  const [r] = await db.select().from(threatRadarSnapshot)
    .where(eq(threatRadarSnapshot.workspaceId, workspaceId))
    .orderBy(desc(threatRadarSnapshot.scanAt)).limit(1)
  return r ?? null
}

export async function radarTickerLine(workspaceId: string): Promise<string> {
  const s = await radarLatest(workspaceId)
  if (!s) return `Scanning… 0 issues detected.`
  if (s.openTotal === 0) return `Scanning… all clear.`
  const parts = [`Scanning… ${s.openTotal} issue${s.openTotal === 1 ? '' : 's'}`]
  if (s.criticalCount > 0) parts.push(`${s.criticalCount} critical`)
  if (s.highCount > 0) parts.push(`${s.highCount} high`)
  return parts.join(' · ')
}
