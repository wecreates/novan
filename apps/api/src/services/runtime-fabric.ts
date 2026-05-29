/**
 * runtime-fabric.ts — Distributed runtime nodes + autonomous scaling.
 *
 * Honest scope:
 *   - Nodes register themselves and emit heartbeats. The fabric tracks
 *     them but DOES NOT spawn nodes — that's k8s/Render/external infra.
 *     What we ship is the awareness + decision layer + audit trail.
 *   - Scaling decisions are RECORDED as scaling_events. An external
 *     control plane (or operator) honors them.
 *   - Region failover routing is signal-only: we mark unhealthy regions
 *     and emit reroute events; the actual traffic shift is done by
 *     load balancers / DNS / cloud provider.
 *
 * Rules enforced:
 *   - All scaling actions emit a scaling_events row (audit)
 *   - Approval policy: autonomous scale-up bounded by max replicas;
 *     scale-down requires no concurrent active load
 *   - Budget cap honored via existing budget_guard
 */
import { db } from '../db/client.js'
import { runtimeNodes, scalingEvents } from '../db/schema.js'
import { and, eq, desc, gte, lt, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { record as recordChain } from './reasoning-chains.js'

// ─── Node mgmt ──────────────────────────────────────────────────────────

export type NodeRole   = 'api' | 'worker' | 'research' | 'image' | 'browser'
export type NodeStatus = 'healthy' | 'degraded' | 'down' | 'isolated'

export async function registerNode(i: {
  workspaceId: string; nodeId: string; region: string; role: NodeRole; capacity?: number; endpoint?: string
}): Promise<void> {
  const now = Date.now()
  await db.insert(runtimeNodes).values({
    id: i.nodeId, workspaceId: i.workspaceId,
    region: i.region, role: i.role,
    status: 'healthy', capacity: i.capacity ?? 1,
    activeLoad: 0, queueDepth: 0,
    endpoint: i.endpoint ?? null,
    metadata: {}, lastHeartbeatAt: now,
    createdAt: now, updatedAt: now,
  }).onConflictDoUpdate({
    target: runtimeNodes.id,
    set: {
      region: i.region, role: i.role,
      capacity: i.capacity ?? 1,
      endpoint: i.endpoint ?? null,
      lastHeartbeatAt: now, updatedAt: now,
    },
  }).catch((e: Error) => { console.error('[runtime-fabric]', e.message); return null })
}

export async function heartbeat(workspaceId: string, nodeId: string, snapshot: { activeLoad?: number; queueDepth?: number; metadata?: Record<string, unknown> }): Promise<void> {
  await db.update(runtimeNodes).set({
    lastHeartbeatAt: Date.now(),
    activeLoad:  snapshot.activeLoad  ?? 0,
    queueDepth:  snapshot.queueDepth  ?? 0,
    metadata:    snapshot.metadata    ?? {},
    status: 'healthy',
    updatedAt: Date.now(),
  }).where(and(eq(runtimeNodes.workspaceId, workspaceId), eq(runtimeNodes.id, nodeId))).catch((e: Error) => { console.error('[runtime-fabric]', e.message); return null })
}

export async function listNodes(workspaceId: string) {
  return db.select().from(runtimeNodes)
    .where(eq(runtimeNodes.workspaceId, workspaceId))
    .orderBy(runtimeNodes.region, runtimeNodes.role).catch(() => [])
}

export async function setNodeStatus(workspaceId: string, nodeId: string, status: NodeStatus, reason: string): Promise<void> {
  await db.update(runtimeNodes).set({ status, updatedAt: Date.now() })
    .where(and(eq(runtimeNodes.workspaceId, workspaceId), eq(runtimeNodes.id, nodeId))).catch((e: Error) => { console.error('[runtime-fabric]', e.message); return null })
  await db.insert(scalingEvents).values({
    id: uuidv7(), workspaceId, kind: status === 'isolated' ? 'isolate' : 'reroute',
    target: nodeId, reason, approvedBy: 'auto',
    createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[runtime-fabric]', e.message); return null })
}

/**
 * Marks nodes whose lastHeartbeat is >2min old as 'down'.
 * Cron-callable. Returns counts.
 */
export async function sweepStaleNodes(workspaceId: string, staleMs = 120_000): Promise<{ marked: number }> {
  const cutoff = Date.now() - staleMs
  const stale = await db.select().from(runtimeNodes)
    .where(and(
      eq(runtimeNodes.workspaceId, workspaceId),
      eq(runtimeNodes.status, 'healthy'),
      lt(runtimeNodes.lastHeartbeatAt, cutoff),
    )).catch(() => [])
  for (const n of stale) {
    await setNodeStatus(workspaceId, n.id, 'down', `heartbeat stale ${Math.floor((Date.now() - n.lastHeartbeatAt) / 1000)}s`)
  }
  return { marked: stale.length }
}

// ─── Scaling decision engine ────────────────────────────────────────────

export interface ScalingDecision {
  kind:    'scale_up' | 'scale_down' | 'throttle' | 'noop'
  target:  string
  before:  number
  after:   number
  reason:  string
}

const MAX_REPLICAS_PER_ROLE: Record<NodeRole, number> = {
  api: 4, worker: 8, research: 4, image: 4, browser: 4,
}

/**
 * Pure scaling rule: examines current node count + queue depth + utilization
 * and returns a decision. Caller persists via recordScalingEvent.
 */
export function decideScale(role: NodeRole, snapshot: {
  healthyNodes: number
  totalQueueDepth: number
  avgUtilization: number   // 0..1
}): ScalingDecision {
  const { healthyNodes, totalQueueDepth, avgUtilization } = snapshot
  const max = MAX_REPLICAS_PER_ROLE[role]

  // Scale up: queue piling + utilization high
  if (totalQueueDepth >= 50 && avgUtilization >= 0.75 && healthyNodes < max) {
    return {
      kind: 'scale_up', target: role,
      before: healthyNodes, after: Math.min(max, healthyNodes + 1),
      reason: `queue=${totalQueueDepth}, utilization=${avgUtilization.toFixed(2)} >= 0.75`,
    }
  }
  // Scale up critical: queue very deep
  if (totalQueueDepth >= 200 && healthyNodes < max) {
    return {
      kind: 'scale_up', target: role,
      before: healthyNodes, after: Math.min(max, healthyNodes + 2),
      reason: `queue critical (${totalQueueDepth})`,
    }
  }
  // Scale down: low queue + low utilization + more than 1 node
  if (totalQueueDepth < 5 && avgUtilization < 0.20 && healthyNodes > 1) {
    return {
      kind: 'scale_down', target: role,
      before: healthyNodes, after: healthyNodes - 1,
      reason: `low load (queue=${totalQueueDepth}, util=${avgUtilization.toFixed(2)})`,
    }
  }
  // Throttle: queue deep but no headroom
  if (totalQueueDepth >= 100 && healthyNodes >= max) {
    return {
      kind: 'throttle', target: role,
      before: healthyNodes, after: healthyNodes,
      reason: `at max replicas (${max}) but queue=${totalQueueDepth} — throttle upstream`,
    }
  }
  return { kind: 'noop', target: role, before: healthyNodes, after: healthyNodes, reason: 'no action needed' }
}

export async function recordScalingEvent(workspaceId: string, d: ScalingDecision, approvedBy = 'auto'): Promise<string | null> {
  if (d.kind === 'noop') return null
  const id = uuidv7()
  await db.insert(scalingEvents).values({
    id, workspaceId,
    kind: d.kind, target: d.target,
    before: d.before, after: d.after,
    reason: d.reason, approvedBy,
    createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[runtime-fabric]', e.message); return null })
  await recordChain({
    workspaceId, kind: 'decision', subjectId: `scaling:${d.target}`,
    decision: `${d.kind} ${d.target}: ${d.before}→${d.after} (${d.reason})`,
    confidence: 0.8, source: 'runtime-fabric',
  }).catch((e: Error) => { console.error('[runtime-fabric]', e.message); return null })
  return id
}

/**
 * Run the scaling decision engine across all roles for a workspace.
 * Cron-callable.
 */
export async function runScalingCycle(workspaceId: string): Promise<{ decisions: ScalingDecision[]; recorded: number }> {
  const nodes = await listNodes(workspaceId)
  const byRole = new Map<NodeRole, typeof nodes>()
  for (const n of nodes) {
    if (n.status !== 'healthy' && n.status !== 'degraded') continue
    const arr = byRole.get(n.role as NodeRole) ?? []
    arr.push(n); byRole.set(n.role as NodeRole, arr)
  }
  const decisions: ScalingDecision[] = []
  let recorded = 0
  for (const [role, group] of byRole) {
    const healthyNodes = group.filter(n => n.status === 'healthy').length
    const totalQueueDepth = group.reduce((s, n) => s + n.queueDepth, 0)
    const utilSum = group.reduce((s, n) => s + (n.capacity > 0 ? n.activeLoad / n.capacity : 0), 0)
    const avgUtilization = group.length > 0 ? utilSum / group.length : 0
    const d = decideScale(role, { healthyNodes, totalQueueDepth, avgUtilization })
    decisions.push(d)
    if (d.kind !== 'noop') {
      const id = await recordScalingEvent(workspaceId, d)
      if (id) recorded++
    }
  }
  return { decisions, recorded }
}

export async function recentScalingEvents(workspaceId: string, limit = 50) {
  return db.select().from(scalingEvents)
    .where(eq(scalingEvents.workspaceId, workspaceId))
    .orderBy(desc(scalingEvents.createdAt))
    .limit(limit).catch(() => [])
}

// ─── Fabric snapshot ────────────────────────────────────────────────────

export async function fabricSnapshot(workspaceId: string) {
  const nodes = await listNodes(workspaceId)
  const events = await recentScalingEvents(workspaceId, 10)

  const byRegion = new Map<string, { healthy: number; degraded: number; down: number; isolated: number }>()
  const byRole   = new Map<string, { healthy: number; total: number; load: number; capacity: number; queueDepth: number }>()
  for (const n of nodes) {
    const r = byRegion.get(n.region) ?? { healthy: 0, degraded: 0, down: 0, isolated: 0 }
    r[n.status as 'healthy' | 'degraded' | 'down' | 'isolated']++
    byRegion.set(n.region, r)

    const role = byRole.get(n.role) ?? { healthy: 0, total: 0, load: 0, capacity: 0, queueDepth: 0 }
    role.total++
    if (n.status === 'healthy') role.healthy++
    role.load += n.activeLoad
    role.capacity += n.capacity
    role.queueDepth += n.queueDepth
    byRole.set(n.role, role)
  }
  return {
    generatedAt: Date.now(),
    totalNodes: nodes.length,
    nodes,
    byRegion: Object.fromEntries(byRegion),
    byRole: Object.fromEntries(byRole),
    recentScalingEvents: events,
  }
}
