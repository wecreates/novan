/**
 * Memory intelligence engine — stale detection and insight generation.
 *
 * Called periodically by the 'analyze-memories' job handler.
 */
import { eq, and, lt, gt, isNotNull } from 'drizzle-orm'
import type { createDb } from '@ops/db'
import { memories, insights }     from '@ops/db'
import { v7 as uuidv7 }                     from 'uuid'

// ─── DB instance (shared with worker via singleton pattern) ───────────────────

let _db: ReturnType<typeof createDb> | null = null

export function setDb(db: ReturnType<typeof createDb>): void {
  _db = db
}

function getDb(): ReturnType<typeof createDb> {
  if (!_db) throw new Error('intelligence: db not initialised — call setDb() first')
  return _db
}

// ─── Stale detection ──────────────────────────────────────────────────────────

export interface StaleResult {
  expiredIds:     string[]
  lowConfIds:     string[]
  totalMarked:    number
}

/**
 * Detect stale memories without mutating schema.
 * Returns IDs of memories that are expired or low-confidence + old.
 * - expiresAt is set and < now
 * - confidence < 0.3 AND created > 30 days ago
 */
export async function detectStaleMemories(workspaceId: string): Promise<StaleResult> {
  const db             = getDb()
  const now            = Date.now()
  const thirtyDaysAgo  = now - 30 * 24 * 60 * 60 * 1_000

  const [expiredRows, lowConfRows] = await Promise.all([
    // Expired by expiresAt
    db.select({ id: memories.id })
      .from(memories)
      .where(
        and(
          eq(memories.workspaceId, workspaceId),
          isNotNull(memories.expiresAt),
          lt(memories.expiresAt, now),
        ),
      ),

    // Low confidence + old
    db.select({ id: memories.id })
      .from(memories)
      .where(
        and(
          eq(memories.workspaceId, workspaceId),
          lt(memories.confidence, 0.3),
          lt(memories.createdAt, thirtyDaysAgo),
        ),
      ),
  ])

  const expiredIds  = expiredRows.map((r) => r.id)
  const lowConfIds  = lowConfRows.map((r) => r.id)
  const totalMarked = expiredIds.length + lowConfIds.length

  return { expiredIds, lowConfIds, totalMarked }
}

// ─── Insight generation ───────────────────────────────────────────────────────

export interface InsightResult {
  analyzed:  number
  created:   number
  skipped:   number
}

/**
 * Analyse memory patterns and surface actionable insights.
 * Deduplicates against insights already created in the last 7 days.
 *
 * Checks:
 *   - High proportion of low-confidence memories (>40%)
 *   - No new memories in the last 7 days (drought)
 *   - High memory activity spike (>50 new in 7 days)
 *   - Dominant single memory type (>60% of total)
 *   - High stale ratio from expiresAt (>20%)
 */
export async function generateMemoryInsights(workspaceId: string): Promise<InsightResult> {
  const db           = getDb()
  const now          = Date.now()
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1_000

  const allMems = await db
    .select({
      type:      memories.type,
      confidence: memories.confidence,
      createdAt:  memories.createdAt,
      expiresAt:  memories.expiresAt,
    })
    .from(memories)
    .where(eq(memories.workspaceId, workspaceId))
    .limit(1_000)

  if (allMems.length === 0) return { analyzed: 0, created: 0, skipped: 0 }

  // Aggregate metrics
  const byType: Record<string, number> = {}
  let lowConfCount  = 0
  let recentCount   = 0
  let expiredCount  = 0

  for (const m of allMems) {
    byType[m.type] = (byType[m.type] ?? 0) + 1
    if (m.confidence < 0.5) lowConfCount++
    if (m.createdAt > sevenDaysAgo) recentCount++
    if (m.expiresAt !== null && m.expiresAt < now) expiredCount++
  }

  const total         = allMems.length
  const lowConfRatio  = lowConfCount / total
  const expiredRatio  = expiredCount / total

  const candidates: Array<{ title: string; body: string; category: string; confidence: number }> = []

  // ── Rule 1: high low-confidence ratio ──────────────────────────────────────
  if (lowConfRatio > 0.4) {
    candidates.push({
      title:      'High proportion of low-confidence memories',
      body:       `${Math.round(lowConfRatio * 100)}% of your ${total} memories have confidence below 50%. ` +
                  'Consider reviewing and updating key memories to improve decision quality.',
      category:   'memory',
      confidence: 0.85,
    })
  }

  // ── Rule 2: memory drought ──────────────────────────────────────────────────
  if (recentCount === 0 && total > 10) {
    candidates.push({
      title:      'No new memories in the last 7 days',
      body:       'The system has not recorded any new memories in the past week. ' +
                  'This may indicate reduced activity or a gap in observation coverage.',
      category:   'operational',
      confidence: 0.9,
    })
  }

  // ── Rule 3: activity spike ──────────────────────────────────────────────────
  if (recentCount > 50) {
    candidates.push({
      title:      'High memory activity this week',
      body:       `${recentCount} new memories recorded in the last 7 days. ` +
                  'This indicates elevated system activity that may warrant review.',
      category:   'operational',
      confidence: 0.8,
    })
  }

  // ── Rule 4: dominant memory type ───────────────────────────────────────────
  const dominantEntry = Object.entries(byType).sort((a, b) => b[1] - a[1])[0]
  if (dominantEntry && dominantEntry[1] / total > 0.6) {
    candidates.push({
      title:      `Memory heavily concentrated in '${dominantEntry[0]}' type`,
      body:       `${Math.round((dominantEntry[1] / total) * 100)}% of memories are of type '${dominantEntry[0]}'. ` +
                  'Diverse memory types improve decision coverage.',
      category:   'memory',
      confidence: 0.75,
    })
  }

  // ── Rule 5: high expired ratio ─────────────────────────────────────────────
  if (expiredRatio > 0.2) {
    candidates.push({
      title:      'Large number of expired memories not yet cleaned up',
      body:       `${Math.round(expiredRatio * 100)}% of memories (${expiredCount} of ${total}) have passed their ` +
                  'expiry date. Running a cleanup job will improve search quality.',
      category:   'memory',
      confidence: 0.88,
    })
  }

  if (candidates.length === 0) return { analyzed: total, created: 0, skipped: 0 }

  // Deduplicate against recent insights
  const recentInsights = await db
    .select({ title: insights.title })
    .from(insights)
    .where(
      and(
        eq(insights.workspaceId, workspaceId),
        gt(insights.createdAt, sevenDaysAgo),
      ),
    )
    .limit(100)

  const existingTitles = new Set(recentInsights.map((i) => i.title))

  let created = 0
  let skipped = 0

  for (const ins of candidates) {
    if (existingTitles.has(ins.title)) { skipped++; continue }

    await db.insert(insights).values({
      id:          uuidv7(),
      workspaceId,
      title:       ins.title,
      body:        ins.body,
      category:    ins.category,
      confidence:  ins.confidence,
      source:      'memory-worker',
      sourceRef:   null,
      tags:        ['auto-generated', 'memory-analysis'],
      dismissed:   false,
      actedOn:     false,
      expiresAt:   now + 7 * 24 * 60 * 60 * 1_000, // insights expire after 7 days
      createdAt:   now,
    })
    created++
  }

  return { analyzed: total, created, skipped }
}
