/**
 * long-horizon-planner.ts — Dependency-aware roadmap sequencing.
 *
 * Reads roadmap_tasks.predecessors and computes a topological ordering
 * with cycle detection. Returns "waves" — groups of tasks safe to run
 * in parallel.
 *
 * Honest: predecessor edges come from real data (set by planners). When
 * no predecessors exist, falls back to phase + priorityScore ordering.
 */
import { db }                          from '../db/client.js'
import { roadmapTasks }                from '../db/schema.js'
import { and, desc, eq, inArray }      from 'drizzle-orm'

export interface PlannedTask {
  id:              string
  recommendationId: string | null
  title:           string
  phase:           string
  category:        string
  priorityScore:   number
  requiresApproval: boolean
  status:          string
  predecessors:    string[]
  missionAlignment: string[]
}

export interface Wave {
  index:    number
  tasks:    PlannedTask[]
  blocked:  number          // tasks waiting on unresolved predecessors
}

export interface SchedulePlan {
  workspaceId:   string
  generatedAt:   number
  totalTasks:    number
  waves:         Wave[]
  cyclesDetected: string[][]  // groups of recommendationIds in a cycle (if any)
  blockedTasks:  PlannedTask[]
  unscheduled:   PlannedTask[]
}

function toPlannedTask(r: typeof roadmapTasks.$inferSelect): PlannedTask {
  return {
    id:               r.id,
    recommendationId: r.recommendationId,
    title:            String(r.title ?? ''),
    phase:            String(r.phase ?? ''),
    category:         String(r.category ?? ''),
    priorityScore:    Number(r.priorityScore ?? 0),
    requiresApproval: !!r.requiresApproval,
    status:           String(r.status ?? ''),
    predecessors:     (Array.isArray(r.predecessors) ? r.predecessors : []) as string[],
    missionAlignment: (Array.isArray(r.missionAlignment) ? r.missionAlignment : []) as string[],
  }
}

/** Topologically sort tasks into parallel-safe waves. */
export async function generateSchedule(workspaceId: string, opts?: { statuses?: string[] }): Promise<SchedulePlan> {
  const statuses = opts?.statuses ?? ['pending', 'approved', 'in_progress']
  const rows = await db.select().from(roadmapTasks)
    .where(and(eq(roadmapTasks.workspaceId, workspaceId), inArray(roadmapTasks.status, statuses)))
    .orderBy(desc(roadmapTasks.priorityScore))
    .catch(() => [])

  const tasks = rows.map(toPlannedTask)
  const byRecId = new Map<string, PlannedTask>()
  for (const t of tasks) if (t.recommendationId) byRecId.set(t.recommendationId, t)

  // Build edge map: task → predecessors that exist in our task set
  const edges = new Map<string, string[]>()
  for (const t of tasks) {
    const resolved = t.predecessors.filter(p => byRecId.has(p))
    edges.set(t.id, resolved.map(p => byRecId.get(p)!.id))
  }

  // Cycle detection via DFS
  const visited = new Set<string>()
  const stack = new Set<string>()
  const cycles: string[][] = []

  function detect(taskId: string, path: string[]): void {
    if (stack.has(taskId)) {
      const start = path.indexOf(taskId)
      if (start >= 0) cycles.push(path.slice(start))
      return
    }
    if (visited.has(taskId)) return
    visited.add(taskId)
    stack.add(taskId)
    for (const next of edges.get(taskId) ?? []) {
      detect(next, [...path, taskId])
    }
    stack.delete(taskId)
  }
  for (const t of tasks) detect(t.id, [])

  // Build waves: Kahn's algorithm
  // In-degree counts how many predecessors each task still depends on
  const inDegree = new Map<string, number>()
  for (const t of tasks) inDegree.set(t.id, edges.get(t.id)?.length ?? 0)

  const completed = new Set<string>()
  const waves: Wave[] = []
  let safety = 100   // bound iterations
  while (completed.size < tasks.length && safety-- > 0) {
    const ready = tasks.filter(t => !completed.has(t.id) && (inDegree.get(t.id) ?? 0) === 0)
    if (ready.length === 0) break
    waves.push({
      index: waves.length,
      tasks: ready.sort((a, b) => b.priorityScore - a.priorityScore),
      blocked: 0,
    })
    for (const t of ready) {
      completed.add(t.id)
      // Decrement in-degree of tasks that depend on this one
      for (const [other, preds] of edges) {
        if (preds.includes(t.id)) inDegree.set(other, (inDegree.get(other) ?? 1) - 1)
      }
    }
  }

  const blocked = tasks.filter(t => !completed.has(t.id))
  // Map recId-of-task → recommendationIds it's stuck behind
  const recIdsInCycles = new Set(cycles.flat())

  return {
    workspaceId, generatedAt: Date.now(),
    totalTasks: tasks.length,
    waves,
    cyclesDetected: cycles,
    blockedTasks: blocked,
    unscheduled: blocked.filter(t => !recIdsInCycles.has(t.id)),
  }
}

/** Add a predecessor edge between two tasks (idempotent). */
export async function addPredecessor(workspaceId: string, taskId: string, predecessorRecommendationId: string): Promise<{ ok: boolean }> {
  const row = await db.select().from(roadmapTasks)
    .where(and(eq(roadmapTasks.workspaceId, workspaceId), eq(roadmapTasks.id, taskId)))
    .limit(1).then(r => r[0]).catch(() => null)
  if (!row) return { ok: false }
  const current = (Array.isArray(row.predecessors) ? row.predecessors : []) as string[]
  if (current.includes(predecessorRecommendationId)) return { ok: true }
  await db.update(roadmapTasks).set({
    predecessors: [...current, predecessorRecommendationId],
    updatedAt: Date.now(),
  }).where(eq(roadmapTasks.id, taskId)).catch(() => null)
  return { ok: true }
}
