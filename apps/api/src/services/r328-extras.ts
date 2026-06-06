/**
 * R146.328 — small extras across the R326+R327 surface.
 *   #10 narrative summary on what_did_you_do_today
 *   #11 clarify outcome tracking (resolve)
 *   #12 persona preference learning
 *   #14 per-business cost attribution
 *   #15 LLM provider failover test
 *   #22 auto-fire whatDidYouDo on intent
 */
import { db } from '../db/client.js'
import { workspaceMemory, clarifyEvents, aiUsage, businesses, workflowRuns, events } from '../db/schema.js'
import { and, eq, gte, sql, desc } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── #12 persona preference ──────────────────────────────────────────────
const PREF_KEY = '_personaPreference'

export interface PersonaPreference {
  totalTurns:    number
  terseRatio:    number   // 0..1
  warmRatio:     number
  analyticalRatio: number
  defaultEnergy: 'terse' | 'warm' | 'analytical'
}

export async function getPersonaPreference(workspaceId: string): Promise<PersonaPreference> {
  const [row] = await db.select({ value: workspaceMemory.value })
    .from(workspaceMemory)
    .where(and(eq(workspaceMemory.workspaceId, workspaceId), eq(workspaceMemory.key, PREF_KEY)))
    .limit(1).catch(() => [])
  if (!row?.value) {
    return { totalTurns: 0, terseRatio: 0, warmRatio: 0, analyticalRatio: 0, defaultEnergy: 'warm' }
  }
  try {
    const v = JSON.parse(row.value) as PersonaPreference
    return v
  } catch {
    return { totalTurns: 0, terseRatio: 0, warmRatio: 0, analyticalRatio: 0, defaultEnergy: 'warm' }
  }
}

export async function recordPersonaTurn(workspaceId: string, energy: 'terse' | 'warm' | 'analytical'): Promise<void> {
  const cur = await getPersonaPreference(workspaceId)
  const total = cur.totalTurns + 1
  const terseN = Math.round(cur.terseRatio * cur.totalTurns) + (energy === 'terse' ? 1 : 0)
  const warmN  = Math.round(cur.warmRatio  * cur.totalTurns) + (energy === 'warm'  ? 1 : 0)
  const analN  = Math.round(cur.analyticalRatio * cur.totalTurns) + (energy === 'analytical' ? 1 : 0)
  const next: PersonaPreference = {
    totalTurns: total,
    terseRatio: terseN / total,
    warmRatio:  warmN  / total,
    analyticalRatio: analN / total,
    defaultEnergy: 'warm',
  }
  // Default flips when ratio crosses 0.6 after at least 10 turns.
  if (total >= 10) {
    if (next.terseRatio      >= 0.6) next.defaultEnergy = 'terse'
    else if (next.analyticalRatio >= 0.6) next.defaultEnergy = 'analytical'
    else next.defaultEnergy = 'warm'
  }
  const now = Date.now()
  await db.insert(workspaceMemory).values({
    workspaceId, key: PREF_KEY, value: JSON.stringify(next),
    scope: 'system', importance: 60, updatedAt: now,
  } as never).onConflictDoUpdate({
    target: [workspaceMemory.workspaceId, workspaceMemory.key],
    set: { value: JSON.stringify(next), updatedAt: now },
  }).catch(() => null)
}

// ─── #11 clarify resolve ─────────────────────────────────────────────────
export async function clarifyResolve(input: { id: string; answer: string }): Promise<{ ok: boolean }> {
  await db.update(clarifyEvents)
    .set({ resolved: true, answer: input.answer.slice(0, 4000), resolvedAt: Date.now() } as never)
    .where(eq(clarifyEvents.id, input.id))
    .catch(() => null)
  return { ok: true }
}

export async function clarifyOutcomes(workspaceId: string, windowDays = 14): Promise<{
  total: number; resolved: number; unresolved: number; resolveRate: number
}> {
  const since = Date.now() - windowDays * 86400_000
  const rows = await db.select({ resolved: clarifyEvents.resolved })
    .from(clarifyEvents)
    .where(and(eq(clarifyEvents.workspaceId, workspaceId), gte(clarifyEvents.createdAt, since)))
    .catch(() => [])
  const total = rows.length
  const resolved = rows.filter(r => r.resolved).length
  return { total, resolved, unresolved: total - resolved, resolveRate: total > 0 ? resolved / total : 0 }
}

// ─── #14 cost attribution ────────────────────────────────────────────────
export interface BusinessCost { businessId: string; name: string; spentUsd: number; rows: number }

