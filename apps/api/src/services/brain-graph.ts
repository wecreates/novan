/**
 * brain-graph.ts — Build the 3D Brain graph from real Novan state.
 *
 * Center: Novan Brain
 * Orbits (14 systems): runtime, agents, security, research, memory,
 *   image-studio, browser-control, commerce, governance, war-room,
 *   infrastructure, learning, simulation, executive-loop
 * Subnodes: counts pulled from the canonical tables; the heaviest
 *   N items are surfaced as individual nodes per system.
 *
 * Templates rearrange the layout; the NODE SET is identical.
 *
 * Honest scope: no synthetic nodes. Empty systems show as single
 * orbit nodes with count=0 so the operator sees the structure.
 */
import { db } from '../db/client.js'
import {
  workflowRuns, incidents, killSwitches, providerConfigs, executionLeases,
  reasoningChains, codeProposals, chatActions, designConcepts, browserSessions,
  commerceSessions, ethicalBlocks, agentPauseState, scenarios, podListings,
  runtimeNodes, accountCredentials, trendFindings, conversations,
  driftWarnings, assumptions, strategicHorizons,
} from '../db/schema.js'
import { and, eq, desc, gte, sql } from 'drizzle-orm'

export type BrainTemplate =
  | 'neural' | 'solar' | 'command_core' | 'galaxy'
  | 'runtime_mesh' | 'agent_swarm' | 'security_grid' | 'mission_orbit'

export type NodeKind =
  | 'core' | 'system' | 'agent' | 'mission' | 'incident' | 'approval'
  | 'provider' | 'worker' | 'memory' | 'concept' | 'browser_session'
  | 'horizon' | 'drift' | 'scenario' | 'event'

export type NodeStatus = 'healthy' | 'degraded' | 'down' | 'pending' | 'paused' | 'unknown'

export interface BrainNode {
  id:        string
  kind:      NodeKind
  label:     string
  system?:   string                  // which orbit it belongs to
  status:    NodeStatus
  metric?:   number                  // load/cost/severity for visual sizing
  detail?:   string                  // short hover text
  position?: [number, number, number]
  scale?:    number
}

export interface BrainEdge {
  from: string
  to:   string
  kind: 'orbit' | 'depends_on' | 'flows_to'
}

export interface BrainGraph {
  template:   BrainTemplate
  generatedAt: number
  nodes:      BrainNode[]
  edges:      BrainEdge[]
  systems:    Array<{ id: string; label: string; count: number; status: NodeStatus }>
}

// 14 orbit systems with their canonical id
const SYSTEMS: Array<{ id: string; label: string }> = [
  { id: 'runtime',         label: 'Runtime' },
  { id: 'agents',          label: 'Agents' },
  { id: 'security',        label: 'Security' },
  { id: 'research',        label: 'Research' },
  { id: 'memory',          label: 'Memory' },
  { id: 'image_studio',    label: 'Image Studio' },
  { id: 'browser_control', label: 'Browser Control' },
  { id: 'commerce',        label: 'Commerce' },
  { id: 'governance',      label: 'Governance' },
  { id: 'war_room',        label: 'War Room' },
  { id: 'infrastructure',  label: 'Infrastructure' },
  { id: 'learning',        label: 'Learning' },
  { id: 'simulation',      label: 'Simulation' },
  { id: 'executive_loop',  label: 'Executive Loop' },
]

// ─── Layout algorithms per template ─────────────────────────────────────

const PHI = (1 + Math.sqrt(5)) / 2

