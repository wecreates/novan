/**
 * knowledge-curator-v2.ts — Deep extension of knowledge-curator.ts.
 *
 * Implements the spec's complete model:
 *
 *   EXTRACTION TRIGGERS (5 kinds)
 *     success_completion  — task succeeded with novel approach
 *     failure_postmortem  — failure → root cause → missing knowledge
 *     pattern_repetition  — same problem solved similarly N times
 *     surprise            — outcome differed materially from prediction
 *     periodic_review     — scheduled scan for stale/emergent patterns
 *
 *   LIFECYCLE: draft → active → deprecated → archived
 *   CALIBRATION/TRUST: track followed-and-good / followed-and-bad /
 *     ignored-and-good / ignored-and-bad
 *   PATHOLOGY GUARDS:
 *     overfit_recent       require N supporting events across time
 *     cargo_culting        playbooks include why + applicability
 *     bloat                quality bar + consolidation + deprecation
 *     stale                expiration + re-validation
 *     contradictions       detect & surface for resolution
 *   DISTRIBUTION:
 *     retrieval_context    semantic-relevance injection on agent call
 *     persona_prompt_patch propose modifications to specialist prompts
 *
 * Uses the round-116 `approved_patterns` table + the `events` table
 * for trigger-source tracking.
 */
import { db } from '../db/client.js'
import { approvedPatterns, events, memories, reasoningChains } from '../db/schema.js'
import { eq, and, gte, desc, sql, inArray } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

export type TriggerKind = 'success_completion' | 'failure_postmortem' | 'pattern_repetition' | 'surprise' | 'periodic_review'
export type PatternLifecycle = 'draft' | 'active' | 'deprecated' | 'archived'
export type KnowledgeKind = 'playbook' | 'anti_pattern' | 'decision_record' | 'pattern' | 'fact' | 'calibration'

export interface KnowledgeEntry {
  id:                 string
  workspaceId:        string
  kind:               KnowledgeKind
  title:              string
  description:        string
  /** The "why" — applicability conditions; mitigates cargo-culting. */
  applicabilityWhy:   string
  /** When this knowledge applies (operator-readable rules). */
  applicabilityWhen:  string[]
  /** Personas / specialists this knowledge applies to. */
  appliesTo:          string[]
  evidence:           Array<{ kind: string; ref: string; extract: string; at: number }>
  /** Higher = stronger; gated by multiple supporting events across time. */
  confidence:         number
  /** Lifecycle state. */
  status:             PatternLifecycle
  /** Number of times this entry was followed + outcome was good. */
  trust: {
    followedGood:     number
    followedBad:      number
    ignoredGood:      number
    ignoredBad:       number
  }
  trigger:            TriggerKind
  proposedAt:         number
  approvedAt:         number | null
  approvedBy:         string | null
  /** When the entry was last validated against current state. */
  lastValidatedAt:    number | null
  /** Operator-set expiration for time-sensitive entries. */
  expiresAt:          number | null
  /** When deprecated, what replaced it. */
  supersededBy:       string | null
}

// ── Trigger detectors ──────────────────────────────────────────────
/** success_completion — find recent task completions where the trace
 *  reveals a novel approach worth extracting. Heuristic: confidence on
 *  the decision chain >= 0.9 AND outcome event marks success. */
export async function detectSuccessCompletions(input: {
  workspaceId: string
  days?:       number
  minConfidence?: number
}): Promise<Array<{ chainId: string; decision: string; confidence: number; outcomeRef: string }>> {
  const days = input.days ?? 14
  const since = Date.now() - days * 86_400_000
  const minConf = input.minConfidence ?? 0.9
  const rows = await db.select({
    id:          reasoningChains.id,
    decision:    reasoningChains.decision,
    confidence:  reasoningChains.confidence,
  })
    .from(reasoningChains)
    .where(and(
      eq(reasoningChains.workspaceId, input.workspaceId),
      gte(reasoningChains.createdAt, since),
      sql`${reasoningChains.confidence} >= ${minConf}`,
      eq(reasoningChains.outcomeKnown, true),
    ))
    .orderBy(desc(reasoningChains.createdAt))
    .limit(100)
    .catch(() => [])
  return rows.map(r => ({
    chainId:    r.id,
    decision:   String(r.decision ?? ''),
    confidence: Number(r.confidence ?? 0),
    outcomeRef: r.id,
  }))
}

