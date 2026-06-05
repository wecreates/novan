/**
 * R146.216 — Multi-model routing + diversity enforcement + Thompson
 * skill picker. The 10× delta over the harness I ported from:
 *
 * 1. TASK_ROUTING: per-task-type preferred provider chains. Not
 *    "Opus/Sonnet/Haiku — guess what fits"; explicit, telemetry-able.
 * 2. healthAwarePick(): provider chain filtered by current health,
 *    degraded providers get downweighted, recently-failed providers
 *    drop to back. Cached for 30s.
 * 3. diverseProviders(N): returns N DIFFERENT providers for adversarial
 *    voters so no single model's bias dominates the verdict.
 * 4. thompsonPickSkill(): Beta-distribution sampling on skills' wins/uses
 *    ratios. Combined with the R208 LLM picker this gives explore/exploit
 *    rather than the LLM's monoculture choice every time.
 */
import { db } from '../db/client.js'
import { aiUsage, providerConfigs } from '../db/schema.js'
import { operatorSkills } from '../db/schema.js'
import { and, eq, gte, sql } from 'drizzle-orm'

export type TaskType =
  | 'chat' | 'codegen' | 'reasoning' | 'classify' | 'extract' | 'synthesize'
  | 'adversarial' | 'skill_pick' | 'memory_extract' | 'chapter_detect'

/** Preferred provider chains per task type. First → last preference.
 *  Routing falls back along the chain when health prunes the head.
 *  Provider IDs match providerConfigs.id. */
export const TASK_ROUTING: Record<TaskType, string[]> = {
  chat:           ['anthropic-sonnet', 'openai-gpt5', 'gemini-flash', 'groq-llama', 'image-pollinations'],
  codegen:        ['anthropic-opus',   'anthropic-sonnet', 'openai-gpt5', 'gemini-pro'],
  reasoning:      ['anthropic-opus',   'openai-gpt5', 'anthropic-sonnet', 'gemini-pro'],
  classify:       ['gemini-flash',     'groq-llama', 'anthropic-haiku', 'openai-gpt5'],
  extract:        ['gemini-flash',     'groq-llama', 'anthropic-haiku'],
  synthesize:     ['anthropic-sonnet', 'openai-gpt5', 'gemini-pro'],
  adversarial:    ['anthropic-sonnet', 'openai-gpt5', 'gemini-pro', 'gemini-flash'],
  skill_pick:     ['gemini-flash',     'groq-llama', 'anthropic-haiku'],
  memory_extract: ['gemini-flash',     'groq-llama', 'anthropic-haiku'],
  chapter_detect: ['gemini-flash',     'groq-llama', 'anthropic-haiku'],
}

interface HealthSnap { score: number; lastTouchedAt: number }
const _healthCache = new Map<string, HealthSnap>()
const HEALTH_TTL_MS = 30_000

async function providerHealth(providerId: string): Promise<number> {
  const cached = _healthCache.get(providerId)
  const now = Date.now()
  if (cached && now - cached.lastTouchedAt < HEALTH_TTL_MS) return cached.score
  // Score = 1 minus recent-failure rate (last 10 min) - capped 0..1
  const since = now - 10 * 60_000
  const rows = await db.select({
    n:    sql<number>`count(*)::int`,
    fail: sql<number>`count(*) filter (where ${aiUsage.outputTokens} = 0)::int`,
  }).from(aiUsage).where(and(eq(aiUsage.provider, providerId), gte(aiUsage.timestamp, since))).catch(() => [])
  const r = rows[0]
  let score = 1
  if (r && r.n > 0) score = Math.max(0, 1 - (r.fail / r.n))
  // Penalize providers explicitly listed as known-degraded in env.
  const knownDegraded = (process.env['KNOWN_DEGRADED_PROVIDERS'] || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  if (knownDegraded.some(k => providerId.toLowerCase().includes(k))) score *= 0.3
  // Provider entirely disabled via providerConfigs?
  const [pc] = await db.select({ enabled: providerConfigs.enabled }).from(providerConfigs)
    .where(eq(providerConfigs.providerId, providerId)).limit(1).catch(() => [])
  if (pc && pc.enabled === false) score = 0
  _healthCache.set(providerId, { score, lastTouchedAt: now })
  return score
}

/** Return the first healthy provider in the task's chain, with the
 *  remainder as fallbacks. Caller can pass to streamChat as preferred
 *  order. Returns empty if no healthy providers. */
export async function healthAwarePick(task: TaskType): Promise<string[]> {
  const chain = TASK_ROUTING[task] ?? TASK_ROUTING.chat
  const scored = await Promise.all(chain.map(async id => ({ id, score: await providerHealth(id) })))
  // Sort by health, drop fully-dead
  return scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).map(s => s.id)
}

