/**
 * Workflow executor — loads and executes a workflow run step-by-step.
 *
 * Algorithm:
 *   1. Load WorkflowRun + WorkflowDefinition
 *   2. Build dependency graph (topological sort via runtime-kernel)
 *   3. Execute ready steps concurrently (no pending dependencies)
 *   4. On step complete: mark done, re-evaluate ready set
 *   5. Repeat until all steps done or fatal failure
 *   6. On approval needed: persist approval record, emit event, pause run
 *   7. On step failure: apply retry policy or mark run failed
 *   8. Checkpoint state after each step for replay safety
 *   9. Write observability traces + recovery snapshots/checkpoints
 */
import type { Logger }    from 'pino'
import { eq }             from 'drizzle-orm'
import { v7 as uuidv7 }  from 'uuid'
import {
  topologicalSort,
  readyNodes,
  shouldRetry,
  nextBackoffMs,
  createCheckpoint as makeCheckpointState,
  serializeCheckpoint,
  DEFAULT_RETRY_POLICY,
  type Node,
} from '@ops/runtime-kernel'
import type { StepDefinition, RetryPolicy } from '@ops/shared-types'
import type { DbClient } from '@ops/db'
import {
  workflowRuns,
  workflowDefinitions,
  stepRuns,
  approvals,
  deadLetterJobs,
} from '@ops/db'

// ─── Observability hooks (optional) ──────────────────────────────────────────

export interface ObservabilityHooks {
  openWorkflowTrace: (input: {
    traceId:     string
    runId:       string
    workflowId:  string
    workspaceId: string
    triggeredBy: string
    status:      string
  }) => Promise<string>

  closeWorkflowTrace: (runId: string, update: {
    status:        string
    durationMs?:   number
    stepCount?:    number
    failedAt?:     number
    completedAt?:  number
    errorMessage?: string
  }) => Promise<void>

  openTaskTrace: (input: {
    traceId:     string
    runId:       string
    stepId:      string
    stepType:    string
    workspaceId: string
    attempt?:    number
  }) => Promise<string>

  closeTaskTrace: (id: string, update: {
    status:      string
    durationMs?: number
    output?:     Record<string, unknown>
    error?:      string
    completedAt?: number
  }) => Promise<void>

  openFailureLineage: (input: {
    workspaceId:   string
    runId:         string
    traceId:       string
    failureChain:  Array<{ eventId: string; eventType: string; timestamp: number; message?: string }>
    affectedSteps: string[]
    rootCause?:    string
  }) => Promise<string>
}

// ─── Recovery hooks (optional) ────────────────────────────────────────────────

export interface RecoveryHooks {
  createSnapshot: (input: {
    workspaceId:  string
    runId:        string
    traceId:      string
    stepId?:      string
    description?: string
  }) => Promise<string>

  createCheckpoint: (input: {
    workspaceId:    string
    runId:          string
    stepId:         string
    traceId:        string
    completedSteps: string[]
    state:          Record<string, unknown>
    snapshotId?:    string
  }) => Promise<string>
}

// ─── Context ──────────────────────────────────────────────────────────────────

export interface ExecutorContext {
  runId:       string
  workspaceId: string
  traceId:     string
  log:         Logger
  db:          DbClient
  emitEvent:   (type: string, workspaceId: string, payload: unknown) => Promise<void>
  observability?: ObservabilityHooks
  recovery?:      RecoveryHooks
  resumeFromApproval?: {
    approvalId: string
    approved:   boolean
    resolvedBy: string
  }
}

// ─── Step types requiring a snapshot (external side effects) ─────────────────

const RISKY_STEP_TYPES = new Set(['action', 'webhook'])

// ─── Step execution ───────────────────────────────────────────────────────────

interface StepResult {
  status:  'completed' | 'failed' | 'approval_needed'
  output?: unknown
  error?:  string
  approvalContext?: Record<string, unknown>
}

