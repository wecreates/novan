/**
 * intelligence-dedup.ts — Cross-entity duplicate detection.
 *
 * Suggests merges; never auto-merges. Operator approves via API.
 *
 * Similarity = Jaccard over normalised tokens (title or summary).
 * Threshold 0.7 — high-precision, low-recall by design (false merges
 * are worse than missing dupes).
 */
import { db }                          from '../db/client.js'
import {
  duplicateMergeLog, incidents, researchFindings,
  strategicGoals, skills as skillsTable,
} from '../db/schema.js'
import { and, desc, eq, sql }          from 'drizzle-orm'
import { v7 as uuidv7 }                from 'uuid'

const SIMILARITY_THRESHOLD = 0.7

function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3),
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  const inter = new Set([...a].filter(x => b.has(x)))
  const union = new Set([...a, ...b])
  return inter.size / union.size
}

export interface DupSuggestion {
  entityType: 'incident' | 'research_finding' | 'mission' | 'skill'
  primaryId:  string
  duplicateId: string
  similarity: number
  reason:     string
}

async function recordSuggestion(workspaceId: string, s: DupSuggestion): Promise<void> {
  // Idempotency: skip if pair already logged in either direction
  const existing = await db.select({ id: duplicateMergeLog.id }).from(duplicateMergeLog)
    .where(and(
      eq(duplicateMergeLog.workspaceId, workspaceId),
      eq(duplicateMergeLog.entityType, s.entityType),
      sql`(${duplicateMergeLog.primaryId} = ${s.primaryId} AND ${duplicateMergeLog.duplicateId} = ${s.duplicateId})
         OR (${duplicateMergeLog.primaryId} = ${s.duplicateId} AND ${duplicateMergeLog.duplicateId} = ${s.primaryId})`,
    ))
    .limit(1).then(r => r[0]).catch(() => null)
  if (existing) return
  await db.insert(duplicateMergeLog).values({
    id: uuidv7(), workspaceId,
    entityType: s.entityType, primaryId: s.primaryId, duplicateId: s.duplicateId,
    similarity: s.similarity, reason: s.reason,
    status: 'suggested',
    createdAt: Date.now(),
  }).catch(() => null)
}

async function pairwiseScan<T extends { id: string }>(
  rows: T[], text: (r: T) => string,
): Promise<Array<{ a: T; b: T; similarity: number; reason: string }>> {
  const out: Array<{ a: T; b: T; similarity: number; reason: string }> = []
  // Pre-tokenize once
  const tokens = rows.map(r => tokenize(text(r)))
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const sim = jaccard(tokens[i]!, tokens[j]!)
      if (sim >= SIMILARITY_THRESHOLD) {
        out.push({ a: rows[i]!, b: rows[j]!, similarity: Number(sim.toFixed(3)),
          reason: `Jaccard ${sim.toFixed(2)} on normalised tokens` })
      }
    }
  }
  return out
}

export interface DedupResult {
  workspaceId:  string
  suggestions: { incidents: number; research: number; missions: number; skills: number }
}

export async function detectDuplicates(workspaceId: string): Promise<DedupResult> {
  const [incs, rf, miss, sk] = await Promise.all([
    db.select().from(incidents).where(eq(incidents.workspaceId, workspaceId)).limit(200).catch(() => []),
    db.select().from(researchFindings).where(eq(researchFindings.workspaceId, workspaceId)).limit(200).catch(() => []),
    db.select().from(strategicGoals).where(eq(strategicGoals.workspaceId, workspaceId)).limit(200).catch(() => []),
    db.select().from(skillsTable).where(eq(skillsTable.workspaceId, workspaceId)).limit(200).catch(() => []),
  ])

  const result: DedupResult = {
    workspaceId,
    suggestions: { incidents: 0, research: 0, missions: 0, skills: 0 },
  }

  for (const p of await pairwiseScan(incs, r => `${r.title ?? ''} ${r.summary ?? ''}`)) {
    await recordSuggestion(workspaceId, {
      entityType: 'incident', primaryId: p.a.id, duplicateId: p.b.id,
      similarity: p.similarity, reason: p.reason,
    })
    result.suggestions.incidents++
  }
  // Research already deduped by contentHash at insert time — only flag
  // when summary text is similar across different hashes (paraphrased content)
  for (const p of await pairwiseScan(rf, r => `${r.sourceTitle ?? ''} ${r.summary ?? ''}`)) {
    if (p.a.contentHash === p.b.contentHash) continue
    await recordSuggestion(workspaceId, {
      entityType: 'research_finding', primaryId: p.a.id, duplicateId: p.b.id,
      similarity: p.similarity, reason: p.reason,
    })
    result.suggestions.research++
  }
  for (const p of await pairwiseScan(miss, r => `${r.title ?? ''} ${r.description ?? ''}`)) {
    await recordSuggestion(workspaceId, {
      entityType: 'mission', primaryId: p.a.id, duplicateId: p.b.id,
      similarity: p.similarity, reason: p.reason,
    })
    result.suggestions.missions++
  }
  for (const p of await pairwiseScan(sk, r => `${r.name ?? ''} ${r.purpose ?? ''}`)) {
    await recordSuggestion(workspaceId, {
      entityType: 'skill', primaryId: p.a.id, duplicateId: p.b.id,
      similarity: p.similarity, reason: p.reason,
    })
    result.suggestions.skills++
  }

  return result
}

export async function listSuggestions(workspaceId: string, status: 'suggested' | 'merged' | 'dismissed' = 'suggested') {
  return db.select().from(duplicateMergeLog)
    .where(and(eq(duplicateMergeLog.workspaceId, workspaceId), eq(duplicateMergeLog.status, status)))
    .orderBy(desc(duplicateMergeLog.similarity))
    .limit(100).catch(() => [])
}

export async function decideSuggestion(workspaceId: string, id: string, decision: 'merged' | 'dismissed', actor: string): Promise<{ ok: boolean }> {
  await db.update(duplicateMergeLog).set({
    status: decision, decidedBy: actor, decidedAt: Date.now(),
  }).where(and(eq(duplicateMergeLog.workspaceId, workspaceId), eq(duplicateMergeLog.id, id)))
    .catch(() => null)
  return { ok: true }
}
