/**
 * R639 — Scraping UI views.
 *
 *   /ops/scrape           — job list + run history
 *   /ops/scrape/runs/:id  — pages within a run
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

const STYLE = `body{font:14px/1.45 -apple-system,BlinkMacSystemFont,sans-serif;max-width:980px;margin:24px auto;padding:0 16px;color:#222}h1,h2{margin:.6em 0 .3em}h1{font-size:20px}h2{font-size:15px;color:#374151}table{border-collapse:collapse;width:100%;margin:8px 0}th,td{padding:6px 10px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}th{background:#f6f7f9;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em}.meta{color:#6b7280;font-size:12px;margin-bottom:8px}.dim{color:#9ca3af}.good{color:#059669}.bad{color:#b91c1c}.tag{display:inline-block;padding:2px 6px;border-radius:4px;background:#eef2ff;color:#3730a3;font-size:11px;margin-right:4px}.row{display:flex;gap:12px;flex-wrap:wrap}.card{flex:1;min-width:160px;padding:10px;border:1px solid #e5e7eb;border-radius:6px;background:#fff}.big{font-size:22px;font-weight:600;display:block}.kpi-label{color:#6b7280;font-size:11px;text-transform:uppercase}a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}code{font:12.5px/1 ui-monospace,monospace;background:#f6f7f9;padding:1px 4px;border-radius:3px}`

function esc(s: unknown): string { return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!)) }
function fmtAgo(ts: number | null): string { if (!ts) return ''; const ms = Date.now() - ts; if (ms < 60_000) return `${Math.round(ms/1000)}s`; if (ms < 3600_000) return `${Math.round(ms/60_000)}m`; if (ms < 86_400_000) return `${Math.round(ms/3600_000)}h`; return `${Math.round(ms/86_400_000)}d` }
function shell(title: string, body: string, refresh = 30): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="${refresh}"><title>${esc(title)} · Novan</title><style>${STYLE}</style><h1>${esc(title)}</h1>${body}`
}

export async function renderScrapeHtml(workspaceId: string): Promise<string> {
  const jobs = await db.execute(sql`SELECT * FROM scrape_jobs WHERE workspace_id = ${workspaceId} ORDER BY created_at DESC LIMIT 50`).catch(() => [] as unknown[])
  const runs = await db.execute(sql`SELECT * FROM scrape_runs WHERE workspace_id = ${workspaceId} ORDER BY started_at DESC LIMIT 30`).catch(() => [] as unknown[])
  const stats = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'running')::int AS running,
      COUNT(*) FILTER (WHERE status = 'success' AND started_at > ${Date.now() - 24*3600_000})::int AS ok24,
      COUNT(*) FILTER (WHERE status = 'failed' AND started_at > ${Date.now() - 24*3600_000})::int AS fail24,
      COALESCE(SUM(diffs_detected) FILTER (WHERE started_at > ${Date.now() - 7*24*3600_000}), 0)::int AS diffs7d
    FROM scrape_runs WHERE workspace_id = ${workspaceId}
  `).catch(() => [{ running: 0, ok24: 0, fail24: 0, diffs7d: 0 }] as unknown[])
  const t = (stats as Array<Record<string, unknown>>)[0] ?? {}

  const jobRows = (jobs as Array<Record<string, unknown>>).map(j => `<tr>
    <td><code>${esc(j['name'])}</code></td>
    <td class="dim" style="max-width:260px;word-break:break-all">${esc(j['seed_url'])}</td>
    <td>${j['enabled'] ? '<span class="good">on</span>' : '<span class="dim">off</span>'}</td>
    <td>${esc(j['schedule_cron'] ?? '')}</td>
    <td>${esc(j['last_run_status'] ?? '')}</td>
    <td class="dim">${fmtAgo(j['last_run_at'] ? Number(j['last_run_at']) : null)}</td>
  </tr>`).join('')

  const runRows = (runs as Array<Record<string, unknown>>).map(r => {
    const status = String(r['status'])
    const cls = status === 'success' ? 'good' : (status === 'failed' ? 'bad' : 'dim')
    return `<tr>
      <td><a href="/ops/scrape/runs/${esc(r['id'])}?token=__TOKEN__">${esc(String(r['id']).slice(0, 8))}</a></td>
      <td class="${cls}">${esc(status)}</td>
      <td>${esc(r['pages_succeeded'])}/${esc(r['pages_attempted'])}</td>
      <td>${esc(r['pages_failed'])}</td>
      <td>${esc(r['diffs_detected'])}</td>
      <td>${esc(r['trigger'])}</td>
      <td class="dim">${fmtAgo(Number(r['started_at']))}</td>
    </tr>`
  }).join('')

  const body = `
    <div class="meta">workspace=${esc(workspaceId)} · scraping system · refresh 30s</div>
    <div class="row">
      <div class="card"><span class="big">${esc(t['running'] ?? 0)}</span><span class="kpi-label">running</span></div>
      <div class="card"><span class="big good">${esc(t['ok24'] ?? 0)}</span><span class="kpi-label">ok 24h</span></div>
      <div class="card"><span class="big bad">${esc(t['fail24'] ?? 0)}</span><span class="kpi-label">failed 24h</span></div>
      <div class="card"><span class="big">${esc(t['diffs7d'] ?? 0)}</span><span class="kpi-label">diffs 7d</span></div>
    </div>
    <h2>Jobs</h2>
    <table><thead><tr><th>name</th><th>seed</th><th>enabled</th><th>schedule</th><th>last</th><th>age</th></tr></thead><tbody>
      ${jobRows || '<tr><td colspan="6" class="dim">No jobs yet. Use <code>scrape.job.create</code> brain op.</td></tr>'}
    </tbody></table>
    <h2>Recent runs</h2>
    <table><thead><tr><th>id</th><th>status</th><th>pages ok/att</th><th>failed</th><th>diffs</th><th>trigger</th><th>age</th></tr></thead><tbody>
      ${runRows || '<tr><td colspan="7" class="dim">No runs yet.</td></tr>'}
    </tbody></table>
  `
  return shell('Webscraping', body)
}

export async function renderScrapeRunHtml(workspaceId: string, runId: string): Promise<string> {
  const r = await db.execute(sql`SELECT * FROM scrape_runs WHERE workspace_id = ${workspaceId} AND id = ${runId}`).catch(() => [] as unknown[])
  const run = (r as Array<Record<string, unknown>>)[0]
  if (!run) return shell('Run not found', '<p class="dim">No such run in this workspace.</p>', 0)

  const pages = await db.execute(sql`SELECT id, url, status_code, title, bytes, fetched_via, fetched_at, error FROM scrape_pages WHERE workspace_id = ${workspaceId} AND run_id = ${runId} ORDER BY fetched_at LIMIT 200`).catch(() => [] as unknown[])
  const rows = (pages as Array<Record<string, unknown>>).map(p => {
    const err = p['error'] ? String(p['error']) : ''
    const ok = !err && (p['status_code'] === null || Number(p['status_code']) < 400)
    return `<tr>
      <td><span class="${ok ? 'good' : 'bad'}">${esc(p['status_code'] ?? '—')}</span></td>
      <td style="max-width:340px;word-break:break-all"><a href="${esc(p['url'])}" target="_blank" rel="noopener">${esc(p['url'])}</a></td>
      <td>${esc(String(p['title'] ?? '').slice(0, 80))}</td>
      <td class="dim">${esc(p['fetched_via'])}</td>
      <td>${esc(p['bytes'] ?? '')}</td>
      <td class="bad">${esc(err.slice(0, 120))}</td>
    </tr>`
  }).join('')

  const meta = `<div class="meta">run <code>${esc(runId)}</code> · job <code>${esc(run['job_id'])}</code> · ${esc(run['status'])} · ${esc(run['pages_succeeded'])}/${esc(run['pages_attempted'])} ok · ${esc(run['diffs_detected'])} diff(s) · ${esc(run['trigger'])} · started ${fmtAgo(Number(run['started_at']))} ago</div>`
  return shell('Scrape run', meta + `<table><thead><tr><th>code</th><th>url</th><th>title</th><th>via</th><th>bytes</th><th>error</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="dim">No pages yet.</td></tr>'}</tbody></table>`, 15)
}