/** Dispatches a single step. Extend with real adapters per step type. */
async function dispatchStep(
  step:    StepDefinition,
  context: Record<string, unknown>,
  log:     Logger,
): Promise<StepResult> {
  log.info({ stepId: step.id, type: step.type }, 'Dispatching step')

  const cfg = (step.config ?? {}) as Record<string, unknown>

  switch (step.type) {
    case 'approval':
      return {
        status: 'approval_needed',
        approvalContext: { stepId: step.id, config: cfg },
      }

    // ── Real HTTP adapter ──────────────────────────────────────────────────
    case 'http': {
      const url     = cfg['url'] as string | undefined
      const method  = ((cfg['method'] as string | undefined) ?? 'GET').toUpperCase()
      const headers = (cfg['headers'] as Record<string, string> | undefined) ?? {}
      const body    = cfg['body'] as unknown

      if (!url) return { status: 'failed', error: 'http step missing url' }

      // SECURITY: SSRF guard — block private IP ranges + internal hostnames.
      // Workflows can be created by any authenticated user; without this
      // guard a workflow step could fetch http://169.254.169.254 (AWS IMDS),
      // http://10.x.x.x (internal LAN), http://localhost:5432 (Postgres), etc.
      try {
        const u = new URL(url)
        const host = u.hostname.toLowerCase()
        const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
        const isPrivate = /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|fc00::|fd[0-9a-f]{2}:)/.test(host)
        const isInternalTLD = host.endsWith('.local') || host.endsWith('.internal') || host === 'metadata.google.internal'
        const isAllowed = process.env['WORKFLOW_ALLOW_PRIVATE_HOSTS'] === '1'
        if (!isAllowed && (isLocalhost || isPrivate || isInternalTLD)) {
          return { status: 'failed', error: `http step blocked: ${host} is a private/internal host (SSRF protection)` }
        }
        // Require http(s)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          return { status: 'failed', error: `http step blocked: protocol ${u.protocol} not allowed` }
        }
      } catch (e) {
        return { status: 'failed', error: `http step invalid url: ${(e as Error).message}` }
      }

      const timeout = typeof step.timeout === 'number' ? step.timeout : 30_000
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)

      try {
        const reqInit: RequestInit = {
          method,
          headers: { 'Content-Type': 'application/json', ...headers },
          signal:  controller.signal,
          redirect: 'manual',   // prevent SSRF via redirect-to-private
        }
        if (body !== undefined) reqInit.body = JSON.stringify(body)
        const res = await fetch(url, reqInit)
        clearTimeout(timer)

        const text = await res.text().catch(() => '')
        let json: unknown
        try { json = JSON.parse(text) } catch { json = text }

        if (!res.ok) {
          return {
            status: 'failed',
            error:  `HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`,
            output: { statusCode: res.status, body: json },
          }
        }
        return { status: 'completed', output: { statusCode: res.status, body: json } }
      } catch (err: unknown) {
        clearTimeout(timer)
        const msg = err instanceof Error ? err.message : String(err)
        return { status: 'failed', error: `HTTP request failed: ${msg}` }
      }
    }

    // ── Real delay adapter ─────────────────────────────────────────────────
    case 'delay': {
      const waitMs = typeof cfg['waitMs'] === 'number' ? cfg['waitMs'] : 1000
      await new Promise<void>((r) => setTimeout(r, Math.min(waitMs, 60_000)))
      return { status: 'completed', output: { waited: waitMs } }
    }

    // ── Transform adapter ──────────────────────────────────────────────────
    case 'transform': {
      // Simple passthrough — real expression engine can be added later
      const expression = cfg['expression'] as string | undefined
      return { status: 'completed', output: { expression, context } }
    }

    case 'action':
    case 'webhook':
    case 'condition': {
      // TODO: real adapter per type — for now simulate 95% success
      await new Promise<void>((r) => setTimeout(r, 50))
      if (Math.random() < 0.05) {
        return { status: 'failed', error: 'Simulated transient failure' }
      }
      return { status: 'completed', output: { ok: true, ts: Date.now() } }
    }

    case 'ai_inference':
    case 'memory_read':
    case 'memory_write':
    case 'browser':
    case 'parallel':
    case 'scheduled':
    default:
      // Placeholder: mark completed — real adapters added per worker
      await new Promise<void>((r) => setTimeout(r, 20))
      return { status: 'completed', output: { skipped: true, type: step.type } }
  }
}