export async function costByBusiness(workspaceId: string, windowDays = 30): Promise<BusinessCost[]> {
  const since = Date.now() - windowDays * 86400_000
  // Join ai_usage → workflow_runs → businessId via metadata
  const rows = await db.select({
    workflowRunId: aiUsage.workflowRunId,
    costUsd:       aiUsage.costUsd,
  })
    .from(aiUsage)
    .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, since)))
    .catch(() => [])
  const byWorkflow = new Map<string, number>()
  for (const r of rows) {
    if (!r.workflowRunId) continue
    byWorkflow.set(r.workflowRunId, (byWorkflow.get(r.workflowRunId) ?? 0) + Number(r.costUsd ?? 0))
  }
  if (byWorkflow.size === 0) return []
  const wfRows = await db.select({
    id:       workflowRuns.id,
    metadata: workflowRuns.metadata,
  })
    .from(workflowRuns)
    .where(eq(workflowRuns.workspaceId, workspaceId))
    .catch(() => [])
  const byBiz = new Map<string, { spentUsd: number; rows: number }>()
  for (const wf of wfRows) {
    const cost = byWorkflow.get(wf.id) ?? 0
    if (cost === 0) continue
    const meta = (wf.metadata ?? {}) as { businessId?: string }
    const bid = meta.businessId ?? 'unattributed'
    const cur = byBiz.get(bid) ?? { spentUsd: 0, rows: 0 }
    byBiz.set(bid, { spentUsd: cur.spentUsd + cost, rows: cur.rows + 1 })
  }
  const bizRows = await db.select({ id: businesses.id, name: businesses.name })
    .from(businesses)
    .where(eq(businesses.workspaceId, workspaceId))
    .catch(() => [])
  const nameOf = new Map(bizRows.map(b => [b.id, b.name]))
  return Array.from(byBiz.entries()).map(([businessId, { spentUsd, rows: n }]) => ({
    businessId, name: nameOf.get(businessId) ?? 'unattributed',
    spentUsd: Number(spentUsd.toFixed(4)), rows: n,
  })).sort((a, b) => b.spentUsd - a.spentUsd)
}

// ─── #15 LLM failover test ───────────────────────────────────────────────
export async function chatFailoverTest(workspaceId: string): Promise<{
  chainAttempted: string[]; finalProvider: string | null; ok: boolean; reason?: string
}> {
  const chainAttempted: string[] = []
  try {
    // R329 #1 — use the actual chat-providers entry point streamChat.
    const { streamChat } = await import('./chat-providers.js')
    let provider: string | null = null
    const gen = streamChat(workspaceId, [
      { role: 'system', content: 'Reply with the single character: OK' },
      { role: 'user',   content: 'OK' },
    ], { failoverTest: true } as never)
    const collected: string[] = []
    while (true) {
      const r = await gen.next()
      if (r.done) {
        provider = r.value?.provider ?? null
        if (provider) chainAttempted.push(provider)
        break
      }
      if (r.value?.kind === 'provider') chainAttempted.push(String(r.value.provider))
      if (r.value?.kind === 'delta')    collected.push(String(r.value.text ?? ''))
    }
    return { chainAttempted, finalProvider: provider, ok: collected.join('').length > 0 }
  } catch (e) {
    return { chainAttempted, finalProvider: null, ok: false, reason: (e as Error).message }
  }
}

// ─── #22 auto-fire what_did_you_do on intent ─────────────────────────────
const WDID_RX = /\b(what did you do|what'?s? new|catch me up|while i was away|since (?:yesterday|last|when))/i

export function looksLikeRecapRequest(userMessage: string): boolean {
  return WDID_RX.test(userMessage)
}

// ─── #10 narrative summary on what_did_you_do_today ──────────────────────
export async function summarizeTimeline(workspaceId: string, windowHours = 24): Promise<{
  prose: string; bullets: string[]; entryCount: number
}> {
  const { whatDidYouDo } = await import('./r327-misc.js')
  const tl = await whatDidYouDo(workspaceId, windowHours)
  if (tl.entries.length === 0) {
    return { prose: 'Nothing notable in the last window.', bullets: [], entryCount: 0 }
  }
  // Heuristic prose — avoids an LLM call for the basic case. The chat layer
  // can call this then optionally re-summarize via LLM if the operator wants.
  const cats = Object.entries(tl.byCategory).sort((a, b) => b[1] - a[1])
  const top = cats.slice(0, 3).map(([k, v]) => `${v} ${k}`).join(', ')
  const newest = tl.entries[0]
  const oldest = tl.entries[tl.entries.length - 1]
  let prose = `In the last ${windowHours} hours: ${tl.totalEvents} events across ${cats.length} categories (top: ${top}).`
  if (newest && oldest && newest.at && oldest.at) {
    const recentSummary = newest.summary || newest.type
    prose += ` Most recent: ${recentSummary.slice(0, 100)}.`
  }
  const bullets = tl.entries.slice(0, 10).map(e => {
    const when = new Date(e.at).toISOString().slice(11, 16)
    return `${when} · ${e.type} · ${e.summary.slice(0, 80)}`
  })
  // Emit so the timeline itself becomes part of "what did you do"
  await db.insert(events).values({
    id: uuidv7(), type: 'recap.generated', workspaceId,
    payload: { windowHours, entryCount: tl.entries.length },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'r328-extras', version: 1, createdAt: Date.now(),
  } as never).catch(() => null)
  return { prose, bullets, entryCount: tl.entries.length }
}

// ─── small util: keep for #17 cron-metric drop (re-exported elsewhere) ───
export const CRON_METRIC_DROP_TYPES = new Set(['cron.metric', 'cron.tick.timing'])

void sql; void desc  // anchor for tree-shake
