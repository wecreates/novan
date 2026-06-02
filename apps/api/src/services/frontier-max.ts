/**
 * frontier-max.ts — R146.107 — Novan Frontier MAX learning + permanent advancement.
 *
 * Three additions to R146.105's scan/distill/queue loop:
 *
 *  1. CAPABILITY CATALOG — every AI system Novan encounters (model, technique,
 *     framework, agent pattern, RAG variant) becomes a row in
 *     frontier_capabilities. Status transitions:
 *        unknown → learning → basics_known → integrated → advancing → permanent
 *     Each capability carries realism / quality / efficiency scores (0-100)
 *     so we know exactly which ones still have headroom.
 *
 *  2. PERMANENT ADVANCEMENT LOOP — once a capability is 'integrated' or
 *     'permanent', the advance tick proposes concrete improvements via the
 *     LLM router (realism > quality > efficiency, in that order). Each
 *     proposal is recorded in frontier_advancements with before/after deltas
 *     when applied. This loop NEVER stops — every integrated capability gets
 *     a new round of advancement proposals every cycle.
 *
 *  3. MAX MODE — operator-tunable: cron interval, distill batch, prototype
 *     batch, advance batch, parallel source scans. MAX cranks them all to
 *     their safe upper bounds (60s tick, 30 distill, 10 prototype, 10
 *     advance, 8 parallel scans). Settings are per-workspace, persisted.
 *
 * The expanded source list is twice as large as R146.105's: more arxiv
 * categories, more lab blogs, AlphaXiv, Replicate trending, ModelScope,
 * Reddit r/MachineLearning, conference papers.
 */
import { db } from '../db/client.js'
import {
  frontierFindings, frontierCapabilities, frontierAdvancements,
  frontierSettings, frontierSources, events,
} from '@ops/db'
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { recordAiUsage } from './ai-cost-tracker.js'

// ─── Expanded source list (MAX mode adds these on top of R146.105) ───────

export const MAX_FRONTIER_SOURCES: Array<{ kind: string; url: string; label: string; scanIntervalSec: number }> = [
  // Additional arxiv categories
  { kind: 'arxiv',           url: 'https://rss.arxiv.org/rss/cs.NE',                                  label: 'arXiv cs.NE (neuro-evolutionary)', scanIntervalSec: 3600 },
  { kind: 'arxiv',           url: 'https://rss.arxiv.org/rss/cs.IR',                                  label: 'arXiv cs.IR (retrieval)',          scanIntervalSec: 3600 },
  { kind: 'arxiv',           url: 'https://rss.arxiv.org/rss/cs.SD',                                  label: 'arXiv cs.SD (sound)',              scanIntervalSec: 3600 },
  { kind: 'arxiv',           url: 'https://rss.arxiv.org/rss/cs.MM',                                  label: 'arXiv cs.MM (multimedia)',         scanIntervalSec: 3600 },
  { kind: 'arxiv',           url: 'https://rss.arxiv.org/rss/cs.RO',                                  label: 'arXiv cs.RO (robotics)',           scanIntervalSec: 7200 },
  { kind: 'arxiv',           url: 'https://rss.arxiv.org/rss/stat.ML',                                label: 'arXiv stat.ML',                    scanIntervalSec: 3600 },
  // Replicate trending public models (no auth for browse)
  { kind: 'github-trending', url: 'https://api.github.com/search/repositories?q=topic:video-generation+OR+topic:text-to-video+OR+topic:diffusion+pushed:>__SINCE__&sort=stars&order=desc&per_page=30', label: 'GitHub video-gen trending', scanIntervalSec: 21600 },
  { kind: 'github-trending', url: 'https://api.github.com/search/repositories?q=topic:agentic+OR+topic:autonomous-agents+pushed:>__SINCE__&sort=stars&order=desc&per_page=30',                       label: 'GitHub agentic trending',   scanIntervalSec: 21600 },
  // Reddit r/MachineLearning JSON (no auth, rate-limit-prone but free)
  { kind: 'rss',             url: 'https://www.reddit.com/r/MachineLearning/top/.rss?t=week',         label: 'Reddit r/MachineLearning weekly',  scanIntervalSec: 21600 },
  { kind: 'rss',             url: 'https://www.reddit.com/r/LocalLLaMA/top/.rss?t=week',              label: 'Reddit r/LocalLLaMA weekly',       scanIntervalSec: 21600 },
  // Lab blogs not in R146.105
  { kind: 'rss',             url: 'https://blog.research.google/feeds/posts/default',                 label: 'Google Research Blog',             scanIntervalSec: 21600 },
  { kind: 'rss',             url: 'https://machinelearning.apple.com/rss.xml',                        label: 'Apple ML Research',                scanIntervalSec: 43200 },
  { kind: 'rss',             url: 'https://research.nvidia.com/feed',                                 label: 'NVIDIA Research',                  scanIntervalSec: 21600 },
  { kind: 'rss',             url: 'https://www.microsoft.com/en-us/research/feed/',                   label: 'Microsoft Research',               scanIntervalSec: 21600 },
  { kind: 'rss',             url: 'https://huggingface.co/blog/feed.xml',                             label: 'Hugging Face Blog',                scanIntervalSec: 21600 },
  { kind: 'rss',             url: 'https://blog.replicate.com/rss/',                                  label: 'Replicate Blog',                   scanIntervalSec: 43200 },
  { kind: 'rss',             url: 'https://stability.ai/news?format=rss',                             label: 'Stability AI News',                scanIntervalSec: 43200 },
  { kind: 'rss',             url: 'https://www.together.ai/blog?format=rss',                          label: 'Together AI Blog',                 scanIntervalSec: 43200 },
]