function layoutSystems(template: BrainTemplate): Map<string, [number, number, number]> {
  const out = new Map<string, [number, number, number]>()
  const n = SYSTEMS.length
  switch (template) {
    case 'solar': {
      // Concentric rings at varying radii on the XY plane
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2
        const r = 6 + (i % 3) * 1.5
        out.set(SYSTEMS[i]!.id, [Math.cos(a) * r, Math.sin(a) * r, 0])
      }
      break
    }
    case 'galaxy': {
      // Spiral arm
      for (let i = 0; i < n; i++) {
        const t = i / n
        const a = t * Math.PI * 4
        const r = 3 + t * 8
        out.set(SYSTEMS[i]!.id, [Math.cos(a) * r, Math.sin(a) * r, (t - 0.5) * 4])
      }
      break
    }
    case 'command_core': {
      // Cubic grid 3x3x2 centered
      let i = 0
      for (let x = -1; x <= 1; x++) {
        for (let y = -1; y <= 1; y++) {
          for (let z = -1; z <= 0; z++) {
            if (i >= n) break
            out.set(SYSTEMS[i]!.id, [x * 4, y * 4, z * 4 + 2])
            i++
          }
        }
      }
      break
    }
    case 'runtime_mesh': {
      // Fibonacci sphere
      for (let i = 0; i < n; i++) {
        const y = 1 - (i / (n - 1)) * 2
        const r = Math.sqrt(1 - y * y) * 7
        const theta = (i * 2 * Math.PI) / PHI
        out.set(SYSTEMS[i]!.id, [Math.cos(theta) * r, y * 7, Math.sin(theta) * r])
      }
      break
    }
    case 'agent_swarm': {
      // Tight equatorial ring + inner ring
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2
        const r = 5 + (i % 2) * 2
        out.set(SYSTEMS[i]!.id, [Math.cos(a) * r, 0, Math.sin(a) * r])
      }
      break
    }
    case 'security_grid': {
      // Square lattice
      const cols = Math.ceil(Math.sqrt(n))
      for (let i = 0; i < n; i++) {
        const col = i % cols, row = Math.floor(i / cols)
        out.set(SYSTEMS[i]!.id, [(col - cols / 2) * 3, (row - cols / 2) * 3, 0])
      }
      break
    }
    case 'mission_orbit': {
      // Two orbiting rings at different inclinations
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2
        const inclination = (i % 2 === 0 ? 0.3 : -0.3)
        const r = 6
        out.set(SYSTEMS[i]!.id, [Math.cos(a) * r, Math.sin(a) * inclination * r, Math.sin(a) * r])
      }
      break
    }
    case 'neural':
    default: {
      // Neural net layers — 3 horizontal layers
      const perLayer = Math.ceil(n / 3)
      for (let i = 0; i < n; i++) {
        const layer = Math.floor(i / perLayer)
        const idx = i % perLayer
        out.set(SYSTEMS[i]!.id, [(layer - 1) * 5, (idx - perLayer / 2 + 0.5) * 2.5, 0])
      }
      break
    }
  }
  return out
}

// Place subnodes around their parent system
function layoutSubnodes(parent: [number, number, number], count: number, parentScale = 1): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = []
  if (count === 0) return out
  const r = 1.2 * parentScale
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2
    const y = 0.3 * Math.sin(i * 0.7)
    out.push([parent[0] + Math.cos(a) * r, parent[1] + y, parent[2] + Math.sin(a) * r])
  }
  return out
}

// ─── Graph builder ──────────────────────────────────────────────────────

const SUBNODE_CAP = 6   // max real items surfaced per system

export type LODMode = 'global' | 'systems' | 'focus'

export interface BuildGraphOpts {
  lod?: LODMode
  focusSystem?: string
}

