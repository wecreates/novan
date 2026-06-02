/**
 * R146.132 — Cross-account content planning + LLM drift detection.
 */
import { db } from '../db/client.js'
import { accountNiches, llmOutputFingerprints } from '../db/schema.js'
import { and, eq, desc, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { createHash } from 'crypto'

// ─── P3.10 — Cross-account niche+slot planner ────────────────────────

export async function setAccountNiche(workspaceId: string, opts: {
  connectorAccountId: string
  nicheTags: string[]
  postingSlots?: number[]    // minute-of-day [0..1439]
}): Promise<void> {
  const now = Date.now()
  const slots = (opts.postingSlots ?? []).filter(n => typeof n === 'number' && n >= 0 && n < 1440)
  await db.insert(accountNiches).values({
    workspaceId, connectorAccountId: opts.connectorAccountId,
    nicheTags: opts.nicheTags.slice(0, 12),
    postingSlots: slots.slice(0, 12),
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [accountNiches.workspaceId, accountNiches.connectorAccountId],
    set: { nicheTags: opts.nicheTags.slice(0, 12), postingSlots: slots.slice(0, 12), updatedAt: now },
  })
}

export async function listAccountNiches(workspaceId: string): Promise<Array<typeof accountNiches.$inferSelect>> {
  return db.select().from(accountNiches).where(eq(accountNiches.workspaceId, workspaceId))
}

/**
 * Plan post slots across accounts:
 *   - assign each upcoming post to the account whose niche tags best match
 *   - stagger posting times so two accounts never share a minute
 *
 * Returns { accountId, scheduledMinute, score, conflicts } per item.
 */
export interface PlanItem { contentId: string; tags: string[] }
export interface PlanResult {
  contentId: string
  assignedAccountId: string | null
  scheduledMinute: number | null
  score: number
  reason: string
}

export async function planAcrossAccounts(workspaceId: string, items: PlanItem[]): Promise<PlanResult[]> {
  const accounts = await listAccountNiches(workspaceId)
  if (accounts.length === 0) {
    return items.map(it => ({ contentId: it.contentId, assignedAccountId: null, scheduledMinute: null, score: 0, reason: 'no accounts configured' }))
  }
  const usedSlots = new Map<string, Set<number>>()   // accountId → minute slots already taken this run
  const results: PlanResult[] = []
  for (const item of items) {
    // Score each account: count of overlapping tags
    let best: { acc: typeof accounts[0]; score: number } | null = null
    for (const acc of accounts) {
      const overlap = item.tags.filter(t => (acc.nicheTags ?? []).includes(t)).length
      if (!best || overlap > best.score) best = { acc, score: overlap }
    }
    if (!best || best.score === 0) {
      results.push({ contentId: item.contentId, assignedAccountId: null, scheduledMinute: null, score: 0, reason: 'no niche match' })
      continue
    }
    // Pick first unused slot from best.acc.postingSlots
    const used = usedSlots.get(best.acc.connectorAccountId) ?? new Set<number>()
    const slots = (best.acc.postingSlots ?? []).filter(s => !used.has(s))
    if (slots.length === 0) {
      results.push({ contentId: item.contentId, assignedAccountId: best.acc.connectorAccountId, scheduledMinute: null, score: best.score, reason: 'all configured slots used today' })
      continue
    }
    const slot = slots[0]!
    used.add(slot)
    usedSlots.set(best.acc.connectorAccountId, used)
    results.push({ contentId: item.contentId, assignedAccountId: best.acc.connectorAccountId, scheduledMinute: slot, score: best.score, reason: `${best.score} niche tag(s) match` })
  }
  return results
}

// ─── P3.11 — LLM output drift detection ──────────────────────────────

/**
 * Compute a stable "shape" hash for a JSON output: a hash of the
 * sorted set of (path, type) pairs across the entire tree. Two outputs
 * with the same shape have the same hash even if values differ.
 */
function shapeOf(value: unknown, path = ''): Array<[string, string]> {
  if (value === null) return [[path, 'null']]
  if (Array.isArray(value)) {
    if (value.length === 0) return [[path, 'array<empty>']]
    // sample first element shape; arrays of mixed types collapse to 'array<mixed>'
    const types = new Set<string>()
    const shapes: Array<[string, string]> = []
    for (const v of value.slice(0, 3)) {
      types.add(typeof v === 'object' ? (v === null ? 'null' : Array.isArray(v) ? 'array' : 'object') : typeof v)
      shapes.push(...shapeOf(v, `${path}[]`))
    }
    return shapes
  }
  if (typeof value === 'object') {
    const out: Array<[string, string]> = []
    for (const [k, v] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
      out.push(...shapeOf(v, path ? `${path}.${k}` : k))
    }
    return out
  }
  return [[path, typeof value]]
}

export function fingerprint(value: unknown): string {
  const pairs = shapeOf(value)
  const joined = pairs.map(([p, t]) => `${p}:${t}`).join('|')
  return createHash('sha256').update(joined).digest('hex').slice(0, 24)
}

export async function recordFingerprint(workspaceId: string, opts: {
  promptKey: string
  provider: string
  model: string
  output: unknown
}): Promise<{ id: string; shapeHash: string; drift: boolean; previousHash?: string }> {
  const shapeHash = fingerprint(opts.output)
  // Look at the most recent fingerprint for this (workspace, promptKey)
  const [last] = await db.select().from(llmOutputFingerprints)
    .where(and(eq(llmOutputFingerprints.workspaceId, workspaceId), eq(llmOutputFingerprints.promptKey, opts.promptKey)))
    .orderBy(desc(llmOutputFingerprints.observedAt))
    .limit(1)
  const drift = !!(last && last.shapeHash !== shapeHash)
  const id = uuidv7()
  await db.insert(llmOutputFingerprints).values({
    id, workspaceId,
    promptKey: opts.promptKey,
    provider: opts.provider,
    model: opts.model,
    shapeHash,
    shapeSample: typeof opts.output === 'object' && opts.output !== null ? opts.output as Record<string, unknown> : { value: opts.output },
    observedAt: Date.now(),
  })
  return { id, shapeHash, drift, ...(last ? { previousHash: last.shapeHash } : {}) }
}

export async function driftSummary(workspaceId: string, windowDays = 7): Promise<Array<{ promptKey: string; distinctShapes: number; latestShape: string; latestProvider: string }>> {
  const since = Date.now() - windowDays * 24 * 60 * 60_000
  const rows = await db.execute(sql`
    SELECT prompt_key, COUNT(DISTINCT shape_hash)::int AS distinct_shapes,
           (SELECT shape_hash FROM llm_output_fingerprints f2
            WHERE f2.workspace_id = f.workspace_id AND f2.prompt_key = f.prompt_key
            ORDER BY observed_at DESC LIMIT 1) AS latest_shape,
           (SELECT provider FROM llm_output_fingerprints f3
            WHERE f3.workspace_id = f.workspace_id AND f3.prompt_key = f.prompt_key
            ORDER BY observed_at DESC LIMIT 1) AS latest_provider
    FROM llm_output_fingerprints f
    WHERE workspace_id = ${workspaceId} AND observed_at >= ${since}
    GROUP BY prompt_key
    HAVING COUNT(DISTINCT shape_hash) > 1
    ORDER BY distinct_shapes DESC
    LIMIT 50
  `) as unknown as Array<{ prompt_key: string; distinct_shapes: number; latest_shape: string; latest_provider: string }>
  return rows.map(r => ({
    promptKey: r.prompt_key,
    distinctShapes: r.distinct_shapes,
    latestShape: r.latest_shape,
    latestProvider: r.latest_provider,
  }))
}
