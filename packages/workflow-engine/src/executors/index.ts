/**
 * Step executor registry — maps StepType strings to async executor functions.
 *
 * Built-in executors cover the synthetic step types used internally.
 * Application-level executors (browser, ai_inference, webhook, etc.) are
 * registered at worker startup via registerExecutor().
 */
import type { StepType } from '@ops/shared-types'
import type { StepExecutionContext, StepExecutionResult } from '../index.js'

export type { StepExecutionContext, StepExecutionResult }

// ─── Registry ─────────────────────────────────────────────────────────────────

const executors = new Map<string, (ctx: StepExecutionContext) => Promise<StepExecutionResult>>()

export function registerExecutor(
  type:     StepType | string,
  executor: (ctx: StepExecutionContext) => Promise<StepExecutionResult>,
): void {
  executors.set(type, executor)
}

export function getExecutor(
  type: StepType | string,
): ((ctx: StepExecutionContext) => Promise<StepExecutionResult>) | null {
  return executors.get(type) ?? null
}

export function listRegisteredTypes(): string[] {
  return [...executors.keys()]
}

/**
 * Execute a step by type.  Unknown types are treated as a no-op success so
 * that optional / future step types do not break deployed runs.
 */
export async function executeStep(
  ctx:    StepExecutionContext,
  type:   StepType | string,
): Promise<StepExecutionResult> {
  const executor = executors.get(type)
  if (!executor) {
    return {
      status: 'completed',
      output: { skipped: true, reason: `No executor registered for step type: ${type}` },
    }
  }
  return executor(ctx)
}

// ─── Additional executors (registered on import) ──────────────────────────────
// Imported for side-effects: each module calls registerExecutor() at module load.
import './http.js'
import './ai-completion.js'
import './delay.js'

// ─── Built-in executors ───────────────────────────────────────────────────────

/** Pause execution for a configurable duration (max 30 s to avoid queue stalls). */
registerExecutor('wait', async (ctx) => {
  const ms = Math.min(Number(ctx.step.config['durationMs'] ?? 1_000), 30_000)
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
  return { status: 'completed', output: { waited: ms } }
})

/**
 * Evaluate a boolean condition from step config.
 * Supports a simple dot-path lookup against previousOutputs.
 */
registerExecutor('condition', async (ctx) => {
  const fromStep = ctx.step.config['fromStep'] as string | undefined
  const field    = ctx.step.config['field']    as string | undefined

  let value: unknown

  if (fromStep && field) {
    const stepOutput = ctx.previousOutputs[fromStep] ?? {}
    value = field.split('.').reduce<unknown>((acc, part) =>
      acc !== null && acc !== undefined ? (acc as Record<string, unknown>)[part] : undefined,
      stepOutput,
    )
  } else {
    value = ctx.step.config['value']
  }

  const result = Boolean(value)
  return { status: 'completed', output: { result, value } }
})

/**
 * Field-mapping transform — project values from previousOutputs into a new shape.
 * Config: { mappings: { outputKey: 'stepId.fieldPath' } }
 */
registerExecutor('transform', async (ctx) => {
  const mappings = (ctx.step.config['mappings'] ?? {}) as Record<string, string>
  const output: Record<string, unknown> = {}

  for (const [key, dotPath] of Object.entries(mappings)) {
    const parts   = dotPath.split('.')
    const stepId  = parts[0]
    const rest    = parts.slice(1)
    let val: unknown = ctx.previousOutputs[stepId ?? ''] ?? {}
    for (const p of rest) {
      val = val !== null && val !== undefined ? (val as Record<string, unknown>)[p] : undefined
    }
    output[key] = val
  }

  return { status: 'completed', output }
})

/**
 * Notification stub — real implementation pushes to notifications queue.
 * Returns success so workflows are not blocked on notification delivery.
 */
registerExecutor('notification', async (ctx) => {
  return {
    status: 'completed',
    output: {
      sent:    true,
      channel: ctx.step.config['channel'] ?? 'system',
      message: ctx.step.config['message'] ?? '',
    },
  }
})

/**
 * Human-approval gate — signals the engine to pause and await approval.
 * The engine checks StepExecutionResult.status === 'awaiting_approval' and
 * persists an approval request; execution resumes on approveStep().
 */
registerExecutor('approval', async (ctx) => {
  return {
    status: 'awaiting_approval',
    output: {
      label:   ctx.step.config['label']     ?? 'Manual approval required',
      risk:    ctx.step.config['riskLevel'] ?? 'medium',
      message: ctx.step.config['message']  ?? '',
    },
  }
})
