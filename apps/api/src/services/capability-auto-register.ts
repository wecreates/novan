/**
 * capability-auto-register.ts — Discovers services on disk and writes
 * them to `discovered_capabilities`. The gap detector remains the
 * source of truth for HARDCODED capabilities; this table adds a
 * runtime-discovered layer.
 *
 * Idempotent: file stays at first_seen_at, updates last_seen_at + maturity.
 *
 * Maturity heuristic (cheap):
 *   - exports >= 8 → mature
 *   - exports >= 4 → healthy
 *   - exports >= 2 → basic
 *   - else         → scaffolded
 */
import { db } from '../db/client.js'
import { discoveredCapabilities } from '../db/schema.js'
import { eq, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { introspectCode } from './code-introspection.js'

function maturityOf(exportsCount: number): 'scaffolded' | 'basic' | 'healthy' | 'mature' {
  if (exportsCount >= 8) return 'mature'
  if (exportsCount >= 4) return 'healthy'
  if (exportsCount >= 2) return 'basic'
  return 'scaffolded'
}

export async function autoRegister(workspaceId: string): Promise<{ added: number; updated: number; total: number }> {
  // R146.204 — single atomic upsert per row. Previously did SELECT then
  // UPDATE-or-INSERT, blindly rewriting lastSeenAt + exportsCount +
  // maturity on every tick → ~87K writes/24h on 1197 rows (73× churn
  // ratio). Now the upsert's WHERE clause skips no-op writes (same
  // exportsCount + maturity + lastSeenAt freshness <1h), cutting churn
  // by ~50-100×. Relies on uniq idx discovered_capabilities_ws_file_uniq
  // from migration 0111.
  const intro = introspectCode()
  const HOUR_MS = 60 * 60_000
  const now = Date.now()
  let added = 0, updated = 0, skipped = 0
  for (const m of intro.servicesIndex) {
    const exportsCount = m.exports.length
    const maturity = maturityOf(exportsCount)
    const r = await db.insert(discoveredCapabilities).values({
      id: uuidv7(), workspaceId, serviceFile: m.file,
      exportsCount, maturity,
      firstSeenAt: now, lastSeenAt: now,
    })
      .onConflictDoUpdate({
        target: [discoveredCapabilities.workspaceId, discoveredCapabilities.serviceFile],
        set: { exportsCount, maturity, lastSeenAt: now },
        // Only write when something actually changed or the heartbeat
        // is stale (>1h). Avoids burning 73× tick churn on no-op writes.
        setWhere: sql`
          ${discoveredCapabilities.exportsCount} <> ${exportsCount}
          OR ${discoveredCapabilities.maturity}     <> ${maturity}
          OR ${discoveredCapabilities.lastSeenAt}   <  ${now - HOUR_MS}
        `,
      })
      .returning({ firstSeen: discoveredCapabilities.firstSeenAt })
      .catch((e: Error) => { console.error('[capability-auto-register]', e.message); return [] as Array<{ firstSeen: number }> })
    if (r.length === 0) skipped++
    else if (r[0]!.firstSeen === now) added++
    else updated++
  }
  return { added, updated, total: intro.servicesIndex.length }
}

export async function listDiscovered(workspaceId: string) {
  return db.select().from(discoveredCapabilities)
    .where(eq(discoveredCapabilities.workspaceId, workspaceId))
    .catch(() => [])
}
