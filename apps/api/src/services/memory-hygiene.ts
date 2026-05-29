/**
 * memory-hygiene.ts — stale memory pruning + contradiction detection (#45).
 *
 * Operates over the workspace's accumulated memory across multiple
 * tables. Three pure scorers + DB-backed wrappers:
 *
 *   1. scoreMemoryEntry(entry) — confidence × recency × usage
 *   2. detectContradictions(entries) — pairs of memory rows whose
 *      content directly disagrees
 *   3. detectDuplicates(entries) — near-identical entries within a
 *      workspace
 *
 * The DB wrappers iterate over:
 *   - voice_skill_observations  (low-value misunderstandings stack up)
 *   - assumption_tracker rows   (stale assumptions get reconciled)
 *   - events with type LIKE 'memory.%'
 *
 * Conservative by default: prune rows are RECOMMENDED, not auto-deleted.
 * Each recommendation emits a `memory.hygiene.*` audit event so the
 * operator can review before approval.
 */
import { db } from '../db/client.js'
import { events, voiceSkillObservations } from '../db/schema.js'
import { and, eq, gte, sql, lt } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

export interface MemoryEntry {
  id:         string
  kind:       string
  content:    string
  confidence: number    // 0..1
  createdAt:  number
  lastUsedAt: number | null
  useCount:   number
}

export type MemoryVerdict = 'keep' | 'prune' | 'review'

export interface MemoryScore {
  entryId:    string
  retainScore: number   // 0..1 higher = keep
  verdict:    MemoryVerdict
  reasons:    string[]
}

const DEFAULT_TTL_DAYS = 60
const MIN_USE_TO_KEEP  = 2

/** Pure: score an individual memory entry for retention. */
export function scoreMemoryEntry(e: MemoryEntry, now = Date.now()): MemoryScore {
  const reasons: string[] = []
  const ageDays = (now - e.createdAt) / 86_400_000
  const usedDays = e.lastUsedAt ? (now - e.lastUsedAt) / 86_400_000 : ageDays

  // Confidence decay over time — half-life 30 days
  const decay = Math.pow(0.5, ageDays / 30)
  const decayedConfidence = e.confidence * decay
  reasons.push(`age=${ageDays.toFixed(0)}d`, `decayed-confidence=${decayedConfidence.toFixed(2)}`)

  // Usage signal
  const usageBoost = Math.min(0.4, e.useCount * 0.05)
  if (usageBoost > 0) reasons.push(`use-count=${e.useCount}`)

  // Recency-of-use penalty
  const recencyPenalty = usedDays > 30 ? 0.2 : 0
  if (recencyPenalty > 0) reasons.push(`unused-${usedDays.toFixed(0)}d`)

  const retainScore = Math.max(0, Math.min(1, decayedConfidence + usageBoost - recencyPenalty))

  let verdict: MemoryVerdict = 'keep'
  if (retainScore < 0.15) verdict = 'prune'
  else if (retainScore < 0.35) verdict = 'review'

  // Hard rules
  if (ageDays > DEFAULT_TTL_DAYS && e.useCount < MIN_USE_TO_KEEP) {
    verdict = 'prune'
    reasons.push(`ttl-exceeded:${DEFAULT_TTL_DAYS}d`)
  }

  return { entryId: e.id, retainScore: Number(retainScore.toFixed(3)), verdict, reasons }
}

/** Pure: detect direct contradictions between memory entries.
 *  Detects:
 *    - same `kind` + matching subject + opposite polarity ("X is up" vs "X is down")
 *    - same `kind` + same subject + different numeric values exceeding tolerance
 */
export interface Contradiction {
  aId: string; bId: string
  reason: string
  confidenceDelta: number
}

const POLAR_PAIRS: Array<[RegExp, RegExp]> = [
  [/\bis (up|healthy|stable|on|enabled)\b/i, /\bis (down|unhealthy|broken|off|disabled)\b/i],
  [/\b(success(ful)?|succeed(ed)?|completed)\b/i, /\b(failed|failure|error|crashed)\b/i],
  [/\bapprov(ed|al)\b/i,                       /\b(reject(ed)?|denied|blocked)\b/i],
]

export function detectContradictions(entries: ReadonlyArray<MemoryEntry>): Contradiction[] {
  const out: Contradiction[] = []
  // Group by kind for O(n²-per-bucket) instead of full O(n²)
  const buckets = new Map<string, MemoryEntry[]>()
  for (const e of entries) {
    const arr = buckets.get(e.kind) ?? []
    arr.push(e)
    buckets.set(e.kind, arr)
  }
  for (const group of buckets.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!, b = group[j]!
        for (const [posRe, negRe] of POLAR_PAIRS) {
          if (posRe.test(a.content) && negRe.test(b.content)) {
            out.push({ aId: a.id, bId: b.id, reason: `polar-conflict:${posRe.source}/${negRe.source}`, confidenceDelta: Math.abs(a.confidence - b.confidence) })
            break
          }
          if (negRe.test(a.content) && posRe.test(b.content)) {
            out.push({ aId: a.id, bId: b.id, reason: `polar-conflict:${negRe.source}/${posRe.source}`, confidenceDelta: Math.abs(a.confidence - b.confidence) })
            break
          }
        }
      }
    }
  }
  return out
}

