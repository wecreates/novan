/**
 * orchestrator.ts — Multi-agent orchestrator + parallel execution control.
 *
 * Responsibilities:
 * - Register agents with capabilities
 * - Assign tasks to capable agents
 * - Acquire locks before execution
 * - Track dependencies (block dependent tasks until prerequisites complete)
 * - Surface health metrics
 *
 * Locks are persisted via lock-manager. Assignments persisted via agentAssignments.
 * Stuck-agent detection is heartbeat-based with auto-restart.
 */
import { db }              from '../db/client.js'
import {
  agentRegistrations, agentAssignments, events,
}                          from '../db/schema.js'
import { eq, and, desc, lt, inArray, isNull, gt } from 'drizzle-orm'
import { v7 as uuidv7 }    from 'uuid'
import {
  acquireLock, releaseLock, recoverStaleLocks, isLocked,
}                          from './lock-manager.js'
import type { LockKind }   from './lock-manager.js'

export const HEARTBEAT_STALE_MS = 60_000  // 1 min — past this, agent flagged 'down'
export const STUCK_ASSIGNMENT_MS = 10 * 60_000 // 10 min — running too long, auto-fail

async function emitEvent(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'orchestrator', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

// ─── Agent registration ───────────────────────────────────────────────────────

export interface RegisterAgentInput {
  agentId:      string
  workspaceId:  string
  agentName:    string
  capabilities: string[]
}

export async function registerAgent(input: RegisterAgentInput): Promise<void> {
  const now = Date.now()
  const existing = await db.select().from(agentRegistrations)
    .where(eq(agentRegistrations.id, input.agentId)).limit(1)

  if (existing[0]) {
    await db.update(agentRegistrations).set({
      capabilities:  input.capabilities,
      status:        'idle',
      lastHeartbeat: now,
      updatedAt:     now,
    }).where(eq(agentRegistrations.id, input.agentId))
    return
  }

  await db.insert(agentRegistrations).values({
    id:                input.agentId,
    workspaceId:       input.workspaceId,
    agentName:         input.agentName,
    capabilities:      input.capabilities,
    status:            'idle',
    lastHeartbeat:     now,
    activeAssignments: 0,
    successCount:      0,
    failureCount:      0,
    rollbackCount:     0,
    registeredAt:      now,
    updatedAt:         now,
  })
}

export async function heartbeat(agentId: string): Promise<void> {
  await db.update(agentRegistrations).set({
    lastHeartbeat: Date.now(),
    updatedAt:     Date.now(),
  }).where(eq(agentRegistrations.id, agentId))
}

// ─── Health / stuck detection ─────────────────────────────────────────────────

/** Mark agents as 'down' if heartbeat is stale. Returns count flagged. */
export async function detectStuckAgents(workspaceId: string): Promise<number> {
  const cutoff = Date.now() - HEARTBEAT_STALE_MS
  const stale = await db.select({ id: agentRegistrations.id, agentName: agentRegistrations.agentName })
    .from(agentRegistrations)
    .where(and(
      eq(agentRegistrations.workspaceId, workspaceId),
      lt(agentRegistrations.lastHeartbeat, cutoff),
      inArray(agentRegistrations.status, ['idle', 'busy']),
    ))
    .limit(50)

  for (const a of stale) {
    await db.update(agentRegistrations).set({
      status:    'down',
      updatedAt: Date.now(),
    }).where(eq(agentRegistrations.id, a.id))
    await emitEvent(workspaceId, 'orchestrator.agent_marked_down', {
      agentId: a.id, agentName: a.agentName,
    })
  }
  return stale.length
}

/** Restart down agents — mark restarting, expect heartbeat to resume. */
export async function restartAgent(agentId: string, workspaceId: string): Promise<void> {
  await db.update(agentRegistrations).set({
    status:        'restarting',
    lastHeartbeat: Date.now(),
    updatedAt:     Date.now(),
  }).where(eq(agentRegistrations.id, agentId))
  await emitEvent(workspaceId, 'orchestrator.agent_restarted', { agentId })
}

/** Detect and fail stuck assignments (running > STUCK_ASSIGNMENT_MS). */
export async function failStuckAssignments(workspaceId: string): Promise<number> {
  const cutoff = Date.now() - STUCK_ASSIGNMENT_MS
  const stuck = await db.select({
    id: agentAssignments.id, agentId: agentAssignments.agentId, taskRef: agentAssignments.taskRef,
  }).from(agentAssignments)
    .where(and(
      eq(agentAssignments.workspaceId, workspaceId),
      eq(agentAssignments.status, 'running'),
      lt(agentAssignments.startedAt, cutoff),
    ))
    .limit(50)

  for (const s of stuck) {
    await db.update(agentAssignments).set({
      status:       'failed',
      errorMessage: `Stuck for > ${STUCK_ASSIGNMENT_MS / 60_000} min — auto-failed`,
      completedAt:  Date.now(),
      updatedAt:    Date.now(),
    }).where(eq(agentAssignments.id, s.id))
    await emitEvent(workspaceId, 'orchestrator.stuck_assignment_failed', {
      assignmentId: s.id, agentId: s.agentId, taskRef: s.taskRef,
    })
  }
  return stuck.length
}

// ─── Assignment / capability matching ─────────────────────────────────────────

export interface AssignTaskInput {
  workspaceId:       string
  taskKind:          string
  taskRef:           string
  requiredCapability: string
  priority?:         number
  dependsOn?:        string[]   // other assignment IDs
  lockRequests?:     Array<{ kind: LockKind; key: string }>
}

export type AssignResult =
  | { ok: true; assignmentId: string; agentId: string; locks: string[]; blocked: boolean }
  | { ok: false; reason: string }

/** Pick the healthiest idle agent with required capability, or return why we can't. */
async function pickAgent(workspaceId: string, capability: string): Promise<string | null> {
  await detectStuckAgents(workspaceId)
  const candidates = await db.select().from(agentRegistrations)
    .where(and(
      eq(agentRegistrations.workspaceId, workspaceId),
      eq(agentRegistrations.status, 'idle'),
    ))
    .limit(50)

  // Filter to those with required capability
  const eligible = candidates.filter((c) => c.capabilities.includes(capability))
  if (eligible.length === 0) return null

  // Prefer lowest activeAssignments + lowest rollback rate
  eligible.sort((a, b) => {
    if (a.activeAssignments !== b.activeAssignments) return a.activeAssignments - b.activeAssignments
    return a.rollbackCount - b.rollbackCount
  })
  return eligible[0]?.id ?? null
}

export async function assignTask(input: AssignTaskInput): Promise<AssignResult> {
  const agentId = await pickAgent(input.workspaceId, input.requiredCapability)
  if (!agentId) {
    return { ok: false, reason: `No idle agent with capability '${input.requiredCapability}'` }
  }

  const now = Date.now()
  const id  = uuidv7()

  // Check dependencies — if any are incomplete, mark blocked
  let isBlocked = false
  if (input.dependsOn && input.dependsOn.length > 0) {
    const deps = await db.select({ id: agentAssignments.id, status: agentAssignments.status })
      .from(agentAssignments)
      .where(inArray(agentAssignments.id, input.dependsOn))
    isBlocked = deps.some((d) => d.status !== 'complete')
  }

  // Try to acquire all requested locks atomically (best-effort, sequential)
  const heldLocks: string[] = []
  if (input.lockRequests) {
    for (const req of input.lockRequests) {
      const res = await acquireLock({
        workspaceId: input.workspaceId,
        lockKind:    req.kind,
        resourceKey: req.key,
        holderId:    id,
        holderKind:  'assignment',
      })
      if (!res.ok) {
        // Release any acquired so far
        for (const l of heldLocks) await releaseLock(l, id)
        return { ok: false, reason: `Lock conflict: ${res.reason}` }
      }
      heldLocks.push(res.lockId)
    }
  }

  // Insert assignment
  await db.insert(agentAssignments).values({
    id,
    workspaceId: input.workspaceId,
    agentId,
    taskKind:    input.taskKind,
    taskRef:     input.taskRef,
    status:      isBlocked ? 'blocked' : 'assigned',
    dependsOn:   input.dependsOn ?? [],
    priority:    input.priority ?? 50,
    assignedAt:  now,
    updatedAt:   now,
  })

  // Bump agent active count
  await db.update(agentRegistrations).set({
    status:            'busy',
    activeAssignments: (await getAgentActiveCount(agentId)) + 1,
    updatedAt:         now,
  }).where(eq(agentRegistrations.id, agentId))

  await emitEvent(input.workspaceId, 'orchestrator.agent_assigned', {
    assignmentId: id, agentId, taskKind: input.taskKind, taskRef: input.taskRef, isBlocked,
  })
  if (isBlocked) {
    await emitEvent(input.workspaceId, 'orchestrator.task_blocked', {
      assignmentId: id, dependsOn: input.dependsOn,
    })
  }

  return { ok: true, assignmentId: id, agentId, locks: heldLocks, blocked: isBlocked }
}

async function getAgentActiveCount(agentId: string): Promise<number> {
  const rows = await db.select({ id: agentAssignments.id })
    .from(agentAssignments)
    .where(and(
      eq(agentAssignments.agentId, agentId),
      inArray(agentAssignments.status, ['assigned', 'running']),
    ))
  return rows.length
}

// ─── Lifecycle transitions ────────────────────────────────────────────────────

export async function markAssignmentStarted(assignmentId: string): Promise<void> {
  const rows = await db.select().from(agentAssignments).where(eq(agentAssignments.id, assignmentId)).limit(1)
  const a = rows[0]
  if (!a) return
  const now = Date.now()
  await db.update(agentAssignments).set({
    status: 'running', startedAt: now, updatedAt: now,
  }).where(eq(agentAssignments.id, assignmentId))
  await emitEvent(a.workspaceId, 'orchestrator.task_started', {
    assignmentId, agentId: a.agentId, taskRef: a.taskRef,
  })
}

export async function markAssignmentComplete(
  assignmentId: string, success: boolean, errorMessage?: string,
): Promise<void> {
  const rows = await db.select().from(agentAssignments).where(eq(agentAssignments.id, assignmentId)).limit(1)
  const a = rows[0]
  if (!a) return
  const now = Date.now()

  await db.update(agentAssignments).set({
    status:       success ? 'complete' : 'failed',
    errorMessage: errorMessage ?? null,
    completedAt:  now,
    updatedAt:    now,
  }).where(eq(agentAssignments.id, assignmentId))

  // Release all locks held by this assignment via lock-manager API
  const { releaseLock: _r } = await import('./lock-manager.js')
  void _r
  // Get lock IDs held by this assignmentId
  const { executionLocks: locksTable } = await import('../db/schema.js')
  const activeLocks = await db.select({ id: locksTable.id })
    .from(locksTable)
    .where(and(
      eq(locksTable.holderId, assignmentId),
      isNull(locksTable.releasedAt),
    ))
  for (const l of activeLocks) await releaseLock(l.id, assignmentId)

  // Update agent metrics
  const activeCount = await getAgentActiveCount(a.agentId)
  await db.update(agentRegistrations).set({
    status:            activeCount > 0 ? 'busy' : 'idle',
    activeAssignments: activeCount,
    successCount:      success ? (await getAgentSuccessCount(a.agentId)) + 1 : (await getAgentSuccessCount(a.agentId)),
    failureCount:      !success ? (await getAgentFailureCount(a.agentId)) + 1 : (await getAgentFailureCount(a.agentId)),
    updatedAt:         now,
  }).where(eq(agentRegistrations.id, a.agentId))

  // Unblock dependents
  await unblockDependents(a.workspaceId, assignmentId)
}

async function getAgentSuccessCount(agentId: string): Promise<number> {
  const r = await db.select({ c: agentRegistrations.successCount })
    .from(agentRegistrations).where(eq(agentRegistrations.id, agentId)).limit(1)
  return r[0]?.c ?? 0
}
async function getAgentFailureCount(agentId: string): Promise<number> {
  const r = await db.select({ c: agentRegistrations.failureCount })
    .from(agentRegistrations).where(eq(agentRegistrations.id, agentId)).limit(1)
  return r[0]?.c ?? 0
}

/** When a task completes, unblock assignments that depend on it (if all deps done). */
async function unblockDependents(workspaceId: string, completedAssignmentId: string): Promise<void> {
  const blocked = await db.select().from(agentAssignments)
    .where(and(
      eq(agentAssignments.workspaceId, workspaceId),
      eq(agentAssignments.status, 'blocked'),
    ))
    .limit(100)

  for (const b of blocked) {
    if (!b.dependsOn.includes(completedAssignmentId)) continue
    // Check if all deps complete
    const deps = await db.select({ status: agentAssignments.status })
      .from(agentAssignments).where(inArray(agentAssignments.id, b.dependsOn))
    if (deps.every((d) => d.status === 'complete')) {
      await db.update(agentAssignments).set({
        status: 'assigned', updatedAt: Date.now(),
      }).where(eq(agentAssignments.id, b.id))
      await emitEvent(workspaceId, 'orchestrator.task_unblocked', {
        assignmentId: b.id, taskRef: b.taskRef,
      })
    }
  }
}

// ─── Parallel batch dispatch ──────────────────────────────────────────────────

export interface BatchTask {
  taskKind:          string
  taskRef:           string
  requiredCapability: string
  priority?:         number
  lockRequests?:     Array<{ kind: LockKind; key: string }>
  dependsOn?:        string[]
}

export interface BatchResult {
  assigned:   Array<{ taskRef: string; assignmentId: string; agentId: string; blocked: boolean }>
  rejected:   Array<{ taskRef: string; reason: string }>
}

/**
 * Dispatch a batch of tasks. Tasks with no lock conflicts run in parallel.
 * Tasks with conflicting locks are rejected (caller must retry later).
 */
export async function dispatchBatch(
  workspaceId: string, tasks: BatchTask[],
): Promise<BatchResult> {
  await recoverStaleLocks(workspaceId)
  const assigned: BatchResult['assigned'] = []
  const rejected: BatchResult['rejected'] = []

  // Pre-check lock conflicts within the batch itself (file-level dedup)
  const seenKeys = new Set<string>()
  for (const t of tasks) {
    let conflict: string | null = null
    if (t.lockRequests) {
      for (const lr of t.lockRequests) {
        const k = `${lr.kind}:${lr.key}`
        if (seenKeys.has(k)) { conflict = k; break }
        // Also check live locks
        if (await isLocked(workspaceId, lr.kind, lr.key)) { conflict = k; break }
      }
    }
    if (conflict) {
      rejected.push({ taskRef: t.taskRef, reason: `Lock conflict on '${conflict}' (within batch or active)` })
      continue
    }

    // Reserve keys in batch
    if (t.lockRequests) for (const lr of t.lockRequests) seenKeys.add(`${lr.kind}:${lr.key}`)

    const res = await assignTask({
      workspaceId, ...t,
    })
    if (res.ok) {
      assigned.push({
        taskRef: t.taskRef, assignmentId: res.assignmentId, agentId: res.agentId, blocked: res.blocked,
      })
    } else {
      rejected.push({ taskRef: t.taskRef, reason: res.reason })
    }
  }

  await emitEvent(workspaceId, 'orchestrator.parallel_execution_started', {
    assignedCount: assigned.length, rejectedCount: rejected.length, total: tasks.length,
  })

  return { assigned, rejected }
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function listAgents(workspaceId: string) {
  await detectStuckAgents(workspaceId)
  return db.select().from(agentRegistrations)
    .where(eq(agentRegistrations.workspaceId, workspaceId))
    .orderBy(desc(agentRegistrations.lastHeartbeat))
    .limit(100)
}

export async function listAssignments(workspaceId: string, status?: string) {
  if (status) {
    return db.select().from(agentAssignments)
      .where(and(eq(agentAssignments.workspaceId, workspaceId), eq(agentAssignments.status, status)))
      .orderBy(desc(agentAssignments.assignedAt))
      .limit(100)
  }
  return db.select().from(agentAssignments)
    .where(eq(agentAssignments.workspaceId, workspaceId))
    .orderBy(desc(agentAssignments.assignedAt))
    .limit(100)
}

export async function getDependencyGraph(workspaceId: string) {
  // Active + recently completed assignments with deps
  const rows = await db.select().from(agentAssignments)
    .where(and(
      eq(agentAssignments.workspaceId, workspaceId),
      gt(agentAssignments.assignedAt, Date.now() - 6 * 3600_000),
    ))
    .orderBy(desc(agentAssignments.assignedAt))
    .limit(100)

  return rows.map((r) => ({
    id:        r.id,
    taskKind:  r.taskKind,
    taskRef:   r.taskRef,
    agentId:   r.agentId,
    status:    r.status,
    dependsOn: r.dependsOn,
  }))
}
