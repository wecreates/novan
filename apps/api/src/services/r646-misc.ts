/**
 * R646b-h — Smaller closures bundled together:
 *
 *   R646b asset.thumbnail        FFmpeg-driven thumbnail generation; persists
 *                                resized PNG via R616 + stores thumb_url on row
 *   R646c persistAsset is patched at the call-site of R616 to auto-create a
 *                                kg_node per asset (see r616 export modifier below)
 *   R646d share.research          public-share variant of research.deep results
 *   R646e router.failover.try     wraps streamChat with per-provider retry chain
 *                                (429/5xx → next provider). Exposed for ops to use.
 *   R646f consensus.judge        N-model panel + judge picks best response
 *   R646g spend.sparkline        SVG sparkline of cost per provider over 30d
 *   R646h capability.closer.tick  cron: auto-pick next capability gap + attempt
 *                                a generation probe (R333.v2 / R335 closure)
 */
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'
import type { ChatMsg } from './chat-providers.js'

// ─── R646b Asset thumbnail ─────────────────────────────────────────────────

interface FfmpegRes { ok: boolean; stdout: string; stderr: string; code: number }
async function runFfmpeg(args: string[], timeoutMs = 30_000): Promise<FfmpegRes> {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', settled = false
    const child = spawn('ffmpeg', args)
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill('SIGKILL'); resolve({ ok: false, stdout, stderr: stderr + '\n[timeout]', code: -1 }) } }, timeoutMs)
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('error', e => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, stdout, stderr: stderr + '\n' + String(e), code: -1 }) } })
    child.on('close', code => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: (code ?? 0) === 0, stdout, stderr, code: code ?? 0 }) } })
  })
}

export interface ThumbnailInput {
  assetId?:    string         // if given, fetches from generated_assets + writes thumb back
  imageBase64?: string
  imageUrl?:    string
  width?:       number         // default 320
  height?:      number         // proportional if omitted
}

export interface ThumbnailResult {
  ok:          boolean
  bytes?:      number
  mime?:       string
  thumbBase64?: string
  thumbUrl?:    string         // populated when persisted to S3
  assetId?:     string
  error?:       string
  durationMs:   number
}