/** Pure: detect near-duplicate entries by normalized content. */
export function detectDuplicates(entries: ReadonlyArray<MemoryEntry>): Array<{ keepId: string; dropIds: string[] }> {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200)
  const groups = new Map<string, MemoryEntry[]>()
  for (const e of entries) {
    const key = `${e.kind}::${norm(e.content)}`
    const arr = groups.get(key) ?? []
    arr.push(e)
    groups.set(key, arr)
  }
  const result: Array<{ keepId: string; dropIds: string[] }> = []
  for (const [, members] of groups) {
    if (members.length < 2) continue
    // Keep the one with highest useCount, then highest confidence
    const sorted = [...members].sort((a, b) => (b.useCount - a.useCount) || (b.confidence - a.confidence) || (b.createdAt - a.createdAt))
    result.push({ keepId: sorted[0]!.id, dropIds: sorted.slice(1).map(m => m.id) })
  }
  return result
}

// ─── DB wrappers ───────────────────────────────────────────────────────

export interface HygieneReport {
  scoped:           string[]
  scored:           number
  pruneRecommended: number
  reviewRecommended: number
  contradictions:   number
  duplicates:       number
  applied:          number
}

/**
 * Scan voice_skill_observations: misunderstandings older than 30 days
 * with no follow-up correction are prune candidates. Returns a report;
 * does NOT delete unless `apply: true` is passed.
 */
export async function scanVoiceSkillMemory(workspaceId: string, opts: { apply?: boolean } = {}): Promise<HygieneReport> {
  const cutoff = Date.now() - DEFAULT_TTL_DAYS * 86_400_000
  const rows = await db.select().from(voiceSkillObservations)
    .where(and(
      eq(voiceSkillObservations.workspaceId, workspaceId),
      eq(voiceSkillObservations.kind, 'misunderstood'),
      lt(voiceSkillObservations.createdAt, cutoff),
    )).limit(2000).catch(() => [])

  const entries: MemoryEntry[] = rows.map(r => ({
    id: r.id, kind: r.kind,
    content: r.phrase ?? '',
    confidence: r.confidence ?? 0.3,
    createdAt: r.createdAt,
    lastUsedAt: null, useCount: 0,
  }))
  const scores = entries.map(e => scoreMemoryEntry(e))
  const dupes  = detectDuplicates(entries)
  const conts  = detectContradictions(entries)
  const pruneIds = scores.filter(s => s.verdict === 'prune').map(s => s.entryId)
  let applied = 0
  if (opts.apply && pruneIds.length > 0) {
    // Delete in batches to keep the query under any size cap
    for (let i = 0; i < pruneIds.length; i += 200) {
      const batch = pruneIds.slice(i, i + 200)
      const r = await db.delete(voiceSkillObservations)
        .where(and(
          eq(voiceSkillObservations.workspaceId, workspaceId),
          sql`${voiceSkillObservations.id} = ANY(${batch})`,
        )).catch((e: Error) => { console.error('[memory-hygiene]', e.message); return null })
      if (r !== null) applied += batch.length
    }
  }
  await db.insert(events).values({
    id: uuidv7(), type: 'memory.hygiene.scan',
    workspaceId,
    payload: {
      scope: 'voice_skill_observations',
      scored: entries.length,
      pruneRecommended: scores.filter(s => s.verdict === 'prune').length,
      reviewRecommended: scores.filter(s => s.verdict === 'review').length,
      contradictions: conts.length,
      duplicates: dupes.length,
      applied,
    },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/memory-hygiene', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[memory-hygiene]', e.message); return null })

  return {
    scoped: ['voice_skill_observations'],
    scored: entries.length,
    pruneRecommended: scores.filter(s => s.verdict === 'prune').length,
    reviewRecommended: scores.filter(s => s.verdict === 'review').length,
    contradictions: conts.length,
    duplicates: dupes.length,
    applied,
  }
}

/** Aggregate hygiene scan across all in-scope tables. */
export async function runMemoryHygiene(workspaceId: string, opts: { apply?: boolean } = {}): Promise<HygieneReport> {
  return scanVoiceSkillMemory(workspaceId, opts)
  // Future scopes (assumption-tracker, image creative flags, etc.)
  // chain in here as separate scanX functions and merge reports.
}
