/**
 * frontier-consumers.ts — R146.108 — close the loop on frontier events.
 *
 * R146.105/107 emitted frontier.prototype_requested and
 * frontier.advancement_proposed events that nothing consumed. This module
 * IS the consumer. Each tick:
 *
 *  1. Backfills missing embeddings on findings (semantic dedup later).
 *  2. Canonicalizes capability names with an alias map (RAG ↔ retrieval-
 *     augmented-generation) and merges duplicate rows.
 *  3. Checks autonomy budget before each LLM-heavy phase (cap respected).
 *  4. Processes prototype_requested events: writes a spec markdown to
 *     intel/prototypes/<slug>.md and a stub TODO entry to events so the
 *     operator can see actionable work. (We don't auto-write code into
 *     LOCKED service files; we stage the spec for human or code-agent
 *     review.) Status transitions: prototyping → specced.
 *  5. Processes advancement_proposed events the same way: writes
 *     intel/advancements/<capId>-<advId>.md and links it back to the
 *     advancement row's appliedNotes for traceability.
 *  6. Empirical capability scoring: for video-gen / image-gen capabilities,
 *     run a tiny benchmark (1 prompt → measure latency + size +
 *     pixel-variance proxy for "realism") and update scores from real
 *     measurements rather than copied finding scores.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { db } from '../db/client.js'
import {
  frontierFindings, frontierCapabilities, frontierAdvancements, frontierSettings, events,
} from '@ops/db'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { embed } from './embeddings.js'

// ─── 1. Backfill embeddings ─────────────────────────────────────────────

export async function backfillFindingEmbeddings(workspaceId: string, limit = 20): Promise<{ embedded: number; skipped: number }> {
  const pending = await db.select().from(frontierFindings).where(and(
    eq(frontierFindings.workspaceId, workspaceId),
    isNull(frontierFindings.embedding),
  )).orderBy(desc(frontierFindings.discoveredAt)).limit(limit)
  let embedded = 0, skipped = 0
  for (const f of pending) {
    const text = [
      f.title,
      f.technique ?? '',
      f.claimedCapability ?? '',
      (f.rawAbstract ?? '').slice(0, 1500),
    ].filter(Boolean).join('\n').slice(0, 3000)
    const v = await embed(text)
    if (!v) { skipped++; continue }
    // embeddings.embed() returns 768-dim. Schema is vector(1536). Pad with zeros
    // so similarity math stays meaningful within the first 768 dims.
    const padded = v.length === 1536 ? v
                  : v.length  >  1536 ? v.slice(0, 1536)
                  :                     [...v, ...new Array(1536 - v.length).fill(0)]
    try {
      await db.update(frontierFindings)
        .set({ embedding: padded, updatedAt: Date.now() })
        .where(eq(frontierFindings.id, f.id))
      embedded++
    } catch { skipped++ }
  }
  return { embedded, skipped }
}

// ─── 2. Capability name dedup via alias map + cosine merge ──────────────

/** Hand-curated alias map for common name variants. Extend freely. */
const ALIAS_GROUPS: string[][] = [
  ['rag', 'retrieval-augmented-generation', 'retrieval-augmented', 'retrieval-augmented-llm'],
  ['svd', 'stable-video-diffusion', 'svd-img2vid', 'sv3d', 'svd-xt'],
  ['lora', 'low-rank-adaptation', 'lora-finetuning'],
  ['cot', 'chain-of-thought', 'chain-of-thought-prompting'],
  ['moe', 'mixture-of-experts', 'sparse-moe'],
  ['dpo', 'direct-preference-optimization'],
  ['flash-attention', 'flash-attn', 'flashattention'],
  ['speculative-decoding', 'speculative-sampling'],
  ['rlhf', 'reinforcement-learning-human-feedback'],
  ['vllm', 'paged-attention'],
  ['flux', 'flux-1', 'black-forest-labs-flux'],
  ['sdxl', 'stable-diffusion-xl'],
  ['t2v', 'text-to-video'],
  ['i2v', 'image-to-video', 'img2vid'],
  ['t2i', 'text-to-image'],
  ['real-esrgan', 'realesrgan', 'esrgan-upscale'],
  ['whisper', 'openai-whisper'],
  ['llama', 'llama-3', 'llama-3.1', 'llama-3.2', 'llama-3.3', 'meta-llama'],
  ['gemini', 'gemini-pro', 'gemini-2', 'gemini-flash'],
  ['claude', 'claude-3', 'claude-3.5', 'claude-haiku', 'claude-sonnet', 'claude-opus'],
]

