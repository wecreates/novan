/**
 * R419 — Bulk sales import.
 *
 * Operator pastes a CSV (or array) of sales from any platform that doesn't
 * have a webhook (Etsy / INPRNT / FAA / Redbubble). Each row creates a
 * business_revenue entry idempotent on (workspace, external_sale_id).
 *
 * Format:
 *   sale_id,source,net_usd,gross_usd,permalink,product_name,sold_at_iso
 *
 * sold_at_iso optional; defaults to now. permalink optional but enables
 * R374 winner-variant trigger.
 */
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'

export interface BulkImportRow {
  sale_id:      string
  source:       string                  // 'etsy' | 'inprnt' | 'fine_art_america' | etc.
  net_usd:      number
  gross_usd?:   number
  permalink?:   string
  product_name?: string
  sold_at_iso?: string
}

export interface BulkImportResult {
  inserted:   number
  skipped:    number
  triggered:  number   // variant generations fired
  errors:     Array<{ sale_id: string; error: string }>
}

export async function bulkImportSales(workspaceId: string, rows: BulkImportRow[]): Promise<BulkImportResult> {
  const result: BulkImportResult = { inserted: 0, skipped: 0, triggered: 0, errors: [] }
  if (!Array.isArray(rows) || rows.length === 0) return result

  const newlyInsertedSaleIds: string[] = []

  for (const row of rows) {
    try {
      const saleId = String(row.sale_id ?? '').trim()
      const source = String(row.source ?? '').trim()
      const net = Number(row.net_usd)
      if (!saleId || !source || !isFinite(net) || net < 0) {
        result.errors.push({ sale_id: saleId || '?', error: 'missing sale_id/source/net_usd' })
        continue
      }
      const recordedAt = row.sold_at_iso ? Date.parse(row.sold_at_iso) || Date.now() : Date.now()
      const metadata = { permalink: row.permalink, productName: row.product_name, via: 'bulk_import' }

      const r = await db.execute(sql`
        INSERT INTO business_revenue
          (id, workspace_id, external_sale_id, source, net_usd, gross_usd, currency, metadata, recorded_at)
        VALUES
          (${uuidv7()}, ${workspaceId}, ${saleId}, ${source}, ${net},
           ${row.gross_usd ?? null}, 'USD',
           ${JSON.stringify(metadata)}::jsonb, ${recordedAt})
        ON CONFLICT (workspace_id, external_sale_id) WHERE external_sale_id IS NOT NULL
        DO NOTHING
        RETURNING id
      `)
      const wasInserted = Array.isArray(r) && (r as unknown[]).length > 0
      if (wasInserted) {
        result.inserted++
        if (row.permalink) newlyInsertedSaleIds.push(saleId)
      } else {
        result.skipped++
      }
    } catch (e) {
      result.errors.push({ sale_id: String(row.sale_id ?? '?'), error: (e as Error).message.slice(0, 100) })
    }
  }

  // Fire variant generation for newly-inserted sales with permalinks
  if (newlyInsertedSaleIds.length > 0) {
    try {
      const { reactToNewSales } = await import('./r374-winner-variant-generator.js')
      const r = await reactToNewSales(workspaceId, newlyInsertedSaleIds)
      result.triggered = r.triggered
    } catch { /* tolerated */ }
  }

  return result
}

/**
 * Parse a CSV string. Lightweight — assumes no embedded commas in fields.
 */
export function parseCsvSales(csv: string): BulkImportRow[] {
  const lines = csv.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'))
  if (lines.length === 0) return []
  const headerLine = lines[0]!
  const headers = headerLine.split(',').map(h => h.trim().toLowerCase())
  const rows: BulkImportRow[] = []
  for (const line of lines.slice(1)) {
    const cells = line.split(',').map(c => c.trim())
    const obj: Record<string, string> = {}
    headers.forEach((h, i) => { if (cells[i] !== undefined) obj[h] = cells[i] })
    rows.push({
      sale_id:      obj['sale_id'] ?? '',
      source:       obj['source'] ?? '',
      net_usd:      Number(obj['net_usd'] ?? '0'),
      ...(obj['gross_usd']    ? { gross_usd: Number(obj['gross_usd']) } : {}),
      ...(obj['permalink']    ? { permalink: obj['permalink'] }         : {}),
      ...(obj['product_name'] ? { product_name: obj['product_name'] }   : {}),
      ...(obj['sold_at_iso']  ? { sold_at_iso: obj['sold_at_iso'] }     : {}),
    })
  }
  return rows
}
