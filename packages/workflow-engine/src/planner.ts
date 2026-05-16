/**
 * Execution planner — converts a workflow step list (DAG) into ordered waves of
 * parallel-executable steps using a topological sort.
 */
import type { StepDefinition } from '@ops/shared-types'

export interface ExecutionPlan {
  /** Each wave is a set of steps that may run in parallel. */
  waves:      StepDefinition[][]
  totalSteps: number
}

/**
 * Build a wave-based execution plan from a flat step list.
 * Steps with no unresolved dependencies are grouped into the same wave.
 * Circular-dependency detection: if no progress is possible, the first
 * remaining step is broken out to avoid a hang.
 */
export function buildExecutionPlan(steps: StepDefinition[]): ExecutionPlan {
  if (steps.length === 0) return { waves: [], totalSteps: 0 }

  // Use plain string keys to avoid branded-type friction
  const stepMap  = new Map<string, StepDefinition>(steps.map((s) => [s.id as string, s]))
  const completed = new Set<string>()
  const remaining = new Set<string>(steps.map((s) => s.id as string))
  const waves: StepDefinition[][] = []

  while (remaining.size > 0) {
    const wave: StepDefinition[] = []

    for (const id of remaining) {
      const step = stepMap.get(id)!
      const ready = (step.dependsOn as string[]).every((d) => completed.has(d))
      if (ready) wave.push(step)
    }

    if (wave.length === 0) {
      // Circular dependency — break deadlock
      const breakId = remaining.values().next().value as string
      wave.push(stepMap.get(breakId)!)
    }

    for (const s of wave) {
      completed.add(s.id as string)
      remaining.delete(s.id as string)
    }
    waves.push(wave)
  }

  return { waves, totalSteps: steps.length }
}

/**
 * Return steps whose dependencies are satisfied and that have not yet been
 * completed or failed.  A failed dependency only blocks the dependent step
 * when onFailure === 'fail'; otherwise the step may still proceed.
 */
export function getReadySteps(
  steps:          StepDefinition[],
  completedSteps: Set<string>,
  failedSteps:    Set<string>,
): StepDefinition[] {
  return steps.filter((step) => {
    const id = step.id as string
    if (completedSteps.has(id) || failedSteps.has(id)) return false

    return (step.dependsOn as string[]).every((dep) => {
      if (completedSteps.has(dep)) return true
      if (failedSteps.has(dep) && step.onFailure !== 'fail') return true
      return false
    })
  })
}