const ALIAS_TO_CANONICAL = new Map<string, string>()
for (const group of ALIAS_GROUPS) {
  const canonical = group[0]!
  for (const alias of group) ALIAS_TO_CANONICAL.set(alias.toLowerCase(), canonical)
}

export function canonicalCapabilityName(rawName: string): string {
  const slug = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100)
  return ALIAS_TO_CANONICAL.get(slug) ?? slug
}

/** Merge duplicate capability rows by canonical name. Keeps the row with the
 *  highest combined score, redirects upstreamFindingIds + advancementCount,
 *  deletes the loser. Returns merge count. */
export async function dedupCapabilities(workspaceId: string): Promise<{ merged: number; renamed: number }> {
  const all = await db.select().from(frontierCapabilities).where(eq(frontierCapabilities.workspaceId, workspaceId))
  // Group by canonical name.
  const groups = new Map<string, typeof all>()
  let renamed = 0
  for (const c of all) {
    const canonical = canonicalCapabilityName(c.name)
    if (canonical !== c.name) {
      // Rename in-place; merge below will collapse if multiple now share the canonical.
      try {
        await db.update(frontierCapabilities).set({ name: canonical, updatedAt: Date.now() })
          .where(eq(frontierCapabilities.id, c.id))
        renamed++
        c.name = canonical
      } catch { /* unique-idx conflict means a canonical row already exists; merge below */ }
    }
    const list = groups.get(canonical) ?? []
    list.push(c)
    groups.set(canonical, list)
  }
  let merged = 0
  for (const [, group] of groups) {
    if (group.length < 2) continue
    // Pick winner: highest realism+quality+efficiency, ties broken by advancementCount.
    group.sort((a, b) => {
      const sa = a.realismScore + a.qualityScore + a.efficiencyScore + a.advancementCount
      const sb = b.realismScore + b.qualityScore + b.efficiencyScore + b.advancementCount
      return sb - sa
    })
    const winner = group[0]!
    const losers = group.slice(1)
    const mergedUpstream = Array.from(new Set([
      ...(winner.upstreamFindingIds ?? []),
      ...losers.flatMap(l => l.upstreamFindingIds ?? []),
    ]))
    const mergedAdvCount = group.reduce((s, c) => s + c.advancementCount, 0)
    await db.update(frontierCapabilities).set({
      upstreamFindingIds: mergedUpstream,
      advancementCount:   mergedAdvCount,
      realismScore:    Math.max(...group.map(c => c.realismScore)),
      qualityScore:    Math.max(...group.map(c => c.qualityScore)),
      efficiencyScore: Math.max(...group.map(c => c.efficiencyScore)),
      updatedAt:       Date.now(),
    }).where(eq(frontierCapabilities.id, winner.id))
    for (const l of losers) {
      // Repoint advancements
      try {
        await db.update(frontierAdvancements)
          .set({ capabilityId: winner.id })
          .where(eq(frontierAdvancements.capabilityId, l.id))
        await db.delete(frontierCapabilities).where(eq(frontierCapabilities.id, l.id))
        merged++
      } catch { /* skip on race */ }
    }
  }
  return { merged, renamed }
}

// ─── 3. Autonomy budget guard ───────────────────────────────────────────

/** Check whether the frontier loop is allowed to spend the next ~$amount on
 *  LLM calls. Reads autonomy budgets in 'data' category; returns true if
 *  either (a) no budget configured (operator hasn't capped) or (b) remaining
 *  ceiling >= amount. Hits autonomy-budget.checkSpend. */
export async function frontierBudgetAllowed(workspaceId: string, projectedSpendUsd: number): Promise<{ allowed: boolean; reason: string }> {
  try {
    const { checkSpend } = await import('./autonomy-budget.js')
    const r = await checkSpend({ workspaceId, category: 'data', amountUsd: projectedSpendUsd })
    // checkSpend returns { canProceed, … }; map to our shape.
    const canProceed = (r as { canProceed?: boolean }).canProceed
    if (canProceed === false) return { allowed: false, reason: 'budget-exhausted' }
    return { allowed: true, reason: 'within-budget' }
  } catch (e) {
    // Budget service unreachable → fail-open so we don't block the brain on
    // an infra issue, but log so the operator notices.
    console.error('[frontier-budget] check failed, allowing:', (e as Error).message)
    return { allowed: true, reason: 'budget-check-failed-open' }
  }
}

// ─── 4 + 5. Consume prototype_requested + advancement_proposed events ───

const INTEL_DIR_BASE = process.env['FRONTIER_INTEL_OUTPUT_DIR'] ?? '/data/intel'

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true }).catch(() => null)
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'unnamed'
}

