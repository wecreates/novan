/**
 * R146.330 #21-24, #47-50 — discovery, frequency tracking, meta-cognition.
 */
import { db } from '../db/client.js'
import { workspaceMemory, events } from '../db/schema.js'
import { and, eq, gte, desc, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── #22 Op call frequency (in-memory accumulator; flushed via events) ───
const _opCounts = new Map<string, { count: number; lastAt: number; totalMs: number; totalCostUsd: number }>()

export function recordOpCall(op: string, ms: number, costUsd = 0): void {
  const cur = _opCounts.get(op) ?? { count: 0, lastAt: 0, totalMs: 0, totalCostUsd: 0 }
  cur.count += 1; cur.lastAt = Date.now(); cur.totalMs += ms; cur.totalCostUsd += costUsd
  _opCounts.set(op, cur)
  if (_opCounts.size > 5000) {
    // Drop oldest
    const oldest = _opCounts.keys().next().value
    if (oldest) _opCounts.delete(oldest)
  }
}

export function opUsageSnapshot(): Array<{ op: string; count: number; lastAt: number; avgMs: number; totalCostUsd: number }> {
  return Array.from(_opCounts.entries()).map(([op, v]) => ({
    op, count: v.count, lastAt: v.lastAt,
    avgMs: v.count > 0 ? Math.round(v.totalMs / v.count) : 0,
    totalCostUsd: Number(v.totalCostUsd.toFixed(4)),
  })).sort((a, b) => b.count - a.count)
}

// ─── #21 Op browse (list + filter + sort by usage) ───────────────────────
export async function opBrowse(input: {
  search?: string; risk?: string; sortBy?: 'name' | 'usage' | 'recent'
}): Promise<Array<{ name: string; description: string; risk: string; usage?: { count: number; avgMs: number; lastAt: number } }>> {
  const { OPERATIONS } = await import('./brain-task.js')
  const usage = new Map(opUsageSnapshot().map(u => [u.op, u]))
  let list = Object.entries(OPERATIONS as Record<string, { description?: string; risk?: string }>)
    .map(([name, spec]) => ({
      name, description: spec.description ?? '', risk: spec.risk ?? 'low',
      ...(usage.has(name) ? { usage: usage.get(name)! } : {}),
    }))
  if (input.search) {
    const q = input.search.toLowerCase()
    list = list.filter(o => o.name.toLowerCase().includes(q) || o.description.toLowerCase().includes(q))
  }
  if (input.risk) list = list.filter(o => o.risk === input.risk)
  if (input.sortBy === 'usage') {
    list = list.sort((a, b) => ((b.usage?.count ?? 0) - (a.usage?.count ?? 0)))
  } else if (input.sortBy === 'recent') {
    list = list.sort((a, b) => ((b.usage?.lastAt ?? 0) - (a.usage?.lastAt ?? 0)))
  } else {
    list = list.sort((a, b) => a.name.localeCompare(b.name))
  }
  return list.slice(0, 200)
}

// ─── #24 Suggested ops based on context ──────────────────────────────────
const KEYWORD_TO_OPS: Array<{ rx: RegExp; suggest: string[] }> = [
  { rx: /\b(vendor|client|partner|customer)\s+[A-Z][a-z]/, suggest: ['relationship.upsert', 'relationship.recall'] },
  { rx: /\b(cost|spend|budget|forecast)\b/i,              suggest: ['cost.forecast', 'cost.by_business', 'cost.cap_enforcement_check'] },
  { rx: /\b(what did|catch me up|recap|summary)\b/i,      suggest: ['recap.summarize', 'brain.what_did_you_do_today'] },
  { rx: /\b(image|picture|logo|design)\b/i,               suggest: ['image.generate'] },
  { rx: /\b(video|short|reel)\b/i,                        suggest: ['video.generate'] },
  { rx: /\b(remember|important|note that|don't forget)\b/i, suggest: ['memory.remember', 'memory.promote_if_important'] },
  { rx: /\b(slack|gmail|calendar|inbox)\b/i,              suggest: ['connector_cred.list', 'email.triage'] },
]

export function suggestOps(userMessage: string): string[] {
  const matched: string[] = []
  for (const { rx, suggest } of KEYWORD_TO_OPS) {
    if (rx.test(userMessage)) matched.push(...suggest)
  }
  return Array.from(new Set(matched)).slice(0, 6)
}

// ─── #47 about_me — narrative self-description ───────────────────────────
export async function aboutMe(workspaceId: string): Promise<{
  identity:      string
  capabilities:  string
  recentChanges: string[]
  notSure:       string[]
}> {
  const { completenessReport } = await import('./brain-completeness.js')
  const r = completenessReport()
  // Recent changes from last 30 events of type r-marker
  const evtRows = await db.select({ type: events.type, createdAt: events.createdAt })
    .from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      eq(events.type, 'platform.r_marker'),
    ))
    .orderBy(desc(events.createdAt))
    .limit(5).catch(() => [])
  const recentChanges = evtRows.length > 0
    ? evtRows.map(e => `R${new Date(Number(e.createdAt)).toISOString().slice(0, 10)} marker`)
    : ['I haven\'t tracked specific recent changes yet — the R-marker eventing is new.']
  const notSure = r.gaps.map(g => `${g.name} (${g.status})${g.gap ? `: ${g.gap}` : ''}`)
  return {
    identity: 'I\'m Novan — an autonomous teammate for your projects. I remember our conversations, run your daily routine, and act on things you authorize me to.',
    capabilities: `${r.present}/${r.total} capabilities present across perception, memory, reasoning, action, meta, and social. The ones still partial: ${r.gaps.map(g => g.name).join(', ') || 'none'}.`,
    recentChanges,
    notSure,
  }
}

// ─── #48 Persona drift detector ──────────────────────────────────────────
export async function personaDrift(workspaceId: string): Promise<{
  driftDetected: boolean
  notes: string[]
}> {
  const notes: string[] = []
  const { getPersonaPreference } = await import('./r328-extras.js')
  const pref = await getPersonaPreference(workspaceId)
  if (pref.totalTurns < 20) {
    notes.push(`Only ${pref.totalTurns} turns recorded — not enough signal to detect drift yet.`)
    return { driftDetected: false, notes }
  }
  // Compare current default energy vs first-half vs second-half ratios.
  // We don't have per-turn history; approximate by ratio crossing 0.6 threshold.
  if (pref.terseRatio >= 0.7 && pref.defaultEnergy !== 'terse') {
    notes.push('Operator skews terse but default is still warm — drift candidate.')
  }
  if (pref.analyticalRatio >= 0.7 && pref.defaultEnergy !== 'analytical') {
    notes.push('Operator skews analytical but default is still warm — drift candidate.')
  }
  return { driftDetected: notes.length > 0, notes }
}

// ─── #49 mistake memory — "don't do this again" ──────────────────────────
export async function recordMistake(input: {
  workspaceId: string
  what:        string
  correction:  string
}): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(workspaceMemory).values({
    workspaceId: input.workspaceId,
    key: `_mistake.${id.slice(0, 12)}`,
    value: JSON.stringify({ what: input.what.slice(0, 1000), correction: input.correction.slice(0, 1000), at: Date.now() }),
    scope: 'system', importance: 95,  // very high — mistakes are remembered
    updatedAt: Date.now(),
  } as never).catch(() => null)
  return { id }
}

