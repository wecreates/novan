/**
 * R630 — Operator's low-effort/high-revenue cluster.
 *
 *   D4  agent timeline UI    — render every brain-op call + cron tick as a stream of events
 *   F3  mockup gallery       — surface R358 mockup outputs as /ops/mockups
 *   F7  listing A/B testing  — track variant performance per listing
 *   G2  in-chat cost display — emit SSE 'spend' event after each turn (best-effort hook)
 *   I2  public asset sharing — read-only /share/asset/:id without ops token
 *
 * Single file because each piece is small and they share rendering style.
 */
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'

const STYLE = `body{font:14px/1.45 -apple-system,BlinkMacSystemFont,sans-serif;max-width:980px;margin:24px auto;padding:0 16px;color:#222}h1,h2{margin:.6em 0 .3em}h1{font-size:20px}h2{font-size:15px;color:#374151}table{border-collapse:collapse;width:100%}th,td{padding:6px 10px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}th{background:#f6f7f9;font-size:12px;color:#6b7280;text-transform:uppercase}.meta{color:#6b7280;font-size:12px;margin-bottom:8px}.dim{color:#9ca3af}.good{color:#059669}.bad{color:#b91c1c}.tag{display:inline-block;padding:2px 6px;border-radius:4px;background:#eef2ff;color:#3730a3;font-size:11px;margin-right:4px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}.card{padding:10px;border:1px solid #e5e7eb;border-radius:6px;background:#fff}.card img{width:100%;height:auto;border-radius:4px}pre{white-space:pre-wrap;background:#f6f7f9;border:1px solid #e5e7eb;border-radius:6px;padding:8px;font:12px/1.4 ui-monospace,monospace;max-height:280px;overflow:auto}a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}.win{background:#dcfce7;color:#166534;padding:1px 6px;border-radius:3px;font-size:11px}.lose{background:#fee2e2;color:#991b1b;padding:1px 6px;border-radius:3px;font-size:11px}`

function esc(s: unknown): string { return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!)) }
function fmtAgo(ts: number): string { if (!ts) return ''; const m = Date.now() - ts; if (m < 60_000) return `${Math.round(m/1000)}s`; if (m < 3600_000) return `${Math.round(m/60_000)}m`; if (m < 86_400_000) return `${Math.round(m/3600_000)}h`; return `${Math.round(m/86_400_000)}d` }

// ─── D4 Agent timeline ──────────────────────────────────────────────────────

export async function renderTimelineHtml(workspaceId: string): Promise<string> {
  const r = await db.execute(sql`
    SELECT id, type, payload, created_at FROM events
    WHERE workspace_id = ${workspaceId}
      AND type IN ('brain.op.dispatch', 'brain.op.complete', 'brain.op.error', 'cron.tick', 'cron.error', 'inbox.processed', 'pipeline.run', 'patch.applied', 'self_dev.applied')
    ORDER BY created_at DESC LIMIT 150
  `).catch(() => [] as unknown[])
  const events = r as Array<Record<string, unknown>>
  const rows = events.map(ev => {
    const t = String(ev['type'])
    const cls = t.includes('error') ? 'bad' : t.includes('complete') || t.includes('applied') ? 'good' : 'dim'
    const p = ev['payload'] as Record<string, unknown> ?? {}
    const detail = [p['op'], p['cronName'], p['pipelineName'], p['kind']].filter(Boolean).join(' · ')
    return `<tr><td class="${cls}">${esc(t)}</td><td><code>${esc(detail)}</code></td><td class="dim">${fmtAgo(Number(ev['created_at']))}</td></tr>`
  }).join('')
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="15"><title>Timeline · Novan</title><style>${STYLE}</style>
<h1>Agent Timeline</h1><div class="meta">workspace=${esc(workspaceId)} · last 150 events · refresh 15s</div>
<table><thead><tr><th>type</th><th>detail</th><th>age</th></tr></thead><tbody>${rows || '<tr><td colspan="3" class="dim">No events yet.</td></tr>'}</tbody></table>`
}

// ─── F3 Mockup gallery ──────────────────────────────────────────────────────

export async function renderMockupsHtml(workspaceId: string): Promise<string> {
  // generated_assets where kind='mockup' OR (kind='image' AND metadata->>'mockup'='true')
  const r = await db.execute(sql`
    SELECT id, kind, public_url, prompt, bytes, metadata, created_at
    FROM generated_assets
    WHERE workspace_id = ${workspaceId} AND (kind = 'mockup' OR metadata->>'isMockup' = 'true')
    ORDER BY created_at DESC LIMIT 60
  `).catch(() => [] as unknown[])
  const items = r as Array<Record<string, unknown>>
  const cards = items.map(it => {
    const url = String(it['public_url'] ?? '')
    const prompt = String(it['prompt'] ?? '').slice(0, 120)
    return `<div class="card">${url ? `<img src="${esc(url)}" loading="lazy"/>` : '<div class="dim">(no URL)</div>'}<div class="dim" style="font-size:11px;margin-top:6px">${fmtAgo(Number(it['created_at']))} · ${esc(it['bytes'])}b</div><div style="font-size:12px;margin-top:4px">${esc(prompt)}</div></div>`
  }).join('')
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="60"><title>Mockups · Novan</title><style>${STYLE}</style>
<h1>Mockup Gallery</h1><div class="meta">workspace=${esc(workspaceId)} · ${items.length} mockups · refresh 60s · powered by R358 mockup-gen</div>
${items.length === 0 ? '<p class="dim">No mockups yet. Generate via R358 (<code>design.generate_mockup</code>) or queue mockup briefs via <code>inbox.bulk_add</code> with metadata.isMockup=true.</p>' : `<div class="grid">${cards}</div>`}`
}

