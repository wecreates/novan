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
  sparklines: {                                                                          // R394
    uploadsPerDay: number[]   // 14 days, oldest→newest
    salesPerDay:   number[]
    mrrPerDay:     number[]   // cumulative USD per day
  }
}

async function loadState(workspaceId: string): Promise<DashboardState> {
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

function renderHtml(s: DashboardState): string {
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
<div class="subtitle">Operator dashboard · auto-refresh 60s · ${new Date(s.ts).toLocaleString()}</div>

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

export async function renderDashboard(workspaceId: string): Promise<string> {
  try {
    const state = await loadState(workspaceId)
    return renderHtml(state)
  } catch (e) {
    return `<!doctype html><body style="font-family:system-ui;padding:20px"><h1>Dashboard error</h1><pre>${escapeHtml((e as Error).stack ?? (e as Error).message)}</pre></body>`
  }
}