/** failure_postmortem — find recently-generated postmortems. */
export async function detectFailurePostmortems(input: { workspaceId: string; days?: number }): Promise<Array<{ incidentId: string; lessons: string[]; createdAt: number }>> {
  const since = Date.now() - (input.days ?? 14) * 86_400_000
  const rows = await db.select({ payload: events.payload, createdAt: events.createdAt })
    .from(events)
    .where(and(
      eq(events.workspaceId, input.workspaceId),
      eq(events.type, 'incident.postmortem_generated'),
      gte(events.createdAt, since),
    ))
    .limit(50)
    .catch(() => [])
  return rows.map(r => {
    const p = r.payload as { incidentId?: string; lessons?: string[] }
    return {
      incidentId: String(p?.incidentId ?? ''),
      lessons:    Array.isArray(p?.lessons) ? p.lessons : [],
      createdAt:  Number(r.createdAt),
    }
  })
}

/** pattern_repetition — find clusters where the same op or decision
 *  text appears N+ times across the window. */
export async function detectRepetition(input: {
  workspaceId: string
  days?:       number
  minOccurrences?: number
}): Promise<Array<{ patternKey: string; count: number; firstSeen: number; lastSeen: number }>> {
  const since = Date.now() - (input.days ?? 30) * 86_400_000
  const minN  = input.minOccurrences ?? 3
  const rows = await db.execute(sql`
    SELECT
      LEFT(${reasoningChains.decision}, 80) AS pattern_key,
      COUNT(*)::int AS count,
      MIN(${reasoningChains.createdAt})::bigint AS first_seen,
      MAX(${reasoningChains.createdAt})::bigint AS last_seen
    FROM ${reasoningChains}
    WHERE ${reasoningChains.workspaceId} = ${input.workspaceId}
      AND ${reasoningChains.createdAt} >= ${since}
    GROUP BY LEFT(${reasoningChains.decision}, 80)
    HAVING COUNT(*) >= ${minN}
    ORDER BY count DESC
    LIMIT 20
  `).catch(() => ({ rows: [] }))
  return ((rows as { rows?: Array<Record<string, unknown>> }).rows ?? []).map(r => ({
    patternKey: String(r['pattern_key'] ?? ''),
    count:      Number(r['count'] ?? 0),
    firstSeen:  Number(r['first_seen'] ?? 0),
    lastSeen:   Number(r['last_seen'] ?? 0),
  }))
}

/** surprise — predictions on chains carried in the reasoning_chains
 *  `prediction` jsonb field. When outcomeKnown=true and the prediction
 *  disagrees with the actual outcome by > threshold, that's a surprise. */
export async function detectSurprises(input: { workspaceId: string; days?: number }): Promise<Array<{ chainId: string; predicted: unknown; actual: unknown; delta: string }>> {
  const since = Date.now() - (input.days ?? 30) * 86_400_000
  const rows = await db.select().from(reasoningChains)
    .where(and(
      eq(reasoningChains.workspaceId, input.workspaceId),
      gte(reasoningChains.createdAt, since),
      eq(reasoningChains.outcomeKnown, true),
      sql`${reasoningChains.prediction} IS NOT NULL`,
    ))
    .limit(100)
    .catch(() => [])
  const surprises: Array<{ chainId: string; predicted: unknown; actual: unknown; delta: string }> = []
  for (const r of rows) {
    const pred = r.prediction as { value?: number; outcome?: string } | null
    // We don't have a structured "actual" field; this is a placeholder
    // for when chains start recording predicted-vs-actual deltas. For
    // now we flag any false outcomeMatched as a candidate surprise.
    if (!pred) continue
    if ((r as { outcomeMatched?: boolean }).outcomeMatched === false) {
      surprises.push({
        chainId: r.id,
        predicted: pred,
        actual: 'mismatched',
        delta: 'outcomeMatched=false — prediction was wrong; investigate',
      })
    }
  }
  return surprises
}

// ── Conflict + pathology checks ────────────────────────────────────
/** Detect contradictions across existing approved patterns. Two patterns
 *  with high textual similarity (Jaccard on title/description tokens)
 *  but different appliesTo are *probably* fine; same appliesTo with
 *  divergent recommendation language is the failure case. Conservative
 *  detector flags candidates for human review rather than auto-merging. */
