/**
 * R575 — Workspace memory compaction.
 *
 * Anthropic's Claude Code auto-compacts context when prompt budget fills.
 * Novan persists memory across sessions — but without compaction the
 * workspace_memory table grows unbounded and chat injection eventually
 * pushes high-value lessons out of the system prompt.
 *
 * Strategy:
 *   - LOW-importance entries (< 60) older than 90d → compacted into a
 *     scope-level summary entry.
 *   - HIGH-importance entries (>= 80) → preserved untouched (R335 lessons,
 *     R334 brand-locked values, operator-set rules).
 *   - MID (60-79) older than 180d → also compacted.
 *   - Compaction inserts a synthetic entry `compacted.<scope>.YYYYMM`
 *     with summary text + delete-list of original keys.
 *
 * Trigger:
 *   - brain op `memory.compact` for manual run
 *   - daily cron tick in R382 runs it once per UTC day, 03:00 hour
 *
 * Safety:
 *   - DRY_RUN flag lets operator preview
 *   - Per-scope cap on how many keys can be compacted in one run
 *   - Audit row written to events for every compaction batch
 */
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'

export interface CompactionResult {
  ok:               boolean
  scopesProcessed:  number
  keysCompacted:    number
  summariesWritten: number
  dryRun:           boolean
  preview?:         Array<{ scope: string; eligibleCount: number; sampleKeys: string[] }>
}

const LOW_IMPORTANCE_CUTOFF  = 60
const MID_IMPORTANCE_CUTOFF  = 80
const LOW_AGE_MS             = 90  * 24 * 60 * 60_000
const MID_AGE_MS             = 180 * 24 * 60 * 60_000
const MAX_KEYS_PER_SCOPE     = 200   // cap per run so a single sweep can't grenade

export async function compactMemory(workspaceId: string, opts?: { dryRun?: boolean }): Promise<CompactionResult> {
  const dryRun = opts?.dryRun === true
  const now = Date.now()
  // Find scopes with compaction candidates.
  let scopes: string[] = []
  try {
    const r = await db.execute(sql`
      SELECT DISTINCT scope FROM workspace_memory
      WHERE workspace_id = ${workspaceId} AND scope IS NOT NULL
        AND (
          (importance < ${LOW_IMPORTANCE_CUTOFF} AND updated_at < ${now - LOW_AGE_MS}) OR
          (importance >= ${LOW_IMPORTANCE_CUTOFF} AND importance < ${MID_IMPORTANCE_CUTOFF} AND updated_at < ${now - MID_AGE_MS})
        )
    `)
    scopes = (r as unknown as Array<{ scope: string }>).map(x => x.scope).filter(Boolean)
  } catch {
    return { ok: false, scopesProcessed: 0, keysCompacted: 0, summariesWritten: 0, dryRun }
  }

  const out: CompactionResult = { ok: true, scopesProcessed: 0, keysCompacted: 0, summariesWritten: 0, dryRun, preview: dryRun ? [] : undefined }
  for (const scope of scopes) {
    let candidates: Array<{ key: string; value: string; importance: number; updated_at: number }> = []
    try {
      const r = await db.execute(sql`
        SELECT key, value, importance, updated_at FROM workspace_memory
        WHERE workspace_id = ${workspaceId} AND scope = ${scope}
          AND (
            (importance < ${LOW_IMPORTANCE_CUTOFF} AND updated_at < ${now - LOW_AGE_MS}) OR
            (importance >= ${LOW_IMPORTANCE_CUTOFF} AND importance < ${MID_IMPORTANCE_CUTOFF} AND updated_at < ${now - MID_AGE_MS})
          )
        ORDER BY updated_at ASC
        LIMIT ${MAX_KEYS_PER_SCOPE}
      `)
      candidates = r as unknown as typeof candidates
    } catch { continue }
    if (candidates.length === 0) continue
    out.scopesProcessed++

    if (dryRun) {
      out.preview!.push({
        scope,
        eligibleCount: candidates.length,
        sampleKeys:    candidates.slice(0, 5).map(c => c.key),
      })
      continue
    }

    // Build summary value — concise representation of what we're throwing away.
    const oldestMs = Math.min(...candidates.map(c => Number(c.updated_at)))
    const newestMs = Math.max(...candidates.map(c => Number(c.updated_at)))
    const summary = {
      compactedAt:  now,
      keyCount:     candidates.length,
      oldestKeyAt:  oldestMs,
      newestKeyAt:  newestMs,
      sampleKeys:   candidates.slice(0, 10).map(c => c.key),
      avgImportance: Math.round(candidates.reduce((a, c) => a + Number(c.importance), 0) / candidates.length),
      // Keep short slices of the values so we retain SOME signal (1-line excerpts).
      excerpts:     candidates.slice(0, 20).map(c => {
        const v = String(c.value ?? '').replace(/\s+/g, ' ').slice(0, 200)
        return { key: c.key, excerpt: v }
      }),
    }
    const summaryKey = `compacted.${scope}.${new Date(now).toISOString().slice(0, 7).replace('-', '')}`

    try {
      // Write summary entry at importance 75 so it sticks around but doesn't dominate.
      await db.execute(sql`
        INSERT INTO workspace_memory (workspace_id, key, value, scope, importance, updated_at)
        VALUES (${workspaceId}, ${summaryKey}, ${JSON.stringify(summary)}, ${scope}, 75, ${now})
        ON CONFLICT (workspace_id, key) DO UPDATE SET
          value = EXCLUDED.value,
          updated_at = EXCLUDED.updated_at
      `)
      out.summariesWritten++

      // Delete the originals.
      const keysToDelete = candidates.map(c => c.key)
      await db.execute(sql`
        DELETE FROM workspace_memory
        WHERE workspace_id = ${workspaceId} AND scope = ${scope} AND key = ANY(${keysToDelete}::text[])
      `)
      out.keysCompacted += candidates.length

      // Audit event.
      await db.execute(sql`
        INSERT INTO events (id, type, workspace_id, payload, trace_id, correlation_id, source, version, created_at)
        VALUES (${uuidv7()}, 'memory.compacted', ${workspaceId},
          ${JSON.stringify({ scope, keyCount: candidates.length, summaryKey })}::jsonb,
          ${uuidv7()}, ${uuidv7()}, 'r575-memory-compaction', 1, ${now})
      `).catch(() => {/* tolerated */})
    } catch { /* tolerated, move on to next scope */ }
  }
  return out
}

export async function memoryStats(workspaceId: string): Promise<{ total: number; byScope: Array<{ scope: string; n: number; avgImportance: number; oldestUpdatedAt: number | null }> }> {
  try {
    const r = await db.execute(sql`
      SELECT scope,
             COUNT(*)::int AS n,
             AVG(importance)::float AS avg_imp,
             MIN(updated_at) AS oldest
      FROM workspace_memory
      WHERE workspace_id = ${workspaceId}
      GROUP BY scope
      ORDER BY n DESC
    `)
    const rows = r as unknown as Array<{ scope: string; n: number; avg_imp: number; oldest: number | null }>
    return {
      total:    rows.reduce((a, x) => a + Number(x.n), 0),
      byScope:  rows.map(x => ({
        scope:           x.scope ?? '_root',
        n:               Number(x.n),
        avgImportance:   Math.round(Number(x.avg_imp ?? 0)),
        oldestUpdatedAt: x.oldest === null ? null : Number(x.oldest),
      })),
    }
  } catch { return { total: 0, byScope: [] } }
}
