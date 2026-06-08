/**
 * R146.336 — Operator Reports (closes documents.spreadsheet 5→7)
 *
 * Generate CSV/Markdown-table reports across business + revenue + capability
 * data. Lightweight: no Excel binary writing, just well-formatted text that
 * Excel/Sheets opens cleanly. Operator-friendly.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

export type ReportFormat = 'csv' | 'markdown' | 'tsv'

export interface Report {
  name:       string
  format:     ReportFormat
  generatedAt: number
  rows:       number
  content:    string
  filename:   string
}

function escape(v: unknown, format: ReportFormat): string {
  const s = String(v ?? '')
  if (format === 'csv' || format === 'tsv') {
    if (s.includes('"') || s.includes(',') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`
    }
    return s
  }
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function fmtRow(values: unknown[], format: ReportFormat): string {
  const sep = format === 'tsv' ? '\t' : format === 'csv' ? ',' : ' | '
  const escaped = values.map(v => escape(v, format))
  return format === 'markdown' ? `| ${escaped.join(' | ')} |` : escaped.join(sep)
}

function fmtTable(headers: string[], rows: unknown[][], format: ReportFormat): string {
  const lines: string[] = []
  lines.push(fmtRow(headers, format))
  if (format === 'markdown') {
    lines.push(`| ${headers.map(() => '---').join(' | ')} |`)
  }
  for (const r of rows) lines.push(fmtRow(r, format))
  return lines.join('\n')
}

// ─── Per-business revenue report ─────────────────────────────────────────────

export async function revenueByBusinessReport(
  workspaceId: string,
  format: ReportFormat = 'csv',
  daysBack = 30,
): Promise<Report> {
  const sinceMs = Date.now() - daysBack * 24 * 3600 * 1000
  try {
    const rows = await db.execute(sql`
      SELECT business_id, COALESCE(business_name, business_id) AS name,
             COALESCE(SUM(gross_usd), 0) AS gross,
             COALESCE(SUM(fees_usd), 0)  AS fees,
             COALESCE(SUM(net_usd), 0)   AS net,
             COUNT(*) AS orders
      FROM business_revenue
      WHERE workspace_id = ${workspaceId} AND recorded_at >= ${sinceMs}
      GROUP BY business_id, business_name
      ORDER BY gross DESC
    `) as unknown as Array<{ business_id: string; name: string; gross: number; fees: number; net: number; orders: number }>
    const tableRows = rows.map(r => [r.business_id, r.name, r.gross.toFixed(2), r.fees.toFixed(2), r.net.toFixed(2), r.orders])
    const content = fmtTable(
      ['business_id', 'name', 'gross_usd', 'fees_usd', 'net_usd', 'orders'],
      tableRows,
      format,
    )
    return {
      name:        'revenue_by_business',
      format,
      generatedAt: Date.now(),
      rows:        rows.length,
      content,
      filename:    `revenue_by_business_${daysBack}d.${format === 'markdown' ? 'md' : format}`,
    }
  } catch (e) {
    return {
      name:        'revenue_by_business',
      format,
      generatedAt: Date.now(),
      rows:        0,
      content:     `# Error: ${(e as Error).message.slice(0, 200)}`,
      filename:    `revenue_by_business.${format === 'markdown' ? 'md' : format}`,
    }
  }
}

// ─── Capability parity report (R334 registry → table) ───────────────────────

export async function capabilityParityReport(format: ReportFormat = 'markdown'): Promise<Report> {
  const { CLAUDE_PARITY, parityReport } = await import('./r334-claude-parity-registry.js')
  const r = parityReport()
  const tableRows = CLAUDE_PARITY
    .sort((a, b) => b.novanScore - a.novanScore)
    .map(c => [c.id, c.category, c.novanScore, c.closureCost, c.tenXVision.slice(0, 80)])
  const header = `# Claude Parity Report\n\n` +
    `**Total capabilities:** ${r.totalCapabilities}  \n` +
    `**Average score:** ${r.averageScore} / 10  \n` +
    `**Total gap points:** ${r.totalGapPoints}  \n` +
    `**At-or-above Claude (≥7):** ${r.topMatchedAreas.length}  \n` +
    `**Novan advantages (≥8):** ${r.novanAdvantages.length}  \n\n`
  const table = fmtTable(['id', 'category', 'novan_score', 'closure_cost', 'tenX_vision'], tableRows, format)
  const content = format === 'markdown' ? header + table : table
  return {
    name:        'capability_parity',
    format,
    generatedAt: Date.now(),
    rows:        CLAUDE_PARITY.length,
    content,
    filename:    `capability_parity.${format === 'markdown' ? 'md' : format}`,
  }
}

// ─── Recent failures report (debugging aid) ─────────────────────────────────

export async function recentFailuresReport(
  workspaceId: string,
  format: ReportFormat = 'csv',
  daysBack = 7,
): Promise<Report> {
  const sinceMs = Date.now() - daysBack * 24 * 3600 * 1000
  try {
    const rows = await db.execute(sql`
      SELECT type, source, payload, created_at
      FROM events
      WHERE workspace_id = ${workspaceId}
        AND created_at >= ${sinceMs}
        AND (type LIKE '%error%' OR type LIKE '%fail%')
      ORDER BY created_at DESC
      LIMIT 100
    `) as unknown as Array<{ type: string; source: string; payload: Record<string, unknown>; created_at: number }>
    const tableRows = rows.map(r => [
      new Date(Number(r.created_at)).toISOString(),
      r.type,
      r.source,
      JSON.stringify(r.payload).slice(0, 200),
    ])
    const content = fmtTable(['timestamp', 'type', 'source', 'payload'], tableRows, format)
    return {
      name:        'recent_failures',
      format,
      generatedAt: Date.now(),
      rows:        rows.length,
      content,
      filename:    `recent_failures_${daysBack}d.${format === 'markdown' ? 'md' : format}`,
    }
  } catch (e) {
    return {
      name:        'recent_failures',
      format,
      generatedAt: Date.now(),
      rows:        0,
      content:     `# Error: ${(e as Error).message.slice(0, 200)}`,
      filename:    `recent_failures.${format === 'markdown' ? 'md' : format}`,
    }
  }
}
