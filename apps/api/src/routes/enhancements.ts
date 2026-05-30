/**
 * enhancements.ts — Routes for items 25, 27, 28, 29, 30.
 *
 * Mounted at /api/v1/x/* (intentionally short prefix; these are utility
 * endpoints layered over existing services).
 */
import type { FastifyPluginAsync } from 'fastify'
import { db }                      from '../db/client.js'
import { events }                  from '../db/schema.js'
import { v7 as uuidv7 }            from 'uuid'
import { getPreferences, setPreferences, autoApplyConfidenceFloor, type Patch } from '../services/operator-preferences.js'
import { rewritePrompt }           from '../services/prompt-rewriter.js'
import { allDivisionsSnapshot }    from '../services/divisions.js'
import { generateDailyReview }     from '../services/daily-review.js'
import { weeklyOperationalReport } from '../services/executive-briefings.js'
import { computeHealth }           from '../services/operator-health.js'
import { workspaces }              from '../db/schema.js'
import { storeImage, s3Configured } from '../services/image-storage.js'

const enhancementRoutes: FastifyPluginAsync = async (fastify) => {

  // ── #25 Operator preferences ────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/preferences', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await getPreferences(ws) }
  })

  fastify.post<{
    Body: { workspace_id?: string } & Patch
  }>('/preferences', async (req, reply) => {
    const { workspace_id, ...patch } = req.body
    if (!workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await setPreferences(workspace_id, patch) }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/preferences/auto-apply-floor', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: { floor: await autoApplyConfidenceFloor(ws) } }
  })

  // ── #30 Recommendation lineage ──────────────────────────────────────────
  fastify.post<{
    Body: { workspace_id?: string; recommendation_id?: string; action?: string; outcome?: string; notes?: string }
  }>('/recommendations/:id/act-on', async (req, reply) => {
    const { workspace_id, action, outcome, notes } = req.body
    const recommendation_id = (req.params as { id: string }).id
    if (!workspace_id || !action) {
      return reply.code(400).send({ success: false, error: 'workspace_id, action required' })
    }
    const id = uuidv7()
    await db.insert(events).values({
      id, type: 'recommendation.acted_on', workspaceId: workspace_id,
      payload: { recommendationId: recommendation_id, action, outcome: outcome ?? null, notes: notes ?? null },
      traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
      source: 'operator', version: 1, createdAt: Date.now(),
    }).catch((e: Error) => { console.error('[enhancements]', e.message); return null })
    return { success: true, data: { eventId: id, recommendationId: recommendation_id } }
  })

  // ── #28 CSV exports ─────────────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/export/divisions.csv', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const snap = await allDivisionsSnapshot(ws)
    const lines: string[] = [
      'division,health,active_agents,active_missions,open_blockers,events_24h,missions_completed,missions_total',
    ]
    // R146.55 — defuse CSV formula injection in operator-controlled
    // string fields. `name` is the division key, set by the operator.
    // The numeric metrics flow from the system; coerced via String()
    // they can't start with =+-@, but defusing universally is cheap
    // insurance for future schema additions.
    const defuse = (raw: string): string => {
      const c = raw.charCodeAt(0)
      if (c === 0x3D || c === 0x2B || c === 0x2D || c === 0x40 || c === 0x09 || c === 0x0D) return `'${raw}`
      return raw
    }
    const cell = (v: unknown): string => {
      const s = defuse(String(v ?? ''))
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s
    }
    for (const [name, d] of Object.entries(snap)) {
      lines.push([
        cell(name), cell(d.health),
        cell(d.metrics.activeAgents), cell(d.metrics.activeMissions),
        cell(d.metrics.openBlockers), cell(d.metrics.eventsLast24h),
        cell(d.missions.completed), cell(d.missions.total),
      ].join(','))
    }
    reply.header('content-type', 'text/csv')
    reply.header('content-disposition', `attachment; filename="divisions-${Date.now()}.csv"`)
    return lines.join('\n')
  })

  // ── #19 Multi-workspace portfolio aggregator ───────────────────────────
  fastify.get('/portfolio', async () => {
    const ids = await db.select({ id: workspaces.id, name: workspaces.name, plan: workspaces.plan }).from(workspaces)
      .limit(50).catch(() => [] as Array<{ id: string; name: string; plan: string }>)
    const portfolio = await Promise.all(ids.map(async (w) => {
      const h = await computeHealth(w.id).catch((e: Error) => { console.error('[enhancements]', e.message); return null })
      return {
        workspaceId: w.id, name: w.name, plan: w.plan,
        health: h ? { score: h.score, band: h.band, recommendations: h.recommendations } : null,
        signals: h?.signals ?? null,
      }
    }))
    return { success: true, data: { workspaces: portfolio, count: portfolio.length } }
  })

  // ── #8 Storage status ───────────────────────────────────────────────────
  fastify.get('/storage/status', async () => {
    return { success: true, data: { s3Configured: s3Configured(), fallback: 'local_disk', dir: process.env['IMAGE_STORE_DIR'] ?? '/tmp/novan-images' } }
  })

  // ── Manual image-persist (operator-triggered) ───────────────────────────
  fastify.post<{ Body: { source_url?: string; image_id?: string; content_type?: string } }>('/storage/persist-image', async (req, reply) => {
    const { source_url, image_id, content_type } = req.body
    if (!source_url || !image_id) return reply.code(400).send({ success: false, error: 'source_url, image_id required' })
    try {
      const r = await storeImage({
        sourceUrl: source_url, imageId: image_id,
        ...(content_type !== undefined ? { contentType: content_type } : {}),
      })
      return { success: true, data: r }
    } catch (e) {
      return reply.code(502).send({ success: false, error: (e as Error).message })
    }
  })

  // ── #17 Print-optimized briefing (browser Save-as-PDF) ─────────────────
  fastify.get<{ Querystring: { workspace_id?: string; type?: 'daily' | 'weekly' } }>('/briefing.html', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const type = req.query.type ?? 'daily'
    const data = type === 'weekly' ? await weeklyOperationalReport(ws) : await generateDailyReview(ws)
    const title = type === 'weekly' ? 'Weekly Operational Report' : 'Daily Briefing'
    const html = renderBriefingHtml(title, ws, data as unknown as Record<string, unknown>)
    reply.header('content-type', 'text/html; charset=utf-8')
    return html
  })

  // ── #29 Prompt-improvement assistant ────────────────────────────────────
  fastify.post<{
    Body: { workspace_id?: string; prompt?: string; purpose?: 'image' | 'research' | 'general' }
  }>('/rewrite-prompt', async (req, reply) => {
    const { workspace_id, prompt, purpose } = req.body
    if (!workspace_id || !prompt) return reply.code(400).send({ success: false, error: 'workspace_id, prompt required' })
    const result = await rewritePrompt(workspace_id, prompt, purpose ?? 'general')
    if ('error' in result) return reply.code(502).send({ success: false, error: result.error })
    return { success: true, data: result }
  })
}

