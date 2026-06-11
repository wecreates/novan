/**
 * R641 — Unified operator console (/ops/console).
 *
 * Mobile-first single-page summary of everything the operator usually
 * needs: inbox, recent assets, spend, KG counts, voice library, scrape
 * jobs, presence peers, kill switch + cost cap status.
 *
 * Pure HTML; one fetch per data source done in parallel here on the
 * server, so the operator's phone only does one HTTP roundtrip.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

const STYLE = `
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font:14px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#fafbfc;color:#1f2937;min-height:100vh;padding:env(safe-area-inset-top,0) env(safe-area-inset-right,0) env(safe-area-inset-bottom,16px) env(safe-area-inset-left,0)}
.wrap{max-width:1040px;margin:0 auto;padding:14px 14px 30px}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
h1{font-size:18px;margin:0;display:flex;align-items:center;gap:6px}
h1 .dot{width:8px;height:8px;border-radius:50%;background:#22c55e}
.timestamp{color:#6b7280;font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin:10px 0 16px}
.kpi{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;transition:transform .12s}
.kpi:active{transform:scale(.98)}
.kpi .label{color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.kpi .v{font-size:22px;font-weight:600;margin-top:2px}
.kpi .v.warn{color:#b45309}
.kpi .v.bad{color:#b91c1c}
.kpi .v.good{color:#059669}
.kpi .sub{color:#6b7280;font-size:11px;margin-top:2px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin-bottom:14px}
.card h2{font-size:13px;color:#374151;margin:0 0 10px;display:flex;align-items:center;justify-content:space-between;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.card h2 a{font-size:12px;color:#2563eb;text-decoration:none;font-weight:500;text-transform:none;letter-spacing:0}
.assets{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px}
.assets img{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:6px;background:#f3f4f6}
table{border-collapse:collapse;width:100%;font-size:13px}
th{font-size:11px;color:#6b7280;text-align:left;text-transform:uppercase;letter-spacing:.04em;padding:4px 8px 4px 0;border-bottom:1px solid #e5e7eb}
td{padding:6px 8px 6px 0;border-bottom:1px solid #f3f4f6;vertical-align:middle}
td.dim{color:#9ca3af;font-size:12px}
.peers{display:inline-flex;gap:3px;flex-wrap:wrap}
.peer{width:24px;height:24px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:10px;font-weight:700;border:1.5px solid #fff;box-shadow:0 0 0 1px #e5e7eb}
.nav{position:sticky;bottom:0;background:#ffffffec;backdrop-filter:blur(8px);border-top:1px solid #e5e7eb;display:flex;justify-content:space-around;padding:8px 0 calc(env(safe-area-inset-bottom,0) + 8px);margin:18px -14px -30px}
.nav a{color:#374151;text-decoration:none;font-size:11px;display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 12px;border-radius:6px;transition:background .15s}
.nav a:active{background:#f3f4f6}
.nav a svg{width:18px;height:18px;fill:currentColor}
.empty{color:#9ca3af;font-size:12px;padding:8px 0}
code{font:11.5px/1 ui-monospace,monospace;background:#f3f4f6;padding:1px 4px;border-radius:3px}
@media (prefers-color-scheme: dark){body{background:#0b0d12;color:#e5e7eb}.card,.kpi,.nav{background:#111827;border-color:#1f2937}.card h2{color:#9ca3af}.assets img{background:#1f2937}.timestamp,.kpi .label,.kpi .sub,th,td.dim,.empty,.nav a{color:#9ca3af}td{border-bottom-color:#1f2937}.nav a{color:#d1d5db}.nav a:active{background:#1f2937}}
`

function esc(s: unknown): string { return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!)) }
function fmtUsd(n: number): string { return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}` }
function fmtAgo(ts: number | null): string {
  if (!ts) return ''
  const ms = Date.now() - ts
  if (ms < 60_000)     return `${Math.round(ms / 1000)}s`
  if (ms < 3600_000)   return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.round(ms / 3600_000)}h`
  return `${Math.round(ms / 86_400_000)}d`
}

interface ConsoleSnapshot {
  inbox:   { pending: number; working: number; done24h: number; failed24h: number; oldestPendingMin: number | null }
  assets:  { total: number; byKind: Record<string, number>; recent: Array<{ id: string; url: string | null; createdAt: number }> }
  spend:   { d24h: number; d7d: number; daily_cap: number; monthly_cap: number; hardStop: boolean }
  kg:      { nodes: number; edges: number; topTypes: Array<{ type: string; count: number }> }
  voice:   { total: number; defaultName: string | null }
  scrape:  { jobs: number; running: number; ok24: number; fail24: number; nextDue: string | null }
  presence: { peers: Array<{ name: string; color: string; route?: string }> }
  killSwitch: { on: boolean; pausedUntil: number | null }
}

export async function buildSnapshot(workspaceId: string): Promise<ConsoleSnapshot> {
  const [inboxR, assetsR, recentAssetsR, spendR, capR, kgNodesR, kgEdgesR, kgTypesR, voiceR, voiceDefR, scrapeJobsR, scrapeRunsR, ksR] = await Promise.all([
    db.execute(sql`SELECT status, count(*)::int AS n, min(EXTRACT(EPOCH FROM (now() - to_timestamp(created_at/1000))) / 60)::int AS oldest_min FROM novan_inbox WHERE workspace_id = ${workspaceId} GROUP BY status`).catch(() => [] as unknown[]),
    db.execute(sql`SELECT kind, count(*)::int AS n FROM generated_assets WHERE workspace_id = ${workspaceId} GROUP BY kind`).catch(() => [] as unknown[]),
    db.execute(sql`SELECT id, public_url, created_at FROM generated_assets WHERE workspace_id = ${workspaceId} AND kind = 'image' ORDER BY created_at DESC LIMIT 8`).catch(() => [] as unknown[]),
    db.execute(sql`SELECT sum(CASE WHEN timestamp > ${Date.now() - 24*3600_000} THEN cost_usd ELSE 0 END)::float AS d24h, sum(CASE WHEN timestamp > ${Date.now() - 7*24*3600_000} THEN cost_usd ELSE 0 END)::float AS d7d FROM ai_usage WHERE workspace_id = ${workspaceId}`).catch(() => [{ d24h: 0, d7d: 0 }] as unknown[]),
    db.execute(sql`SELECT daily_usd, monthly_usd, hard_stop FROM spend_caps WHERE workspace_id = ${workspaceId}`).catch(() => [] as unknown[]),
    db.execute(sql`SELECT count(*)::int AS n FROM kg_nodes WHERE workspace_id = ${workspaceId}`).catch(() => [{ n: 0 }] as unknown[]),
    db.execute(sql`SELECT count(*)::int AS n FROM kg_edges WHERE workspace_id = ${workspaceId}`).catch(() => [{ n: 0 }] as unknown[]),
    db.execute(sql`SELECT type, count(*)::int AS n FROM kg_nodes WHERE workspace_id = ${workspaceId} GROUP BY type ORDER BY n DESC LIMIT 6`).catch(() => [] as unknown[]),
    db.execute(sql`SELECT count(*)::int AS n FROM voice_library WHERE workspace_id = ${workspaceId}`).catch(() => [{ n: 0 }] as unknown[]),
    db.execute(sql`SELECT name FROM voice_library WHERE workspace_id = ${workspaceId} AND is_default = true LIMIT 1`).catch(() => [] as unknown[]),
    db.execute(sql`SELECT count(*)::int AS n FROM scrape_jobs WHERE workspace_id = ${workspaceId} AND enabled = true`).catch(() => [{ n: 0 }] as unknown[]),
    db.execute(sql`SELECT status, count(*)::int AS n FROM scrape_runs WHERE workspace_id = ${workspaceId} AND started_at > ${Date.now() - 24*3600_000} GROUP BY status`).catch(() => [] as unknown[]),
    db.execute(sql`SELECT kill_switch, paused_until FROM workspace_settings WHERE workspace_id = ${workspaceId}`).catch(() => [] as unknown[]),
  ])

  // Inbox
  const inboxBy: Record<string, number> = {}
  let oldestPending: number | null = null
  for (const row of inboxR as Array<Record<string, unknown>>) {
    inboxBy[String(row['status'])] = Number(row['n'])
    if (String(row['status']) === 'pending') oldestPending = Number(row['oldest_min'] ?? 0)
  }

  // Assets
  const byKind: Record<string, number> = {}
  let total = 0
  for (const row of assetsR as Array<Record<string, unknown>>) {
    byKind[String(row['kind'])] = Number(row['n'])
    total += Number(row['n'])
  }
  const recent = (recentAssetsR as Array<Record<string, unknown>>).map(r => ({
    id:        String(r['id']),
    url:       r['public_url'] != null ? String(r['public_url']) : null,
    createdAt: Number(r['created_at']),
  }))

  // Spend + cap
  const spend = (spendR as Array<Record<string, unknown>>)[0] ?? { d24h: 0, d7d: 0 }
  const cap = (capR as Array<Record<string, unknown>>)[0] ?? { daily_usd: 5, monthly_usd: 100, hard_stop: false }

  // KG
  const kgNodes = Number(((kgNodesR as Array<Record<string, unknown>>)[0] ?? {})['n'] ?? 0)
  const kgEdges = Number(((kgEdgesR as Array<Record<string, unknown>>)[0] ?? {})['n'] ?? 0)
  const topTypes = (kgTypesR as Array<Record<string, unknown>>).map(r => ({ type: String(r['type']), count: Number(r['n']) }))

  // Voice
  const voiceTotal = Number(((voiceR as Array<Record<string, unknown>>)[0] ?? {})['n'] ?? 0)
  const voiceDef = (voiceDefR as Array<Record<string, unknown>>)[0]?.['name']
  const defaultName: string | null = voiceDef != null ? String(voiceDef) : null

  // Scrape
  const scrapeJobs = Number(((scrapeJobsR as Array<Record<string, unknown>>)[0] ?? {})['n'] ?? 0)
  const scrapeStatus: Record<string, number> = {}
  for (const row of scrapeRunsR as Array<Record<string, unknown>>) scrapeStatus[String(row['status'])] = Number(row['n'])

  // Kill switch
  const ksRow = (ksR as Array<Record<string, unknown>>)[0]
  const killSwitch = {
    on:          Boolean(ksRow?.['kill_switch']),
    pausedUntil: ksRow?.['paused_until'] != null ? Number(ksRow['paused_until']) : null,
  }

  // Presence (in-memory from R637 — read-only roster snapshot)
  let presencePeers: ConsoleSnapshot['presence']['peers'] = []
  try {
    const { presenceRoster } = await import('./r637-presence.js')
    presencePeers = presenceRoster(workspaceId).map(p => {
      const out: { name: string; color: string; route?: string } = { name: p.name, color: p.color }
      if (p.route) out.route = p.route
      return out
    })
  } catch { /* presence module optional */ }

  return {
    inbox: {
      pending:   inboxBy['pending'] ?? 0,
      working:   inboxBy['working'] ?? 0,
      done24h:   inboxBy['done']    ?? 0,
      failed24h: inboxBy['failed']  ?? 0,
      oldestPendingMin: oldestPending,
    },
    assets: { total, byKind, recent },
    spend: {
      d24h:       Number(spend['d24h'] ?? 0),
      d7d:        Number(spend['d7d']  ?? 0),
      daily_cap:  Number(cap['daily_usd']   ?? 5),
      monthly_cap:Number(cap['monthly_usd'] ?? 100),
      hardStop:   Boolean(cap['hard_stop']),
    },
    kg: { nodes: kgNodes, edges: kgEdges, topTypes },
    voice: { total: voiceTotal, defaultName },
    scrape: {
      jobs:    scrapeJobs,
      running: scrapeStatus['running'] ?? 0,
      ok24:    scrapeStatus['success'] ?? 0,
      fail24:  scrapeStatus['failed']  ?? 0,
      nextDue: null,
    },
    presence: { peers: presencePeers },
    killSwitch,
  }
}

