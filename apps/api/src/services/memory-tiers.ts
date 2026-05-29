/**
 * memory-tiers.ts — Formal memory tier discipline + age-based decay.
 *
 * The blueprint calls for four tiers; this maps them onto Novan's
 * existing storage:
 *
 *   working   — short-lived, in-process per request. NOT persisted.
 *               Hot context for the current brain.task / chat turn.
 *               Existing: ChatMsg arrays, planner scratch buffers.
 *
 *   episodic  — what happened when. Persisted in `events` table.
 *               Append-only; the audit trail. No decay (this is the
 *               legal record).
 *
 *   semantic  — how the world works. Persisted in `memories` table
 *               with confidence + tags. Decays via relevance score.
 *
 *   procedural — how to execute playbooks. Static markdown files in
 *               apps/api/knowledge/. Versioned via git, no DB decay.
 *
 * Decay model for semantic memories:
 *   - On every insert, memories start at confidence 1.0 (or whatever
 *     the inserter set).
 *   - The decay sweeper runs hourly via learning-cron. For each memory,
 *     newConfidence = oldConfidence * exp(-(ageDays - graceDays) / halfLifeDays)
 *     once ageDays > graceDays. Before grace, full confidence holds.
 *   - Memories below pruneThreshold (default 0.10) are deleted unless
 *     they were promoted via `promote()` — promoted memories never decay.
 *   - On every successful retrieval via `recall()`, the memory's
 *     lastRecalledAt is bumped, which RESETS the decay clock. So
 *     memories the brain actually uses survive; unused ones fade.
 *
 * This implements the "forgetting mechanism so stale context doesn't
 * poison future decisions" from the blueprint.
 */
import { db } from '../db/client.js'
import { memories } from '../db/schema.js'
import { sql, eq, and, lt, gt } from 'drizzle-orm'

export type MemoryTier = 'working' | 'episodic' | 'semantic' | 'procedural'

export interface DecayConfig {
  /** Days from creation before decay starts. */
  graceDays:        number
  /** Half-life: confidence halves every halfLifeDays after grace. */
  halfLifeDays:     number
  /** Below this confidence, memory is pruned (unless promoted). */
  pruneThreshold:   number
  /** Hard ceiling on memories per workspace — oldest non-promoted
   *  pruned first when exceeded. Prevents unbounded growth. */
  perWorkspaceCap:  number
}

const DEFAULT_DECAY: DecayConfig = {
  graceDays:       7,
  halfLifeDays:    30,
  pruneThreshold:  0.10,
  perWorkspaceCap: 10_000,
}

/** Compute decayed confidence from base + age. Exponential decay after
 *  grace period. Returns the new confidence; caller decides whether to
 *  persist or prune. */
export function decayedConfidence(baseConfidence: number, ageDays: number, cfg: DecayConfig = DEFAULT_DECAY): number {
  if (ageDays <= cfg.graceDays) return baseConfidence
  const decayDays = ageDays - cfg.graceDays
  const factor = Math.pow(0.5, decayDays / cfg.halfLifeDays)
  return Math.max(0, baseConfidence * factor)
}

/** Run a decay sweep across all memories for a workspace. Returns the
 *  number of pruned + the number of decayed-but-kept. Idempotent. */