/** R146.51 — small HTML-attribute escape. Used on any string flowing
 *  into text-context or attribute-context positions in the template. */
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Render a printable HTML briefing. Operator's browser handles Save-as-PDF. */
function renderBriefingHtml(title: string, workspaceId: string, data: Record<string, unknown>): string {
  const safeJson = escHtml(JSON.stringify(data, null, 2))
  const generated = new Date().toISOString()
  // R146.51 — escape every dynamic value flowing into HTML text contexts.
  // Previously workspaceId was interpolated raw (XSS via the query
  // string), and the inline onclick handlers below were silently broken
  // by R146.43's CSP (script-src-attr 'none'). Removed the buttons —
  // Ctrl+P is universal, the Back button just shadowed the browser's
  // back action. The CSP stays tight; the only loss is two ornamental
  // buttons.
  const safeTitle = escHtml(title)
  const safeWs    = escHtml(workspaceId)
  const safeGen   = escHtml(generated)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Novan ${safeTitle}</title>
<style>
  @page { size: letter; margin: 0.5in; }
  body {
    font-family: 'Inter', -apple-system, system-ui, sans-serif;
    color: #111;
    line-height: 1.45;
    max-width: 7.5in;
    margin: 0 auto;
    padding: 0.4in 0.3in;
  }
  h1 { font-size: 22px; margin: 0 0 4px 0; }
  h2 { font-size: 14px; margin: 18px 0 6px 0; color: #444; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  .meta { color: #666; font-size: 11px; margin-bottom: 14px; }
  pre {
    background: #f7f7f9;
    border: 1px solid #e4e4eb;
    padding: 12px;
    font-size: 10px;
    line-height: 1.4;
    overflow-x: auto;
    border-radius: 4px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .hint { color: #666; font-size: 11px; margin: 14px 0; }
  @media print {
    .hint { display: none; }
    body { padding: 0; }
  }
</style>
</head>
<body>
  <h1>${safeTitle}</h1>
  <div class="meta">Workspace: ${safeWs} · Generated: ${safeGen}</div>
  <div class="hint">Press <kbd>Ctrl</kbd>+<kbd>P</kbd> (or <kbd>⌘</kbd>+<kbd>P</kbd>) to save as PDF.</div>
  <h2>Briefing Data (full payload, evidence-based)</h2>
  <pre>${safeJson}</pre>
</body>
</html>`
}

export default enhancementRoutes