// ─── Main executor ────────────────────────────────────────────────────────────

export async function executeWorkflowRun(ctx: ExecutorContext): Promise<void> {
  const { runId, workspaceId, traceId, log, db, emitEvent, observability, recovery, resumeFromApproval } = ctx

  log.info({ runId }, 'Starting workflow execution')

  // ── 1. Load run + definition ──────────────────────────────────────────────

  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId))
  if (!run) throw new Error(`WorkflowRun not found: ${runId}`)

  const [def] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run.workflowId))
  if (!def)  throw new Error(`WorkflowDefinition not found: ${run.workflowId}`)

  // ── 2. Mark running + open workflow trace ─────────────────────────────────

  await db.update(workflowRuns)
    .set({ status: 'running', startedAt: Date.now() })
    .where(eq(workflowRuns.id, runId))

  await emitEvent('workflow.run.started', workspaceId, { runId, traceId })

  // Open observability workflow trace
  await observability?.openWorkflowTrace({
    traceId,
    runId,
    workflowId:  run.workflowId,
    workspaceId,
    triggeredBy: run.triggeredBy ?? 'unknown',
    status:      'running',
  }).catch((err: unknown) => log.warn({ err }, 'openWorkflowTrace failed — continuing'))

  // ── 3. Build dependency graph ─────────────────────────────────────────────

  const steps = (def.steps ?? []) as StepDefinition[]
  if (steps.length === 0) {
    await finishRun(ctx, 0, 0, 0)
    return
  }

  const nodes: Node[] = steps.map((s) => ({ id: s.id, deps: s.dependsOn ?? [] }))
  let sortedIds: string[]
  try {
    sortedIds = topologicalSort(nodes)
  } catch {
    await failRun(ctx, 'Cycle detected in step dependency graph', [])
    return
  }

  const stepMap = new Map<string, StepDefinition>(steps.map((s) => [s.id as string, s]))

  // ── 4. Load existing step-run records (for resume / retry) ────────────────

  const existingRuns = await db.select().from(stepRuns).where(eq(stepRuns.runId, runId))
  const completed    = new Set<string>(existingRuns.filter((r) => r.status === 'completed').map((r) => r.stepId as string))
  const runContext   = (run.context ?? {}) as Record<string, unknown>

  let stepsSuccess = completed.size
  let stepsFailed  = 0
  const startTs    = Date.now()
  const failedStepIds: string[] = []

  // ── 5. Handle resume-from-approval ───────────────────────────────────────

  if (resumeFromApproval) {
    const { approvalId, approved } = resumeFromApproval
    if (!approved) {
      await failRun(ctx, `Approval ${approvalId} rejected`, [])
      return
    }
    log.info({ approvalId }, 'Resuming after approval')
  }

  // ── 6. Execute step-by-step ───────────────────────────────────────────────

  const total          = sortedIds.length
  let   activeSnapshot = ''   // most recent snapshot id for checkpoints

  while (completed.size < total) {
    const ready = readyNodes(nodes, completed)
    if (ready.length === 0) break  // blocked (approval pause or cycle escape)

    // Run ready steps concurrently
    const results = await Promise.allSettled(
      ready.map(async (stepId) => {
        const step = stepMap.get(stepId)
        if (!step) return

        const retryPolicy: RetryPolicy = {
          ...(def.retryPolicy as RetryPolicy ?? DEFAULT_RETRY_POLICY),
          ...(step.retryPolicy ?? {}),
        }

        let attempt = 1

        while (true) {
          const stepRunId  = uuidv7()
          const stepStart  = Date.now()

          // Create snapshot before risky steps
          if (RISKY_STEP_TYPES.has(step.type) && recovery) {
            try {
              activeSnapshot = await recovery.createSnapshot({
                workspaceId,
                runId,
                traceId,
                stepId,
                description: `Before ${step.type} step: ${step.name ?? stepId}`,
              })
            } catch (err: unknown) {
              log.warn({ err, stepId }, 'createSnapshot failed — continuing without snapshot')
            }
          }

          // Open task trace
          const taskTraceId = await observability?.openTaskTrace({
            traceId,
            runId,
            stepId,
            stepType:    step.type,
            workspaceId,
            attempt,
          }).catch((err: unknown) => { log.warn({ err }, 'openTaskTrace failed'); return undefined })

          await db.insert(stepRuns).values({
            id:          stepRunId,
            runId,
            stepId,
            workspaceId,
            status:      'running',
            startedAt:   stepStart,
            attempt,
          })

          const result = await dispatchStep(step, runContext, log)

          if (result.status === 'approval_needed') {
            // Close task trace as paused
            if (taskTraceId) {
              await observability?.closeTaskTrace(taskTraceId, {
                status:    'paused',
                durationMs: Date.now() - stepStart,
              }).catch(() => null)
            }

            // Persist approval record and pause run
            const approvalId  = uuidv7()
            const expiresAt   = Date.now() + 24 * 60 * 60 * 1000 // 24h

            await db.insert(approvals).values({
              id:             approvalId,
              workspaceId,
              runId,
              stepId,
              requestedBy:    'workflow-engine',
              requestedAt:    Date.now(),
              expiresAt,
              status:         'pending',
              operationLabel: step.name ?? step.id,
              context:        (result.approvalContext ?? {}) as Record<string, unknown>,
              risk:           (step.config as Record<string, string> | undefined)?.['risk'] ?? 'medium',
            })

            await db.update(workflowRuns)
              .set({
                status:          'awaiting_approval',
                checkpointAt:    Date.now(),
                checkpointState: serializeCheckpoint(
                  makeCheckpointState(runId, sortedIds.indexOf(stepId), { completed: [...completed] })
                ) as unknown as Record<string, unknown>,
              })
              .where(eq(workflowRuns.id, runId))

            await emitEvent('workflow.approval.needed', workspaceId, {
              runId, stepId, approvalId, traceId,
            })

            return  // Pause execution — resume job will be queued by approvals route
          }

          if (result.status === 'completed') {
            const durationMs = Date.now() - stepStart

            await db.update(stepRuns)
              .set({ status: 'completed', completedAt: Date.now(), output: result.output as Record<string, unknown> })
              .where(eq(stepRuns.runId, runId))

            completed.add(stepId)
            stepsSuccess++

            await emitEvent('workflow.step.completed', workspaceId, { runId, stepId, traceId })

            // Close task trace as completed
            if (taskTraceId) {
              await observability?.closeTaskTrace(taskTraceId, {
                status:    'completed',
                durationMs,
                completedAt: Date.now(),
                ...(result.output !== undefined ? { output: result.output as Record<string, unknown> } : {}),
              }).catch(() => null)
            }

            // Save recovery checkpoint
            if (recovery) {
              await recovery.createCheckpoint({
                workspaceId,
                runId,
                stepId,
                traceId,
                completedSteps: [...completed],
                state:          { output: result.output },
                ...(activeSnapshot ? { snapshotId: activeSnapshot } : {}),
              }).catch((err: unknown) => log.warn({ err, stepId }, 'createCheckpoint failed'))
            }

            return
          }

          // Failed
          if (shouldRetry(retryPolicy, attempt)) {
            attempt++
            const delay = nextBackoffMs(retryPolicy, attempt)
            log.warn({ stepId, attempt, delay }, 'Step failed, retrying')

            await db.update(stepRuns)
              .set({ status: 'retrying', attempt })
              .where(eq(stepRuns.runId, runId))

            if (taskTraceId) {
              await observability?.closeTaskTrace(taskTraceId, {
                status: 'retrying',
                error:  result.error ?? 'unknown',
                durationMs: Date.now() - stepStart,
              }).catch(() => null)
            }

            await new Promise<void>((r) => setTimeout(r, delay))
            continue
          }

          // Exhausted retries
          await db.update(stepRuns)
            .set({ status: 'failed', error: result.error ?? null, completedAt: Date.now() })
            .where(eq(stepRuns.runId, runId))

          stepsFailed++
          failedStepIds.push(stepId)

          if (taskTraceId) {
            await observability?.closeTaskTrace(taskTraceId, {
              status:    'failed',
              error:     result.error ?? 'unknown',
              durationMs: Date.now() - stepStart,
              completedAt: Date.now(),
            }).catch(() => null)
          }

          await emitEvent('workflow.step.failed', workspaceId, { runId, stepId, error: result.error, traceId })
          throw new Error(`Step ${stepId} failed: ${result.error}`)
        }
      }),
    )

    // Check if any step threw
    const failure = results.find((r) => r.status === 'rejected')
    if (failure) {
      const err = (failure as PromiseRejectedResult).reason as Error
      await failRun(ctx, err.message, failedStepIds)
      return
    }

    // If run is now paused for approval, stop iterating
    const [refreshed] = await db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, runId))
    if (refreshed?.status === 'awaiting_approval') {
      log.info({ runId }, 'Run paused awaiting approval')
      return
    }
  }

  await finishRun(ctx, stepsSuccess, stepsFailed, Date.now() - startTs)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function finishRun(
  ctx:          ExecutorContext,
  stepsSuccess: number,
  stepsFailed:  number,
  durationMs:   number,
): Promise<void> {
  const { runId, workspaceId, traceId, log, db, emitEvent, observability } = ctx

  await db.update(workflowRuns)
    .set({ status: 'completed', completedAt: Date.now() })
    .where(eq(workflowRuns.id, runId))

  await emitEvent('workflow.run.completed', workspaceId, {
    runId, traceId, durationMs,
    stepsTotal: stepsSuccess + stepsFailed,
    stepsSuccess,
    stepsFailed,
  })

  await observability?.closeWorkflowTrace(runId, {
    status:      'completed',
    durationMs,
    stepCount:   stepsSuccess + stepsFailed,
    completedAt: Date.now(),
  }).catch(() => null)

  log.info({ runId, durationMs, stepsSuccess, stepsFailed }, 'Workflow run completed')
}

