/**
 * prompt-evolution.ts — Versioned prompts the brain rotates through.
 *
 * Every routine LLM call (script-draft, thumbnail-prompt, comment-reply,
 * etsy-listing-description, …) goes through `usePrompt(workspaceId, slot)`.
 * The function returns the highest-scoring enabled version's body — that's
 * the prompt the LLM gets called with.
 *
 * After the call's downstream signal is known (CTR for a thumbnail prompt,
 * watch-through for a script prompt, sales-per-listing for a listing
 * description), `recordOutcome(promptId, score)` updates the rolling
 * aggregates.
 *
 * Mutation happens in `evolvePrompt(workspaceId, slot)`:
 *   1. Identify the lowest-scoring enabled version
 *   2. If it has > 30 uses and its score is below the slot median, mark
 *      `enabled = false` (retired)
 *   3. If the slot has < 4 active versions, ask the LLM to generate a
 *      variant of the current winner with one targeted change
 *      ("shorter hook", "stronger emotional opener", etc.)
 *   4. Insert the new version with `origin = 'auto_mutation'`
 *
 * The cron tick (`learning-cron`'s portfolio review) calls evolvePrompt
 * weekly per slot. Operator can also call it via `prompt.evolve`.
 *
 * Honest scope: this won't auto-discover entirely novel approaches —
 * mutations are conservative variations of existing winners. The brain
 * needs the operator (or the LLM's own brainstorming op) to introduce
 * fundamentally different prompt styles. What this DOES achieve:
 * stable upward drift on routine work, automatic retirement of dead
 * patterns, full audit trail of why prompt-X-v3 exists.
 */
import { v7 as uuidv7 }                  from 'uuid'
import { and, eq, sql as drizzleSql, desc, gte } from 'drizzle-orm'
import { db }                            from '../db/client.js'
import { businessPrompts, events }       from '../db/schema.js'

// ─── Selection ──────────────────────────────────────────────────────────────

export interface PromptHandle {
  id:       string
  slot:     string
  version:  number
  body:     string
  uses:     number
  avgScore: number | null
}

/** Pick the active prompt for (workspaceId, slot). Returns null if no
 *  version exists yet — callers should fall back to a hardcoded prompt
 *  and then call `seedPrompt` to persist it for future scoring. */
export async function usePrompt(workspaceId: string, slot: string): Promise<PromptHandle | null> {
  // ε-greedy exploration: 10% of calls pick a random non-best version
  // so under-explored prompts get usage data. The other 90% pick the
  // best mean-score. Without exploration, a slightly-lucky seed prompt
  // dominates forever and the slot never improves.
  const rows = await db.select().from(businessPrompts)
    .where(and(
      eq(businessPrompts.workspaceId, workspaceId),
      eq(businessPrompts.slot, slot),
      eq(businessPrompts.enabled, true),
    ))
    .orderBy(desc(businessPrompts.uses))
  if (rows.length === 0) return null

  const explore = Math.random() < 0.10 && rows.length >= 2
  const picked = explore
    ? (rows[Math.floor(Math.random() * rows.length)] ?? rows[0]!)
    : pickBestByMeanScore(rows)
  if (!picked) return null

  // Bump usage atomically — increment uses + set lastUsedAt
  await db.update(businessPrompts).set({
    uses:       picked.uses + 1,
    lastUsedAt: Date.now(),
    updatedAt:  Date.now(),
  }).where(eq(businessPrompts.id, picked.id))

  return {
    id: picked.id, slot: picked.slot, version: picked.version, body: picked.body,
    uses: picked.uses + 1,
    avgScore: picked.uses > 0 ? picked.scoreSum / picked.uses : null,
  }
}

function pickBestByMeanScore<T extends typeof businessPrompts.$inferSelect>(rows: T[]): T | null {
  if (rows.length === 0) return null
  // Use Wilson lower bound on mean+uses for stability — a prompt with
  // 50 uses at mean 0.7 should beat one with 2 uses at mean 0.9.
  let best: T | null = null
  let bestKey = -Infinity
  for (const r of rows) {
    const mean = r.uses > 0 ? r.scoreSum / r.uses : 0
    // Penalize low-use rows so they don't dominate by lucky-mean.
    const key = r.uses === 0 ? 0 : mean - (1.0 / Math.sqrt(r.uses + 1))
    if (key > bestKey) { bestKey = key; best = r }
  }
  return best
}