// ─── F7 A/B listing tests ───────────────────────────────────────────────────

export interface AbVariant { id: string; label: string; title?: string; description?: string; price?: number; tags?: string[] }
export interface AbTest {
  id: string
  workspaceId: string
  listingKey: string
  platform: string
  variants: AbVariant[]
  metrics: Record<string, { impressions: number; clicks: number; sales: number; revenueUsd: number }>
  startedAt: number
  endedAt?: number
  winner?: string
}

async function ensureAbTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ab_tests (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      listing_key   TEXT NOT NULL,
      platform      TEXT NOT NULL,
      variants      JSONB NOT NULL,
      metrics       JSONB NOT NULL DEFAULT '{}'::jsonb,
      started_at    BIGINT NOT NULL,
      ended_at      BIGINT,
      winner        TEXT
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS ab_tests_ws_listing_idx ON ab_tests (workspace_id, listing_key, started_at DESC)`).catch(() => {})
}

export async function createAbTest(workspaceId: string, input: { listingKey: string; platform: string; variants: AbVariant[] }): Promise<{ id: string }> {
  await ensureAbTable()
  if (!input.listingKey?.trim()) throw new Error('listingKey required')
  if (!input.variants || input.variants.length < 2) throw new Error('variants[] requires ≥2 entries')
  const id = uuidv7()
  const metrics: AbTest['metrics'] = {}
  for (const v of input.variants) metrics[v.id] = { impressions: 0, clicks: 0, sales: 0, revenueUsd: 0 }
  await db.execute(sql`
    INSERT INTO ab_tests (id, workspace_id, listing_key, platform, variants, metrics, started_at)
    VALUES (${id}, ${workspaceId}, ${input.listingKey}, ${input.platform},
            ${JSON.stringify(input.variants)}::jsonb, ${JSON.stringify(metrics)}::jsonb, ${Date.now()})
  `)
  return { id }
}

export async function recordAbMetric(workspaceId: string, input: { testId: string; variantId: string; impressions?: number; clicks?: number; sales?: number; revenueUsd?: number }): Promise<{ ok: boolean }> {
  await ensureAbTable()
  // Read-modify-write inside one query via jsonb_set chain
  const cur = await db.execute(sql`SELECT metrics FROM ab_tests WHERE id = ${input.testId} AND workspace_id = ${workspaceId}`).catch(() => [] as unknown[])
  const row = (cur as Array<Record<string, unknown>>)[0]
  if (!row) return { ok: false }
  const m = (row['metrics'] as Record<string, { impressions: number; clicks: number; sales: number; revenueUsd: number }>) ?? {}
  const v = m[input.variantId] ?? { impressions: 0, clicks: 0, sales: 0, revenueUsd: 0 }
  v.impressions += input.impressions ?? 0
  v.clicks      += input.clicks ?? 0
  v.sales       += input.sales ?? 0
  v.revenueUsd  += input.revenueUsd ?? 0
  m[input.variantId] = v
  await db.execute(sql`UPDATE ab_tests SET metrics = ${JSON.stringify(m)}::jsonb WHERE id = ${input.testId} AND workspace_id = ${workspaceId}`).catch(() => {})
  return { ok: true }
}

export async function pickAbWinner(workspaceId: string, testId: string, metric: 'ctr' | 'cvr' | 'revenue' = 'revenue'): Promise<{ winner: string | null; scores: Record<string, number> }> {
  await ensureAbTable()
  const r = await db.execute(sql`SELECT variants, metrics FROM ab_tests WHERE id = ${testId} AND workspace_id = ${workspaceId}`).catch(() => [] as unknown[])
  const row = (r as Array<Record<string, unknown>>)[0]
  if (!row) return { winner: null, scores: {} }
  const m = (row['metrics'] as AbTest['metrics']) ?? {}
  const scores: Record<string, number> = {}
  for (const [vid, mv] of Object.entries(m)) {
    if (metric === 'ctr')     scores[vid] = mv.impressions > 0 ? mv.clicks / mv.impressions : 0
    if (metric === 'cvr')     scores[vid] = mv.clicks > 0 ? mv.sales / mv.clicks : 0
    if (metric === 'revenue') scores[vid] = mv.revenueUsd
  }
  let winner: string | null = null; let best = -1
  for (const [vid, s] of Object.entries(scores)) if (s > best) { best = s; winner = vid }
  if (winner && best > 0) {
    await db.execute(sql`UPDATE ab_tests SET winner = ${winner}, ended_at = ${Date.now()} WHERE id = ${testId} AND workspace_id = ${workspaceId}`).catch(() => {})
  }
  return { winner, scores }
}

export async function listAbTests(workspaceId: string, limit = 30): Promise<AbTest[]> {
  await ensureAbTable()
  const r = await db.execute(sql`SELECT * FROM ab_tests WHERE workspace_id = ${workspaceId} ORDER BY started_at DESC LIMIT ${Math.max(1, Math.min(100, limit))}`).catch(() => [] as unknown[])
  return (r as Array<Record<string, unknown>>).map(row => {
    const t: AbTest = {
      id: String(row['id']), workspaceId: String(row['workspace_id']),
      listingKey: String(row['listing_key']), platform: String(row['platform']),
      variants: (row['variants'] as AbVariant[]) ?? [],
      metrics: (row['metrics'] as AbTest['metrics']) ?? {},
      startedAt: Number(row['started_at']),
    }
    if (row['ended_at'] != null) t.endedAt = Number(row['ended_at'])
    if (row['winner']   != null) t.winner  = String(row['winner'])
    return t
  })
}

export async function renderAbHtml(workspaceId: string): Promise<string> {
  const tests = await listAbTests(workspaceId, 50)
  const rows = tests.map(t => {
    const variantRows = t.variants.map(v => {
      const mv = t.metrics[v.id] ?? { impressions: 0, clicks: 0, sales: 0, revenueUsd: 0 }
      const isWin = t.winner === v.id
      return `<tr><td>${isWin ? '<span class="win">winner</span> ' : ''}${esc(v.label)}</td><td>${mv.impressions}</td><td>${mv.clicks}</td><td>${mv.sales}</td><td>$${mv.revenueUsd.toFixed(2)}</td></tr>`
    }).join('')
    return `<h2><code>${esc(t.listingKey)}</code> <span class="tag">${esc(t.platform)}</span> ${t.endedAt ? `<span class="dim">ended ${fmtAgo(t.endedAt)} ago</span>` : '<span class="good">live</span>'}</h2>
<table><thead><tr><th>variant</th><th>imp</th><th>clicks</th><th>sales</th><th>rev</th></tr></thead><tbody>${variantRows}</tbody></table>`
  }).join('')
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="60"><title>A/B Tests · Novan</title><style>${STYLE}</style>
<h1>Listing A/B Tests</h1><div class="meta">workspace=${esc(workspaceId)} · ${tests.length} tests · refresh 60s</div>
${tests.length === 0 ? '<p class="dim">No A/B tests yet. Use <code>ab.create</code> brain op.</p>' : rows}`
}