async function failRun(
  ctx:            ExecutorContext,
  reason:         string,
  failedStepIds:  string[],
): Promise<void> {
  const { runId, workspaceId, traceId, log, db, emitEvent, observability } = ctx

  await db.update(workflowRuns)
    .set({ status: 'failed', failedAt: Date.now(), errorMessage: reason })
    .where(eq(workflowRuns.id, runId))

  await emitEvent('workflow.run.failed', workspaceId, { runId, traceId, reason })

  // Write to dead-letter queue table so ops team can retry/discard
  await db.insert(deadLetterJobs).values({
    id:             uuidv7(),
    queueName:      'workflow',       // matches QUEUE_NAMES.WORKFLOW — used for re-enqueue on retry
    jobId:          runId,
    jobName:        'execute-workflow',
    workspaceId,
    payload:        { runId, traceId, failedStepIds } as Record<string, unknown>,
    error:          reason,
    attempts:       failedStepIds.length,
    workerId:       'workflow-worker',
    traceId,
    firstFailedAt:  Date.now(),
    deadLetteredAt: Date.now(),
  }).catch((err: unknown) => log.warn({ err, runId }, 'Failed to write to DLQ — continuing'))

  // Open failure lineage
  await observability?.openFailureLineage({
    workspaceId,
    runId,
    traceId,
    failureChain:  [{ eventId: uuidv7(), eventType: 'workflow.run.failed', timestamp: Date.now(), message: reason }],
    affectedSteps: failedStepIds,
    rootCause:     reason,
  }).catch(() => null)

  await observability?.closeWorkflowTrace(runId, {
    status:       'failed',
    failedAt:     Date.now(),
    errorMessage: reason,
  }).catch(() => null)

  log.error({ runId, reason }, 'Workflow run failed')
}
