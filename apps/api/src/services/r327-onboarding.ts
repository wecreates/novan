/**
 * R146.327 (#5) — operator onboarding tracker.
 *
 * Fresh workspace needs 5 minimal steps:
 *   1. persona      — name + greeting (operator's preferred address)
 *   2. firstGoal    — at least one strategic goal
 *   3. connector    — at least one wired (Slack/Gmail/etc)
 *   4. budget       — confirm cost cap is acceptable
 *   5. preview      — see first Monday briefing
 *
 * Tracker lives in workspace_setup_progress. Brain ops surface state +
 * mark-complete. UI calls these as the operator clicks through.
 */
import { db } from '../db/client.js'
import { workspaceSetupProgress } from '../db/schema.js'
import { eq } from 'drizzle-orm'

const STEPS = ['persona', 'firstGoal', 'connector', 'budget', 'preview'] as const
export type SetupStep = (typeof STEPS)[number]

export interface SetupState {
  workspaceId: string
  steps:       Record<SetupStep, boolean>
  completed:   boolean
  nextStep:    SetupStep | null
  percentDone: number
  startedAt:   number
  completedAt: number | null
}

function emptyStepRecord(): Record<SetupStep, boolean> {
  const out: Record<string, boolean> = {}
  for (const s of STEPS) out[s] = false
  return out as Record<SetupStep, boolean>
}

export async function getSetupState(workspaceId: string): Promise<SetupState> {
  const [row] = await db.select().from(workspaceSetupProgress)
    .where(eq(workspaceSetupProgress.workspaceId, workspaceId))
    .limit(1)
    .catch(() => [])
  const now = Date.now()
  if (!row) {
    // First visit — create row.
    await db.insert(workspaceSetupProgress).values({
      workspaceId, steps: emptyStepRecord(),
      startedAt: now, updatedAt: now,
    } as never).onConflictDoNothing().catch(() => null)
    const next = STEPS[0]
    return {
      workspaceId, steps: emptyStepRecord(), completed: false,
      nextStep: next ?? null, percentDone: 0,
      startedAt: now, completedAt: null,
    }
  }
  const steps = { ...emptyStepRecord(), ...((row.steps ?? {}) as Record<SetupStep, boolean>) }
  const doneCount = STEPS.filter(s => steps[s]).length
  const nextStep = STEPS.find(s => !steps[s]) ?? null
  return {
    workspaceId, steps,
    completed: doneCount === STEPS.length,
    nextStep, percentDone: Math.round((doneCount / STEPS.length) * 100),
    startedAt: Number(row.startedAt),
    completedAt: row.completedAt ? Number(row.completedAt) : null,
  }
}

export async function markStep(workspaceId: string, step: SetupStep): Promise<SetupState> {
  if (!(STEPS as readonly string[]).includes(step)) throw new Error(`unknown step: ${step}`)
  const state = await getSetupState(workspaceId)
  state.steps[step] = true
  const allDone = STEPS.every(s => state.steps[s])
  const now = Date.now()
  await db.update(workspaceSetupProgress)
    .set({
      steps: state.steps,
      updatedAt: now,
      ...(allDone && !state.completedAt ? { completedAt: now } : {}),
    } as never)
    .where(eq(workspaceSetupProgress.workspaceId, workspaceId))
  return getSetupState(workspaceId)
}