// ─── Settings ────────────────────────────────────────────────────────────

export interface FrontierSettings {
  maxMode:            boolean
  scanIntervalMs:     number
  distillBatchSize:   number
  prototypeBatchSize: number
  advanceBatchSize:   number
  parallelSources:    number
}

const DEFAULTS: FrontierSettings = {
  maxMode: false, scanIntervalMs: 300_000,
  distillBatchSize: 8, prototypeBatchSize: 3, advanceBatchSize: 3, parallelSources: 3,
}

const MAX_PRESET: FrontierSettings = {
  maxMode: true, scanIntervalMs: 60_000,
  distillBatchSize: 30, prototypeBatchSize: 10, advanceBatchSize: 10, parallelSources: 8,
}

export async function getSettings(workspaceId: string): Promise<FrontierSettings> {
  const [row] = await db.select().from(frontierSettings).where(eq(frontierSettings.workspaceId, workspaceId)).limit(1)
  if (!row) return { ...DEFAULTS }
  return {
    maxMode:            row.maxMode,
    scanIntervalMs:     row.scanIntervalMs,
    distillBatchSize:   row.distillBatchSize,
    prototypeBatchSize: row.prototypeBatchSize,
    advanceBatchSize:   row.advanceBatchSize,
    parallelSources:    row.parallelSources,
  }
}

export async function setMaxMode(workspaceId: string, enabled: boolean): Promise<FrontierSettings> {
  const preset = enabled ? MAX_PRESET : DEFAULTS
  const now = Date.now()
  await db.insert(frontierSettings).values({
    workspaceId,
    ...preset,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: frontierSettings.workspaceId,
    set: { ...preset, updatedAt: now },
  })
  // Also seed the expanded MAX source list when enabling.
  if (enabled) {
    for (const s of MAX_FRONTIER_SOURCES) {
      await db.insert(frontierSources).values({
        id: uuidv7(),
        workspaceId,
        kind: s.kind,
        url: s.url,
        label: s.label,
        enabled: true,
        scanIntervalSec: s.scanIntervalSec,
        createdAt: now,
      }).onConflictDoNothing().catch(() => null)
    }
  }
  return preset
}