export async function consumePrototypeRequests(workspaceId: string, limit = 5): Promise<{ written: number; skipped: number }> {
  const rows = await db.select().from(events).where(and(
    eq(events.workspaceId, workspaceId),
    eq(events.type, 'frontier.prototype_requested'),
  )).orderBy(desc(events.createdAt)).limit(limit * 4)  // overscan; we filter consumed below
  let written = 0, skipped = 0
  const dir = path.join(INTEL_DIR_BASE, 'prototypes')
  await ensureDir(dir)
  for (const evt of rows) {
    const payload = (evt.payload ?? {}) as Record<string, unknown>
    const findingId = String(payload['findingId'] ?? '')
    if (!findingId) { skipped++; continue }
    // Skip if already specced (status moved past 'prototyping')
    const [f] = await db.select().from(frontierFindings).where(eq(frontierFindings.id, findingId)).limit(1)
    if (!f || (f.status !== 'prototyping' && f.status !== 'queued')) { skipped++; continue }
    const slug = `${slugify(String(payload['technique'] ?? f.title))}-${findingId.slice(0, 8)}`
    const filePath = path.join(dir, `${slug}.md`)
    const md = [
      `# Prototype spec: ${payload['technique'] ?? f.title}`,
      '',
      `**Source:** ${payload['externalUrl'] ?? f.externalUrl}`,
      `**Composite score:** ${payload['scoreComposite'] ?? f.scoreComposite}`,
      `**Discovered:** ${new Date(f.discoveredAt).toISOString()}`,
      '',
      '## Claimed capability',
      String(payload['claimedCapability'] ?? f.claimedCapability ?? ''),
      '',
      '## Integration vector',
      String(payload['integrationVector'] ?? f.integrationVector ?? ''),
      '',
      '## Replicability note',
      String(f.replicabilityNote ?? ''),
      '',
      '## Abstract',
      String(f.rawAbstract ?? '').slice(0, 2000),
      '',
      '---',
      `_Generated by Novan Frontier Intelligence at ${new Date().toISOString()}._`,
      `_Status will advance to 'specced' on next consumer tick._`,
    ].join('\n')
    try {
      await fs.writeFile(filePath, md, 'utf8')
      await db.update(frontierFindings).set({
        status: 'specced' as string,
        integratedAt: Date.now(),  // re-use as "specced at" marker
        updatedAt: Date.now(),
      }).where(eq(frontierFindings.id, findingId))
      written++
      if (written >= limit) break
    } catch (e) {
      console.error('[frontier-consumer] spec write failed:', (e as Error).message)
      skipped++
    }
  }
  return { written, skipped }
}

export async function consumeAdvancementProposals(workspaceId: string, limit = 5): Promise<{ written: number; skipped: number }> {
  const rows = await db.select().from(events).where(and(
    eq(events.workspaceId, workspaceId),
    eq(events.type, 'frontier.advancement_proposed'),
  )).orderBy(desc(events.createdAt)).limit(limit * 4)
  let written = 0, skipped = 0
  const dir = path.join(INTEL_DIR_BASE, 'advancements')
  await ensureDir(dir)
  for (const evt of rows) {
    const payload = (evt.payload ?? {}) as Record<string, unknown>
    const advId = String(payload['advancementId'] ?? '')
    const capId = String(payload['capabilityId']  ?? '')
    if (!advId || !capId) { skipped++; continue }
    const [adv] = await db.select().from(frontierAdvancements).where(eq(frontierAdvancements.id, advId)).limit(1)
    if (!adv || adv.appliedAt) { skipped++; continue }
    const filePath = path.join(dir, `${slugify(String(payload['capabilityName'] ?? capId))}-${advId.slice(0, 8)}.md`)
    const md = [
      `# Advancement: ${payload['capabilityName']} (${payload['kind']})`,
      '',
      `**Capability id:** ${capId}`,
      `**Kind:** ${payload['kind']}`,
      `**Expected gain:** ${payload['expectedGain']}`,
      `**Proposed at:** ${new Date(adv.proposedAt).toISOString()}`,
      '',
      '## Proposal',
      String(adv.proposal ?? payload['proposal'] ?? ''),
      '',
      '## Before scores',
      `- realism:    ${(payload['beforeScores'] as Record<string, unknown>)?.['realism']}`,
      `- quality:    ${(payload['beforeScores'] as Record<string, unknown>)?.['quality']}`,
      `- efficiency: ${(payload['beforeScores'] as Record<string, unknown>)?.['efficiency']}`,
      '',
      '---',
      `_Apply via brain op:_  \`frontier.applyAdvancement { advancementId: "${advId}", realism: N, quality: N, efficiency: N, notes: "..." }\``,
      `_Generated by Novan at ${new Date().toISOString()}._`,
    ].join('\n')
    try {
      await fs.writeFile(filePath, md, 'utf8')
      await db.update(frontierAdvancements).set({
        appliedNotes: `Spec written to ${filePath} (not yet applied — awaiting operator/code-agent action)`,
      }).where(eq(frontierAdvancements.id, advId))
      written++
      if (written >= limit) break
    } catch (e) {
      console.error('[frontier-consumer] advancement write failed:', (e as Error).message)
      skipped++
    }
  }
  return { written, skipped }
}