export async function listMistakes(workspaceId: string, limit = 50): Promise<Array<{ id: string; what: string; correction: string; at: number }>> {
  const rows = await db.select({ key: workspaceMemory.key, value: workspaceMemory.value })
    .from(workspaceMemory)
    .where(and(
      eq(workspaceMemory.workspaceId, workspaceId),
      sql`${workspaceMemory.key} LIKE '_mistake.%'`,
    ))
    .limit(limit)
    .catch(() => [])
  const out: Array<{ id: string; what: string; correction: string; at: number }> = []
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.value) as { what: string; correction: string; at: number }
      out.push({ id: r.key.replace('_mistake.', ''), ...parsed })
    } catch { /* skip malformed */ }
  }
  return out.sort((a, b) => b.at - a.at)
}

// ─── #50 operator rating loop ────────────────────────────────────────────
export async function recordReplyRating(input: {
  workspaceId:    string
  conversationId?: string
  messageId?:     string
  rating:         'up' | 'down' | 'skip'
  comment?:       string
}): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(events).values({
    id, type: 'reply.rating', workspaceId: input.workspaceId,
    payload: { rating: input.rating, ...(input.messageId ? { messageId: input.messageId } : {}), ...(input.comment ? { comment: input.comment.slice(0, 1000) } : {}) },
    traceId: id, correlationId: input.conversationId ?? id, causationId: null,
    source: 'r330-discovery', version: 1, createdAt: Date.now(),
  } as never).catch(() => null)
  return { id }
}

export async function ratingStats(workspaceId: string, windowDays = 30): Promise<{
  total: number; up: number; down: number; skip: number; satisfactionRate: number
}> {
  const since = Date.now() - windowDays * 86400_000
  const rows = await db.select({ payload: events.payload })
    .from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      eq(events.type, 'reply.rating'),
      gte(events.createdAt, since),
    ))
    .catch(() => [])
  let up = 0, down = 0, skip = 0
  for (const r of rows) {
    const rating = (r.payload as { rating?: string } | null)?.rating
    if (rating === 'up') up++
    else if (rating === 'down') down++
    else skip++
  }
  const total = rows.length
  const rated = up + down
  return {
    total, up, down, skip,
    satisfactionRate: rated > 0 ? Number((up / rated).toFixed(2)) : 0,
  }
}