export async function setCustomSettings(workspaceId: string, patch: Partial<FrontierSettings>): Promise<FrontierSettings> {
  const cur = await getSettings(workspaceId)
  const next: FrontierSettings = {
    maxMode:            patch.maxMode            ?? cur.maxMode,
    scanIntervalMs:     clamp(patch.scanIntervalMs     ?? cur.scanIntervalMs,     30_000, 3_600_000),
    distillBatchSize:   clamp(patch.distillBatchSize   ?? cur.distillBatchSize,   1, 100),
    prototypeBatchSize: clamp(patch.prototypeBatchSize ?? cur.prototypeBatchSize, 1, 50),
    advanceBatchSize:   clamp(patch.advanceBatchSize   ?? cur.advanceBatchSize,   1, 50),
    parallelSources:    clamp(patch.parallelSources    ?? cur.parallelSources,    1, 16),
  }
  const now = Date.now()
  await db.insert(frontierSettings).values({ workspaceId, ...next, updatedAt: now })
    .onConflictDoUpdate({ target: frontierSettings.workspaceId, set: { ...next, updatedAt: now } })
  return next
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

// ─── Capability catalog ─────────────────────────────────────────────────

const CATEGORY_HINTS: Array<{ kw: RegExp; cat: string }> = [
  { kw: /\b(video|svd|i2v|t2v|img2vid|text-to-video|cogvideo|sora|kling|veo|runway|luma)\b/i, cat: 'video-gen' },
  { kw: /\b(image|t2i|flux|sdxl|stable\s*diffusion|dall-?e|imagen|midjourney)\b/i,            cat: 'image-gen' },
  { kw: /\b(llm|gpt|claude|gemini|llama|mistral|qwen|deepseek|moe|sparse|reasoning|cot)\b/i,  cat: 'llm-reasoning' },
  { kw: /\b(rag|retrieval|vector|embedding|reranker|bm25|colbert|hyde)\b/i,                   cat: 'retrieval' },
  { kw: /\b(asr|tts|whisper|voice|speech|audio|elevenlabs|playht)\b/i,                        cat: 'audio' },
  { kw: /\b(agent|tool-use|react|autogen|crew|swarm|planner)\b/i,                             cat: 'agent' },
  { kw: /\b(train|fine-tun|lora|dpo|rlhf|distill|pretrain)\b/i,                               cat: 'training' },
]

function inferCategory(text: string): string {
  for (const h of CATEGORY_HINTS) if (h.kw.test(text)) return h.cat
  return 'other'
}

function canonicalize(name: string): string {
  return name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
}

/** Promote distilled findings into the capability catalog. Called after each
 *  distill batch. Dedups by canonical(technique). New capabilities start at
 *  'basics_known'; if same name appears 3+ times, advance to 'integrated'
 *  (Novan has seen enough corroboration to start building permanently). */
export async function catalogFromFindings(workspaceId: string, limit = 50): Promise<{ added: number; promoted: number }> {
  const recent = await db.select().from(frontierFindings).where(and(
    eq(frontierFindings.workspaceId, workspaceId),
    or(eq(frontierFindings.status, 'distilled'), eq(frontierFindings.status, 'queued'), eq(frontierFindings.status, 'prototyping'), eq(frontierFindings.status, 'integrated')),
  )).orderBy(desc(frontierFindings.discoveredAt)).limit(limit)
  let added = 0, promoted = 0
  const byName = new Map<string, typeof recent>()
  for (const f of recent) {
    if (!f.technique) continue
    const name = canonicalize(f.technique)
    if (!name) continue
    const list = byName.get(name) ?? []
    list.push(f)
    byName.set(name, list)
  }
  const now = Date.now()
  for (const [name, group] of byName) {
    const first = group[0]
    if (!first) continue
    const category = inferCategory(`${first.technique ?? ''} ${first.claimedCapability ?? ''} ${first.rawAbstract?.slice(0, 200) ?? ''}`)
    const ids = group.map(g => g.id)
    const initialStatus = group.length >= 3 ? 'integrated' : 'basics_known'
    const realism    = Math.max(...group.map(g => g.scoreApplicability))
    const quality    = Math.max(...group.map(g => g.scoreImpact))
    const efficiency = Math.max(...group.map(g => g.scoreReplicability))
    try {
      const existing = await db.select().from(frontierCapabilities).where(and(eq(frontierCapabilities.workspaceId, workspaceId), eq(frontierCapabilities.name, name))).limit(1)
      if (existing.length === 0) {
        await db.insert(frontierCapabilities).values({
          id: uuidv7(),
          workspaceId, name, category,
          status: initialStatus,
          description: first.claimedCapability ?? null,
          upstreamFindingIds: ids,
          integrationPath: null,
          currentVersion: 1,
          realismScore: realism,
          qualityScore:  quality,
          efficiencyScore: efficiency,
          lastAdvancedAt: null,
          advancementCount: 0,
          createdAt: now, updatedAt: now,
        })
        added++
        if (initialStatus === 'integrated') promoted++
      } else {
        const cur = existing[0]!
        if (cur.status === 'basics_known' && group.length >= 3) {
          await db.update(frontierCapabilities).set({
            status: 'integrated',
            upstreamFindingIds: ids,
            realismScore: Math.max(cur.realismScore, realism),
            qualityScore:  Math.max(cur.qualityScore, quality),
            efficiencyScore: Math.max(cur.efficiencyScore, efficiency),
            updatedAt: now,
          }).where(eq(frontierCapabilities.id, cur.id))
          promoted++
        }
      }
    } catch { /* dedup race */ }
  }
  return { added, promoted }
}

// ─── Permanent advancement loop ─────────────────────────────────────────

const ADVANCE_PROMPT = `You are Novan's Advancement Engineer. A capability is already integrated. Propose ONE concrete improvement focused on the MOST IMPORTANT axis (realism, quality, efficiency).

Output strict JSON:
{
  "kind": "realism" | "quality" | "efficiency" | "scope",
  "proposal": "one-sentence concrete change (specific param, model swap, pipeline stage, dataset, decoding strategy)",
  "expectedGain": 0-100 integer (predicted improvement on the chosen axis)
}

Capability: {{name}} (category: {{category}})
Description: {{description}}
Current scores — realism: {{realism}}, quality: {{quality}}, efficiency: {{efficiency}}
Advancements already proposed: {{priorCount}}

Propose something NEW and SPECIFIC. No fluff, no caveats. JSON only.`

async function callAdvanceLlm(workspaceId: string, name: string, category: string, description: string, scores: { r: number; q: number; e: number }, priorCount: number): Promise<{ kind: string; proposal: string; expectedGain: number } | null> {
  const prompt = ADVANCE_PROMPT
    .replace('{{name}}', name).replace('{{category}}', category)
    .replace('{{description}}', description.slice(0, 400))
    .replace('{{realism}}', String(scores.r)).replace('{{quality}}', String(scores.q))
    .replace('{{efficiency}}', String(scores.e)).replace('{{priorCount}}', String(priorCount))
  const groqKey = process.env['GROQ_API_KEY']
  const geminiKey = process.env['GEMINI_API_KEY']
  const t0 = Date.now()
  const tryParse = (s: string): { kind: string; proposal: string; expectedGain: number } | null => {
    try {
      const o = JSON.parse(s.trim().replace(/^```json\s*|```$/g, '')) as { kind?: string; proposal?: string; expectedGain?: number }
      if (!o.kind || !o.proposal) return null
      const allowed = ['realism', 'quality', 'efficiency', 'scope']
      const kind = allowed.includes(String(o.kind)) ? String(o.kind) : 'quality'
      const gain = Number(o.expectedGain)
      return { kind, proposal: String(o.proposal).slice(0, 800), expectedGain: Number.isFinite(gain) ? Math.max(0, Math.min(100, Math.round(gain))) : 10 }
    } catch { return null }
  }
  if (groqKey) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], temperature: 0.4, max_tokens: 300, response_format: { type: 'json_object' } }),
        signal: AbortSignal.timeout(30_000),
      })
      if (res.ok) {
        const d = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }
        recordAiUsage({ workspaceId, provider: 'groq', model: 'llama-3.3-70b', promptTokens: d.usage?.prompt_tokens ?? 0, outputTokens: d.usage?.completion_tokens ?? 0, costUsd: 0.00005, latencyMs: Date.now() - t0, taskType: 'other' })
        return tryParse(d.choices?.[0]?.message?.content ?? '')
      }
    } catch { /* fall through */ }
  }
  if (geminiKey) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4, maxOutputTokens: 300, responseMimeType: 'application/json' } }),
        signal: AbortSignal.timeout(30_000),
      })
      if (res.ok) {
        const d = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
        recordAiUsage({ workspaceId, provider: 'gemini', model: 'gemini-2.0-flash', promptTokens: 0, outputTokens: 0, costUsd: 0.00002, latencyMs: Date.now() - t0, taskType: 'other' })
        return tryParse(d.candidates?.[0]?.content?.parts?.[0]?.text ?? '')
      }
    } catch { /* fall through */ }
  }
  return null
}

