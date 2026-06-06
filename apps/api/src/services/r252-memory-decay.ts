/**
 * R146.252 — Workspace memory decay sweep.
 *
 * The brain.loop.extractFacts writer (R215) can be enthusiastic; left
 * unbounded, workspace_memory grows monotonically and the memoryDigest
 * pollutes every chat system prompt with stale entries. Decay model:
 *
 *   For each row with importance < 80 (NOT "promoted"):
 *     - if it hasn't been updated/recalled in 7 days, importance -= 5
 *     - if importance drops to ≤ 5, delete it
 *
 * Promoted memories (importance ≥ 80, set explicitly by operator or by
 * extractFacts marking it as a decision/preference) never decay.
 *
 * Runs daily via learning-cron. Idempotent per UTC day — wraps in a
 * single UPDATE per workspace so it can't double-decay even if invoked
 * twice in a tick.
 */
import { db } from '../db/client.js'
import { workspaceMemory } from '../db/schema.js'
import { sql, and, lt } from 'drizzle-orm'

export const DECAY_AGE_MS    = 7 * 24 * 60 * 60_000  // 7 days
export const DECAY_STEP      = 5
export const PROMOTED_FLOOR  = 80
export const PRUNE_THRESHOLD = 5

export interface DecayResult { decayed: number; pruned: number }

export async function runMemoryDecay(): Promise<DecayResult> {
  const now = Date.now()
  const cutoff = now - DECAY_AGE_MS

  // 1. Decay: importance -= DECAY_STEP for stale, non-promoted rows.
  //    Atomic single UPDATE. Sets updatedAt to now so the same row
  //    doesn't decay again until another DECAY_AGE_MS passes.
  const decayed = await db.execute(sql`
    UPDATE workspace_memory
       SET importance = GREATEST(0, importance - ${DECAY_STEP}),
           updated_at = ${now}
     WHERE importance < ${PROMOTED_FLOOR}
       AND updated_at < ${cutoff}
  `).catch(() => ({ rowCount: 0 } as any))
  const decayedCount = Number((decayed as { rowCount?: number }).rowCount ?? 0)

  // 2. Prune anything that fell to <= PRUNE_THRESHOLD.
  const pruned = await db.delete(workspaceMemory)
    .where(and(
      lt(workspaceMemory.importance, PRUNE_THRESHOLD + 1),
    ))
    .catch(() => null)
  const prunedCount = Number((pruned as { rowCount?: number } | null)?.rowCount ?? 0)

  return { decayed: decayedCount, pruned: prunedCount }
}
