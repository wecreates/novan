/**
 * R603 — End-to-end neural-net view of Novan.
 *
 * Treats the whole platform as a single neural network whose:
 *   - INPUT layer   = stimuli arriving (webhooks, chat, cron triggers, connector events)
 *   - HIDDEN layers = brain ops, pipelines, autobrowser pool, self-dev cycles
 *   - OUTPUT layer  = revenue events, emails sent, content posted, code shipped
 *   - LEARNING      = R582 memory recall + R601 knowledge graph + R55 prompt evolution
 *
 * Live counters:
 *   - tasksInFlight   = running pipelines + running autobrowser jobs + queued brain ops
 *   - revenueToday    = sum(net_usd) WHERE recorded_at >= UTC midnight
 *   - revenueMtd      = sum(net_usd) for current YYYY-MM
 *   - revenueYtd      = sum(net_usd) for current YYYY
 *
 * Activations:
 *   - last 60 minutes of ops fired (events table grouped by type)
 *   - hottest paths (top edges in event sequences within a 10-min window)
 *
 * Weights:
 *   - per-op = success_rate × log(1 + calls_24h). Surfaces the load-bearing
 *     paths so the operator can see which ops carry the network.
 *
 * All read-only; safe to poll at 5s intervals from a dashboard.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

// ─── Counters ────────────────────────────────────────────────────────────────

export interface LiveCounters {
  tasksInFlight: {
    total:               number
    pipelinesRunning:    number
    autobrowserRunning:  number
    autobrowserQueued:   number
    selfDevDraftWaiting: number
  }
  revenue: {
    today: number
    mtd:   number
    ytd:   number
    lifetime: number
    bySource24h: Array<{ source: string; usd: number; salesCount: number }>
  }
  throughput: {
    eventsLast60m:     number
    opsLast60m:        number
    pipelinesLast24h:  number
    autobrowserLast24h:number
  }
}

function utcDayStart(d = new Date()): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}
function utcMonthStr(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
function utcYearStr(d = new Date()): string {
  return String(d.getUTCFullYear())
}

export async function liveCounters(workspaceId: string): Promise<LiveCounters> {
  const dayStart  = utcDayStart()
  const monthStr  = utcMonthStr()
  const yearStr   = utcYearStr()
  const since60m  = Date.now() - 60 * 60_000
  const since24h  = Date.now() - 24 * 60 * 60_000

  const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback)

  const [
    pipelinesRunning, autobrowserRun, autobrowserQ, selfDevDraft,
    revToday, revMtd, revYtd, revLifetime, revBySrc,
    evt60m, ops60m, pipe24h, ab24h,
  ] = await Promise.all([
    safe(db.execute(sql`SELECT COUNT(*)::int AS n FROM pipeline_runs WHERE workspace_id = ${workspaceId} AND status = 'running'`), [{ n: 0 }] as unknown[]),
    safe(db.execute(sql`SELECT COUNT(*)::int AS n FROM autobrowser_jobs WHERE workspace_id = ${workspaceId} AND status = 'running'`), [{ n: 0 }] as unknown[]),
    safe(db.execute(sql`SELECT COUNT(*)::int AS n FROM autobrowser_jobs WHERE workspace_id = ${workspaceId} AND status = 'queued'`),  [{ n: 0 }] as unknown[]),
    safe(db.execute(sql`SELECT COUNT(*)::int AS n FROM self_dev_proposal WHERE workspace_id = ${workspaceId} AND status = 'draft'`),  [{ n: 0 }] as unknown[]),

    safe(db.execute(sql`SELECT COALESCE(SUM(net_usd),0)::float AS s FROM business_revenue WHERE workspace_id = ${workspaceId} AND recorded_at >= ${dayStart}`), [{ s: 0 }] as unknown[]),
    safe(db.execute(sql`SELECT COALESCE(SUM(net_usd),0)::float AS s FROM business_revenue WHERE workspace_id = ${workspaceId} AND earnings_month = ${monthStr}`), [{ s: 0 }] as unknown[]),
    safe(db.execute(sql`SELECT COALESCE(SUM(net_usd),0)::float AS s FROM business_revenue WHERE workspace_id = ${workspaceId} AND earnings_month LIKE ${`${yearStr}-%`}`), [{ s: 0 }] as unknown[]),
    safe(db.execute(sql`SELECT COALESCE(SUM(net_usd),0)::float AS s FROM business_revenue WHERE workspace_id = ${workspaceId}`), [{ s: 0 }] as unknown[]),
    safe(db.execute(sql`SELECT COALESCE(source,'unknown') AS source, COALESCE(SUM(net_usd),0)::float AS usd, COUNT(*) FILTER (WHERE net_usd > 0)::int AS n FROM business_revenue WHERE workspace_id = ${workspaceId} AND recorded_at >= ${since24h} GROUP BY source ORDER BY usd DESC LIMIT 8`), [] as unknown[]),

    safe(db.execute(sql`SELECT COUNT(*)::int AS n FROM events WHERE workspace_id = ${workspaceId} AND created_at >= ${since60m}`), [{ n: 0 }] as unknown[]),
    safe(db.execute(sql`SELECT COUNT(*)::int AS n FROM events WHERE workspace_id = ${workspaceId} AND created_at >= ${since60m} AND type LIKE 'admin_brain%'`), [{ n: 0 }] as unknown[]),
    safe(db.execute(sql`SELECT COUNT(*)::int AS n FROM pipeline_runs WHERE workspace_id = ${workspaceId} AND started_at >= ${since24h}`), [{ n: 0 }] as unknown[]),
    safe(db.execute(sql`SELECT COUNT(*)::int AS n FROM autobrowser_jobs WHERE workspace_id = ${workspaceId} AND created_at >= ${since24h}`), [{ n: 0 }] as unknown[]),
  ])

  const num = (r: unknown[]): number => Number((r as Array<{ n?: number; s?: number }>)[0]?.n ?? (r as Array<{ n?: number; s?: number }>)[0]?.s ?? 0)
  const pipelinesRunningN = num(pipelinesRunning)
  const autobrowserRunningN = num(autobrowserRun)
  const autobrowserQueuedN  = num(autobrowserQ)
  const selfDevDraftN       = num(selfDevDraft)

  return {
    tasksInFlight: {
      total: pipelinesRunningN + autobrowserRunningN + autobrowserQueuedN,
      pipelinesRunning:    pipelinesRunningN,
      autobrowserRunning:  autobrowserRunningN,
      autobrowserQueued:   autobrowserQueuedN,
      selfDevDraftWaiting: selfDevDraftN,
    },
    revenue: {
      today:    Math.round(num(revToday)    * 100) / 100,
      mtd:      Math.round(num(revMtd)      * 100) / 100,
      ytd:      Math.round(num(revYtd)      * 100) / 100,
      lifetime: Math.round(num(revLifetime) * 100) / 100,
      bySource24h: (revBySrc as Array<{ source: string; usd: number; n: number }>).map(x => ({
        source: x.source, usd: Math.round(Number(x.usd) * 100) / 100, salesCount: Number(x.n),
      })),
    },
    throughput: {
      eventsLast60m:      num(evt60m),
      opsLast60m:         num(ops60m),
      pipelinesLast24h:   num(pipe24h),
      autobrowserLast24h: num(ab24h),
    },
  }
}

// ─── Activations (event histogram) ──────────────────────────────────────────

export interface Activation { type: string; n: number; lastAt: number }

export async function recentActivations(workspaceId: string, windowMs = 60 * 60_000, limit = 30): Promise<Activation[]> {
  const since = Date.now() - windowMs
  const r = await db.execute(sql`
    SELECT type, COUNT(*)::int AS n, MAX(created_at) AS last_at
    FROM events WHERE workspace_id = ${workspaceId} AND created_at >= ${since}
    GROUP BY type ORDER BY n DESC LIMIT ${Math.min(limit, 200)}
  `).catch(() => [] as unknown[])
  return (r as Array<{ type: string; n: number; last_at: number }>).map(x => ({ type: x.type, n: Number(x.n), lastAt: Number(x.last_at) }))
}

// ─── Layer view ──────────────────────────────────────────────────────────────

export interface NeuralLayer {
  name:        string
  description: string
  nodes:       Array<{ id: string; label: string; weight: number; lastFired?: number }>
}

const LAYER_PATTERNS: Array<{ name: string; description: string; types: RegExp[] }> = [
  { name: 'Input',     description: 'Stimuli arriving — connectors, webhooks, chat, cron triggers', types: [/^webhook\./, /^chat\./, /^cron\./, /^stripe\./, /^gumroad\./, /^tiktok\./, /^connector\./, /^email_inbound/, /^scrape/] },
  { name: 'Decision',  description: 'Brain dispatch, plan mode, hooks, ACL gates',                  types: [/^admin_brain\./, /^plan_proposal\./, /^selfdev\./, /^operator_hook\./, /^team\./] },
  { name: 'Processing',description: 'Pipelines, ops, autobrowser, music studio, voice, video',     types: [/^pipeline\./, /^autobrowser\./, /^music\./, /^voice\./, /^video\./, /^image_gen\./, /^embed\./, /^op\./, /^business\./] },
  { name: 'Output',    description: 'Revenue events, emails sent, content posted, code applied',    types: [/^revenue\./, /^email\./, /^post_published\./, /^upload\./, /^applier\./, /^deploy\./, /^kg\./] },
  { name: 'Learning',  description: 'Memory recall, KG, evolution, parity, federation',             types: [/^memory\./, /^parity\./, /^federation\./, /^prompt_evolution/, /^lesson\./, /^standards\./] },
]

export async function neuralLayers(workspaceId: string, windowMs = 24 * 60 * 60_000, perLayer = 8): Promise<NeuralLayer[]> {
  const since = Date.now() - windowMs
  const r = await db.execute(sql`
    SELECT type, COUNT(*)::int AS n, MAX(created_at) AS last_at
    FROM events WHERE workspace_id = ${workspaceId} AND created_at >= ${since}
    GROUP BY type
  `).catch(() => [] as unknown[])
  const rows = r as Array<{ type: string; n: number; last_at: number }>
  const out: NeuralLayer[] = []
  for (const L of LAYER_PATTERNS) {
    const nodes = rows
      .filter(x => L.types.some(rgx => rgx.test(x.type)))
      .map(x => ({ id: x.type, label: x.type.split('.').slice(0, 2).join('.'), weight: Math.log(1 + Number(x.n)), lastFired: Number(x.last_at) }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, perLayer)
    out.push({ name: L.name, description: L.description, nodes })
  }
  return out
}

// ─── R605: Per-layer sparklines (last 60 minutes in 5-min buckets) ──────────

export interface LayerSparkline {
  name:    string
  buckets: number[]   // 12 values (oldest → newest), 5-min buckets
  total:   number
}

export async function layerSparklines(workspaceId: string, bucketCount = 12, bucketMs = 5 * 60_000): Promise<LayerSparkline[]> {
  const windowMs = bucketCount * bucketMs
  const now = Date.now()
  const since = now - windowMs
  const r = await db.execute(sql`
    SELECT type, created_at FROM events
    WHERE workspace_id = ${workspaceId} AND created_at >= ${since}
  `).catch(() => [] as unknown[])
  const rows = r as Array<{ type: string; created_at: number }>

  const out: LayerSparkline[] = []
  for (const L of LAYER_PATTERNS) {
    const buckets = new Array(bucketCount).fill(0)
    let total = 0
    for (const row of rows) {
      if (!L.types.some(rgx => rgx.test(row.type))) continue
      const idx = Math.min(bucketCount - 1, Math.floor((Number(row.created_at) - since) / bucketMs))
      if (idx < 0) continue
      buckets[idx]++
      total++
    }
    out.push({ name: L.name, buckets, total })
  }
  return out
}

/** Compact SVG sparkline render. Returns inline SVG string ready to embed. */
export function renderSparklineSvg(buckets: number[], opts: { width?: number; height?: number; color?: string } = {}): string {
  const w = opts.width ?? 120, h = opts.height ?? 22
  const max = Math.max(1, ...buckets)
  if (buckets.length < 2) return `<svg width="${w}" height="${h}"></svg>`
  const dx = w / (buckets.length - 1)
  const points = buckets.map((v, i) => `${(i * dx).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`).join(' ')
  const last = buckets[buckets.length - 1] ?? 0
  const color = opts.color ?? '#60a5fa'
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="display:inline-block;vertical-align:middle">
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="${(w).toFixed(1)}" cy="${(h - (last / max) * (h - 2) - 1).toFixed(1)}" r="2" fill="${color}"/>
  </svg>`
}

// ─── R604: Compact hero strip for embed on /ops/dashboard ───────────────────

/** One-liner HTML strip with live counters + sparklines for header injection. */
export async function renderHeroStrip(workspaceId: string): Promise<string> {
  const [counters, sparks] = await Promise.all([
    liveCounters(workspaceId),
    layerSparklines(workspaceId),
  ])
  const layerColor: Record<string, string> = { Input: '#60a5fa', Decision: '#a78bfa', Processing: '#22c55e', Output: '#facc15', Learning: '#f472b6' }
  const sparkCells = sparks.map(s => `
    <div title="${s.name}: ${s.total} events in 60m">
      <div style="font-size:10px;color:#a1a1aa;letter-spacing:.3px">${s.name.toUpperCase()}</div>
      ${renderSparklineSvg(s.buckets, { width: 110, height: 22, color: layerColor[s.name] ?? '#60a5fa' })}
      <span style="font-size:11px;color:#fafafa;font-variant-numeric:tabular-nums">${s.total}</span>
    </div>
  `).join('')
  return `<div style="background:#0f0f12;border:1px solid #27272a;border-radius:10px;padding:12px 16px;margin-bottom:18px;display:flex;flex-wrap:wrap;gap:24px;align-items:center;font-family:-apple-system,system-ui,sans-serif">
    <div style="display:flex;flex-direction:column;min-width:140px">
      <span style="font-size:10px;color:#a1a1aa;letter-spacing:.5px;text-transform:uppercase">Tasks in flight</span>
      <span style="font-size:24px;font-weight:600;color:#22c55e;line-height:1.1">${counters.tasksInFlight.total}</span>
      <span style="font-size:10px;color:#71717a">${counters.tasksInFlight.pipelinesRunning} pipe · ${counters.tasksInFlight.autobrowserRunning} browse · ${counters.tasksInFlight.autobrowserQueued} q</span>
    </div>
    <div style="display:flex;flex-direction:column;min-width:120px">
      <span style="font-size:10px;color:#a1a1aa;letter-spacing:.5px;text-transform:uppercase">Today</span>
      <span style="font-size:24px;font-weight:600;color:#facc15;line-height:1.1">${fmtUsd(counters.revenue.today)}</span>
      <span style="font-size:10px;color:#71717a">${counters.revenue.bySource24h.length} sources 24h</span>
    </div>
    <div style="display:flex;flex-direction:column;min-width:120px">
      <span style="font-size:10px;color:#a1a1aa;letter-spacing:.5px;text-transform:uppercase">Month</span>
      <span style="font-size:24px;font-weight:600;color:#facc15;line-height:1.1">${fmtUsd(counters.revenue.mtd)}</span>
      <span style="font-size:10px;color:#71717a">YTD ${fmtUsd(counters.revenue.ytd)}</span>
    </div>
    <div style="display:flex;flex-direction:column;min-width:120px">
      <span style="font-size:10px;color:#a1a1aa;letter-spacing:.5px;text-transform:uppercase">Lifetime</span>
      <span style="font-size:24px;font-weight:600;color:#facc15;line-height:1.1">${fmtUsd(counters.revenue.lifetime)}</span>
      <span style="font-size:10px;color:#71717a">${counters.throughput.eventsLast60m} events/60m</span>
    </div>
    <div style="flex:1;display:flex;gap:14px;flex-wrap:wrap;justify-content:flex-end">${sparkCells}</div>
    <a href="/ops/neural?token=${encodeURIComponent('any')}&workspace=default" style="color:#60a5fa;text-decoration:none;font-size:11px;border:1px solid #27272a;padding:4px 8px;border-radius:6px;background:#18181b">R603 neural →</a>
  </div>`
}

// ─── HTML render ─────────────────────────────────────────────────────────────

function fmtUsd(n: number): string {
  return n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(2)}`
}

function fmtAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export async function renderNeuralHtml(workspaceId: string): Promise<string> {
  const [counters, layers, activations, sparks] = await Promise.all([
    liveCounters(workspaceId),
    neuralLayers(workspaceId),
    recentActivations(workspaceId, 60 * 60_000, 20),
    layerSparklines(workspaceId),
  ])
  const sparkByLayer = new Map(sparks.map(s => [s.name, s]))
  const maxA = activations.reduce((m, a) => Math.max(m, a.n), 1)

  const layerColor: Record<string, string> = { Input: '#60a5fa', Decision: '#a78bfa', Processing: '#22c55e', Output: '#facc15', Learning: '#f472b6' }
  const layerColumns = layers.map(L => `
    <div class="layer">
      <h3>${escapeHtml(L.name)}</h3>
      <div class="layer-sub">${escapeHtml(L.description)}</div>
      <div style="margin:4px 0 8px;display:flex;align-items:center;gap:6px">
        ${sparkByLayer.has(L.name) ? renderSparklineSvg(sparkByLayer.get(L.name)!.buckets, { width: 140, height: 24, color: layerColor[L.name] ?? '#60a5fa' }) : ''}
        <span style="font-size:10px;color:#a1a1aa">${sparkByLayer.get(L.name)?.total ?? 0} in 60m</span>
      </div>
      ${L.nodes.length === 0 ? '<div class="empty">no activity in 24h</div>' :
        L.nodes.map(n => `
          <div class="node" style="--w:${Math.min(1, n.weight / 6)}" title="${escapeHtml(n.id)}${n.lastFired ? ' · last ' + fmtAgo(n.lastFired) + ' ago' : ''}">
            <span class="node-lbl">${escapeHtml(n.label)}</span>
            <span class="node-w">${n.weight.toFixed(2)}</span>
          </div>
        `).join('')
      }
    </div>
  `).join('')

  const activationBars = activations.map(a => `
    <div class="actbar">
      <span class="actbar-name">${escapeHtml(a.type)}</span>
      <span class="actbar-bar" style="width:${Math.round((a.n / maxA) * 100)}%"></span>
      <span class="actbar-n">${a.n}</span>
      <span class="actbar-ago">${fmtAgo(a.lastAt)} ago</span>
    </div>
  `).join('')

  const revRows = counters.revenue.bySource24h.length === 0
    ? '<tr><td colspan="3" class="empty">No revenue events in last 24h</td></tr>'
    : counters.revenue.bySource24h.map(s => `<tr><td>${escapeHtml(s.source)}</td><td>${fmtUsd(s.usd)}</td><td>${s.salesCount}</td></tr>`).join('')

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta http-equiv="refresh" content="5"/>
<title>Novan Neural Net</title>
<style>
  :root { color-scheme: dark; --bg:#09090b; --card:#18181b; --border:#27272a; --fg:#fafafa; --mute:#a1a1aa; --accent:#22c55e; --warn:#facc15; --pink:#f472b6; --blue:#60a5fa; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px -apple-system, system-ui, sans-serif; padding:18px; }
  h1 { margin:0 0 4px; font-size:18px; font-weight:600 }
  .subtitle { color:var(--mute); margin-bottom:18px; font-size:12px }
  .hero { display:grid; grid-template-columns: repeat(4, 1fr); gap:12px; margin-bottom:18px }
  .hero-card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:16px }
  .hero-card h4 { margin:0 0 6px; color:var(--mute); font-size:11px; text-transform:uppercase; letter-spacing:.5px; font-weight:500 }
  .hero-val { font-size:28px; font-weight:600; line-height:1 }
  .hero-sub { color:var(--mute); font-size:11px; margin-top:6px }
  .hero-card.pulse .hero-val { color:var(--accent) }
  .hero-card.rev .hero-val { color:var(--warn) }
  .grid { display:grid; grid-template-columns: 2fr 1fr; gap:18px }
  .card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:16px }
  .card h2 { margin:0 0 14px; font-size:14px; font-weight:600; color:var(--fg) }
  .layers { display:grid; grid-template-columns: repeat(5, 1fr); gap:10px }
  .layer { background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:10px; min-height:200px }
  .layer h3 { margin:0 0 4px; font-size:12px; font-weight:600; color:var(--blue) }
  .layer-sub { color:var(--mute); font-size:10px; margin-bottom:10px; line-height:1.3 }
  .empty { color:var(--mute); font-size:11px; font-style:italic }
  .node { display:flex; justify-content:space-between; align-items:center; padding:5px 7px; margin-bottom:4px; background:#0f0f12; border-radius:4px; border-left:3px solid transparent; border-image: linear-gradient(to bottom, rgba(96,165,250,calc(0.4 + var(--w) * 0.6)), rgba(96,165,250,calc(0.4 + var(--w) * 0.6))) 1; font-size:11px }
  .node-lbl { color:var(--fg); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:130px }
  .node-w { color:var(--mute); font-variant-numeric:tabular-nums; font-size:10px }
  .actbar { display:grid; grid-template-columns: 1fr auto auto auto; gap:8px; align-items:center; padding:4px 0; font-size:11px; border-bottom:1px dashed #1f1f23 }
  .actbar-name { color:var(--fg); overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
  .actbar-bar { display:inline-block; height:5px; background:linear-gradient(to right, var(--blue), var(--pink)); border-radius:2px; min-width:1px; max-width:120px }
  .actbar-n { color:var(--accent); font-variant-numeric:tabular-nums; min-width:30px; text-align:right }
  .actbar-ago { color:var(--mute); min-width:50px; text-align:right }
  table { width:100%; border-collapse:collapse; font-size:12px }
  th { text-align:left; color:var(--mute); font-weight:500; padding:6px 4px; border-bottom:1px solid var(--border) }
  td { padding:6px 4px; border-bottom:1px dashed #1f1f23 }
  td.empty { text-align:center; color:var(--mute); padding:20px 0 }
  .throughput { display:grid; grid-template-columns: repeat(2, 1fr); gap:8px; font-size:11px; margin-top:10px }
  .throughput div { padding:6px 8px; background:#0f0f12; border-radius:4px; color:var(--mute) }
  .throughput div b { color:var(--fg); float:right }
</style>
</head><body>
<h1>Novan Neural Network · R603</h1>
<div class="subtitle">live · refreshes every 5s · workspace ${escapeHtml(workspaceId)}</div>

<div class="hero">
  <div class="hero-card pulse">
    <h4>Tasks in flight</h4>
    <div class="hero-val">${counters.tasksInFlight.total}</div>
    <div class="hero-sub">${counters.tasksInFlight.pipelinesRunning} pipelines · ${counters.tasksInFlight.autobrowserRunning} browsing · ${counters.tasksInFlight.autobrowserQueued} queued · ${counters.tasksInFlight.selfDevDraftWaiting} self-dev drafts</div>
  </div>
  <div class="hero-card rev">
    <h4>Revenue today</h4>
    <div class="hero-val">${fmtUsd(counters.revenue.today)}</div>
    <div class="hero-sub">since UTC midnight</div>
  </div>
  <div class="hero-card rev">
    <h4>Revenue MTD</h4>
    <div class="hero-val">${fmtUsd(counters.revenue.mtd)}</div>
    <div class="hero-sub">${utcMonthStr()} earnings_month</div>
  </div>
  <div class="hero-card rev">
    <h4>Revenue YTD / Lifetime</h4>
    <div class="hero-val">${fmtUsd(counters.revenue.ytd)}</div>
    <div class="hero-sub">lifetime ${fmtUsd(counters.revenue.lifetime)}</div>
  </div>
</div>

<div class="card" style="margin-bottom:18px">
  <h2>Network — 5 layers · weights = log(1 + 24h call count)</h2>
  <div class="layers">${layerColumns}</div>
</div>

<div class="grid">
  <div class="card">
    <h2>Activations · last 60 min</h2>
    ${activations.length === 0 ? '<div class="empty">No events in the last hour.</div>' : activationBars}
  </div>
  <div>
    <div class="card" style="margin-bottom:14px">
      <h2>Revenue by source · 24h</h2>
      <table><thead><tr><th>Source</th><th>Net</th><th>Sales</th></tr></thead><tbody>${revRows}</tbody></table>
    </div>
    <div class="card">
      <h2>Throughput</h2>
      <div class="throughput">
        <div>Events · 60m <b>${counters.throughput.eventsLast60m}</b></div>
        <div>Ops · 60m <b>${counters.throughput.opsLast60m}</b></div>
        <div>Pipelines · 24h <b>${counters.throughput.pipelinesLast24h}</b></div>
        <div>Autobrowser · 24h <b>${counters.throughput.autobrowserLast24h}</b></div>
      </div>
    </div>
  </div>
</div>
</body></html>`
}