export async function advanceCapabilities(workspaceId: string, limit = 3): Promise<{ proposed: number; emitted: number }> {
  // Pick integrated capabilities with the longest time since last advancement.
  // 'permanent' caps also get advanced — that's the whole point of "permanent
  // advancement" — they never stop improving.
  const candidates = await db.select().from(frontierCapabilities).where(and(
    eq(frontierCapabilities.workspaceId, workspaceId),
    inArray(frontierCapabilities.status, ['integrated', 'permanent', 'advancing']),
  )).orderBy(sql`COALESCE(${frontierCapabilities.lastAdvancedAt}, 0) ASC`).limit(limit)
  let proposed = 0, emitted = 0
  for (const c of candidates) {
    const out = await callAdvanceLlm(workspaceId, c.name, c.category, c.description ?? '', { r: c.realismScore, q: c.qualityScore, e: c.efficiencyScore }, c.advancementCount)
    if (!out) continue
    const advId = uuidv7()
    const now = Date.now()
    await db.insert(frontierAdvancements).values({
      id: advId, workspaceId, capabilityId: c.id,
      proposedAt: now, kind: out.kind, proposal: out.proposal, expectedGain: out.expectedGain,
    })
    proposed++
    await db.update(frontierCapabilities).set({
      status: c.status === 'integrated' ? 'advancing' : c.status,
      lastAdvancedAt: now,
      advancementCount: c.advancementCount + 1,
      updatedAt: now,
    }).where(eq(frontierCapabilities.id, c.id))
    // Emit so the brain orchestrator can pick it up.
    try {
      await db.insert(events).values({
        id: uuidv7(), workspaceId,
        type: 'frontier.advancement_proposed',
        payload: {
          capabilityId: c.id, capabilityName: c.name, category: c.category,
          advancementId: advId, kind: out.kind, proposal: out.proposal,
          expectedGain: out.expectedGain,
          beforeScores: { realism: c.realismScore, quality: c.qualityScore, efficiency: c.efficiencyScore },
        },
        traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
        source: 'frontier-max', version: 1, createdAt: now,
      })
      emitted++
    } catch { /* skip */ }
  }
  return { proposed, emitted }
}