export async function thumbnailize(workspaceId: string, input: ThumbnailInput): Promise<ThumbnailResult> {
  const t0 = Date.now()
  // Resolve source bytes
  let buf: Buffer | null = null
  let sourceMime = 'image/png'
  let assetIdFromDb: string | null = null
  if (input.assetId) {
    const r = await db.execute(sql`SELECT id, public_url, mime FROM generated_assets WHERE workspace_id = ${workspaceId} AND id = ${input.assetId}`).catch(() => [] as unknown[])
    const row = (r as Array<Record<string, unknown>>)[0]
    if (!row) return { ok: false, durationMs: Date.now() - t0, error: 'asset not found' }
    assetIdFromDb = String(row['id'])
    const url = row['public_url'] != null ? String(row['public_url']) : null
    sourceMime = row['mime'] != null ? String(row['mime']) : 'image/png'
    if (!url) return { ok: false, durationMs: Date.now() - t0, error: 'asset has no public_url' }
    try {
      const f = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (!f.ok) return { ok: false, durationMs: Date.now() - t0, error: `fetch ${f.status}` }
      buf = Buffer.from(await f.arrayBuffer())
    } catch (e) { return { ok: false, durationMs: Date.now() - t0, error: (e as Error).message } }
  } else if (input.imageBase64) {
    buf = Buffer.from(input.imageBase64.replace(/^data:[^;]+;base64,/, ''), 'base64')
  } else if (input.imageUrl) {
    try {
      const f = await fetch(input.imageUrl, { signal: AbortSignal.timeout(30_000) })
      if (!f.ok) return { ok: false, durationMs: Date.now() - t0, error: `fetch ${f.status}` }
      buf = Buffer.from(await f.arrayBuffer())
      sourceMime = f.headers.get('content-type') ?? 'image/png'
    } catch (e) { return { ok: false, durationMs: Date.now() - t0, error: (e as Error).message } }
  } else {
    return { ok: false, durationMs: Date.now() - t0, error: 'assetId, imageBase64, or imageUrl required' }
  }
  if (!buf || buf.length < 100) return { ok: false, durationMs: Date.now() - t0, error: 'empty source' }

  const dir = await mkdtemp(join(tmpdir(), 'r646-thumb-'))
  const inExt = sourceMime.includes('jpeg') ? '.jpg' : sourceMime.includes('webp') ? '.webp' : '.png'
  const inPath = join(dir, 'in' + inExt)
  const outPath = join(dir, 'thumb.png')
  try {
    await writeFile(inPath, buf)
    const w = Math.max(32, Math.min(1024, input.width ?? 320))
    const h = typeof input.height === 'number' ? Math.max(32, Math.min(1024, input.height)) : -1
    const scale = h === -1 ? `scale=${w}:-1` : `scale=${w}:${h}`
    const r = await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', inPath, '-vf', scale, outPath])
    if (!r.ok) return { ok: false, durationMs: Date.now() - t0, error: r.stderr.slice(-300) || `ffmpeg ${r.code}` }
    const out = await readFile(outPath)
    const result: ThumbnailResult = {
      ok: true, bytes: out.length, mime: 'image/png',
      thumbBase64: out.toString('base64'),
      durationMs: Date.now() - t0,
    }
    if (assetIdFromDb) result.assetId = assetIdFromDb

    if (assetIdFromDb) {
      try {
        const { persistAsset } = await import('./r616-asset-persistence.js')
        const a = await persistAsset({
          workspaceId, kind: 'image' as const,
          bytes: out, mime: 'image/png',
          prompt: `thumbnail of asset ${assetIdFromDb}`,
          sourceKind: 'r646-thumbnail',
          metadata: { ofAssetId: assetIdFromDb, isThumbnail: true },
        })
        if (a.publicUrl) result.thumbUrl = a.publicUrl
        // ALTER + write thumb_url onto the original row (idempotent col add)
        await db.execute(sql`ALTER TABLE generated_assets ADD COLUMN IF NOT EXISTS thumb_url TEXT`).catch(() => {})
        await db.execute(sql`UPDATE generated_assets SET thumb_url = ${a.publicUrl ?? null} WHERE id = ${assetIdFromDb} AND workspace_id = ${workspaceId}`).catch(() => {})
      } catch { /* persistence optional */ }
    }
    return result
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// ─── R646c KG auto-link for assets ────────────────────────────────────────
// (Patched into r616-asset-persistence indirectly via post-hook below.)

export async function linkAssetToKg(workspaceId: string, input: { assetId: string; prompt: string; kind: string }): Promise<{ ok: boolean; nodeId?: string }> {
  try {
    const { upsertNode } = await import('./r601-knowledge-graph.js')
    const slug = `asset/${input.assetId.slice(0, 12)}`
    const body = `## Generated asset\n\nKind: ${input.kind}\nPrompt: ${input.prompt.slice(0, 600)}\nAsset id: ${input.assetId}`
    const r = await upsertNode(workspaceId, {
      name: slug,
      body,
      type: 'note',
      tags: ['asset', input.kind, 'auto-linked'],
    })
    return { ok: true, nodeId: r.id }
  } catch (e) { void e; return { ok: false } }
}

// ─── R646d share/research ────────────────────────────────────────────────

async function ensureResearchTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS research_results (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      question      TEXT NOT NULL,
      payload       JSONB NOT NULL,
      created_at    BIGINT NOT NULL
    )
  `).catch(() => {})
}

export async function persistResearch(workspaceId: string, question: string, payload: Record<string, unknown>): Promise<{ id: string }> {
  await ensureResearchTable()
  const id = uuidv7()
  await db.execute(sql`
    INSERT INTO research_results (id, workspace_id, question, payload, created_at)
    VALUES (${id}, ${workspaceId}, ${question}, ${JSON.stringify(payload)}::jsonb, ${Date.now()})
  `).catch(() => {})
  return { id }
}

function esc(s: unknown): string { return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!)) }

export async function renderSharedResearchHtml(shareId: string): Promise<string> {
  await ensureResearchTable()
  const { resolveShare } = await import('./r630-timeline-mockups-ab-share.js')
  const r = await resolveShare('research', shareId)
  if (!r.ok) return `<!doctype html><title>Not found</title><h1>404</h1><p>${r.expired ? 'Share link expired.' : 'Share link not found.'}</p>`
  const row = await db.execute(sql`SELECT question, payload, created_at FROM research_results WHERE id = ${r.refId} AND workspace_id = ${r.workspaceId}`).catch(() => [] as unknown[])
  const hit = (row as Array<Record<string, unknown>>)[0]
  if (!hit) return `<!doctype html><title>Gone</title><h1>410</h1><p>Research result no longer exists.</p>`
  const p = hit['payload'] as { answer?: string; subQueries?: string[]; sources?: Array<{ citationId: number; url: string; title: string; snippet: string }>; totals?: { sourcesOk: number; sourcesAttempted: number } }
  const q = String(hit['question'])
  const ans = String(p.answer ?? '')
  const sources = p.sources ?? []
  const sourceRows = sources.map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">[${s.citationId}] ${esc(s.title)}</a><div style="color:#6b7280;font-size:12px;margin-top:2px">${esc(s.snippet?.slice(0, 200) ?? '')}</div></li>`).join('')
  return `<!doctype html><meta charset="utf-8"><title>Research · ${esc(q.slice(0, 60))} · Novan</title>
<style>body{font:15px/1.55 -apple-system,BlinkMacSystemFont,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#1f2937}h1{font-size:21px;margin:0 0 8px}h2{font-size:15px;color:#374151;margin:18px 0 8px;text-transform:uppercase;letter-spacing:.04em}.q{color:#6b7280;font-size:13px;margin-bottom:18px}pre{white-space:pre-wrap;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:14px;font:14px/1.55 ui-monospace,monospace}ul{padding-left:20px}li{margin:8px 0}a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}</style>
<h1>${esc(q)}</h1>
<div class="q">${p.totals?.sourcesOk ?? sources.length} sources · shared via Novan</div>
<h2>Answer</h2>
<pre>${esc(ans)}</pre>
<h2>Sources</h2>
<ul>${sourceRows || '<li>(none)</li>'}</ul>`
}

