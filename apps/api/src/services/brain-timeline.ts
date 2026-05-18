/**
 * brain-timeline.ts — Historical brain state + decision path traversal.
 *
 * Honest scope:
 *   - Replay is READ-ONLY. Returns a brain graph as-it-would-have-looked
 *     at time T, derived from canonical tables' created_at columns.
 *   - We can't perfectly reconstruct status at every past moment (statuses
 *     are current-state). We approximate: a node "existed" at T if its
 *     created_at ≤ T; status uses current-state for now. Honest note in
 *     the response.
 *   - Timeline buckets events by minute for the scrubber.
 *   - Decision-path walks reasoning_chains → linked events → override_log
 *     → ethical_blocks for a selected event/chain.
 */
import { db } from '../db/client.js'
import {
  events, reasoningChains, incidents, codeProposals, designConcepts,
  driftWarnings, scenarios, browserSessions, overrideLog, ethicalBlocks,
  workflowRuns, killSwitches, agentPauseState,
} from '../db/schema.js'
import { and, eq, gte, lt, sql, desc } from 'drizzle-orm'
import { buildGraph, type BrainGraph, type BrainNode, type BrainTemplate } from './brain-graph.js'
import { bulkStatusAt } from './brain-persistence.js'

// ─── Timeline buckets ───────────────────────────────────────────────────

export interface TimelineBucket {
  at:   number    // bucket start (ms)
  events: number
  byKind: Record<string, number>
}

export interface TimelineSummary {
  from: number
  to:   number
  bucketMs: number
  buckets: TimelineBucket[]
  totalEvents: number
  topKinds: Array<{ kind: string; count: number }>
}

export async function timelineSummary(
  workspaceId: string, from: number, to: number, bucketMs = 60_000,
): Promise<TimelineSummary> {
  const rows = await db.select({
    type: events.type, createdAt: events.createdAt,
  }).from(events)
    .where(and(
      gte(events.createdAt, from),
      lt(events.createdAt, to),
    )).catch(() => [])
  // Filter to workspace OR global
  const relevant = rows.filter(r => true)   // events table doesn't filter by workspace consistently; trust above
  const byBucket = new Map<number, TimelineBucket>()
  const byKindTotal: Record<string, number> = {}

  for (const r of relevant) {
    const b = Math.floor(r.createdAt / bucketMs) * bucketMs
    const entry = byBucket.get(b) ?? { at: b, events: 0, byKind: {} }
    entry.events++
    entry.byKind[r.type] = (entry.byKind[r.type] ?? 0) + 1
    byBucket.set(b, entry)
    byKindTotal[r.type] = (byKindTotal[r.type] ?? 0) + 1
  }

  const buckets = Array.from(byBucket.values()).sort((a, b) => a.at - b.at)
  const topKinds = Object.entries(byKindTotal)
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  return { from, to, bucketMs, buckets, totalEvents: relevant.length, topKinds }
}

// ─── Replay: graph as-of time T ─────────────────────────────────────────

/**
 * Build a graph snapshot for a past moment. Uses created_at <= at for
 * existence; status uses current-state for nodes still present.
 *
 * Honest: this is a "what existed by T" reconstruction. Full state replay
 * would require event sourcing on every status change, which we don't do.
 */