export async function buildGraph(workspaceId: string, template: BrainTemplate = 'neural', opts: BuildGraphOpts = {}): Promise<BrainGraph> {
  const lod = opts.lod ?? 'systems'
  const since7d = Date.now() - 7 * 24 * 60 * 60_000
  const since24h = Date.now() - 24 * 60 * 60_000

  // Gather real data per system in parallel
  const [
    agentsActive, runs, openInc, killers, providers, leases, mem,
    proposals, sessions, concepts, listings, ethicalRecent,
    paused, runtimeRows, sims, drifts, horizonsRows,
  ] = await Promise.all([
    db.select({ name: agentPauseState.agentName, paused: agentPauseState.paused })
      .from(agentPauseState).where(eq(agentPauseState.workspaceId, workspaceId)).catch(() => []),
    db.select().from(workflowRuns)
      .where(and(eq(workflowRuns.workspaceId, workspaceId), gte(workflowRuns.triggeredAt, since7d)))
      .orderBy(desc(workflowRuns.triggeredAt)).limit(SUBNODE_CAP).catch(() => []),
    db.select().from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), eq(incidents.status, 'open')))
      .orderBy(desc(incidents.createdAt)).limit(SUBNODE_CAP).catch(() => []),
    db.select().from(killSwitches)
      .where(eq(killSwitches.workspaceId, workspaceId)).limit(SUBNODE_CAP).catch(() => []),
    db.select().from(providerConfigs)
      .where(eq(providerConfigs.workspaceId, workspaceId)).limit(SUBNODE_CAP).catch(() => []),
    db.select().from(executionLeases)
      .where(and(eq(executionLeases.workspaceId, workspaceId), eq(executionLeases.status, 'active')))
      .limit(SUBNODE_CAP).catch(() => []),
    db.select().from(reasoningChains)
      .where(and(eq(reasoningChains.workspaceId, workspaceId), gte(reasoningChains.createdAt, since7d)))
      .orderBy(desc(reasoningChains.createdAt)).limit(SUBNODE_CAP).catch(() => []),
    db.select().from(codeProposals)
      .where(and(eq(codeProposals.workspaceId, workspaceId), eq(codeProposals.status, 'proposed')))
      .orderBy(desc(codeProposals.createdAt)).limit(SUBNODE_CAP).catch(() => []),
    db.select().from(browserSessions)
      .where(eq(browserSessions.workspaceId, workspaceId))
      .orderBy(desc(browserSessions.startedAt)).limit(SUBNODE_CAP).catch(() => []),
    db.select().from(designConcepts)
      .where(eq(designConcepts.workspaceId, workspaceId))
      .orderBy(desc(designConcepts.createdAt)).limit(SUBNODE_CAP).catch(() => []),
    db.select().from(podListings)
      .where(eq(podListings.workspaceId, workspaceId))
      .orderBy(desc(podListings.createdAt)).limit(SUBNODE_CAP).catch(() => []),
    db.select({ n: sql<number>`count(*)::int` }).from(ethicalBlocks)
      .where(and(eq(ethicalBlocks.workspaceId, workspaceId), gte(ethicalBlocks.blockedAt, since24h)))
      .then(r => Number(r[0]?.n ?? 0)).catch(() => 0),
    db.select().from(agentPauseState).where(and(eq(agentPauseState.workspaceId, workspaceId), eq(agentPauseState.paused, true))).catch(() => []),
    db.select().from(runtimeNodes).where(eq(runtimeNodes.workspaceId, workspaceId)).limit(SUBNODE_CAP).catch(() => []),
    db.select().from(scenarios)
      .where(eq(scenarios.workspaceId, workspaceId))
      .orderBy(desc(scenarios.createdAt)).limit(SUBNODE_CAP).catch(() => []),
    db.select().from(driftWarnings)
      .where(and(eq(driftWarnings.workspaceId, workspaceId), eq(driftWarnings.status, 'open')))
      .limit(SUBNODE_CAP).catch(() => []),
    db.select().from(strategicHorizons)
      .where(and(eq(strategicHorizons.workspaceId, workspaceId), eq(strategicHorizons.status, 'active')))
      .limit(SUBNODE_CAP).catch(() => []),
  ])

  // Build per-system metadata
  const systemData: Record<string, { count: number; status: NodeStatus; items: BrainNode[] }> = {}

  // runtime
  systemData['runtime'] = {
    count: runtimeRows.length,
    status: runtimeRows.some(r => r.status === 'down') ? 'down' : runtimeRows.length === 0 ? 'unknown' : 'healthy',
    items: runtimeRows.map(n => ({
      id: `runtime:${n.id}`, kind: 'worker', system: 'runtime',
      label: n.role, status: n.status as NodeStatus, metric: n.activeLoad,
      detail: `${n.region} · load ${n.activeLoad}/${n.capacity}`,
    })),
  }
  // agents
  systemData['agents'] = {
    count: agentsActive.length,
    status: agentsActive.some(a => a.paused) ? 'paused' : 'healthy',
    items: paused.map(p => ({
      id: `agent:${p.agentName}`, kind: 'agent', system: 'agents',
      label: p.agentName, status: 'paused', detail: p.reason ?? 'paused',
    })),
  }
  // security
  systemData['security'] = {
    count: killers.length + ethicalRecent,
    status: ethicalRecent > 10 ? 'degraded' : killers.some(k => k.enabled) ? 'paused' : 'healthy',
    items: killers.map(k => ({
      id: `kill:${k.id}`, kind: 'incident', system: 'security',
      label: `kill:${k.switchType}`, status: k.enabled ? 'down' : 'healthy',
      detail: k.reason ?? '',
    })),
  }
  // research
  systemData['research'] = {
    count: 0,   // trends loaded below if needed
    status: 'healthy',
    items: [],
  }
  // memory
  systemData['memory'] = {
    count: mem.length,
    status: mem.length === 0 ? 'unknown' : 'healthy',
    items: mem.slice(0, SUBNODE_CAP).map(m => ({
      id: `mem:${m.id}`, kind: 'memory', system: 'memory',
      label: m.kind, status: m.outcomeKnown ? (m.outcomeMatched ? 'healthy' : 'degraded') : 'pending',
      detail: m.decision.slice(0, 80),
    })),
  }
  // image studio
  systemData['image_studio'] = {
    count: concepts.length,
    status: concepts.some(c => c.status === 'rejected') ? 'degraded' : 'healthy',
    items: concepts.map(c => ({
      id: `concept:${c.id}`, kind: 'concept', system: 'image_studio',
      label: c.brief.slice(0, 30), status: c.status === 'rejected' ? 'down' : 'healthy',
      detail: `quality ${(c.qualityScore ?? 0).toFixed(2)}`,
    })),
  }
  // browser control
  systemData['browser_control'] = {
    count: sessions.length,
    status: 'healthy',
    items: sessions.map(s => ({
      id: `bsession:${s.id}`, kind: 'browser_session', system: 'browser_control',
      label: s.url.slice(0, 40), status: s.status === 'completed' ? 'healthy' : 'pending',
      detail: s.url,
    })),
  }
  // commerce
  systemData['commerce'] = {
    count: listings.length,
    status: 'healthy',
    items: listings.map(l => ({
      id: `listing:${l.id}`, kind: 'mission', system: 'commerce',
      label: l.title.slice(0, 30), status: l.status === 'live' ? 'healthy' : 'pending',
      detail: `${l.platform} · q ${(l.qualityScore ?? 0).toFixed(2)}`,
    })),
  }
  // governance
  systemData['governance'] = {
    count: drifts.length,
    status: drifts.some(d => d.severity === 'critical') ? 'down' : drifts.length > 0 ? 'degraded' : 'healthy',
    items: drifts.map(d => ({
      id: `drift:${d.id}`, kind: 'drift', system: 'governance',
      label: d.kind, status: d.severity === 'critical' ? 'down' : 'degraded',
      detail: d.recommendedAction ?? '',
    })),
  }
  // war room (proposals + approvals proxy)
  systemData['war_room'] = {
    count: proposals.length,
    status: 'healthy',
    items: proposals.map(p => ({
      id: `proposal:${p.id}`, kind: 'approval', system: 'war_room',
      label: p.title.slice(0, 40), status: p.status === 'rejected' ? 'down' : 'pending',
      detail: `${p.estimatedLoc} LOC · ${p.riskLevel}`,
    })),
  }
  // infrastructure (providers)
  systemData['infrastructure'] = {
    count: providers.length,
    status: providers.length === 0 ? 'unknown' : 'healthy',
    items: providers.map(p => ({
      id: `provider:${p.id}`, kind: 'provider', system: 'infrastructure',
      label: p.providerId, status: p.enabled ? 'healthy' : 'paused',
      detail: p.label,
    })),
  }
  // learning (recent runs + chains)
  systemData['learning'] = {
    count: runs.length,
    status: runs.filter(r => r.status === 'failed').length > runs.length / 3 ? 'degraded' : 'healthy',
    items: runs.map(r => ({
      id: `run:${r.id}`, kind: 'mission', system: 'learning',
      label: r.workflowId.slice(0, 24), status: r.status === 'completed' ? 'healthy' : r.status === 'failed' ? 'down' : 'pending',
      detail: r.status,
    })),
  }
  // simulation
  systemData['simulation'] = {
    count: sims.length,
    status: 'healthy',
    items: sims.map(s => ({
      id: `scenario:${s.id}`, kind: 'scenario', system: 'simulation',
      label: s.name.slice(0, 30), status: 'healthy',
      detail: `${s.kind} · conf ${s.confidence.toFixed(2)}`,
    })),
  }
  // executive loop (horizons)
  systemData['executive_loop'] = {
    count: horizonsRows.length,
    status: 'healthy',
    items: horizonsRows.map(h => ({
      id: `horizon:${h.id}`, kind: 'horizon', system: 'executive_loop',
      label: h.title.slice(0, 30), status: 'healthy',
      detail: `${h.horizon} · objs ${(h.objectives as Array<unknown>).length}`,
    })),
  }

  // ── Position everything per template
  const systemPositions = layoutSystems(template)
  const nodes: BrainNode[] = []
  const edges: BrainEdge[] = []

  // Core
  nodes.push({
    id: 'core', kind: 'core', label: 'Novan Brain',
    status: 'healthy', position: [0, 0, 0], scale: 1.5,
  })

  // System nodes + subnode rings
  for (const sys of SYSTEMS) {
    const pos = systemPositions.get(sys.id) ?? [0, 0, 0]
    const data = systemData[sys.id] ?? { count: 0, status: 'unknown' as NodeStatus, items: [] }

    // LOD focus: skip non-focused systems entirely in 'focus' mode
    if (lod === 'focus' && opts.focusSystem && sys.id !== opts.focusSystem) continue

    // Status-based emphasis: pull degraded/down systems forward in Z
    const adjustedPos: [number, number, number] = [
      pos[0],
      pos[1],
      pos[2] + (data.status === 'down' ? 2 : data.status === 'degraded' ? 1 : 0),
    ]

    const sysNode: BrainNode = {
      id: sys.id, kind: 'system', label: sys.label,
      status: data.status, metric: data.count,
      position: adjustedPos,
      scale: data.status === 'down' ? 1.1 : data.status === 'degraded' ? 1.0 : 0.9,
      detail: `${data.count} items`,
    }
    nodes.push(sysNode)
    edges.push({ from: 'core', to: sys.id, kind: 'orbit' })

    // LOD global: stop at systems
    if (lod === 'global') continue

    // Subnodes around system
    const subPositions = layoutSubnodes(adjustedPos, data.items.length, 0.9)
    data.items.forEach((item, idx) => {
      const subPos = subPositions[idx] ?? adjustedPos
      nodes.push({ ...item, position: subPos, scale: 0.4 })
      edges.push({ from: sys.id, to: item.id, kind: 'depends_on' })
    })
  }

  return {
    template, generatedAt: Date.now(),
    nodes, edges,
    systems: SYSTEMS.map(s => {
      const d = systemData[s.id] ?? { count: 0, status: 'unknown' as NodeStatus, items: [] }
      return { id: s.id, label: s.label, count: d.count, status: d.status }
    }),
  }
}