export async function renderConsoleHtml(workspaceId: string, token: string): Promise<string> {
  const s = await buildSnapshot(workspaceId)
  const t = encodeURIComponent(token)

  // KPI tiles
  const inboxBacklog = s.inbox.pending + s.inbox.working
  const inboxKpi = inboxBacklog === 0 ? 'good' : (inboxBacklog > 50 ? 'warn' : '')
  const failKpi = s.inbox.failed24h === 0 ? '' : 'bad'
  const spendKpi = s.spend.d24h >= s.spend.daily_cap * 0.8 ? 'warn' : (s.spend.d24h >= s.spend.daily_cap ? 'bad' : '')
  const ksKpi = s.killSwitch.on ? 'bad' : 'good'

  const kpiHtml = `
    <div class="kpi"><div class="label">inbox</div><div class="v ${inboxKpi}">${inboxBacklog}</div><div class="sub">${s.inbox.pending} pend · ${s.inbox.working} run</div></div>
    <div class="kpi"><div class="label">failed 24h</div><div class="v ${failKpi}">${s.inbox.failed24h}</div><div class="sub">${s.inbox.done24h} done 24h</div></div>
    <div class="kpi"><div class="label">spend 24h</div><div class="v ${spendKpi}">${fmtUsd(s.spend.d24h)}</div><div class="sub">cap ${fmtUsd(s.spend.daily_cap)}${s.spend.hardStop ? ' · hard' : ''}</div></div>
    <div class="kpi"><div class="label">spend 7d</div><div class="v">${fmtUsd(s.spend.d7d)}</div><div class="sub">cap mo ${fmtUsd(s.spend.monthly_cap)}</div></div>
    <div class="kpi"><div class="label">assets</div><div class="v">${s.assets.total}</div><div class="sub">${Object.entries(s.assets.byKind).slice(0, 2).map(([k, n]) => `${n} ${esc(k)}`).join(' · ')}</div></div>
    <div class="kpi"><div class="label">kg</div><div class="v">${s.kg.nodes}</div><div class="sub">${s.kg.edges} edges</div></div>
    <div class="kpi"><div class="label">scrape</div><div class="v">${s.scrape.jobs}</div><div class="sub">${s.scrape.ok24} ok · ${s.scrape.fail24} fail 24h</div></div>
    <div class="kpi"><div class="label">kill switch</div><div class="v ${ksKpi}">${s.killSwitch.on ? 'ON' : 'off'}</div><div class="sub">voice: ${esc(s.voice.defaultName ?? '—')}</div></div>
  `

  const assetCards = s.assets.recent.map(a => a.url
    ? `<a href="${esc(a.url)}" target="_blank" rel="noopener"><img src="${esc(a.url)}" loading="lazy" alt="" title="${fmtAgo(a.createdAt)} ago"></a>`
    : '').join('')

  const peerHtml = s.presence.peers.length === 0
    ? '<span class="empty">No-one else online.</span>'
    : `<span class="peers">${s.presence.peers.map(p => `<span class="peer" style="background:${esc(p.color)}" title="${esc(p.name)}${p.route ? ' · ' + esc(p.route) : ''}">${esc((p.name ?? '?').slice(0, 1).toUpperCase())}</span>`).join('')}</span>`

  const kgTypesHtml = s.kg.topTypes.length === 0
    ? '<span class="empty">No KG nodes yet.</span>'
    : `<table><tbody>${s.kg.topTypes.map(t2 => `<tr><td><code>${esc(t2.type)}</code></td><td class="dim">${t2.count}</td></tr>`).join('')}</tbody></table>`

  const NAV_LINKS: Array<{ label: string; href: string; svg: string }> = [
    { label: 'voice',    href: `/voice?token=${t}`,           svg: '<path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/>' },
    { label: 'inbox',    href: `/ops/inbox?token=${t}`,       svg: '<path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 6h-4v6h-2V9H7l5-5 5 5z"/>' },
    { label: 'assets',   href: `/ops/gallery?token=${t}`,     svg: '<path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5z"/>' },
    { label: 'kg',       href: `/ops/kg/graph?token=${t}`,    svg: '<path d="M17 4a3 3 0 1 0-2.82 4H10v2H8a3 3 0 1 0 0 2h2v2h-.18A3 3 0 1 0 12 18a3 3 0 0 0 0-6v-2h4.18A3 3 0 1 0 17 4z"/>' },
    { label: 'spend',    href: `/ops/spend?token=${t}`,       svg: '<path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm.88 13.92v1.83h-1.75v-1.84a4 4 0 0 1-3.13-3.91h1.83a2.21 2.21 0 0 0 4.41 0c0-1.06-.59-1.84-2.65-2.34-2.05-.5-3.55-1.4-3.55-3.39a3.25 3.25 0 0 1 3.09-3.05V1.42h1.75v1.78a3.13 3.13 0 0 1 3 2.95H10.06a2.13 2.13 0 0 0 4.25.05c0-1-.4-1.85-2.39-2.38-2-.53-3.91-1.4-3.91-3.49a3.13 3.13 0 0 1 3-3z"/>' },
  ]

  const navHtml = NAV_LINKS.map(n => `<a href="${esc(n.href)}"><svg viewBox="0 0 24 24">${n.svg}</svg><span>${esc(n.label)}</span></a>`).join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#fafbfc" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0b0d12" media="(prefers-color-scheme: dark)">
<meta http-equiv="refresh" content="20">
<title>Novan Console</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
<header>
  <h1><span class="dot"></span>Novan</h1>
  <span class="timestamp">${esc(workspaceId)} · ${new Date().toUTCString().slice(0, 22)}</span>
</header>

<div class="grid">${kpiHtml}</div>

<div class="card">
  <h2>Recent assets <a href="/ops/gallery?token=${t}">gallery →</a></h2>
  <div class="assets">${assetCards || '<span class="empty">No assets yet. Drop briefs into the inbox or call <code>image.free.generate</code>.</span>'}</div>
</div>

<div class="card">
  <h2>Online <a href="/ops/timeline?token=${t}">timeline →</a></h2>
  ${peerHtml}
</div>

<div class="card">
  <h2>Knowledge graph <a href="/ops/kg/graph?token=${t}">view graph →</a></h2>
  ${kgTypesHtml}
</div>

<div class="card">
  <h2>Voice library <a href="/ops/voices?token=${t}">edit →</a></h2>
  <div style="font-size:13px;color:#374151">${s.voice.total} voice(s) saved${s.voice.defaultName ? ` · default <strong>${esc(s.voice.defaultName)}</strong>` : ''}</div>
</div>

<div class="card">
  <h2>Scrape <a href="/ops/scrape?token=${t}">jobs →</a></h2>
  <div style="font-size:13px">${s.scrape.jobs} enabled · <span class="${s.scrape.fail24 > 0 ? 'bad' : ''}">${s.scrape.fail24} failed 24h</span> · ${s.scrape.ok24} ok 24h</div>
</div>

<nav class="nav">${navHtml}</nav>
</div>
</body></html>`
}