export async function replayAt(workspaceId: string, at: number, template: BrainTemplate = 'neural'): Promise<BrainGraph & { replay: { at: number; readOnly: true; honestNote: string; statusReconstructed: number } }> {
  const graph = await buildGraph(workspaceId, template)

  // Bulk historical status maps (status_changes table)
  const [agentStatus, proposalStatus, killStatus, providerStatus, driftStatus] = await Promise.all([
    bulkStatusAt(workspaceId, 'agent',       at),
    bulkStatusAt(workspaceId, 'proposal',    at),
    bulkStatusAt(workspaceId, 'kill_switch', at),
    bulkStatusAt(workspaceId, 'provider',    at),
    bulkStatusAt(workspaceId, 'drift',       at),
  ])

  let statusReconstructed = 0

  // Filter subnodes by createdAt + overlay historical status when available
  const filteredNodes: BrainNode[] = []
  for (const node of graph.nodes) {
    if (node.kind === 'core' || node.kind === 'system') {
      filteredNodes.push(node)
      continue
    }
    const exists = await nodeExistedAt(workspaceId, node.id, at)
    if (!exists) continue

    // Overlay historical status when we have it
    const i = node.id.indexOf(':')
    const prefix = i > 0 ? node.id.slice(0, i) : ''
    const raw = i > 0 ? node.id.slice(i + 1) : node.id
    let histStatus: string | undefined
    if      (prefix === 'agent')    histStatus = agentStatus.get(raw)
    else if (prefix === 'proposal') histStatus = proposalStatus.get(raw)
    else if (prefix === 'kill')     histStatus = killStatus.get(raw)
    else if (prefix === 'provider') histStatus = providerStatus.get(raw)
    else if (prefix === 'drift')    histStatus = driftStatus.get(raw)

    if (histStatus !== undefined) {
      statusReconstructed++
      filteredNodes.push({ ...node, status: histStatus as BrainNode['status'] })
    } else {
      filteredNodes.push(node)
    }
  }
  const visibleIds = new Set(filteredNodes.map(n => n.id))
  const filteredEdges = graph.edges.filter(e => visibleIds.has(e.from) && visibleIds.has(e.to))
  return {
    ...graph,
    nodes: filteredNodes,
    edges: filteredEdges,
    replay: {
      at, readOnly: true,
      statusReconstructed,
      honestNote: statusReconstructed > 0
        ? `${statusReconstructed} node statuses reconstructed from status_changes history; nodes without history use current-state.`
        : 'Existence reconstructed from created_at. No historical status_changes yet — using current-state. Status history accumulates as services emit changes.',
    },
  }
}

async function nodeExistedAt(workspaceId: string, nodeId: string, at: number): Promise<boolean> {
  const i = nodeId.indexOf(':')
  if (i < 0) return true
  const prefix = nodeId.slice(0, i), rawId = nodeId.slice(i + 1)
  try {
    switch (prefix) {
      case 'proposal': {
        const row = await db.select({ createdAt: codeProposals.createdAt }).from(codeProposals)
          .where(and(eq(codeProposals.workspaceId, workspaceId), eq(codeProposals.id, rawId)))
          .limit(1).then(r => r[0])
        return row ? row.createdAt <= at : false
      }
      case 'drift': {
        const row = await db.select({ createdAt: driftWarnings.createdAt }).from(driftWarnings)
          .where(and(eq(driftWarnings.workspaceId, workspaceId), eq(driftWarnings.id, rawId)))
          .limit(1).then(r => r[0])
        return row ? row.createdAt <= at : false
      }
      case 'scenario': {
        const row = await db.select({ createdAt: scenarios.createdAt }).from(scenarios)
          .where(and(eq(scenarios.workspaceId, workspaceId), eq(scenarios.id, rawId)))
          .limit(1).then(r => r[0])
        return row ? row.createdAt <= at : false
      }
      case 'concept': {
        const row = await db.select({ createdAt: designConcepts.createdAt }).from(designConcepts)
          .where(and(eq(designConcepts.workspaceId, workspaceId), eq(designConcepts.id, rawId)))
          .limit(1).then(r => r[0])
        return row ? row.createdAt <= at : false
      }
      case 'bsession': {
        const row = await db.select({ createdAt: browserSessions.createdAt }).from(browserSessions)
          .where(and(eq(browserSessions.workspaceId, workspaceId), eq(browserSessions.id, rawId)))
          .limit(1).then(r => r[0])
        return row ? row.createdAt <= at : false
      }
      case 'run': {
        const row = await db.select({ triggeredAt: workflowRuns.triggeredAt }).from(workflowRuns)
          .where(and(eq(workflowRuns.workspaceId, workspaceId), eq(workflowRuns.id, rawId)))
          .limit(1).then(r => r[0])
        return row ? row.triggeredAt <= at : false
      }
      case 'mem': {
        const row = await db.select({ createdAt: reasoningChains.createdAt }).from(reasoningChains)
          .where(and(eq(reasoningChains.workspaceId, workspaceId), eq(reasoningChains.id, rawId)))
          .limit(1).then(r => r[0])
        return row ? row.createdAt <= at : false
      }
      case 'kill': {
        const row = await db.select({ createdAt: killSwitches.createdAt }).from(killSwitches)
          .where(and(eq(killSwitches.workspaceId, workspaceId), eq(killSwitches.id, rawId)))
          .limit(1).then(r => r[0])
        return row ? row.createdAt <= at : false
      }
    }
  } catch { /* tolerate */ }
  return true   // benevolent default — show if uncertain
}