// ─── Node detail ────────────────────────────────────────────────────────

export interface NodeDetail {
  id:       string
  kind:     NodeKind
  label:    string
  status:   NodeStatus
  fields:   Array<{ key: string; value: string }>
  events:   Array<{ at: number; type: string; summary: string }>
  actions:  Array<{ id: string; label: string; risk: 'low' | 'medium' | 'high' | 'critical'; payload?: Record<string, unknown> }>
}

export async function getNodeDetail(workspaceId: string, nodeId: string): Promise<NodeDetail | null> {
  // Parse "kind:id" prefix
  const colonIdx = nodeId.indexOf(':')
  const prefix = colonIdx > 0 ? nodeId.slice(0, colonIdx) : nodeId
  const rawId  = colonIdx > 0 ? nodeId.slice(colonIdx + 1) : ''

  if (nodeId === 'core') {
    return {
      id: 'core', kind: 'core', label: 'Novan Brain', status: 'healthy',
      fields: [
        { key: 'mode', value: 'autonomous operational intelligence' },
        { key: 'orbit_systems', value: String(SYSTEMS.length) },
      ],
      events: [], actions: [],
    }
  }

  // Single system node
  const sys = SYSTEMS.find(s => s.id === nodeId)
  if (sys) {
    return {
      id: sys.id, kind: 'system', label: sys.label, status: 'healthy',
      fields: [{ key: 'system_id', value: sys.id }],
      events: [], actions: [],
    }
  }

  switch (prefix) {
    case 'agent': {
      const row = await db.select().from(agentPauseState)
        .where(and(eq(agentPauseState.workspaceId, workspaceId), eq(agentPauseState.agentName, rawId)))
        .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[brain-graph]', e.message); return null })
      const status: NodeStatus = row?.paused ? 'paused' : 'healthy'
      return {
        id: nodeId, kind: 'agent', label: rawId, status,
        fields: [
          { key: 'paused', value: String(row?.paused ?? false) },
          { key: 'paused_by', value: row?.pausedBy ?? '—' },
          { key: 'reason', value: row?.reason ?? '—' },
        ],
        events: [], actions: row?.paused
          ? [{ id: 'resume_agent', label: 'Resume agent', risk: 'medium', payload: { agentName: rawId } }]
          : [{ id: 'pause_agent', label: 'Pause agent', risk: 'medium', payload: { agentName: rawId } }],
      }
    }
    case 'proposal': {
      const row = await db.select().from(codeProposals)
        .where(and(eq(codeProposals.workspaceId, workspaceId), eq(codeProposals.id, rawId)))
        .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[brain-graph]', e.message); return null })
      if (!row) return null
      return {
        id: nodeId, kind: 'approval', label: row.title,
        status: row.status === 'rejected' ? 'down' : 'pending',
        fields: [
          { key: 'risk', value: row.riskLevel },
          { key: 'loc', value: String(row.estimatedLoc) },
          { key: 'status', value: row.status },
          { key: 'capability', value: row.capabilityId ?? '—' },
        ],
        events: [], actions: row.status === 'proposed'
          ? [
              { id: 'approve_proposal', label: 'Approve', risk: 'low', payload: { proposalId: row.id } },
              { id: 'reject_proposal', label: 'Reject', risk: 'low', payload: { proposalId: row.id } },
            ]
          : [],
      }
    }
    case 'provider': {
      const row = await db.select().from(providerConfigs)
        .where(and(eq(providerConfigs.workspaceId, workspaceId), eq(providerConfigs.id, rawId)))
        .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[brain-graph]', e.message); return null })
      if (!row) return null
      return {
        id: nodeId, kind: 'provider', label: row.providerId,
        status: row.enabled ? 'healthy' : 'paused',
        fields: [
          { key: 'enabled', value: String(row.enabled) },
          { key: 'priority', value: String(row.priority) },
          { key: 'label', value: row.label },
        ],
        events: [], actions: [
          { id: 'inspect_provider', label: 'Open provider page', risk: 'low', payload: { providerId: row.providerId } },
        ],
      }
    }
    case 'drift': {
      const row = await db.select().from(driftWarnings)
        .where(and(eq(driftWarnings.workspaceId, workspaceId), eq(driftWarnings.id, rawId)))
        .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[brain-graph]', e.message); return null })
      if (!row) return null
      return {
        id: nodeId, kind: 'drift', label: row.kind,
        status: row.severity === 'critical' ? 'down' : 'degraded',
        fields: [
          { key: 'severity', value: row.severity },
          { key: 'subject', value: row.subjectId ?? '—' },
          { key: 'recommended', value: row.recommendedAction ?? '—' },
          { key: 'created_at', value: new Date(row.createdAt).toISOString() },
        ],
        events: [], actions: [
          { id: 'open_audit', label: 'Open audit trail', risk: 'low', payload: { entityType: 'drift', entityId: row.id } },
        ],
      }
    }
    case 'scenario': {
      const row = await db.select().from(scenarios)
        .where(and(eq(scenarios.workspaceId, workspaceId), eq(scenarios.id, rawId)))
        .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[brain-graph]', e.message); return null })
      if (!row) return null
      return {
        id: nodeId, kind: 'scenario', label: row.name, status: 'healthy',
        fields: [
          { key: 'kind', value: row.kind },
          { key: 'confidence', value: row.confidence.toFixed(2) },
        ],
        events: [], actions: [
          { id: 'focus_mission', label: 'Open simulation', risk: 'low', payload: { scenarioId: row.id } },
        ],
      }
    }
    case 'horizon': {
      const row = await db.select().from(strategicHorizons)
        .where(and(eq(strategicHorizons.workspaceId, workspaceId), eq(strategicHorizons.id, rawId)))
        .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[brain-graph]', e.message); return null })
      if (!row) return null
      return {
        id: nodeId, kind: 'horizon', label: row.title, status: 'healthy',
        fields: [
          { key: 'horizon', value: row.horizon },
          { key: 'objectives', value: String((row.objectives as Array<unknown>).length) },
        ],
        events: [], actions: [
          { id: 'focus_mission', label: 'Open mission', risk: 'low', payload: { horizonId: row.id } },
        ],
      }
    }
    case 'run': {
      const row = await db.select().from(workflowRuns)
        .where(and(eq(workflowRuns.workspaceId, workspaceId), eq(workflowRuns.id, rawId)))
        .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[brain-graph]', e.message); return null })
      if (!row) return null
      return {
        id: nodeId, kind: 'mission', label: row.workflowId,
        status: row.status === 'completed' ? 'healthy' : row.status === 'failed' ? 'down' : 'pending',
        fields: [
          { key: 'status', value: row.status },
          { key: 'triggered_at', value: new Date(row.triggeredAt).toISOString() },
        ],
        events: [], actions: [],
      }
    }
    case 'concept': {
      const row = await db.select().from(designConcepts)
        .where(and(eq(designConcepts.workspaceId, workspaceId), eq(designConcepts.id, rawId)))
        .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[brain-graph]', e.message); return null })
      if (!row) return null
      return {
        id: nodeId, kind: 'concept', label: row.brief.slice(0, 40),
        status: row.status === 'rejected' ? 'down' : 'healthy',
        fields: [
          { key: 'originality', value: (row.originalityScore ?? 0).toFixed(2) },
          { key: 'quality', value: (row.qualityScore ?? 0).toFixed(2) },
          { key: 'slop', value: (row.slopScore ?? 0).toFixed(2) },
        ],
        events: [], actions: [],
      }
    }
  }
  return null
}