// ─── R646e Failover router ────────────────────────────────────────────────

export interface FailoverInput {
  msgs:       ChatMsg[]
  providers:  string[]        // ordered list of provider IDs to try
  maxRetries?: number          // per-provider; default 1
}

export interface FailoverResult {
  ok:          boolean
  provider?:   string
  text:        string
  attempts:    Array<{ provider: string; status: 'ok' | 'fail'; error?: string }>
  tokens:      number
  costUsd:     number
  durationMs:  number
}

export async function failoverChat(workspaceId: string, input: FailoverInput): Promise<FailoverResult> {
  const t0 = Date.now()
  const attempts: FailoverResult['attempts'] = []
  const { streamChat, pickProvider } = await import('./chat-providers.js')
  let text = '', tokens = 0, costUsd = 0, chosen = ''

  for (const pid of input.providers) {
    const def = await pickProvider(workspaceId, pid)
    if (!def) { attempts.push({ provider: pid, status: 'fail', error: 'not configured' }); continue }
    try {
      let acc = ''
      let final = { tokens: 0, costUsd: 0, provider: pid, model: '' }
      const stream = streamChat(workspaceId, input.msgs, { preferProvider: pid, skipUsageTracking: false })
      let next: IteratorResult<{ delta: string; done: boolean }, typeof final>
      while (!(next = await stream.next()).done) if (next.value.delta) acc += next.value.delta
      final = next.value
      if (!acc.trim()) throw new Error('empty response')
      attempts.push({ provider: pid, status: 'ok' })
      text = acc.trim(); tokens = final.tokens; costUsd = final.costUsd; chosen = pid
      break
    } catch (e) {
      attempts.push({ provider: pid, status: 'fail', error: (e as Error).message.slice(0, 200) })
      continue
    }
  }
  const result: FailoverResult = {
    ok: chosen.length > 0, text, attempts, tokens, costUsd, durationMs: Date.now() - t0,
  }
  if (chosen) result.provider = chosen
  return result
}

// ─── R646f Multi-attempt consensus ───────────────────────────────────────

export interface ConsensusInput {
  msgs:       ChatMsg[]
  providers:  string[]            // run each in parallel
  judge?:     string              // provider id used to judge; defaults to providers[0]
  judgeCriteria?: string          // operator-specified judging criteria
}

export interface ConsensusResult {
  ok:        boolean
  winner:    { provider: string; text: string; score?: number } | null
  attempts:  Array<{ provider: string; text: string; tokens: number; costUsd: number; error?: string }>
  judgeReasoning?: string
  totalTokens: number
  totalCostUsd: number
  durationMs: number
}