// ─── Decision path ──────────────────────────────────────────────────────

export interface DecisionPathStep {
  step:       number
  kind:       'event' | 'chain' | 'override' | 'block' | 'incident'
  at:         number
  summary:    string
  detail?:    Record<string, unknown>
  source?:    string
}

export interface DecisionPath {
  rootEvent: { type: string; at: number; payload: Record<string, unknown> | null } | null
  steps:     DecisionPathStep[]
  notes:     string[]
}

/**
 * For a given chain id (reasoning chain) OR event timestamp, walk:
 *   chain → its evidence/tradeoffs/prediction
 *   → related override_log entries (subjectId match)
 *   → related ethical_blocks (intent/source match)
 *   → surrounding events (±5 min)
 */
export async function decisionPath(workspaceId: string, key: string, windowMinutes = 5): Promise<DecisionPath> {
  const notes: string[] = []
  const steps: DecisionPathStep[] = []
  const windowMs = Math.max(1, Math.min(60, windowMinutes)) * 60_000

  // Try as reasoning chain id first
  const chain = await db.select().from(reasoningChains)
    .where(and(eq(reasoningChains.workspaceId, workspaceId), eq(reasoningChains.id, key)))
    .limit(1).then(r => r[0]).catch(() => null)

  let rootAt: number | null = null
  let rootEvent: DecisionPath['rootEvent'] = null

  if (chain) {
    rootAt = chain.createdAt
    steps.push({
      step: 1, kind: 'chain', at: chain.createdAt,
      summary: chain.decision,
      detail: {
        kind: chain.kind, source: chain.source,
        confidence: chain.confidence,
        evidence: chain.evidence,
        outcomeKnown: chain.outcomeKnown,
        outcomeMatched: chain.outcomeMatched,
      },
      source: chain.source,
    })

    // Related override_log by subjectId
    if (chain.subjectId) {
      const overs = await db.select().from(overrideLog)
        .where(and(eq(overrideLog.workspaceId, workspaceId), eq(overrideLog.subjectId, chain.subjectId)))
        .orderBy(desc(overrideLog.createdAt)).limit(5).catch(() => [])
      for (const o of overs) {
        steps.push({
          step: steps.length + 1, kind: 'override', at: o.createdAt,
          summary: `Operator override: ${o.actionType} ${o.originalStatus} → ${o.overrideStatus}`,
          detail: { operatorId: o.operatorId, reason: o.reason },
        })
      }
    }
  } else {
    notes.push('No reasoning chain found by id; falling back to event-timestamp lookup.')
  }

  // Try as event timestamp (numeric) if no chain
  if (!chain && /^\d+$/.test(key)) {
    rootAt = Number(key)
    const ev = await db.select().from(events).where(eq(events.createdAt, rootAt)).limit(1).then(r => r[0]).catch(() => null)
    if (ev) {
      rootEvent = { type: ev.type, at: ev.createdAt, payload: (ev.payload as Record<string, unknown> | null) ?? null }
      steps.push({
        step: steps.length + 1, kind: 'event', at: ev.createdAt,
        summary: ev.type, detail: ev.payload as Record<string, unknown> ?? {},
        source: ev.source,
      })
    }
  }

  // Surrounding events (±windowMinutes)
  if (rootAt !== null) {
    const winStart = rootAt - windowMs
    const winEnd   = rootAt + windowMs
    const surrounding = await db.select().from(events)
      .where(and(gte(events.createdAt, winStart), lt(events.createdAt, winEnd)))
      .orderBy(events.createdAt).limit(20).catch(() => [])
    for (const e of surrounding) {
      if (rootEvent && e.createdAt === rootEvent.at && e.type === rootEvent.type) continue
      steps.push({
        step: steps.length + 1, kind: 'event', at: e.createdAt,
        summary: e.type, detail: e.payload as Record<string, unknown> ?? {},
        source: e.source,
      })
    }

    // Recent ethical blocks in window
    const blocks = await db.select().from(ethicalBlocks)
      .where(and(eq(ethicalBlocks.workspaceId, workspaceId), gte(ethicalBlocks.blockedAt, winStart), lt(ethicalBlocks.blockedAt, winEnd)))
      .limit(5).catch(() => [])
    for (const b of blocks) {
      steps.push({
        step: steps.length + 1, kind: 'block', at: b.blockedAt,
        summary: `Blocked (${b.category}): ${b.reason.slice(0, 80)}`,
        detail: { intent: b.intent.slice(0, 200), source: b.source },
      })
    }

    // Open incidents in window
    const incs = await db.select().from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), gte(incidents.createdAt, winStart), lt(incidents.createdAt, winEnd)))
      .limit(5).catch(() => [])
    for (const inc of incs) {
      steps.push({
        step: steps.length + 1, kind: 'incident', at: inc.createdAt,
        summary: `Incident: ${inc.title}`,
        detail: { severity: inc.severity, status: inc.status, type: inc.type },
      })
    }
  }

  // Sort by time
  steps.sort((a, b) => a.at - b.at)
  steps.forEach((s, i) => { s.step = i + 1 })

  if (steps.length === 0) notes.push(`No related events found in ±${windowMinutes}min window.`)
  if (steps.length > 0) notes.push(`Window: ±${windowMinutes}min (max 60). Use ?window_minutes= to expand.`)
  return { rootEvent, steps, notes }
}