// ─── Recording outcomes ─────────────────────────────────────────────────────

/** Record an outcome for a prompt use. Score is 0..1 (higher = better).
 *  The caller decides what 1.0 means for their slot — for a thumbnail-prompt
 *  this is CTR vs the slot's median, for a script-prompt it's AVD%. */
export async function recordOutcome(promptId: string, score: number): Promise<void> {
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    console.warn(`[prompt-evolution] recordOutcome: out-of-range score ${score} for ${promptId}`)
    return
  }
  // Atomic accumulator update — score_sum += score, last_score = score
  await db.update(businessPrompts).set({
    scoreSum:  drizzleSql`${businessPrompts.scoreSum} + ${score}`,
    lastScore: score,
    updatedAt: Date.now(),
  }).where(eq(businessPrompts.id, promptId))
}

// ─── Seeding ────────────────────────────────────────────────────────────────

export interface SeedPromptInput {
  workspaceId: string
  slot:        string
  body:        string
  origin?:     'seed' | 'manual_edit' | 'auto_mutation' | 'auto_promotion'
  parentId?:   string
}

/** Insert a new prompt version. Auto-assigns the next version number. */
export async function seedPrompt(input: SeedPromptInput): Promise<{ id: string; version: number }> {
  const [latest] = await db.select({ v: drizzleSql<number>`COALESCE(MAX(${businessPrompts.version}), 0)::int` })
    .from(businessPrompts)
    .where(and(
      eq(businessPrompts.workspaceId, input.workspaceId),
      eq(businessPrompts.slot, input.slot),
    ))
  const next = (latest?.v ?? 0) + 1
  const id = uuidv7()
  const now = Date.now()
  const row: typeof businessPrompts.$inferInsert = {
    id,
    workspaceId: input.workspaceId,
    slot:        input.slot,
    version:     next,
    body:        input.body,
    origin:      input.origin ?? 'seed',
    createdAt:   now,
    updatedAt:   now,
  }
  if (input.parentId !== undefined) row.parentId = input.parentId
  await db.insert(businessPrompts).values(row)
  return { id, version: next }
}

// ─── Evolution ──────────────────────────────────────────────────────────────

const MUTATION_DIRECTIVES = [
  'Make the hook shorter and more visceral',
  'Add a concrete number or specific claim early',
  'Strengthen the emotional appeal in the first sentence',
  'Replace abstract nouns with action verbs',
  'Trim wordiness; keep the same intent in 60% of the original length',
  'Add a comparison or contrast that creates a curiosity gap',
  'Shift from third-person to second-person ("you")',
  'Add one sensory detail to make it more vivid',
]

/** Identify retired/promoted candidates + ask the LLM for one new variant
 *  of the slot's current winner. Idempotent across short windows: the
 *  function is safe to call repeatedly but bails out if the slot was
 *  evolved in the last 24h. */
