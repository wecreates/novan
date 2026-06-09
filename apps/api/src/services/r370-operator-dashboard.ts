/**
 * R370 — Operator dashboard.
 *
 * One self-contained HTML page that renders the live state of the operator's
 * POD pipeline:
 *   - Upload queue per platform
 *   - Live SKUs / external URLs
 *   - Goal-ladder tier + gap to next
 *   - Recent agent heartbeat + uploads
 *   - Pinterest queue + posting status
 *   - Recent failures (clickable to view screenshot)
 *
 * Read-only, no JS framework, no build step. Auto-refreshes every 60s.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { classifyTier, nextMilestone } from './r350-goal-ladder.js'

interface DashboardState {
  ts:               number
  workspaceId?:     string                                                                // R440
  uploads: {
    queueByPlatform: Array<{ platform: string; queued: number; uploaded: number }>
    recentUploads:   Array<{ platform: string; externalUrl: string; title: string; postedAt: number }>
    recentFailures:  Array<{ platform: string; error: string; pageUrl: string; ts: number; eventId: string }>
  }
  ladder: {
    tier:            string
    mrr30d:          number
    nextTier:        string | null
    gapUsd:          number
    percentToNext:   number
    unlockedTactics: string[]
    nextUnlocks?:    string[]   // R396 — tactics that unlock at next tier
  }
  agent: {
    lastHeartbeat:   number
    uploadsToday:    number
    failuresToday:   number
  }
  pinterest: {
    queued:          number
    postedTotal:     number
    postedToday:     number
    remainingToday:  number
    recentPosts:     Array<{ title: string; externalUrl: string; postedAt: number }>
  }
  activity: Array<{ ts: number; type: string; summary: string }>     // R379 — live activity feed
  nextActions: Array<{ id: string; title: string; detail: string; score: number; category: string }>  // R385
  failureClusters: Array<{ platform: string; signature: string; count: number; isLivePattern: boolean; suggestedFix: string; lastSeen: number }>  // R388
  stuck: Array<{ id: string; platform: string; title: string; ageHours: number }>        // R407
  niches: Array<{ niche: string; designCount: number; winnerRate: number; totalUsd: number }>  // R408
  topDesigns: Array<{ designId: string; prompt: string; totalUsd: number; saleCount: number; winnerScore: number; hasVariants: boolean }>  // R409
  mrrProjection?: {                                                                       // R414
    rate7dUsdPerDay: number
    rate14dUsdPerDay: number
    rateChangePct:   number
    projections:     Array<{ tier: string; daysToReach: number | null; reachableDate: string | null }>
  }
  cronHealth: Array<{ name: string; lastRanAt: number; lastStatus: string; lastDurationMs: number; lastError: string | null; staleHours: number }>  // R423
  disabledPlatforms: Array<{ platform: string; disabledAt: number; reason: string; autoReenableAt?: number }>  // R424 + R490
  selectorBreakers?: Array<{ key: string; fails: number; openUntilMs: number }>          // R491
  sessionAges?: Array<{ platform: string; ageDays: number; warningLevel: string }>      // R506
  aiSpend?: { todayUsd: number; todayCallCount: number; bySource: Array<{ source: string; usd: number; calls: number }>; cap?: { dailyUsd: number; pctUsed: number; budgetExhausted: boolean } }  // R428
  autonomyPaused?: boolean                                                                // R482
  sparklines: {                                                                          // R394
    uploadsPerDay: number[]   // 14 days, oldest→newest
    salesPerDay:   number[]
    mrrPerDay:     number[]   // cumulative USD per day
  }
}

export async function loadState(workspaceId: string): Promise<DashboardState> {
  const dayMs = 24 * 60 * 60 * 1000
  const cutoff = Date.now() - dayMs

  // Queue per platform
  const queueRows = await db.execute(sql`
    SELECT platform,
      COUNT(*) FILTER (WHERE status = 'queued')::int   AS queued,
      COUNT(*) FILTER (WHERE status = 'uploaded')::int AS uploaded
    FROM design_upload_queue
    WHERE workspace_id = ${workspaceId}
    GROUP BY platform
    ORDER BY platform
  `).catch(() => [] as unknown[])

  // Recent live SKUs (last 25 uploaded)
  const recentRows = await db.execute(sql`
    SELECT platform, external_url, title, uploaded_at
    FROM design_upload_queue
    WHERE workspace_id = ${workspaceId} AND status = 'uploaded' AND external_url IS NOT NULL
    ORDER BY uploaded_at DESC NULLS LAST
    LIMIT 25
  `).catch(() => [] as unknown[])

  // Recent failures from events
  const failureRows = await db.execute(sql`
    SELECT id, payload, created_at
    FROM events
    WHERE workspace_id = ${workspaceId} AND type = 'agent.failure'
    ORDER BY created_at DESC
    LIMIT 10
  `).catch(() => [] as unknown[])

  // Goal ladder via business_revenue
  const revenueRows = await db.execute(sql`
    SELECT COALESCE(SUM(net_usd), 0) AS total FROM business_revenue
    WHERE workspace_id = ${workspaceId} AND recorded_at >= ${cutoff * 30}
  `).catch(() => [] as unknown[])
  const mrr30d = Number((revenueRows as Array<{ total: number }>)[0]?.total ?? 0)
  const ms = nextMilestone(mrr30d)

  // Agent heartbeat
  const hbRows = await db.execute(sql`
    SELECT MAX(created_at) AS last_at FROM events
    WHERE workspace_id = ${workspaceId} AND type = 'agent.heartbeat'
  `).catch(() => [] as unknown[])
  const lastHeartbeat = Number((hbRows as Array<{ last_at: number }>)[0]?.last_at ?? 0)

  const todayUploadsRows = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM events
    WHERE workspace_id = ${workspaceId} AND type = 'agent.upload.success' AND created_at >= ${cutoff}
  `).catch(() => [] as unknown[])
  const uploadsToday = Number((todayUploadsRows as Array<{ n: number }>)[0]?.n ?? 0)

  const todayFailRows = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM events
    WHERE workspace_id = ${workspaceId} AND type = 'agent.upload.failed' AND created_at >= ${cutoff}
  `).catch(() => [] as unknown[])
  const failuresToday = Number((todayFailRows as Array<{ n: number }>)[0]?.n ?? 0)

  // Pinterest
  const pinRows = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
      COUNT(*) FILTER (WHERE status = 'posted')::int AS posted_total,
      COUNT(*) FILTER (WHERE status = 'posted' AND posted_at >= ${cutoff})::int AS posted_today
    FROM pinterest_pin_queue WHERE workspace_id = ${workspaceId}
  `).catch(() => [] as unknown[])
  const pinStat = (pinRows as Array<Record<string, number>>)[0] ?? { queued: 0, posted_total: 0, posted_today: 0 }

  // R379 — last 50 events (any type, recent first)
  const activityRows = await db.execute(sql`
    SELECT created_at, type, payload FROM events
    WHERE workspace_id = ${workspaceId}
    ORDER BY created_at DESC
    LIMIT 50
  `).catch(() => [] as unknown[])

  const recentPinRows = await db.execute(sql`
    SELECT title, external_url, posted_at FROM pinterest_pin_queue
    WHERE workspace_id = ${workspaceId} AND status = 'posted'
    ORDER BY posted_at DESC NULLS LAST LIMIT 5
  `).catch(() => [] as unknown[])

  return {
    ts: Date.now(),
    workspaceId,
    uploads: {
      queueByPlatform: (queueRows as Array<{ platform: string; queued: number; uploaded: number }>).map(r => ({
        platform: r.platform, queued: Number(r.queued) || 0, uploaded: Number(r.uploaded) || 0,
      })),
      recentUploads: (recentRows as Array<{ platform: string; external_url: string; title: string; uploaded_at: number }>).map(r => ({
        platform: r.platform, externalUrl: r.external_url, title: r.title, postedAt: Number(r.uploaded_at) || 0,
      })),
      recentFailures: (failureRows as Array<{ id: string; payload: Record<string, unknown>; created_at: number }>).map(r => ({
        platform: String(r.payload['platform'] ?? '?'),
        error:    String(r.payload['errorMessage'] ?? '?').slice(0, 200),
        pageUrl:  String(r.payload['pageUrl'] ?? ''),
        ts:       Number(r.created_at),
        eventId:  r.id,
      })),
    },
    ladder: {
      tier:            ms.current.tier,
      mrr30d:          Math.round(mrr30d * 100) / 100,
      nextTier:        ms.next?.tier ?? null,
      gapUsd:          Math.round(ms.gapUsd * 100) / 100,
      percentToNext:   ms.percentToNext,
      unlockedTactics: ms.current.unlockedTactics.slice(0, 5),
      nextUnlocks:     ms.next?.unlockedTactics.slice(0, 5),
    },
    agent: { lastHeartbeat, uploadsToday, failuresToday },
    pinterest: {
      queued:         Number(pinStat['queued']) || 0,
      postedTotal:    Number(pinStat['posted_total']) || 0,
      postedToday:    Number(pinStat['posted_today']) || 0,
      remainingToday: Math.max(0, 5 - (Number(pinStat['posted_today']) || 0)),
      recentPosts:    (recentPinRows as Array<{ title: string; external_url: string; posted_at: number }>).map(r => ({
        title: r.title, externalUrl: r.external_url, postedAt: Number(r.posted_at) || 0,
      })),
    },
    activity: (activityRows as Array<{ created_at: number; type: string; payload: Record<string, unknown> }>).map(r => {
      const t = r.type
      const p = r.payload
      let summary = t
      if (t === 'agent.upload.success')   summary = `✓ ${p['platform']} ${(p['externalUrl'] as string ?? '').slice(0, 60)}`
      else if (t === 'agent.upload.failed') summary = `✗ ${p['platform']}: ${(p['reason'] as string ?? '').slice(0, 60)}`
      else if (t === 'agent.upload.skipped') summary = `○ ${p['platform']}: ${(p['reason'] as string ?? '').slice(0, 60)}`
      else if (t === 'agent.heartbeat')   summary = `♥ agent uploads=${p['uploads']} failures=${p['failures']}`
      else if (t === 'agent.failure')     summary = `⚠ ${p['platform']}: ${(p['errorMessage'] as string ?? '').slice(0, 80)}`
      else if (t === 'business.tier_unlocked') summary = `🎉 ${p['fromTier']} → ${p['toTier']} ($${p['mrrUsd']} MRR)`
      else summary = `${t}`
      return { ts: Number(r.created_at), type: t, summary }
    }),
    nextActions: await (async () => {
      try {
        const { nextActions } = await import('./r385-next-action-recommender.js')
        const r = await nextActions(workspaceId)
        return r.actions.slice(0, 3).map(a => ({ id: a.id, title: a.title, detail: a.detail, score: a.score, category: a.category }))
      } catch { return [] }
    })(),
    failureClusters: await (async () => {
      try {
        const { detectFailureClusters } = await import('./r388-failure-clusters.js')
        const r = await detectFailureClusters(workspaceId)
        return r.clusters.slice(0, 5).map(c => ({
          platform: c.platform, signature: c.signature.slice(0, 100),
          count: c.count, isLivePattern: c.isLivePattern,
          suggestedFix: c.suggestedFix, lastSeen: c.lastSeen,
        }))
      } catch { return [] }
    })(),
    autonomyPaused: await (async () => {
      try {
        const { isAutonomyAllowed } = await import('./r443-autonomy-gate.js')
        return !await isAutonomyAllowed(workspaceId)
      } catch { return false }
    })(),
    aiSpend: await (async () => {
      try {
        const { spendSnapshot } = await import('./r428-ai-spend-tracker.js')
        return spendSnapshot(workspaceId)
      } catch { return undefined }
    })(),
    cronHealth: await (async () => {
      try {
        const { cronHealthSnapshot } = await import('./r423-cron-health.js')
        const r = await cronHealthSnapshot()
        return r.rows.map(x => ({
          name: x.name, lastRanAt: x.lastRanAt, lastStatus: x.lastStatus,
          lastDurationMs: x.lastDurationMs, lastError: x.lastError, staleHours: x.staleHours,
        }))
      } catch { return [] }
    })(),
    sessionAges: await (async () => {
      try {
        const { sessionAges } = await import('./r506-session-validity-probe.js')
        const r = await sessionAges(workspaceId)
        return r.filter(s => s.warningLevel !== 'ok').map(s => ({ platform: s.platform, ageDays: s.ageDays, warningLevel: s.warningLevel }))
      } catch { return [] }
    })(),
    selectorBreakers: await (async () => {
      try {
        const { selectorBreakerSnapshot } = await import('./r366-selector-improver.js')
        return selectorBreakerSnapshot()
      } catch { return [] }
    })(),
    disabledPlatforms: await (async () => {
      try {
        const { listDisabledPlatforms } = await import('./r412-platform-auto-disable.js')
        return listDisabledPlatforms(workspaceId)
      } catch { return [] }
    })(),
    mrrProjection: await (async () => {
      try {
        const { projectMrr } = await import('./r414-mrr-projection.js')
        const r = await projectMrr(workspaceId)
        return {
          rate7dUsdPerDay: r.rate7dUsdPerDay,
          rate14dUsdPerDay: r.rate14dUsdPerDay,
          rateChangePct: r.rateChangePct,
          projections: r.projections.slice(0, 3).map(p => ({ tier: p.tier, daysToReach: p.daysToReach, reachableDate: p.reachableDate })),
        }
      } catch { return undefined }
    })(),
    niches: await (async () => {
      try {
        const { rankNichePerformance } = await import('./r404-niche-performance.js')
        const r = await rankNichePerformance(workspaceId)
        return r.niches.slice(0, 6).map(n => ({
          niche: n.niche, designCount: n.designCount, winnerRate: n.winnerRate, totalUsd: n.totalUsd,
        }))
      } catch { return [] }
    })(),
    topDesigns: await (async () => {
      try {
        const { rankDesignPerformance } = await import('./r395-design-performance.js')
        const r = await rankDesignPerformance(workspaceId, 6)
        return r.designs.map(d => ({
          designId: d.designId, prompt: d.prompt.slice(0, 60),
          totalUsd: d.totalUsd, saleCount: d.saleCount,
          winnerScore: d.winnerScore, hasVariants: d.hasVariants,
        }))
      } catch { return [] }
    })(),
    stuck: await (async () => {
      try {
        const { detectStuckQueueItems } = await import('./r391-stuck-queue-detector.js')
        const r = await detectStuckQueueItems(workspaceId, 5)
        return r.items.map(i => ({ id: i.id, platform: i.platform, title: i.title.slice(0, 60), ageHours: i.ageHours }))
      } catch { return [] }
    })(),
    sparklines: await (async () => {
      const empty = Array(14).fill(0)
      const days = 14
      const dayMs2 = 24 * 60 * 60 * 1000
      const start = Date.now() - days * dayMs2
      try {
        const ur = await db.execute(sql`
          SELECT FLOOR((uploaded_at - ${start}) / ${dayMs2})::int AS bucket, COUNT(*)::int AS n
          FROM design_upload_queue
          WHERE workspace_id = ${workspaceId} AND status = 'uploaded' AND uploaded_at >= ${start}
          GROUP BY bucket
        `).catch(() => [] as unknown[])
        const u: number[] = [...empty]
        for (const r of (ur as Array<{ bucket: number; n: number }>)) {
          const b = Number(r.bucket); if (b >= 0 && b < days) u[b] = Number(r.n)
        }
        const sr = await db.execute(sql`
          SELECT FLOOR((recorded_at - ${start}) / ${dayMs2})::int AS bucket,
                 COUNT(*)::int AS n,
                 COALESCE(SUM(net_usd), 0)::float AS usd
          FROM business_revenue
          WHERE workspace_id = ${workspaceId} AND recorded_at >= ${start}
          GROUP BY bucket
        `).catch(() => [] as unknown[])
        const sd: number[] = [...empty]
        const m:  number[] = [...empty]
        for (const r of (sr as Array<{ bucket: number; n: number; usd: number }>)) {
          const b = Number(r.bucket); if (b >= 0 && b < days) { sd[b] = Number(r.n); m[b] = Number(r.usd) }
        }
        return { uploadsPerDay: u, salesPerDay: sd, mrrPerDay: m }
      } catch {
        return { uploadsPerDay: empty, salesPerDay: empty, mrrPerDay: empty }
      }
    })(),
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

function renderHtml(s: DashboardState, token?: string): string {
  const ago = (ms: number): string => {
    if (!ms) return '—'
    const diff = Date.now() - ms
    if (diff < 60_000) return Math.floor(diff / 1000) + 's ago'
    if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago'
    if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago'
    return Math.floor(diff / 86_400_000) + 'd ago'
  }
  const heartbeatStatus = s.agent.lastHeartbeat && (Date.now() - s.agent.lastHeartbeat) < 30 * 60_000 ? '🟢' : '🟡'

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Novan Operator Dashboard</title>
<meta http-equiv="refresh" content="60">
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #0a0a0b; color: #e5e7eb; }
  h1 { margin: 0 0 6px; font-size: 22px; font-weight: 600; letter-spacing: -0.5px; }
  .subtitle { color: #6b7280; margin-bottom: 24px; font-size: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 16px; }
  .card { background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 16px; }
  .card h2 { margin: 0 0 12px; font-size: 13px; font-weight: 600; color: #a1a1aa; text-transform: uppercase; letter-spacing: 0.6px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 6px 8px; border-bottom: 1px solid #27272a; text-align: left; font-size: 13px; }
  th { color: #71717a; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .pill-tier { background: #1e3a8a; color: #93c5fd; }
  .pill-up   { background: #14532d; color: #86efac; }
  .pill-fail { background: #7f1d1d; color: #fca5a5; }
  a { color: #60a5fa; text-decoration: none; word-break: break-all; }
  a:hover { text-decoration: underline; }
  .stat { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
  .stat-val { font-size: 24px; font-weight: 700; color: #fafafa; }
  .stat-lbl { font-size: 12px; color: #71717a; }
  .mini { font-size: 11px; color: #71717a; }
  .bar { height: 6px; background: #27272a; border-radius: 3px; overflow: hidden; margin-top: 6px; }
  .bar-fill { height: 100%; background: linear-gradient(90deg, #1e3a8a 0%, #3b82f6 100%); }
  ul { margin: 0; padding-left: 18px; color: #d4d4d8; font-size: 12px; line-height: 1.6; }
</style>
</head>
<body>
<h1>🎨 Novan — CYZOR CREATIONS</h1>
<div class="subtitle">Operator dashboard · auto-refresh 60s · ${new Date(s.ts).toLocaleString()}${s.workspaceId && s.workspaceId !== 'default' ? ` · workspace=${escapeHtml(s.workspaceId)}` : ''}</div>

${token ? `<div style="margin-bottom:20px;padding:12px;background:#18181b;border:1px solid #27272a;border-radius:8px;display:flex;flex-wrap:wrap;gap:8px">
  ${[
    ['daily_cron',           '🌅 Run daily cron'],
    ['replenish_queue',      '📦 Replenish queue'],
    ['auto_variants',        '🎨 Variants for winners'],
    ['auto_cross_list',      '🔁 Cross-list winners'],
    ['push_next_action',     '📱 Push next-action'],
    ['requeue_failed',       '♻ Requeue failed'],
    ['pacing_auto_loosen',   '⚡ Auto-loosen pacing'],
    ['relist_zero_sales',    '✏ Relist zero-sale'],
    ['webhook_self_test',    '🧪 Test webhook'],
  ].map(([action, label]) => `<form method="POST" action="/ops/dashboard/action" style="margin:0">
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    <input type="hidden" name="action" value="${escapeHtml(action as string)}">
    <button type="submit" aria-label="Fire ${escapeHtml(action as string)}" style="background:#1e3a8a;border:1px solid #3b82f6;color:#dbeafe;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600">${escapeHtml(label as string)}</button>
  </form>`).join('')}
</div>` : ''}

${s.autonomyPaused ? `<div style="background:#7f1d1d;border:1px solid #fca5a5;border-radius:8px;padding:16px;margin-bottom:20px"><strong style="color:#fee2e2">⏸ Autonomy paused</strong><div style="color:#fecaca;font-size:13px;margin-top:4px">kill_switch.autonomous_writes is engaged for this workspace. R382/R401/R411/R421/R458 won't fire. Resume via brain-task: kill_switch.enable autonomous_writes</div></div>` : ''}

${s.nextActions.length > 0 ? `<div style="background:#1e3a8a;border:1px solid #3b82f6;border-radius:8px;padding:16px;margin-bottom:20px">
  <div style="font-size:11px;color:#93c5fd;text-transform:uppercase;letter-spacing:0.6px;font-weight:600;margin-bottom:8px">Do this next · R385</div>
  <div style="font-size:18px;font-weight:600;color:#fafafa;margin-bottom:4px">${escapeHtml(s.nextActions[0]!.title)}</div>
  <div style="font-size:13px;color:#dbeafe;line-height:1.5">${escapeHtml(s.nextActions[0]!.detail)}</div>
  ${s.nextActions.length > 1 ? `<div style="margin-top:12px;font-size:12px;color:#93c5fd">Then: ${s.nextActions.slice(1).map(a => escapeHtml(a.title)).join(' · ')}</div>` : ''}
</div>` : ''}

<div class="grid">

  <div class="card" style="grid-column: 1 / -1">
    <h2>Trends — last 14 days (R394)</h2>
    ${(() => {
      const spark = (data: number[], color: string): string => {
        const w = 280, h = 36, n = data.length
        const max = Math.max(...data, 1)
        const pts = data.map((v, i) => `${(i / (n - 1)) * w},${h - (v / max) * (h - 2) - 1}`).join(' ')
        return `<svg width="${w}" height="${h}" style="vertical-align:middle"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/></svg>`
      }
      const sumU = s.sparklines.uploadsPerDay.reduce((a, b) => a + b, 0)
      const sumS = s.sparklines.salesPerDay.reduce((a, b) => a + b, 0)
      const sumM = s.sparklines.mrrPerDay.reduce((a, b) => a + b, 0)
      return `<table style="width:100%">
        <tr><td style="width:120px"><div class="stat-lbl">Uploads</div><div class="stat-val" style="font-size:18px">${sumU}</div></td><td>${spark(s.sparklines.uploadsPerDay, '#3b82f6')}</td></tr>
        <tr><td><div class="stat-lbl">Sales</div><div class="stat-val" style="font-size:18px">${sumS}</div></td><td>${spark(s.sparklines.salesPerDay, '#86efac')}</td></tr>
        <tr><td><div class="stat-lbl">Revenue</div><div class="stat-val" style="font-size:18px">$${sumM.toFixed(2)}</div></td><td>${spark(s.sparklines.mrrPerDay, '#fbbf24')}</td></tr>
      </table>`
    })()}
  </div>

  <div class="card">
    <h2>Goal-Ladder Tier</h2>
    <div class="stat"><span class="stat-val">$${s.ladder.mrr30d.toFixed(2)}</span><span class="stat-lbl">30d MRR</span></div>
    <div><span class="pill pill-tier">${escapeHtml(s.ladder.tier)}</span></div>
    ${s.ladder.nextTier ? `<div class="mini" style="margin-top:8px">Next: <strong>${escapeHtml(s.ladder.nextTier)}</strong> — gap $${s.ladder.gapUsd.toFixed(2)} (${s.ladder.percentToNext.toFixed(1)}%)</div><div class="bar"><div class="bar-fill" style="width:${s.ladder.percentToNext}%"></div></div>` : '<div class="mini">No next tier — top of ladder</div>'}
    <h2 style="margin-top:16px">Unlocked tactics</h2>
    <ul>${s.ladder.unlockedTactics.map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
    ${s.ladder.nextUnlocks && s.ladder.nextUnlocks.length > 0 ? `<h2 style="margin-top:16px">Coming up @ ${escapeHtml(s.ladder.nextTier ?? '')}</h2><ul style="opacity:0.6">${s.ladder.nextUnlocks.map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>` : ''}
  </div>

  <div class="card">
    <h2>Agent ${heartbeatStatus}</h2>
    <div class="mini">Last heartbeat: ${ago(s.agent.lastHeartbeat)}</div>
    <div style="margin-top:8px"><span class="pill pill-up">${s.agent.uploadsToday} uploads today</span> <span class="pill pill-fail">${s.agent.failuresToday} failures</span></div>
  </div>

  <div class="card">
    <h2>Upload queue per platform</h2>
    <table>
      <thead><tr><th>Platform</th><th>Queued</th><th>Live</th></tr></thead>
      <tbody>
        ${s.uploads.queueByPlatform.map(r => `<tr><td>${escapeHtml(r.platform)}</td><td>${r.queued}</td><td>${r.uploaded}</td></tr>`).join('')}
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>Recent live SKUs (${s.uploads.recentUploads.length})</h2>
    <table>
      <thead><tr><th>When</th><th>Platform</th><th>Link</th></tr></thead>
      <tbody>
        ${s.uploads.recentUploads.map(u => `<tr><td>${ago(u.postedAt)}</td><td>${escapeHtml(u.platform)}</td><td><a href="${escapeHtml(u.externalUrl)}" target="_blank">${escapeHtml(u.title.slice(0, 50))}</a></td></tr>`).join('')}
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>Pinterest</h2>
    <div class="stat"><span class="stat-val">${s.pinterest.postedTotal}</span><span class="stat-lbl">posted total · ${s.pinterest.postedToday} today · ${s.pinterest.queued} queued</span></div>
    <div class="mini">Remaining today: ${s.pinterest.remainingToday} / 5 cap</div>
    ${s.pinterest.recentPosts.length ? `<h2 style="margin-top:16px">Recent pins</h2><table><tbody>${s.pinterest.recentPosts.map(p => `<tr><td>${ago(p.postedAt)}</td><td><a href="${escapeHtml(p.externalUrl)}" target="_blank">${escapeHtml(p.title.slice(0, 50))}</a></td></tr>`).join('')}</tbody></table>` : ''}
  </div>

  <div class="card">
    <h2>Recent failures (${s.uploads.recentFailures.length})</h2>
    ${s.uploads.recentFailures.length === 0 ? '<div class="mini">✓ no recent failures</div>' : `<table><thead><tr><th>When</th><th>Platform</th><th>Error</th></tr></thead><tbody>${s.uploads.recentFailures.map(f => `<tr><td>${ago(f.ts)}</td><td>${escapeHtml(f.platform)}</td><td class="mini">${escapeHtml(f.error)}</td></tr>`).join('')}</tbody></table>`}
  </div>

  ${s.aiSpend ? `<div class="card">
    <h2>AI spend today (R428)</h2>
    <div class="stat"><span class="stat-val">$${s.aiSpend.todayUsd.toFixed(2)}</span><span class="stat-lbl">${s.aiSpend.todayCallCount} calls${s.aiSpend.cap ? ` · ${s.aiSpend.cap.pctUsed}% of $${s.aiSpend.cap.dailyUsd} cap` : ''}</span></div>
    ${s.aiSpend.cap?.budgetExhausted ? '<div class="pill pill-fail" style="margin-top:8px">budget exhausted — autonomous gen paused</div>' : ''}
    ${s.aiSpend.cap ? `<div class="bar" style="margin-top:6px"><div class="bar-fill" style="width:${Math.min(100, s.aiSpend.cap.pctUsed)}%;background:${s.aiSpend.cap.pctUsed >= 100 ? '#7f1d1d' : s.aiSpend.cap.pctUsed >= 80 ? '#fbbf24' : '#3b82f6'}"></div></div>` : ''}
    ${s.aiSpend.bySource.length > 0 ? `<table style="margin-top:8px"><tbody>${s.aiSpend.bySource.map(b => `<tr><td class="mini">${escapeHtml(b.source)}</td><td>$${b.usd.toFixed(2)}</td><td class="mini">${b.calls}</td></tr>`).join('')}</tbody></table>` : ''}
  </div>` : ''}

  ${s.mrrProjection ? `<div class="card" style="grid-column: 1 / -1">
    <h2>MRR projection (R414)</h2>
    <div class="stat">
      <span class="stat-val">$${s.mrrProjection.rate7dUsdPerDay.toFixed(2)}</span><span class="stat-lbl">7d/day · 14d/day $${s.mrrProjection.rate14dUsdPerDay.toFixed(2)} · trend ${s.mrrProjection.rateChangePct >= 0 ? '+' : ''}${s.mrrProjection.rateChangePct.toFixed(1)}%</span>
    </div>
    ${s.mrrProjection.projections.length > 0 ? `<table style="margin-top:8px"><thead><tr><th>Next tier</th><th>Days</th><th>Date</th></tr></thead><tbody>${s.mrrProjection.projections.map(p => `<tr><td>${escapeHtml(p.tier)}</td><td>${p.daysToReach ?? '—'}</td><td class="mini">${escapeHtml(p.reachableDate ?? '—')}</td></tr>`).join('')}</tbody></table>` : ''}
  </div>` : ''}

  ${s.topDesigns.length > 0 ? `<div class="card">
    <h2>Top designs (R409 · by revenue)</h2>
    <table>
      <thead><tr><th>Design</th><th>$</th><th>Sales</th><th>Score</th><th>Var.</th></tr></thead>
      <tbody>
        ${s.topDesigns.map(d => `<tr>
          <td>${escapeHtml(d.prompt)}</td>
          <td>$${d.totalUsd.toFixed(2)}</td>
          <td>${d.saleCount}</td>
          <td><span class="pill pill-up">${d.winnerScore}</span></td>
          <td>${d.hasVariants ? '✓' : '—'}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>` : ''}

  ${s.niches.length > 0 ? `<div class="card">
    <h2>Niches (R408)</h2>
    <table>
      <thead><tr><th>Niche</th><th>Designs</th><th>Win-rate</th><th>$</th></tr></thead>
      <tbody>
        ${s.niches.map(n => `<tr>
          <td>${escapeHtml(n.niche)}</td>
          <td>${n.designCount}</td>
          <td class="mini">${(n.winnerRate * 100).toFixed(1)}%</td>
          <td>$${n.totalUsd.toFixed(2)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>` : ''}

  ${s.stuck.length > 0 ? `<div class="card" style="grid-column: 1 / -1">
    <h2>Stuck queue items (R407 · queued >48h)</h2>
    <table>
      <thead><tr><th>Platform</th><th>Age</th><th>Title</th></tr></thead>
      <tbody>
        ${s.stuck.map(i => `<tr><td>${escapeHtml(i.platform)}</td><td class="mini">${i.ageHours}h</td><td>${escapeHtml(i.title)}</td></tr>`).join('')}
      </tbody>
    </table>
  </div>` : ''}

  ${s.sessionAges && s.sessionAges.length > 0 ? `<div class="card" style="grid-column: 1 / -1">
    <h2>Sessions aging (R506)</h2>
    <table>
      <thead><tr><th>Platform</th><th>Age</th><th>Status</th></tr></thead>
      <tbody>${s.sessionAges.map(x => `<tr>
        <td>${escapeHtml(x.platform)}</td>
        <td class="mini">${x.ageDays}d</td>
        <td><span class="pill ${x.warningLevel === 'stale' ? 'pill-fail' : 'pill-tier'}">${escapeHtml(x.warningLevel)}</span></td>
      </tr>`).join('')}</tbody>
    </table>
    <div class="mini" style="margin-top:8px">Sessions >20d may auto-expire. Run <code>pnpm signin</code> on your laptop to refresh.</div>
  </div>` : ''}

  ${s.disabledPlatforms.length > 0 ? `<div class="card" style="grid-column: 1 / -1">
    <h2>Disabled platforms (R424 · auto-probe in R490)</h2>
    <table>
      <thead><tr><th>Platform</th><th>Disabled</th><th>Auto-probe in</th><th>Reason</th></tr></thead>
      <tbody>${s.disabledPlatforms.map(p => {
        const remaining = (p.autoReenableAt ?? 0) - Date.now()
        const probeIn = remaining > 0 ? Math.round(remaining / 3_600_000) + 'h' : 'next 6h tick'
        return `<tr><td>${escapeHtml(p.platform)}</td><td class="mini">${ago(p.disabledAt)}</td><td class="mini">${probeIn}</td><td class="mini">${escapeHtml(p.reason)}</td></tr>`
      }).join('')}</tbody>
    </table>
  </div>` : ''}

  ${s.selectorBreakers && s.selectorBreakers.length > 0 ? `<div class="card" style="grid-column: 1 / -1">
    <h2>Selector improver breakers (R491)</h2>
    <table>
      <thead><tr><th>workspace|platform</th><th>Fails</th><th>State</th></tr></thead>
      <tbody>${s.selectorBreakers.map(b => {
        const state = b.openUntilMs > Date.now()
          ? `open · retries in ${Math.round((b.openUntilMs - Date.now()) / 60_000)}min`
          : `${b.fails}/3 fails`
        const pill = b.openUntilMs > Date.now() ? 'pill-fail' : 'pill-tier'
        return `<tr><td class="mini">${escapeHtml(b.key)}</td><td>${b.fails}</td><td><span class="pill ${pill}">${escapeHtml(state)}</span></td></tr>`
      }).join('')}</tbody>
    </table>
  </div>` : ''}

  ${s.cronHealth.length > 0 ? `<div class="card" style="grid-column: 1 / -1">
    <h2>Autonomous cron health (R423)</h2>
    <table>
      <thead><tr><th>Cron</th><th>Last run</th><th>Status</th><th>Duration</th><th>Note</th></tr></thead>
      <tbody>${s.cronHealth.map(c => `<tr>
        <td>${escapeHtml(c.name)}</td>
        <td class="mini">${ago(c.lastRanAt)}</td>
        <td>${c.lastStatus === 'ok' ? '<span class="pill pill-up">ok</span>' : c.lastStatus === 'skipped' ? '<span class="pill pill-tier">skip</span>' : '<span class="pill pill-fail">err</span>'}</td>
        <td class="mini">${c.lastDurationMs}ms</td>
        <td class="mini">${escapeHtml(c.lastError ?? (c.staleHours > 25 ? `stale ${c.staleHours}h` : ''))}</td>
      </tr>`).join('')}</tbody>
    </table>
  </div>` : ''}

  ${s.failureClusters.length > 0 ? `<div class="card" style="grid-column: 1 / -1">
    <h2>Failure patterns (R388 · last 7d)</h2>
    <table>
      <thead><tr><th>Platform</th><th>×</th><th>Signature</th><th>Suggested fix</th><th>Last</th></tr></thead>
      <tbody>
        ${s.failureClusters.map(c => `<tr>
          <td>${escapeHtml(c.platform)}</td>
          <td>${c.isLivePattern ? `<span class="pill pill-fail">${c.count}</span>` : c.count}</td>
          <td class="mini">${escapeHtml(c.signature)}</td>
          <td class="mini">${escapeHtml(c.suggestedFix)}</td>
          <td class="mini">${ago(c.lastSeen)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>` : ''}

  <div class="card" style="grid-column: 1 / -1">
    <h2>Activity stream — last 50 events</h2>
    <table>
      <thead><tr><th style="width:90px">When</th><th>Event</th></tr></thead>
      <tbody>
        ${s.activity.map(a => `<tr><td class="mini">${ago(a.ts)}</td><td>${escapeHtml(a.summary)}</td></tr>`).join('')}
      </tbody>
    </table>
  </div>

</div>
</body>
</html>`
}

// R433 — 30s in-memory snapshot cache so 60s auto-refresh + chat injection
// don't pound the DB with 25 queries per hit. Per-workspace.
const SNAPSHOT_CACHE = new Map<string, { ts: number; state: DashboardState }>()
const SNAPSHOT_TTL_MS = 30_000

async function loadStateCached(workspaceId: string): Promise<DashboardState> {
  const c = SNAPSHOT_CACHE.get(workspaceId)
  if (c && Date.now() - c.ts < SNAPSHOT_TTL_MS) return c.state
  const state = await loadState(workspaceId)
  SNAPSHOT_CACHE.set(workspaceId, { ts: Date.now(), state })
  return state
}

/** R399 — JSON dashboard snapshot for chat / brain-task consumption. */
export async function dashboardSnapshot(workspaceId: string): Promise<DashboardState> {
  return loadStateCached(workspaceId)
}

export async function renderDashboard(workspaceId: string, token?: string): Promise<string> {
  try {
    const state = await loadStateCached(workspaceId)
    return renderHtml(state, token)
  } catch (e) {
    return `<!doctype html><body style="font-family:system-ui;padding:20px"><h1>Dashboard error</h1><pre>${escapeHtml((e as Error).stack ?? (e as Error).message)}</pre></body>`
  }
}