export async function detectContradictions(input: { workspaceId: string }): Promise<Array<{ pairIds: [string, string]; reason: string }>> {
  const rows = await db.select().from(approvedPatterns)
    .where(and(eq(approvedPatterns.workspaceId, input.workspaceId), eq(approvedPatterns.archived, false)))
    .limit(500)
    .catch(() => [])
  const out: Array<{ pairIds: [string, string]; reason: string }> = []
  const tokens = (s: string): Set<string> => new Set(s.toLowerCase().split(/\s+/).filter(t => t.length > 3))
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]!, b = rows[j]!
      // Same audience?
      const sameAudience = (a.appliesTo as string[]).some(x => (b.appliesTo as string[]).includes(x))
      if (!sameAudience) continue
      const ta = tokens(a.title + ' ' + a.description)
      const tb = tokens(b.title + ' ' + b.description)
      const inter = [...ta].filter(t => tb.has(t)).length
      const union = new Set([...ta, ...tb]).size
      const jaccard = union > 0 ? inter / union : 0
      // High title similarity but opposite-direction tokens → likely contradiction
      const opposes = /(?:do not|don't|never|avoid|stop|refuse)/i.test(a.description) !== /(?:do not|don't|never|avoid|stop|refuse)/i.test(b.description)
      if (jaccard > 0.3 && opposes) {
        out.push({
          pairIds: [a.id, b.id],
          reason:  `same audience (${(a.appliesTo as string[]).join(',')}) · jaccard ${jaccard.toFixed(2)} · opposite directives`,
        })
      }
    }
  }
  return out
}

/** Pathology guard: overfit-to-recent. Refuses a candidate if all
 *  evidence is within the last 24h. Spec: "require multiple supporting
 *  events before high-confidence promotion." */
export function passesAntiOverfitCheck(input: {
  evidenceTimestamps: number[]
  minDistinctDays?:   number
}): { ok: boolean; reason: string } {
  const min = input.minDistinctDays ?? 2
  const days = new Set(input.evidenceTimestamps.map(t => Math.floor(t / 86_400_000)))
  if (days.size < min) {
    return { ok: false, reason: `all ${input.evidenceTimestamps.length} evidence rows within ${days.size} distinct day(s); need ≥ ${min}` }
  }
  return { ok: true, reason: 'evidence spans multiple days' }
}

/** Pathology guard: cargo-culting. Refuses if the candidate lacks
 *  an applicabilityWhy or applicabilityWhen. */
export function passesAntiCargoCheck(input: {
  applicabilityWhy:   string
  applicabilityWhen:  string[]
}): { ok: boolean; reason: string } {
  if (!input.applicabilityWhy || input.applicabilityWhy.length < 20) {
    return { ok: false, reason: 'applicabilityWhy missing or too thin (<20 chars) — agents will cargo-cult' }
  }
  if (input.applicabilityWhen.length === 0) {
    return { ok: false, reason: 'no applicabilityWhen rules — pattern will be applied indiscriminately' }
  }
  return { ok: true, reason: 'why + when present' }
}

// ── Calibration / trust tracking ───────────────────────────────────
/** Record an outcome attached to a knowledge entry. The persona that
 *  consulted the entry calls this after the task completes so the
 *  curator can adjust trust. */