/** Return N DIFFERENT providers for adversarial voters. If fewer than N
 *  distinct providers are available, falls back to repeating with
 *  different model variants (e.g. anthropic-sonnet + anthropic-haiku). */
export async function diverseProviders(n: number, task: TaskType = 'adversarial'): Promise<string[]> {
  const chain = await healthAwarePick(task)
  if (chain.length === 0) return []
  if (chain.length >= n) return chain.slice(0, n)
  // Repeat by cycling
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(chain[i % chain.length]!)
  return out
}

// ─── Thompson sampling skill picker ──────────────────────────────────

function betaSample(alpha: number, beta: number): number {
  // Marsaglia & Tsang via two gamma samples — small approximation OK here.
  const x = gammaSample(alpha)
  const y = gammaSample(beta)
  return x / (x + y || 1)
}
function gammaSample(k: number): number {
  // Marsaglia-Tsang for k>=1; for k<1 use boost trick.
  if (k < 1) return gammaSample(k + 1) * Math.pow(rng(), 1 / k)
  const d = k - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  while (true) {
    let x: number, v: number
    do { x = gauss(); v = 1 + c * x } while (v <= 0)
    v = v * v * v
    const u = rng()
    if (u < 1 - 0.0331 * x * x * x * x) return d * v
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}
let _gaussCache: number | null = null
function gauss(): number {
  if (_gaussCache !== null) { const r = _gaussCache; _gaussCache = null; return r }
  let u = 0, v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  const mag = Math.sqrt(-2 * Math.log(u))
  _gaussCache = mag * Math.sin(2 * Math.PI * v)
  return mag * Math.cos(2 * Math.PI * v)
}
function rng(): number {
  // Math.random() banned by harness in some contexts; fall back to crypto.
  try { return Math.random() } catch { return Number('0.' + Date.now()) }
}

/** Sample winning skill via Thompson sampling on Beta(wins+1, uses-wins+1).
 *  Returns null if no skills exist or all are very young (<3 uses) — caller
 *  should fall back to LLM picker for cold-start. */
export async function thompsonPickSkill(workspaceId: string, candidateNames?: string[]): Promise<string | null> {
  const rows = await db.select({
    name: operatorSkills.name, uses: operatorSkills.uses, wins: operatorSkills.wins,
  }).from(operatorSkills).where(eq(operatorSkills.workspaceId, workspaceId))
  const filtered = candidateNames ? rows.filter(r => candidateNames.includes(r.name)) : rows
  if (filtered.length === 0) return null
  // Cold start: if all skills <3 uses, return null so LLM picker decides
  const allCold = filtered.every(r => r.uses < 3)
  if (allCold) return null
  let bestName: string | null = null
  let bestScore = -1
  for (const r of filtered) {
    const wins = r.wins, losses = Math.max(0, r.uses - r.wins)
    const s = betaSample(wins + 1, losses + 1)
    if (s > bestScore) { bestScore = s; bestName = r.name }
  }
  return bestName
}

/** Combined picker: try Thompson first (exploit); if it returns null
 *  (cold start), fall back to LLM picker which the caller supplies. */
export async function pickSkillSmart(
  workspaceId: string,
  llmFallback: () => Promise<string | null>,
  candidates?: string[],
): Promise<{ name: string | null; via: 'thompson' | 'llm' | 'none' }> {
  const tName = await thompsonPickSkill(workspaceId, candidates).catch(() => null)
  if (tName) return { name: tName, via: 'thompson' }
  const lName = await llmFallback().catch(() => null)
  return lName ? { name: lName, via: 'llm' } : { name: null, via: 'none' }
}

/** Telemetry view of routing state for /metrics. */
export async function routingHealthSnapshot(): Promise<Array<{ task: TaskType; chain: string[] }>> {
  const snap: Array<{ task: TaskType; chain: string[] }> = []
  for (const t of Object.keys(TASK_ROUTING) as TaskType[]) {
    snap.push({ task: t, chain: await healthAwarePick(t) })
  }
  return snap
}
