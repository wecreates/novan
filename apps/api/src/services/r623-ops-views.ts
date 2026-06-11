/**
 * R623 — Operator-facing HTML views for systems that were query-only.
 *
 *   /ops/memory   — workspace_memory + KG nodes, editable scope
 *   /ops/kg       — KG node + edge browser with mermaid graph
 *   /ops/spend    — ai_usage rollup per provider / day / model
 *   /ops/inbox    — inbox queue dashboard with pending/done/failed counts
 *   /ops/desktop  — desktop_action_queue dashboard
 *   /ops/rag      — rag_documents list + per-doc chunk count
 *
 * Same auth pattern as /ops/dashboard: ?token= query param against
 * NOVAN_OPS_TOKEN / OPERATOR_TOKEN env. Auto-refresh built in (30s
 * for runtime dashboards, none for editor views).
 *
 * No frontend framework — minimal HTML + inline CSS. Operator can read
 * everything from a phone browser.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

const STYLE = `
body{font:14px/1.45 -apple-system,BlinkMacSystemFont,sans-serif;max-width:880px;margin:24px auto;padding:0 16px;color:#222}
h1,h2{margin:.6em 0 .3em}
h1{font-size:20px}h2{font-size:15px;color:#374151}
table{border-collapse:collapse;width:100%;margin:8px 0}
th,td{padding:6px 10px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}
th{background:#f6f7f9;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em}
.meta{color:#6b7280;font-size:12px;margin-bottom:8px}
.tag{display:inline-block;padding:2px 6px;border-radius:4px;background:#eef2ff;color:#3730a3;font-size:11px;margin-right:4px}
.bad{color:#b91c1c}.good{color:#059669}.dim{color:#9ca3af}
pre{white-space:pre-wrap;background:#f6f7f9;border:1px solid #e5e7eb;border-radius:6px;padding:10px;font:12.5px/1.5 ui-monospace,monospace;max-height:360px;overflow:auto}
a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}
.row{display:flex;gap:12px;flex-wrap:wrap}.card{flex:1;min-width:180px;padding:10px;border:1px solid #e5e7eb;border-radius:6px;background:#fff}
.big{font-size:22px;font-weight:600;display:block}
.kpi-label{color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
`

function shell(title: string, body: string, refreshSec?: number): string {
  const refresh = refreshSec ? `<meta http-equiv="refresh" content="${refreshSec}">` : ''
  return `<!doctype html><meta charset="utf-8">${refresh}<title>${esc(title)} · Novan</title><style>${STYLE}</style><h1>${esc(title)}</h1>${body}`
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '$0.00'
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`
}

function fmtAgo(ts: number): string {
  if (!ts) return ''
  const ms = Date.now() - ts
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.round(ms / 3600_000)}h`
  return `${Math.round(ms / 86_400_000)}d`
}

// ─── /ops/memory ─────────────────────────────────────────────────────────────

export async function renderMemoryHtml(workspaceId: string, token = ''): Promise<string> {
  const r = await db.execute(sql`
    SELECT key, value, scope, importance, updated_at
    FROM workspace_memory
    WHERE workspace_id = ${workspaceId}
    ORDER BY importance DESC NULLS LAST, updated_at DESC
    LIMIT 200
  `).catch(() => [] as unknown[])
  const rows = r as Array<Record<string, unknown>>
  const byScope: Record<string, Array<Record<string, unknown>>> = {}
  for (const row of rows) {
    const scope = String(row['scope'] ?? 'global')
    byScope[scope] = byScope[scope] || []
    byScope[scope]!.push(row)
  }
  const t = encodeURIComponent(token)
  const editorForm = `
    <h2>Add / update memory</h2>
    <form method="POST" action="/ops/memory/upsert?token=${t}&workspace=${esc(workspaceId)}" style="display:grid;grid-template-columns:1fr 2fr;gap:6px;margin:6px 0 14px;max-width:640px">
      <input name="key" placeholder="key (e.g. operator.preference.timezone)" required style="padding:6px 8px;border:1px solid #d1d5db;border-radius:4px">
      <textarea name="value" placeholder="value (multi-line OK)" required rows="3" style="padding:6px 8px;border:1px solid #d1d5db;border-radius:4px;font-family:inherit;resize:vertical"></textarea>
      <input name="scope" placeholder="scope (default: global)" style="padding:6px 8px;border:1px solid #d1d5db;border-radius:4px">
      <input name="importance" type="number" min="0" max="100" placeholder="importance 0-100" style="padding:6px 8px;border:1px solid #d1d5db;border-radius:4px">
      <button style="grid-column:1 / -1;padding:8px;background:#2563eb;color:#fff;border:none;border-radius:4px;cursor:pointer">Upsert</button>
    </form>`
  const deleteBtn = (key: string): string => `<form method="POST" action="/ops/memory/delete?token=${t}&workspace=${esc(workspaceId)}" style="display:inline" onsubmit="return confirm('Delete &quot;${esc(key)}&quot;?')"><input type="hidden" name="key" value="${esc(key)}"><button style="background:none;border:none;color:#b91c1c;cursor:pointer;font-size:12px">×</button></form>`
  const scopeBlocks = Object.entries(byScope).map(([scope, items]) => `
    <h2>${esc(scope)} <span class="dim">(${items.length})</span></h2>
    <table><thead><tr><th>key</th><th>value</th><th>importance</th><th>updated</th><th></th></tr></thead><tbody>
      ${items.map(it => `<tr>
        <td><code>${esc(it['key'])}</code></td>
        <td>${esc(String(it['value'] ?? '').slice(0, 240))}</td>
        <td>${esc(it['importance'] ?? '')}</td>
        <td class="dim">${fmtAgo(Number(it['updated_at'] ?? 0))}</td>
        <td>${token ? deleteBtn(String(it['key'])) : ''}</td>
      </tr>`).join('')}
    </tbody></table>
  `).join('')
  const body = `
    <div class="meta">workspace=${esc(workspaceId)} · ${rows.length} memories · auto-refresh 30s</div>
    ${token ? editorForm : ''}
    ${rows.length === 0 ? '<p class="dim">No memories yet. Memory grows via the <code>memory.recall</code> brain op and chat interactions.</p>' : scopeBlocks}
  `
  return shell('Memory', body, 30)
}

// ─── /ops/kg ─────────────────────────────────────────────────────────────────

export async function renderKgHtml(workspaceId: string): Promise<string> {
  const r = await db.execute(sql`
    SELECT id, name, type, importance, tags, created_at
    FROM kg_nodes WHERE workspace_id = ${workspaceId}
    ORDER BY importance DESC NULLS LAST, created_at DESC LIMIT 100
  `).catch(() => [] as unknown[])
  const nodes = r as Array<Record<string, unknown>>
  const counts = await db.execute(sql`SELECT type, count(*)::int AS n FROM kg_nodes WHERE workspace_id = ${workspaceId} GROUP BY type ORDER BY n DESC`).catch(() => [] as unknown[])
  const edgeCount = await db.execute(sql`SELECT count(*)::int AS n FROM kg_edges WHERE workspace_id = ${workspaceId}`).catch(() => [{ n: 0 }] as unknown[])
  const kpi = `
    <div class="row">
      ${(counts as Array<Record<string, unknown>>).map(c => `<div class="card"><span class="big">${esc(c['n'])}</span><span class="kpi-label">${esc(c['type'])}</span></div>`).join('')}
      <div class="card"><span class="big">${esc((edgeCount as Array<Record<string, unknown>>)[0]?.['n'] ?? 0)}</span><span class="kpi-label">edges</span></div>
    </div>
  `
  const body = `
    <div class="meta">workspace=${esc(workspaceId)} · top 100 nodes by importance · auto-refresh 30s</div>
    ${kpi}
    <h2>Recent nodes</h2>
    <table><thead><tr><th>name</th><th>type</th><th>imp</th><th>tags</th><th>created</th></tr></thead><tbody>
      ${nodes.map(n => {
        const tags = Array.isArray(n['tags']) ? (n['tags'] as unknown[]).map(t => `<span class="tag">${esc(t)}</span>`).join('') : ''
        return `<tr>
          <td><code>${esc(n['name'])}</code></td>
          <td>${esc(n['type'])}</td>
          <td>${esc(n['importance'])}</td>
          <td>${tags}</td>
          <td class="dim">${fmtAgo(Number(n['created_at'] ?? 0))}</td>
        </tr>`
      }).join('')}
    </tbody></table>
  `
  return shell('Knowledge Graph', body, 30)
}

// ─── /ops/spend ──────────────────────────────────────────────────────────────

export async function renderSpendHtml(workspaceId: string): Promise<string> {
  const day = Date.now() - 24 * 60 * 60_000
  const week = Date.now() - 7 * 24 * 60 * 60_000
  const totals = await db.execute(sql`
    SELECT
      sum(CASE WHEN timestamp > ${day}  THEN cost_usd ELSE 0 END)::float AS d24h,
      sum(CASE WHEN timestamp > ${week} THEN cost_usd ELSE 0 END)::float AS d7d,
      sum(cost_usd)::float AS all_time
    FROM ai_usage WHERE workspace_id = ${workspaceId}
  `).catch(() => [{ d24h: 0, d7d: 0, all_time: 0 }] as unknown[])
  const t = (totals as Array<Record<string, unknown>>)[0] ?? {}
  const byProvider = await db.execute(sql`
    SELECT provider, model,
      sum(cost_usd)::float AS cost,
      sum(prompt_tokens + output_tokens)::bigint AS toks,
      count(*)::int AS calls
    FROM ai_usage WHERE workspace_id = ${workspaceId} AND timestamp > ${week}
    GROUP BY provider, model ORDER BY cost DESC LIMIT 30
  `).catch(() => [] as unknown[])
  const byTask = await db.execute(sql`
    SELECT task_type, sum(cost_usd)::float AS cost, count(*)::int AS calls
    FROM ai_usage WHERE workspace_id = ${workspaceId} AND timestamp > ${week}
    GROUP BY task_type ORDER BY cost DESC LIMIT 15
  `).catch(() => [] as unknown[])
  const body = `
    <div class="meta">workspace=${esc(workspaceId)} · auto-refresh 30s</div>
    <div class="row">
      <div class="card"><span class="big">${fmtUsd(Number(t['d24h'] ?? 0))}</span><span class="kpi-label">last 24h</span></div>
      <div class="card"><span class="big">${fmtUsd(Number(t['d7d']  ?? 0))}</span><span class="kpi-label">last 7d</span></div>
      <div class="card"><span class="big">${fmtUsd(Number(t['all_time'] ?? 0))}</span><span class="kpi-label">all time</span></div>
    </div>
    <h2>By provider / model (7d)</h2>
    <table><thead><tr><th>provider</th><th>model</th><th>cost</th><th>tokens</th><th>calls</th></tr></thead><tbody>
      ${(byProvider as Array<Record<string, unknown>>).map(r => `<tr>
        <td>${esc(r['provider'])}</td>
        <td><code>${esc(r['model'])}</code></td>
        <td>${fmtUsd(Number(r['cost'] ?? 0))}</td>
        <td>${esc(r['toks'])}</td>
        <td>${esc(r['calls'])}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="dim">No usage in last 7 days.</td></tr>'}
    </tbody></table>
    <h2>By task type (7d)</h2>
    <table><thead><tr><th>task</th><th>cost</th><th>calls</th></tr></thead><tbody>
      ${(byTask as Array<Record<string, unknown>>).map(r => `<tr>
        <td><code>${esc(r['task_type'])}</code></td>
        <td>${fmtUsd(Number(r['cost'] ?? 0))}</td>
        <td>${esc(r['calls'])}</td>
      </tr>`).join('') || '<tr><td colspan="3" class="dim">No usage in last 7 days.</td></tr>'}
    </tbody></table>
  `
  return shell('AI Spend', body, 30)
}

// ─── /ops/inbox ──────────────────────────────────────────────────────────────

export async function renderInboxHtml(workspaceId: string): Promise<string> {
  const stats = await db.execute(sql`
    SELECT status, count(*)::int AS n FROM novan_inbox WHERE workspace_id = ${workspaceId} GROUP BY status
  `).catch(() => [] as unknown[])
  const byStatus: Record<string, number> = {}
  for (const r of stats as Array<Record<string, unknown>>) byStatus[String(r['status'])] = Number(r['n'])
  const recent = await db.execute(sql`
    SELECT id, kind, brief, status, created_at, completed_at, last_error
    FROM novan_inbox WHERE workspace_id = ${workspaceId}
    ORDER BY created_at DESC LIMIT 30
  `).catch(() => [] as unknown[])
  const body = `
    <div class="meta">workspace=${esc(workspaceId)} · auto-refresh 30s</div>
    <div class="row">
      ${['pending', 'working', 'done', 'failed', 'cancelled'].map(s => `<div class="card"><span class="big ${s === 'failed' ? 'bad' : ''}">${byStatus[s] ?? 0}</span><span class="kpi-label">${s}</span></div>`).join('')}
    </div>
    <h2>Recent</h2>
    <table><thead><tr><th>kind</th><th>brief</th><th>status</th><th>age</th><th>error</th></tr></thead><tbody>
      ${(recent as Array<Record<string, unknown>>).map(r => `<tr>
        <td>${esc(r['kind'])}</td>
        <td>${esc(String(r['brief'] ?? '').slice(0, 140))}</td>
        <td class="${r['status'] === 'failed' ? 'bad' : r['status'] === 'done' ? 'good' : 'dim'}">${esc(r['status'])}</td>
        <td class="dim">${fmtAgo(Number(r['created_at'] ?? 0))}</td>
        <td class="bad">${esc(String(r['last_error'] ?? '').slice(0, 120))}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="dim">Empty.</td></tr>'}
    </tbody></table>
  `
  return shell('Inbox', body, 30)
}

// ─── /ops/desktop ────────────────────────────────────────────────────────────

export async function renderDesktopHtml(workspaceId: string): Promise<string> {
  // Tolerate missing table — R620 may not have created it yet
  const stats = await db.execute(sql`SELECT status, count(*)::int AS n FROM desktop_action_queue WHERE workspace_id = ${workspaceId} GROUP BY status`).catch(() => [] as unknown[])
  const byStatus: Record<string, number> = {}
  for (const r of stats as Array<Record<string, unknown>>) byStatus[String(r['status'])] = Number(r['n'])
  const recent = await db.execute(sql`
    SELECT id, kind, brief, status, attempts, created_at, claimed_at, completed_at, error
    FROM desktop_action_queue WHERE workspace_id = ${workspaceId}
    ORDER BY created_at DESC LIMIT 30
  `).catch(() => [] as unknown[])
  const body = `
    <div class="meta">workspace=${esc(workspaceId)} · R620 desktop queue · auto-refresh 30s</div>
    <div class="row">
      ${['pending', 'claimed', 'done', 'failed', 'cancelled'].map(s => `<div class="card"><span class="big ${s === 'failed' ? 'bad' : ''}">${byStatus[s] ?? 0}</span><span class="kpi-label">${s}</span></div>`).join('')}
    </div>
    <h2>Recent</h2>
    <table><thead><tr><th>kind</th><th>brief</th><th>status</th><th>attempts</th><th>age</th><th>error</th></tr></thead><tbody>
      ${(recent as Array<Record<string, unknown>>).map(r => `<tr>
        <td><code>${esc(r['kind'])}</code></td>
        <td>${esc(String(r['brief'] ?? '').slice(0, 140))}</td>
        <td class="${r['status'] === 'failed' ? 'bad' : r['status'] === 'done' ? 'good' : 'dim'}">${esc(r['status'])}</td>
        <td>${esc(r['attempts'])}</td>
        <td class="dim">${fmtAgo(Number(r['created_at'] ?? 0))}</td>
        <td class="bad">${esc(String(r['error'] ?? '').slice(0, 120))}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="dim">No desktop jobs yet. Use <code>desktop.enqueue</code> brain op.</td></tr>'}
    </tbody></table>
  `
  return shell('Desktop Queue', body, 30)
}

// ─── /ops/rag ────────────────────────────────────────────────────────────────

export async function renderRagHtml(workspaceId: string): Promise<string> {
  const docs = await db.execute(sql`SELECT id, name, mime, bytes, chunks_count, created_at FROM rag_documents WHERE workspace_id = ${workspaceId} ORDER BY created_at DESC LIMIT 100`).catch(() => [] as unknown[])
  const stats = await db.execute(sql`SELECT count(*)::int AS docs, COALESCE(sum(chunks_count),0)::int AS chunks, COALESCE(sum(bytes),0)::bigint AS bytes FROM rag_documents WHERE workspace_id = ${workspaceId}`).catch(() => [{ docs: 0, chunks: 0, bytes: 0 }] as unknown[])
  const embedded = await db.execute(sql`SELECT count(*) FILTER (WHERE embedding IS NOT NULL)::int AS n FROM rag_chunks WHERE workspace_id = ${workspaceId}`).catch(() => [{ n: 0 }] as unknown[])
  const t = (stats as Array<Record<string, unknown>>)[0] ?? {}
  const e = (embedded as Array<Record<string, unknown>>)[0] ?? {}
  const body = `
    <div class="meta">workspace=${esc(workspaceId)} · R621 document RAG · auto-refresh 30s</div>
    <div class="row">
      <div class="card"><span class="big">${esc(t['docs'] ?? 0)}</span><span class="kpi-label">documents</span></div>
      <div class="card"><span class="big">${esc(t['chunks'] ?? 0)}</span><span class="kpi-label">chunks</span></div>
      <div class="card"><span class="big">${esc(e['n'] ?? 0)}</span><span class="kpi-label">embedded</span></div>
      <div class="card"><span class="big">${esc(t['bytes'] ?? 0)}</span><span class="kpi-label">bytes</span></div>
    </div>
    <h2>Documents</h2>
    <table><thead><tr><th>name</th><th>mime</th><th>bytes</th><th>chunks</th><th>created</th></tr></thead><tbody>
      ${(docs as Array<Record<string, unknown>>).map(d => `<tr>
        <td>${esc(d['name'])}</td>
        <td class="dim">${esc(d['mime'])}</td>
        <td>${esc(d['bytes'])}</td>
        <td>${esc(d['chunks_count'])}</td>
        <td class="dim">${fmtAgo(Number(d['created_at'] ?? 0))}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="dim">No documents. Use <code>rag.ingest</code> brain op.</td></tr>'}
    </tbody></table>
  `
  return shell('Document RAG', body, 30)
}
