/**
 * R503 — CSV export of business_revenue for tax / accountant.
 *
 * Returns a CSV string. Operator hits the dashboard button → downloads file.
 * Format suitable for Schedule C import in TurboTax, QuickBooks, etc.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

export async function exportRevenueCsv(workspaceId: string, opts?: { sinceMs?: number; untilMs?: number }): Promise<string> {
  const since = opts?.sinceMs ?? 0
  const until = opts?.untilMs ?? Date.now()
  const rows = await db.execute(sql`
    SELECT external_sale_id, source, net_usd, gross_usd, currency, recorded_at, metadata
    FROM business_revenue
    WHERE workspace_id = ${workspaceId}
      AND recorded_at >= ${since}
      AND recorded_at <= ${until}
      AND external_sale_id IS NOT NULL
      AND external_sale_id NOT LIKE '\\_\\_synthetic\\_test\\_\\_%' ESCAPE '\\'
    ORDER BY recorded_at ASC
  `).catch(() => [] as unknown[])

  const data = rows as unknown as Array<{ external_sale_id: string; source: string; net_usd: number; gross_usd: number; currency: string; recorded_at: number; metadata: Record<string, unknown> | null }>

  const esc = (v: string): string => {
    const s = String(v ?? '')
    if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`
    return s
  }

  const lines: string[] = [
    'date_utc,platform,sale_id,product,net_usd,gross_usd,currency,permalink',
  ]
  for (const r of data) {
    const date = new Date(Number(r.recorded_at)).toISOString().slice(0, 10)
    const product = String(r.metadata?.['productName'] ?? r.metadata?.['product'] ?? '')
    const permalink = String(r.metadata?.['permalink'] ?? '')
    lines.push([
      date, esc(String(r.source ?? '')), esc(String(r.external_sale_id ?? '')),
      esc(product), Number(r.net_usd ?? 0).toFixed(2), Number(r.gross_usd ?? 0).toFixed(2),
      esc(String(r.currency ?? 'USD')), esc(permalink),
    ].join(','))
  }
  return lines.join('\n') + '\n'
}
