/**
 * R658 — Agent run rollup + dashboard.
 *
 * Aggregates r649_agent_runs by day → totals + per-tool counts → renders
 * a single-pane HTML view operators can hit at /ops/agents/rollup. Useful
 * for spotting cost spikes from scheduled agents (R656) or runaway loops.
 */
import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

export interface RollupRow {
  day:        string
  runs:       number
  done:       number
  capped:     number
  tool_calls: number
  tokens:     number
  cost_usd:   number
}

export async function rollupByDay(workspaceId: string, days = 14): Promise<RollupRow[]> {
  try {
    const rows = await db.execute(sql`
      SELECT date_trunc('day', created_at)::date AS day,
             count(*)::int                                                    AS runs,
             count(*) FILTER (WHERE status = 'done')::int                     AS done,
             count(*) FILTER (WHERE status = 'capped')::int                   AS capped,
             COALESCE(sum(tool_calls), 0)::int                                AS tool_calls,
             COALESCE(sum(tokens), 0)::int                                    AS tokens,
             COALESCE(sum(cost_usd), 0)::numeric(14,6)                        AS cost_usd
      FROM r649_agent_runs
      WHERE workspace_id = ${workspaceId}
        AND created_at >= now() - (${days} || ' days')::interval
      GROUP BY day
      ORDER BY day DESC
    `)
    return ((rows.rows ?? rows) as Array<Record<string, unknown>>).map(r => ({
      day:        String(r['day']).slice(0, 10),
      runs:       Number(r['runs']),
      done:       Number(r['done']),
      capped:     Number(r['capped']),
      tool_calls: Number(r['tool_calls']),
      tokens:     Number(r['tokens']),
      cost_usd:   Number(r['cost_usd']),
    }))
  } catch { return [] }
}

export async function topGoals(workspaceId: string, days = 14, limit = 10): Promise<Array<{ goal: string; runs: number; cost_usd: number }>> {
  try {
    const rows = await db.execute(sql`
      SELECT substring(goal, 1, 80) AS goal,
             count(*)::int          AS runs,
             COALESCE(sum(cost_usd), 0)::numeric(14,6) AS cost_usd
      FROM r649_agent_runs
      WHERE workspace_id = ${workspaceId}
        AND created_at >= now() - (${days} || ' days')::interval
      GROUP BY substring(goal, 1, 80)
      ORDER BY cost_usd DESC, runs DESC
      LIMIT ${limit}
    `)
    return ((rows.rows ?? rows) as Array<Record<string, unknown>>).map(r => ({
      goal: String(r['goal']),
      runs: Number(r['runs']),
      cost_usd: Number(r['cost_usd']),
    }))
  } catch { return [] }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function sparkSvg(values: number[]): string {
  if (values.length === 0) return ''
  const W = 480, H = 60, P = 4
  const max = Math.max(...values, 1)
  const step = (W - 2 * P) / Math.max(1, values.length - 1)
  const pts = values.map((v, i) => `${(P + i * step).toFixed(1)},${(H - P - (v / max) * (H - 2 * P)).toFixed(1)}`).join(' ')
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <polyline fill="none" stroke="#4a7" stroke-width="2" points="${pts}"/>
  </svg>`
}

export async function renderAgentRollupHtml(workspaceId: string): Promise<string> {
  const days = await rollupByDay(workspaceId, 14)
  const goals = await topGoals(workspaceId, 14, 10)
  const totalRuns = days.reduce((s, d) => s + d.runs, 0)
  const totalCost = days.reduce((s, d) => s + d.cost_usd, 0)
  const totalTokens = days.reduce((s, d) => s + d.tokens, 0)
  const totalTools = days.reduce((s, d) => s + d.tool_calls, 0)
  const oldestFirst = [...days].reverse()
  const costSpark   = sparkSvg(oldestFirst.map(d => d.cost_usd))
  const runsSpark   = sparkSvg(oldestFirst.map(d => d.runs))

  const dayRows = days.map(d => `
    <tr>
      <td>${d.day}</td>
      <td>${d.runs}</td>
      <td>${d.done}</td>
      <td>${d.capped}</td>
      <td>${d.tool_calls}</td>
      <td>${d.tokens.toLocaleString()}</td>
      <td>$${d.cost_usd.toFixed(4)}</td>
    </tr>`).join('')
  const goalRows = goals.map(g => `
    <tr>
      <td>${escapeHtml(g.goal)}…</td>
      <td>${g.runs}</td>
      <td>$${g.cost_usd.toFixed(4)}</td>
    </tr>`).join('')

  return `<!doctype html><html><head><title>R658 agent rollup</title>
    <style>body{font:14px system-ui;max-width:1100px;margin:2rem auto;padding:1rem}
    table{width:100%;border-collapse:collapse;margin-bottom:1.5rem}
    th,td{padding:6px 10px;border-bottom:1px solid #eee;text-align:left;font-size:13px}
    th{background:#f7f7f7}.s{font:13px monospace;color:#555}.k{display:inline-block;margin-right:24px}
    h2{margin-top:2rem;font-size:16px}</style></head>
    <body><h1>R658 agent observability — last 14 days</h1>
    <p class="s">
      <span class="k">total runs: <b>${totalRuns}</b></span>
      <span class="k">tool calls: <b>${totalTools}</b></span>
      <span class="k">tokens: <b>${totalTokens.toLocaleString()}</b></span>
      <span class="k">spend: <b>$${totalCost.toFixed(4)}</b></span>
    </p>
    <!-- R658 -->
    <h2>Daily cost</h2>
    ${costSpark}
    <h2>Daily runs</h2>
    ${runsSpark}
    <h2>By day</h2>
    <table><thead><tr><th>day</th><th>runs</th><th>done</th><th>capped</th><th>tools</th><th>tokens</th><th>cost</th></tr></thead>
    <tbody>${dayRows}</tbody></table>
    <h2>Top goals by spend</h2>
    <table><thead><tr><th>goal (truncated)</th><th>runs</th><th>cost</th></tr></thead>
    <tbody>${goalRows}</tbody></table>
    </body></html>`
}
