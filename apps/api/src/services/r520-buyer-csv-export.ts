/**
 * R520 — Buyer-email opt-in CSV export.
 *
 * Captured emails (R517) are an asset; this turns them into a downloadable
 * mail-merge file the operator can import into a real email tool. Excludes
 * any rows that have been GDPR-redacted (R515 deletes outright so they
 * don't appear).
 *
 * Columns: email, source, sale_count, first_seen, last_seen
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

export async function exportBuyerOptInsCsv(workspaceId: string): Promise<string> {
  const header = 'email,source,sale_count,first_seen_iso,last_seen_iso\n'
  try {
    // R547 — cap rows so a degenerate workspace doesn't OOM the Node process.
    // 50K opted-in buyers is far past any realistic POD operator's audience.
    const rows = await db.execute(sql`
      SELECT email, source, sale_count, first_seen_at, last_seen_at
      FROM buyer_emails
      WHERE workspace_id = ${workspaceId}
      ORDER BY last_seen_at DESC
      LIMIT 50000
    `)
    const body = (rows as unknown as Array<{ email: string; source: string; sale_count: number; first_seen_at: number; last_seen_at: number }>)
      .map(r => {
        const e  = `"${String(r.email).replace(/"/g, '""')}"`
        const s  = `"${String(r.source).replace(/"/g, '""')}"`
        const fs = new Date(Number(r.first_seen_at)).toISOString()
        const ls = new Date(Number(r.last_seen_at)).toISOString()
        return `${e},${s},${r.sale_count},${fs},${ls}`
      })
      .join('\n')
    return header + body + (body ? '\n' : '')
  } catch {
    return header
  }
}