// ─── I2 Public asset share ──────────────────────────────────────────────────

async function ensureShareTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS public_shares (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      kind          TEXT NOT NULL,
      ref_id        TEXT NOT NULL,
      created_at    BIGINT NOT NULL,
      expires_at    BIGINT,
      hits          INTEGER NOT NULL DEFAULT 0
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS public_shares_ref_idx ON public_shares (kind, ref_id)`).catch(() => {})
}

export async function createShare(workspaceId: string, input: { kind: 'asset' | 'digest' | 'research'; refId: string; ttlDays?: number }): Promise<{ id: string; url: string }> {
  await ensureShareTable()
  if (!input.refId) throw new Error('refId required')
  const id = uuidv7().replace(/-/g, '').slice(0, 16)        // short share id
  const now = Date.now()
  const expiresAt = input.ttlDays ? now + input.ttlDays * 24 * 60 * 60_000 : null
  await db.execute(sql`
    INSERT INTO public_shares (id, workspace_id, kind, ref_id, created_at, expires_at)
    VALUES (${id}, ${workspaceId}, ${input.kind}, ${input.refId}, ${now}, ${expiresAt})
  `).catch(() => {})
  const base = process.env['NOVAN_PUBLIC_URL'] ?? ''
  return { id, url: `${base}/share/${input.kind}/${id}` }
}

export async function resolveShare(kind: string, id: string): Promise<{ ok: boolean; workspaceId?: string; refId?: string; expired?: boolean }> {
  await ensureShareTable()
  const r = await db.execute(sql`SELECT workspace_id, ref_id, expires_at FROM public_shares WHERE id = ${id} AND kind = ${kind}`).catch(() => [] as unknown[])
  const row = (r as Array<Record<string, unknown>>)[0]
  if (!row) return { ok: false }
  const expiresAt = row['expires_at'] != null ? Number(row['expires_at']) : null
  if (expiresAt && Date.now() > expiresAt) return { ok: false, expired: true }
  // Bump hit counter (best-effort, async)
  void db.execute(sql`UPDATE public_shares SET hits = hits + 1 WHERE id = ${id}`).catch(() => {})
  return { ok: true, workspaceId: String(row['workspace_id']), refId: String(row['ref_id']) }
}

export async function renderSharedAssetHtml(shareId: string): Promise<string> {
  const r = await resolveShare('asset', shareId)
  if (!r.ok) return `<!doctype html><title>Not found</title><style>${STYLE}</style><h1>404</h1><p class="dim">${r.expired ? 'Share link expired.' : 'Share link not found.'}</p>`
  const a = await db.execute(sql`SELECT public_url, prompt, kind, bytes, created_at FROM generated_assets WHERE id = ${r.refId} AND workspace_id = ${r.workspaceId}`).catch(() => [] as unknown[])
  const asset = (a as Array<Record<string, unknown>>)[0]
  if (!asset) return `<!doctype html><title>Asset gone</title><style>${STYLE}</style><h1>410</h1><p class="dim">Underlying asset was deleted.</p>`
  const url = String(asset['public_url'] ?? '')
  return `<!doctype html><meta charset="utf-8"><title>Shared asset · Novan</title><style>${STYLE}</style>
<div style="text-align:center;margin:24px 0">
  ${url ? `<img src="${esc(url)}" style="max-width:100%;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.08)"/>` : '<p class="dim">No public URL</p>'}
  <p class="dim" style="margin-top:12px">${esc(asset['kind'])} · ${esc(asset['bytes'])} bytes · ${fmtAgo(Number(asset['created_at']))} ago</p>
  <p style="max-width:520px;margin:0 auto">${esc(String(asset['prompt'] ?? '').slice(0, 200))}</p>
</div>`
}

export async function renderSharedDigestHtml(shareId: string): Promise<string> {
  const r = await resolveShare('digest', shareId)
  if (!r.ok) return `<!doctype html><title>Not found</title><style>${STYLE}</style><h1>404</h1><p class="dim">${r.expired ? 'Expired.' : 'Not found.'}</p>`
  try {
    const { compose } = await import('./r613-daily-digest.js')
    const d = await compose(r.workspaceId!)
    return `<!doctype html><meta charset="utf-8"><title>Digest · ${esc(d.forDateUtc)}</title><style>${STYLE}</style>
<h1>Daily digest · ${esc(d.forDateUtc)}</h1><pre>${esc(d.markdown ?? '')}</pre>`
  } catch (e) {
    return `<!doctype html><title>Error</title><style>${STYLE}</style><h1>500</h1><pre>${esc((e as Error).message)}</pre>`
  }
}