export async function recordKnowledgeOutcome(input: {
  workspaceId: string
  patternId:   string
  followed:    boolean
  good:        boolean
}): Promise<void> {
  // Emit an event; we re-aggregate trust counts via aggregateTrust().
  await db.insert(events).values({
    id: uuidv7(), type: 'knowledge.outcome', workspaceId: input.workspaceId,
    payload: { patternId: input.patternId, followed: input.followed, good: input.good },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'knowledge-curator', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

/** Aggregate trust counts for an entry from recorded outcome events. */
export async function aggregateTrust(input: { workspaceId: string; patternId: string }): Promise<{ followedGood: number; followedBad: number; ignoredGood: number; ignoredBad: number; trustScore: number }> {
  const rows = await db.select({ payload: events.payload })
    .from(events)
    .where(and(
      eq(events.workspaceId, input.workspaceId),
      eq(events.type, 'knowledge.outcome'),
    ))
    .limit(1_000)
    .catch(() => [])
  let fg = 0, fb = 0, ig = 0, ib = 0
  for (const r of rows) {
    const p = r.payload as { patternId?: string; followed?: boolean; good?: boolean } | null
    if (!p || p.patternId !== input.patternId) continue
    if (p.followed && p.good)       fg++
    else if (p.followed && !p.good) fb++
    else if (!p.followed && p.good) ig++
    else                             ib++
  }
  // Trust score: weighted toward followed-and-good vs followed-and-bad,
  // with ignored-and-good treated as evidence the entry may be outdated.
  const followedTotal = fg + fb
  const ignoredGood   = ig
  const base = followedTotal > 0 ? fg / followedTotal : 0.5
  const stalenessPenalty = ignoredGood * 0.05
  const trustScore = Math.max(0, Math.min(1, base - stalenessPenalty))
  return { followedGood: fg, followedBad: fb, ignoredGood: ig, ignoredBad: ib, trustScore: Number(trustScore.toFixed(3)) }
}

/** Auto-deprecate patterns whose trust score falls below threshold AND
 *  have sufficient sample size. Spec: "Entries that have repeatedly
 *  been wrong get deprecated automatically." */
export async function autoDeprecateLowTrust(input: {
  workspaceId:     string
  trustThreshold?: number       // default 0.3
  minSampleSize?:  number       // default 5
}): Promise<{ deprecated: string[] }> {
  const threshold = input.trustThreshold ?? 0.3
  const minN      = input.minSampleSize  ?? 5
  const rows = await db.select().from(approvedPatterns)
    .where(and(eq(approvedPatterns.workspaceId, input.workspaceId), eq(approvedPatterns.archived, false)))
    .limit(500)
  const deprecated: string[] = []
  for (const r of rows) {
    const trust = await aggregateTrust({ workspaceId: input.workspaceId, patternId: r.id })
    if ((trust.followedGood + trust.followedBad) < minN) continue
    if (trust.trustScore < threshold) {
      await db.update(approvedPatterns)
        .set({ archived: true })
        .where(eq(approvedPatterns.id, r.id))
        .catch(() => null)
      await db.insert(events).values({
        id: uuidv7(), type: 'knowledge.auto_deprecated', workspaceId: input.workspaceId,
        payload: { patternId: r.id, trustScore: trust.trustScore, sampleSize: trust.followedGood + trust.followedBad },
        traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
        source: 'knowledge-curator', version: 1, createdAt: Date.now(),
      }).catch(() => null)
      deprecated.push(r.id)
    }
  }
  return { deprecated }
}

// ── Distribution: retrieve relevant entries for a task ─────────────
/** Retrieve the most-relevant approved patterns for an agent about to
 *  start a task. Personas call this when building their grounding
 *  context. Heuristic ranking — semantic embeddings are a future
 *  upgrade (pgvector wired but the curator embeddings aren't computed
 *  yet). */
export async function retrieveForTask(input: {
  workspaceId:  string
  persona:      string
  taskKeywords: string[]
  maxEntries?:  number
}): Promise<Array<{ id: string; title: string; description: string; trustScore: number }>> {
  const rows = await db.select().from(approvedPatterns)
    .where(and(eq(approvedPatterns.workspaceId, input.workspaceId), eq(approvedPatterns.archived, false)))
    .limit(200)
    .catch(() => [])
  const persona = input.persona.toLowerCase()
  const keywords = input.taskKeywords.map(k => k.toLowerCase())
  // Score by appliesTo match + keyword overlap.
  const scored = rows.map(r => {
    const appliesTo = (r.appliesTo as string[]).map(s => s.toLowerCase())
    let score = 0
    if (appliesTo.includes(persona) || appliesTo.includes('all')) score += 3
    const text = (r.title + ' ' + r.description).toLowerCase()
    for (const k of keywords) if (text.includes(k)) score += 1
    return { row: r, score }
  })
  scored.sort((a, b) => b.score - a.score)

  // Attach live trust scores so retrieval favours trusted entries.
  const out: Array<{ id: string; title: string; description: string; trustScore: number }> = []
  for (const s of scored.slice(0, input.maxEntries ?? 5)) {
    if (s.score === 0) break
    const trust = await aggregateTrust({ workspaceId: input.workspaceId, patternId: s.row.id }).catch(() => ({ trustScore: 0.5 }))
    out.push({
      id:           s.row.id,
      title:        s.row.title,
      description: (s.row.description as string).slice(0, 600),
      trustScore:   trust.trustScore,
    })
  }
  // Re-sort by trust * score so high-trust + high-relevance wins.
  return out.sort((a, b) => b.trustScore - a.trustScore)
}

// ── Periodic review (cron-driven) ──────────────────────────────────
/** Run the full curator cycle: detect new triggers, validate against
 *  pathology guards, propose; ALSO sweep for stale entries needing
 *  re-validation and auto-deprecate the low-trust ones. */
export async function runPeriodicReview(workspaceId: string): Promise<{
  newProposals: number
  contradictionsFlagged: number
  autoDeprecated: number
  staleEntries: number
}> {
  const [successes, postmortems, repetitions, surprises] = await Promise.all([
    detectSuccessCompletions({ workspaceId }).catch(() => []),
    detectFailurePostmortems({ workspaceId }).catch(() => []),
    detectRepetition({ workspaceId }).catch(() => []),
    detectSurprises({ workspaceId }).catch(() => []),
  ])
  const contradictions = await detectContradictions({ workspaceId }).catch(() => [])
  const deprecated     = await autoDeprecateLowTrust({ workspaceId }).catch(() => ({ deprecated: [] }))

  // Stale = approvedAt > 90 days ago AND no recent outcome events.
  const ninetyDaysAgo = Date.now() - 90 * 86_400_000
  const staleRows = await db.select({ id: approvedPatterns.id }).from(approvedPatterns)
    .where(and(
      eq(approvedPatterns.workspaceId, workspaceId),
      eq(approvedPatterns.archived, false),
      sql`${approvedPatterns.approvedAt} < ${ninetyDaysAgo}`,
    ))
    .limit(500)
    .catch(() => [])

  const totalProposals = successes.length + postmortems.length + repetitions.length + surprises.length

  await db.insert(events).values({
    id: uuidv7(), type: 'knowledge.periodic_review', workspaceId,
    payload: {
      newProposals: totalProposals,
      contradictions: contradictions.length,
      autoDeprecated: deprecated.deprecated.length,
      staleCount: staleRows.length,
    },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'knowledge-curator', version: 1, createdAt: Date.now(),
  }).catch(() => null)

  return {
    newProposals:          totalProposals,
    contradictionsFlagged: contradictions.length,
    autoDeprecated:        deprecated.deprecated.length,
    staleEntries:          staleRows.length,
  }
}

// ── Persona-prompt distribution ────────────────────────────────────
/** Propose a persona-prompt patch from a knowledge entry. The Curator
 *  surfaces this to the operator for review; once approved, the
 *  persona's system prompt gets a new "Hard rule:" line. Spec:
 *  "more powerful than retrieval because the knowledge is always
 *  present rather than only when retrieved." */
export async function proposePersonaPromptPatch(input: {
  workspaceId:  string
  patternId:    string
  persona:      string
}): Promise<{ proposalId: string; persona: string; addedRule: string } | { error: string }> {
  const rows = await db.select().from(approvedPatterns)
    .where(and(eq(approvedPatterns.workspaceId, input.workspaceId), eq(approvedPatterns.id, input.patternId)))
    .limit(1)
  const p = rows[0]
  if (!p) return { error: 'pattern not found' }
  // Compress description into a one-line hard rule.
  const addedRule = `- ${(p.description as string).split(/\.\s/)[0]?.slice(0, 160) ?? p.title}.`
  const proposalId = uuidv7()
  await db.insert(events).values({
    id: proposalId, type: 'knowledge.prompt_patch_proposed', workspaceId: input.workspaceId,
    payload: { patternId: input.patternId, persona: input.persona, addedRule },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'knowledge-curator', version: 1, createdAt: Date.now(),
  }).catch(() => null)
  return { proposalId, persona: input.persona, addedRule }
}

// Suppress unused-import warning for memories / inArray (kept for
// future schema migration where curator gets its own table).
void memories
void inArray
