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
import { and, eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { introspectCode } from './code-introspection.js'

function maturityOf(exportsCount: number): 'scaffolded' | 'basic' | 'healthy' | 'mature' {
  if (exportsCount >= 8) return 'mature'
  if (exportsCount >= 4) return 'healthy'
  if (exportsCount >= 2) return 'basic'
  return 'scaffolded'
}

export async function autoRegister(workspaceId: string): Promise<{ added: number; updated: number; total: number }> {
  const intro = introspectCode()
  let added = 0, updated = 0
  for (const m of intro.servicesIndex) {
    const exportsCount = m.exports.length
    const maturity = maturityOf(exportsCount)
    const existing = await db.select().from(discoveredCapabilities)
      .where(and(
        eq(discoveredCapabilities.workspaceId, workspaceId),
        eq(discoveredCapabilities.serviceFile, m.file),
      )).limit(1).then(r => r[0]).catch((e: Error) => { console.error('[capability-auto-register]', e.message); return null })
    if (existing) {
      await db.update(discoveredCapabilities).set({
        exportsCount, maturity, lastSeenAt: Date.now(),
      }).where(eq(discoveredCapabilities.id, existing.id)).catch((e: Error) => { console.error('[capability-auto-register]', e.message); return null })
      updated++
    } else {
      await db.insert(discoveredCapabilities).values({
        id: uuidv7(), workspaceId, serviceFile: m.file,
        exportsCount, maturity,
        firstSeenAt: Date.now(), lastSeenAt: Date.now(),
      }).onConflictDoNothing().catch((e: Error) => { console.error('[capability-auto-register]', e.message); return null })
      added++
    }
  }
  return { added, updated, total: intro.servicesIndex.length }
}

export async function listDiscovered(workspaceId: string) {
  return db.select().from(discoveredCapabilities)
    .where(eq(discoveredCapabilities.workspaceId, workspaceId))
    .catch(() => [])
}