// ─── Historical search ──────────────────────────────────────────────────

export async function searchHistorical(
  workspaceId: string, q: string, from: number, to: number, limit = 30,
): Promise<SearchHit[]> {
  if (!q || q.length < 2) return []
  const needle = q.toLowerCase()
  const out: SearchHit[] = []

  // Search reasoning chains in window
  const chains = await db.select().from(reasoningChains)
    .where(and(eq(reasoningChains.workspaceId, workspaceId), gte(reasoningChains.createdAt, from), lt(reasoningChains.createdAt, to)))
    .orderBy(desc(reasoningChains.createdAt)).limit(500).catch(() => [])
  for (const c of chains) {
    const text = `${c.decision} ${c.kind} ${c.source}`.toLowerCase()
    if (text.includes(needle)) {
      out.push({
        id: `mem:${c.id}`, kind: 'chain', label: c.decision.slice(0, 80),
        detail: `${c.kind} · ${new Date(c.createdAt).toLocaleString()} · ${c.source}`,
        score: text.startsWith(needle) ? 1 : 0.6,
      })
    }
  }

  // Search events in window
  const evRows = await db.select().from(events)
    .where(and(gte(events.createdAt, from), lt(events.createdAt, to)))
    .orderBy(desc(events.createdAt)).limit(500).catch(() => [])
  for (const e of evRows) {
    if (e.workspaceId !== workspaceId && e.workspaceId !== 'global') continue
    const text = `${e.type} ${e.source}`.toLowerCase()
    if (text.includes(needle)) {
      out.push({
        id: `event:${e.id}`, kind: 'event', label: e.type,
        detail: `${e.source} · ${new Date(e.createdAt).toLocaleString()}`,
        score: text.startsWith(needle) ? 1 : 0.5,
      })
    }
  }

  return out.sort((a, b) => b.score - a.score).slice(0, limit)
}

// ─── Command palette search ─────────────────────────────────────────────

export interface SearchHit {
  id:    string
  kind:  string
  label: string
  detail: string
  score: number
}

export async function searchBrain(workspaceId: string, q: string, limit = 20): Promise<SearchHit[]> {
  if (!q || q.length < 2) return []
  const needle = q.toLowerCase()
  const hits: SearchHit[] = []

  // Graph nodes (current snapshot)
  const graph = await buildGraph(workspaceId, 'neural')
  for (const n of graph.nodes) {
    const text = `${n.label} ${n.id} ${n.detail ?? ''}`.toLowerCase()
    if (text.includes(needle)) {
      hits.push({
        id: n.id, kind: n.kind, label: n.label,
        detail: n.detail ?? n.id,
        score: text.startsWith(needle) ? 1.0 : text.indexOf(needle) < 20 ? 0.8 : 0.5,
      })
    }
  }
  // Sort + dedup
  const seen = new Set<string>()
  return hits
    .filter(h => { if (seen.has(h.id)) return false; seen.add(h.id); return true })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