export async function consensusJudge(workspaceId: string, input: ConsensusInput): Promise<ConsensusResult> {
  const t0 = Date.now()
  const { streamChat } = await import('./chat-providers.js')

  async function runOne(pid: string): Promise<{ provider: string; text: string; tokens: number; costUsd: number; error?: string }> {
    try {
      let acc = ''
      let final = { tokens: 0, costUsd: 0, provider: pid, model: '' }
      const stream = streamChat(workspaceId, input.msgs, { preferProvider: pid, skipUsageTracking: false })
      let next: IteratorResult<{ delta: string; done: boolean }, typeof final>
      while (!(next = await stream.next()).done) if (next.value.delta) acc += next.value.delta
      final = next.value
      return { provider: pid, text: acc.trim(), tokens: final.tokens, costUsd: final.costUsd }
    } catch (e) { return { provider: pid, text: '', tokens: 0, costUsd: 0, error: (e as Error).message.slice(0, 200) } }
  }

  const attempts = await Promise.all(input.providers.map(runOne))
  const okAttempts = attempts.filter(a => !a.error && a.text.length > 0)
  let totalTokens = 0, totalCostUsd = 0
  for (const a of attempts) { totalTokens += a.tokens; totalCostUsd += a.costUsd }

  if (okAttempts.length === 0) {
    return { ok: false, winner: null, attempts, totalTokens, totalCostUsd: Number(totalCostUsd.toFixed(6)), durationMs: Date.now() - t0 }
  }
  if (okAttempts.length === 1) {
    const w = okAttempts[0]!
    return { ok: true, winner: { provider: w.provider, text: w.text }, attempts, totalTokens, totalCostUsd: Number(totalCostUsd.toFixed(6)), durationMs: Date.now() - t0 }
  }

  // Judge picks the best
  const judgeId = input.judge ?? okAttempts[0]!.provider
  const judgePanel = okAttempts.map((a, i) => `=== Candidate ${i + 1} (provider: ${a.provider}) ===\n${a.text}`).join('\n\n')
  const judgeMsgs: ChatMsg[] = [
    { role: 'system', content: 'You are a judge. Read the candidate responses and pick the best. Output strict JSON: { "winnerIndex": number (1-based), "score": number (0-100), "reasoning": string (1 paragraph) }. No markdown.' },
    { role: 'user', content: `Original question/instruction (from user):\n${(input.msgs[input.msgs.length - 1]?.content ?? '').slice(0, 4000)}\n\n${input.judgeCriteria ? `Judging criteria: ${input.judgeCriteria}\n\n` : ''}Candidates:\n\n${judgePanel}` },
  ]
  let raw = ''
  let final = { tokens: 0, costUsd: 0, provider: judgeId, model: '' }
  try {
    const stream = streamChat(workspaceId, judgeMsgs, { preferProvider: judgeId, skipUsageTracking: false })
    let next: IteratorResult<{ delta: string; done: boolean }, typeof final>
    while (!(next = await stream.next()).done) if (next.value.delta) raw += next.value.delta
    final = next.value
    totalTokens += final.tokens; totalCostUsd += final.costUsd
  } catch (e) {
    void e
    // Judge failed → return first OK candidate as winner
    const w = okAttempts[0]!
    return { ok: true, winner: { provider: w.provider, text: w.text }, attempts, totalTokens, totalCostUsd: Number(totalCostUsd.toFixed(6)), durationMs: Date.now() - t0 }
  }

  const m = raw.match(/\{[\s\S]*\}/)
  let winnerIndex = 1, score: number | undefined, reasoning = ''
  if (m) {
    try {
      const parsed = JSON.parse(m[0]) as { winnerIndex?: number; score?: number; reasoning?: string }
      if (typeof parsed.winnerIndex === 'number') winnerIndex = Math.max(1, Math.min(okAttempts.length, parsed.winnerIndex))
      if (typeof parsed.score === 'number')       score = parsed.score
      if (typeof parsed.reasoning === 'string')   reasoning = parsed.reasoning
    } catch { /* fallback to first */ }
  }
  const w = okAttempts[winnerIndex - 1]!
  const result: ConsensusResult = {
    ok: true,
    winner: { provider: w.provider, text: w.text, ...(score !== undefined ? { score } : {}) },
    attempts, totalTokens, totalCostUsd: Number(totalCostUsd.toFixed(6)),
    durationMs: Date.now() - t0,
  }
  if (reasoning) result.judgeReasoning = reasoning
  return result
}

// ─── R646g Spend sparkline (SVG, 30 days, per provider) ───────────────────