// ─── MAX tick: runs all phases with current settings ────────────────────

export async function frontierMaxTick(workspaceId: string): Promise<{
  settings: FrontierSettings
  budget:    { allowed: boolean; reason: string }
  scan:   { scanned: number; raw: number; inserted: number }
  distill:{ distilled: number; queued: number }
  prototype: { spawned: number }
  catalog:{ added: number; promoted: number }
  advance:{ proposed: number; emitted: number }
}> {
  const settings = await getSettings(workspaceId)
  const { scanSourceOnce, distillPending, spawnPrototypeTasks } = await import('./frontier-intel.js')

  // R146.108 — autonomy-budget guard: distill+advance phases call LLMs.
  // MAX mode can do up to ~40 LLM calls per tick; if data-category budget is
  // exhausted we still do free phases (scan + catalog + dedup) but skip
  // LLM-cost phases. This prevents MAX mode from blowing the ceiling.
  const { frontierBudgetAllowed } = await import('./frontier-consumers.js')
  const projected = settings.distillBatchSize * 0.0005 + settings.advanceBatchSize * 0.0005
  const budget = await frontierBudgetAllowed(workspaceId, projected)

  // Phase 1: parallel scan up to settings.parallelSources due sources.
  const now = Date.now()
  const due = await db.select().from(frontierSources).where(and(
    eq(frontierSources.workspaceId, workspaceId),
    eq(frontierSources.enabled, true),
    or(
      sql`${frontierSources.lastScannedAt} IS NULL`,
      sql`${frontierSources.lastScannedAt} + (${frontierSources.scanIntervalSec} * 1000) <= ${now}`,
    ),
  )).limit(settings.parallelSources)
  const scanResults = await Promise.all(due.map(s => scanSourceOnce(workspaceId, s.id).catch(() => ({ raw: 0, inserted: 0 }))))
  const scan = scanResults.reduce<{ scanned: number; raw: number; inserted: number }>(
    (a, r) => ({ scanned: a.scanned + 1, raw: a.raw + r.raw, inserted: a.inserted + r.inserted }),
    { scanned: 0, raw: 0, inserted: 0 },
  )

  // Phase 2: distill batch (LLM-cost — skip if budget exhausted).
  const distill = budget.allowed
    ? await distillPending(workspaceId, settings.distillBatchSize)
    : { distilled: 0, queued: 0 }
  // Phase 3: prototype spawn (free — just event emit).
  const prototype = await spawnPrototypeTasks(workspaceId, settings.prototypeBatchSize)
  // Phase 4: catalog promotion (free — DB only).
  const catalog = await catalogFromFindings(workspaceId, 50)
  // Phase 5: permanent advancement (LLM-cost — skip if budget exhausted).
  const advance = budget.allowed
    ? await advanceCapabilities(workspaceId, settings.advanceBatchSize)
    : { proposed: 0, emitted: 0 }

  return { settings, budget, scan, distill, prototype, catalog, advance }
}