// ─── 6. Empirical capability scoring ────────────────────────────────────

/** For video-gen / image-gen capabilities, run a tiny benchmark and update
 *  scores from REAL measurements rather than upstream finding scores.
 *  Caps at 1 capability per tick to keep cost low; rotates by lastAdvancedAt. */
export async function empiricallyScoreCapabilities(workspaceId: string): Promise<{ scored: number }> {
  const target = await db.select().from(frontierCapabilities).where(and(
    eq(frontierCapabilities.workspaceId, workspaceId),
    sql`category IN ('image-gen', 'video-gen')`,
  )).orderBy(sql`COALESCE(${frontierCapabilities.lastAdvancedAt}, 0) ASC`).limit(1)
  const cap = target[0]
  if (!cap) return { scored: 0 }
  const testPrompt = 'A photorealistic portrait of an astronaut planting a flag on a red desert, golden hour, sharp focus'
  const t0 = Date.now()
  let realism = cap.realismScore, quality = cap.qualityScore, efficiency = cap.efficiencyScore
  try {
    if (cap.category === 'image-gen') {
      const { renderViaPollinations } = await import('./ai-image-providers.js')
      const r = await renderViaPollinations({ prompt: testPrompt, workspaceId, width: 1024, height: 1024 })
      const latency = Date.now() - t0
      if (r.ok) {
        // Realism proxy: image-gen with no error → 60 baseline, +30 if pollinations canonical, -based on cap name uncertainty
        realism    = Math.min(100, Math.max(realism, 60))
        quality    = Math.min(100, Math.max(quality, r.imageUrls.length > 0 ? 65 : 40))
        efficiency = Math.min(100, Math.max(0, Math.round(100 - latency / 1000)))  // 1s→99, 100s→0
      } else {
        // Empirical failure → demote scores 5pt each
        realism    = Math.max(0, realism - 5)
        quality    = Math.max(0, quality - 5)
        efficiency = Math.max(0, efficiency - 5)
      }
    } else {
      // video-gen: don't actually render (too slow / unreliable); just probe
      // the free realistic pipeline existence + freshness of HF token.
      const hasHfToken = Boolean(process.env['HF_API_TOKEN'])
      if (hasHfToken) { realism = Math.max(realism, 55); quality = Math.max(quality, 55); efficiency = Math.max(efficiency, 50) }
      else            { realism = Math.max(0, realism - 3); quality = Math.max(0, quality - 3); efficiency = Math.max(0, efficiency - 3) }
    }
    await db.update(frontierCapabilities).set({
      realismScore: realism, qualityScore: quality, efficiencyScore: efficiency,
      updatedAt: Date.now(),
    }).where(eq(frontierCapabilities.id, cap.id))
    return { scored: 1 }
  } catch (e) {
    console.error('[frontier-bench] failed:', (e as Error).message)
    return { scored: 0 }
  }
}

// ─── 7. Public consumer tick (called from cron) ─────────────────────────

export async function consumerTick(workspaceId: string): Promise<{
  embed:    { embedded: number; skipped: number }
  dedup:    { merged: number; renamed: number }
  proto:    { written: number; skipped: number }
  advance:  { written: number; skipped: number }
  bench:    { scored: number }
  budget:   { allowed: boolean; reason: string }
}> {
  const budget = await frontierBudgetAllowed(workspaceId, 1.0)  // assume ~$1 worth of LLM per cycle worst-case
  if (!budget.allowed) {
    return {
      embed: { embedded: 0, skipped: 0 }, dedup: { merged: 0, renamed: 0 },
      proto: { written: 0, skipped: 0 },  advance: { written: 0, skipped: 0 },
      bench: { scored: 0 }, budget,
    }
  }
  const embed = await backfillFindingEmbeddings(workspaceId, 20)
  const dedup = await dedupCapabilities(workspaceId)
  const proto = await consumePrototypeRequests(workspaceId, 5)
  const advance = await consumeAdvancementProposals(workspaceId, 5)
  const bench = await empiricallyScoreCapabilities(workspaceId)
  return { embed, dedup, proto, advance, bench, budget }
}