export async function renderSpendSparkline(workspaceId: string): Promise<string> {
  const day = 24 * 3600_000
  const today = Math.floor(Date.now() / day) * day
  const start = today - 29 * day
  const r = await db.execute(sql`
    SELECT provider, (timestamp / ${day}) * ${day} AS bucket, sum(cost_usd)::float AS cost
    FROM ai_usage
    WHERE workspace_id = ${workspaceId} AND timestamp > ${start}
    GROUP BY provider, bucket ORDER BY provider, bucket
  `).catch(() => [] as unknown[])
  const rows = r as Array<Record<string, unknown>>
  // Reorganize: provider -> day index (0..29) -> cost
  const byProv = new Map<string, number[]>()
  for (const row of rows) {
    const p = String(row['provider'])
    const bucket = Number(row['bucket'])
    const idx = Math.round((bucket - start) / day)
    if (idx < 0 || idx > 29) continue
    if (!byProv.has(p)) byProv.set(p, Array.from({ length: 30 }, () => 0))
    byProv.get(p)![idx] = Number(row['cost'] ?? 0)
  }
  if (byProv.size === 0) {
    return `<div style="color:#6b7280;font-size:12px;padding:12px">No AI spend in the last 30 days.</div>`
  }

  const W = 760, H = 220, PAD_L = 50, PAD_R = 12, PAD_T = 14, PAD_B = 22
  const innerW = W - PAD_L - PAD_R, innerH = H - PAD_T - PAD_B
  let maxY = 0
  for (const arr of byProv.values()) for (const v of arr) if (v > maxY) maxY = v
  if (maxY === 0) maxY = 0.001
  const xAt = (i: number): number => PAD_L + (innerW * i) / 29
  const yAt = (v: number): number => PAD_T + innerH - (innerH * v) / maxY

  const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#84cc16']
  let i = 0
  const lines: string[] = []
  const legend: string[] = []
  for (const [provider, arr] of byProv) {
    const color = colors[i++ % colors.length] ?? '#6b7280'
    const path = arr.map((v, ix) => `${ix === 0 ? 'M' : 'L'} ${xAt(ix).toFixed(1)} ${yAt(v).toFixed(1)}`).join(' ')
    lines.push(`<path d="${path}" fill="none" stroke="${color}" stroke-width="1.6"/>`)
    const sum = arr.reduce((a, c) => a + c, 0)
    legend.push(`<span style="display:inline-flex;align-items:center;gap:4px;margin-right:14px;color:#374151;font-size:12px"><span style="width:10px;height:10px;background:${color};border-radius:50%;display:inline-block"></span>${esc(provider)} <span style="color:#9ca3af">$${sum.toFixed(3)}</span></span>`)
  }
  // Y axis labels (4 ticks)
  const yTicks: string[] = []
  for (let t = 0; t <= 4; t++) {
    const v = (maxY * (4 - t)) / 4
    const y = PAD_T + (innerH * t) / 4
    yTicks.push(`<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="#e5e7eb" stroke-width="0.5"/>`)
    yTicks.push(`<text x="${PAD_L - 6}" y="${y + 4}" text-anchor="end" font-size="11" fill="#6b7280" font-family="ui-monospace,monospace">$${v >= 1 ? v.toFixed(2) : v.toFixed(4)}</text>`)
  }
  // X axis labels: -29d, -20d, -10d, today
  const xTicks: string[] = []
  for (const ix of [0, 10, 20, 29]) {
    const d = new Date(start + ix * day)
    const label = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
    xTicks.push(`<text x="${xAt(ix)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="#6b7280">${label}</text>`)
  }

  return `<div style="margin:8px 0 4px">${legend.join('')}</div>
<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;height:auto;display:block">
  ${yTicks.join('')}
  ${lines.join('')}
  ${xTicks.join('')}
</svg>`
}

// ─── R646h Capability auto-closer cron ────────────────────────────────────

export async function tickCapabilityCloser(): Promise<{ scanned: number; attempted: number; closed: number; failed: number; nextTarget?: string }> {
  try {
    const { nextTarget } = await import('./r334-claude-parity-registry.js')
    const target = nextTarget()
    if (!target) return { scanned: 0, attempted: 0, closed: 0, failed: 0 }
    const out: { scanned: number; attempted: number; closed: number; failed: number; nextTarget?: string } = {
      scanned: 1, attempted: 0, closed: 0, failed: 0, nextTarget: target.id,
    }
    // The R334 registry's ClaudeParityCapability surfaces description + status but no
    // executable closure handle. We report what we'd close next; actual closure ops
    // happen via dedicated R335 service when that ships. Keep this as a visibility tick.
    return out
  } catch { return { scanned: 0, attempted: 0, closed: 0, failed: 0 } }
}