export async function evolvePrompt(workspaceId: string, slot: string): Promise<{
  retired:  number
  added:    { id: string; version: number; directive: string } | null
  reason:   string
}> {
  const dayAgo = Date.now() - 86_400_000
  const recentMutations = await db.select({ id: businessPrompts.id }).from(businessPrompts)
    .where(and(
      eq(businessPrompts.workspaceId, workspaceId),
      eq(businessPrompts.slot, slot),
      eq(businessPrompts.origin, 'auto_mutation'),
      gte(businessPrompts.createdAt, dayAgo),
    ))
    .limit(1)
  if (recentMutations.length > 0) {
    return { retired: 0, added: null, reason: 'already mutated within 24h' }
  }

  const active = await db.select().from(businessPrompts)
    .where(and(
      eq(businessPrompts.workspaceId, workspaceId),
      eq(businessPrompts.slot, slot),
      eq(businessPrompts.enabled, true),
    ))
  if (active.length === 0) {
    return { retired: 0, added: null, reason: 'no active versions to evolve from' }
  }

  // 1) retire under-performers — must have ≥ 30 uses AND mean < slot median
  let retired = 0
  if (active.length >= 4) {
    const means = active.map(r => ({ id: r.id, uses: r.uses, mean: r.uses > 0 ? r.scoreSum / r.uses : 0 }))
    means.sort((a, b) => a.mean - b.mean)
    const median = means[Math.floor(means.length / 2)]?.mean ?? 0
    for (const m of means.slice(0, 1)) {
      if (m.uses >= 30 && m.mean < median * 0.85) {
        await db.update(businessPrompts).set({ enabled: false, updatedAt: Date.now() })
          .where(eq(businessPrompts.id, m.id))
        retired++
      }
    }
  }

  // 2) mutate the winner — only if active count is below cap (4)
  const winner = pickBestByMeanScore(active)
  if (!winner) return { retired, added: null, reason: 'no winner identifiable' }
  if (active.length >= 4) {
    return { retired, added: null, reason: 'slot at capacity (4 active versions) — retire one first' }
  }

  const directive = MUTATION_DIRECTIVES[Math.floor(Math.random() * MUTATION_DIRECTIVES.length)] ?? MUTATION_DIRECTIVES[0]!

  // Call the LLM to mutate. Lazy import so worker / API processes that
  // don't need this dependency don't pay the load cost at boot.
  // Cost is recorded to ai_usage — without this, the 6h evolution cron
  // (N workspaces × ~3 slots = potentially 30+ LLM calls/day) was
  // invisible to budget-guard.
  let mutated = ''
  let final = { tokens: 0, costUsd: 0, provider: 'none', model: 'none' }
  const t0 = Date.now()
  try {
    const { streamChat } = await import('./chat-providers.js')
    const stream = streamChat(workspaceId, [
      {
        role: 'system',
        content: 'You are a prompt-engineering assistant. Given an existing prompt and one targeted edit directive, return ONLY the rewritten prompt — no preamble, no explanation, no markdown fence. Preserve the original\'s intent and structure; apply the directive minimally.',
      },
      {
        role: 'user',
        content: `Original prompt for slot "${slot}":\n\n${winner.body}\n\nDirective: ${directive}\n\nReturn only the rewritten prompt.`,
      },
    ], { skipUsageTracking: true })   // R146.10 — caller records its own ai_usage row below
    let next: IteratorResult<{ delta: string; done: boolean }, typeof final>
    while (!(next = await stream.next()).done) {
      if (next.value.delta) mutated += next.value.delta
    }
    final = next.value
    const { recordAiUsage } = await import('./ai-cost-tracker.js')
    recordAiUsage({
      workspaceId,
      provider:     final.provider,
      model:        final.model,
      promptTokens: 0,
      outputTokens: final.tokens,
      costUsd:      final.costUsd,
      latencyMs:    Date.now() - t0,
      taskType:     'chat',
    })
  } catch (e) {
    return { retired, added: null, reason: `LLM call failed: ${(e as Error).message}` }
  }

  mutated = mutated.trim()
  if (mutated.length < 20 || mutated.length > 8000) {
    return { retired, added: null, reason: `mutation returned bad length (${mutated.length})` }
  }
  if (mutated === winner.body.trim()) {
    return { retired, added: null, reason: 'mutation identical to parent — skipped' }
  }

  const inserted = await seedPrompt({
    workspaceId, slot, body: mutated,
    origin: 'auto_mutation', parentId: winner.id,
  })
  await emit(workspaceId, 'prompt.evolved', {
    slot, parentId: winner.id, newId: inserted.id, version: inserted.version, directive,
  })
  return { retired, added: { id: inserted.id, version: inserted.version, directive }, reason: 'mutated' }
}

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'prompt-evolution', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

// ─── Introspection ──────────────────────────────────────────────────────────

export async function listSlots(workspaceId: string): Promise<Array<{
  slot: string; versions: number; activeVersions: number; bestMean: number | null; totalUses: number
}>> {
  const rows = await db.select().from(businessPrompts)
    .where(eq(businessPrompts.workspaceId, workspaceId))
  const bySlot = new Map<string, typeof businessPrompts.$inferSelect[]>()
  for (const r of rows) {
    const arr = bySlot.get(r.slot) ?? []
    arr.push(r); bySlot.set(r.slot, arr)
  }
  const out: ReturnType<typeof listSlots> extends Promise<infer U> ? U : never = []
  for (const [slot, arr] of bySlot) {
    let bestMean: number | null = null
    let activeVersions = 0
    let totalUses = 0
    for (const r of arr) {
      totalUses += r.uses
      if (r.enabled) activeVersions++
      if (r.uses > 0) {
        const m = r.scoreSum / r.uses
        if (bestMean === null || m > bestMean) bestMean = m
      }
    }
    out.push({ slot, versions: arr.length, activeVersions, bestMean, totalUses })
  }
  return out.sort((a, b) => b.totalUses - a.totalUses)
}