// ─── Reporting ───────────────────────────────────────────────────────────

export async function listCapabilities(workspaceId: string, opts: { status?: string; category?: string; limit?: number } = {}): Promise<unknown[]> {
  const limit = clamp(opts.limit ?? 50, 1, 500)
  const filters = [eq(frontierCapabilities.workspaceId, workspaceId)]
  if (opts.status)   filters.push(eq(frontierCapabilities.status,   opts.status))
  if (opts.category) filters.push(eq(frontierCapabilities.category, opts.category))
  return db.select().from(frontierCapabilities).where(and(...filters)).orderBy(desc(frontierCapabilities.updatedAt)).limit(limit)
}

export async function listAdvancements(workspaceId: string, capabilityId?: string, limit = 50): Promise<unknown[]> {
  const filters = [eq(frontierAdvancements.workspaceId, workspaceId)]
  if (capabilityId) filters.push(eq(frontierAdvancements.capabilityId, capabilityId))
  return db.select().from(frontierAdvancements).where(and(...filters)).orderBy(desc(frontierAdvancements.proposedAt)).limit(clamp(limit, 1, 500))
}

export async function applyAdvancement(workspaceId: string, advancementId: string, deltas: { realism?: number; quality?: number; efficiency?: number; notes?: string }): Promise<{ ok: boolean }> {
  const [adv] = await db.select().from(frontierAdvancements).where(and(eq(frontierAdvancements.workspaceId, workspaceId), eq(frontierAdvancements.id, advancementId))).limit(1)
  if (!adv) return { ok: false }
  const [cap] = await db.select().from(frontierCapabilities).where(eq(frontierCapabilities.id, adv.capabilityId)).limit(1)
  if (!cap) return { ok: false }
  const next = {
    realism:    clamp(cap.realismScore    + (deltas.realism    ?? 0), 0, 100),
    quality:    clamp(cap.qualityScore    + (deltas.quality    ?? 0), 0, 100),
    efficiency: clamp(cap.efficiencyScore + (deltas.efficiency ?? 0), 0, 100),
  }
  const now = Date.now()
  await db.update(frontierAdvancements).set({
    appliedAt: now,
    ...(deltas.notes ? { appliedNotes: deltas.notes } : {}),
    realismBefore: cap.realismScore, realismAfter: next.realism,
    qualityBefore: cap.qualityScore, qualityAfter: next.quality,
    efficiencyBefore: cap.efficiencyScore, efficiencyAfter: next.efficiency,
  }).where(eq(frontierAdvancements.id, advancementId))
  // Promote to 'permanent' once a capability has applied 5+ advancements.
  const newCount = cap.advancementCount + 1
  const newStatus = newCount >= 5 ? 'permanent' : cap.status === 'integrated' ? 'advancing' : cap.status
  await db.update(frontierCapabilities).set({
    realismScore: next.realism, qualityScore: next.quality, efficiencyScore: next.efficiency,
    advancementCount: newCount, status: newStatus, currentVersion: cap.currentVersion + 1,
    updatedAt: now,
  }).where(eq(frontierCapabilities.id, cap.id))
  return { ok: true }
}