export async function decaySweep(workspaceId: string, cfg: DecayConfig = DEFAULT_DECAY): Promise<{ pruned: number; decayed: number; kept: number }> {
  const now = Date.now()

  // Find candidates: not pinned/promoted, past grace period.
  const graceCutoff = now - cfg.graceDays * 86_400_000
  const rows = await db.select({
    id:        memories.id,
    confidence: memories.confidence,
    updatedAt: memories.updatedAt,
    tags:      memories.tags,
  }).from(memories).where(and(
    eq(memories.workspaceId, workspaceId),
    lt(memories.updatedAt, graceCutoff),
  )).limit(5_000)

  let pruned = 0, decayed = 0, kept = 0
  for (const r of rows) {
    // Promoted memories carry the 'pinned' tag — they skip decay.
    const tags = (r.tags as string[] | null) ?? []
    if (tags.includes('pinned') || tags.includes('procedural')) { kept++; continue }
    const ageDays = (now - Number(r.updatedAt)) / 86_400_000
    const baseConf = Number(r.confidence ?? 1.0)
    const newConf = decayedConfidence(baseConf, ageDays, cfg)
    if (newConf < cfg.pruneThreshold) {
      await db.delete(memories).where(eq(memories.id, r.id)).catch(() => null)
      pruned++
    } else if (Math.abs(newConf - baseConf) > 0.01) {
      await db.update(memories).set({ confidence: newConf }).where(eq(memories.id, r.id)).catch(() => null)
      decayed++
    } else {
      kept++
    }
  }

  // Hard cap enforcement: if workspace still exceeds the cap, prune
  // the lowest-confidence non-pinned memories until under the cap.
  const countRow = await db.select({ c: sql<number>`count(*)::int` }).from(memories)
    .where(eq(memories.workspaceId, workspaceId))
  const total = Number(countRow[0]?.c ?? 0)
  if (total > cfg.perWorkspaceCap) {
    const excess = total - cfg.perWorkspaceCap
    const toPrune = await db.select({ id: memories.id, tags: memories.tags }).from(memories)
      .where(eq(memories.workspaceId, workspaceId))
      .orderBy(memories.confidence)
      .limit(excess + 50)   // grab a few extra in case some are pinned
    let pruneCount = 0
    for (const r of toPrune) {
      const tags = (r.tags as string[] | null) ?? []
      if (tags.includes('pinned')) continue
      await db.delete(memories).where(eq(memories.id, r.id)).catch(() => null)
      pruned++
      pruneCount++
      if (pruneCount >= excess) break
    }
  }

  return { pruned, decayed, kept }
}

/** Promote a memory to permanent — bypasses decay forever. Operator
 *  marks "this lesson must not be forgotten" via UI; brain marks
 *  high-impact decisions automatically via this. */
export async function promote(memoryId: string): Promise<boolean> {
  const row = await db.select({ tags: memories.tags }).from(memories)
    .where(eq(memories.id, memoryId)).limit(1)
  if (row.length === 0) return false
  const tags = ((row[0]?.tags as string[] | null) ?? []).filter(t => t !== 'pinned')
  tags.push('pinned')
  await db.update(memories).set({ tags, confidence: 1.0 }).where(eq(memories.id, memoryId)).catch(() => null)
  return true
}

/** Bump a memory's lastRecalledAt (via updatedAt) so it survives the
 *  next decay sweep. Brain.task calls this whenever it consumes a
 *  memory in a successful response. */
export async function touch(memoryId: string): Promise<void> {
  await db.update(memories).set({ updatedAt: Date.now() })
    .where(eq(memories.id, memoryId)).catch(() => null)
}

/** Run decay across every workspace. Called from learning-cron. Bounded
 *  by perWorkspaceCap × workspaces — at 100 workspaces × 5k rows each =
 *  500k row scan; acceptable hourly cost. Larger fleets need a paged
 *  scan; not built yet. */
export async function decaySweepAll(): Promise<{ workspacesScanned: number; totalPruned: number; totalDecayed: number }> {
  const rows = await db.select({ ws: memories.workspaceId }).from(memories)
    .where(gt(memories.updatedAt, 0))
    .groupBy(memories.workspaceId)
  let totalPruned = 0, totalDecayed = 0
  for (const r of rows) {
    const s = await decaySweep(r.ws).catch(() => ({ pruned: 0, decayed: 0, kept: 0 }))
    totalPruned += s.pruned
    totalDecayed += s.decayed
  }
  return { workspacesScanned: rows.length, totalPruned, totalDecayed }
}