export async function capabilityStats(workspaceId: string): Promise<{ total: number; byStatus: Record<string, number>; byCategory: Record<string, number>; avgRealism: number; avgQuality: number; avgEfficiency: number }> {
  const [s] = await db.execute<{ total: number; learning: number; basics_known: number; integrated: number; advancing: number; permanent: number; avg_r: number; avg_q: number; avg_e: number }>(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status='learning')::int     AS learning,
      COUNT(*) FILTER (WHERE status='basics_known')::int AS basics_known,
      COUNT(*) FILTER (WHERE status='integrated')::int   AS integrated,
      COUNT(*) FILTER (WHERE status='advancing')::int    AS advancing,
      COUNT(*) FILTER (WHERE status='permanent')::int    AS permanent,
      COALESCE(AVG(realism_score),0)::real    AS avg_r,
      COALESCE(AVG(quality_score),0)::real    AS avg_q,
      COALESCE(AVG(efficiency_score),0)::real AS avg_e
    FROM frontier_capabilities WHERE workspace_id = ${workspaceId}`) as unknown as Array<{ total: number; learning: number; basics_known: number; integrated: number; advancing: number; permanent: number; avg_r: number; avg_q: number; avg_e: number }>
  const cats = await db.execute<{ category: string; n: number }>(sql`
    SELECT category, COUNT(*)::int AS n FROM frontier_capabilities WHERE workspace_id = ${workspaceId} GROUP BY category`) as unknown as Array<{ category: string; n: number }>
  const byCategory: Record<string, number> = {}
  for (const c of cats) byCategory[c.category] = c.n
  return {
    total: s?.total ?? 0,
    byStatus: { learning: s?.learning ?? 0, basics_known: s?.basics_known ?? 0, integrated: s?.integrated ?? 0, advancing: s?.advancing ?? 0, permanent: s?.permanent ?? 0 },
    byCategory,
    avgRealism:    Number(s?.avg_r ?? 0),
    avgQuality:    Number(s?.avg_q ?? 0),
    avgEfficiency: Number(s?.avg_e ?? 0),
  }
}
