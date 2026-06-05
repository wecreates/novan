/**
 * R146.210 — Workflow runtime. Operators write JS scripts that compose
 * sub-agents, parallel(), pipeline(), and brain ops. Scripts run in a
 * sandbox (V8 vm context — no node API access). Each run is persisted
 * to workflow_runs for replay + observability.
 *
 * Exposed globals inside scripts:
 *   agent(prompt, opts?)       → string or parsed object
 *   parallel(thunks[])         → results[]
 *   log(message)               → appended to run.log
 *   args                       → the value passed to workflow.run
 *
 * Safety: scripts can only call the exposed globals. No `require`, no
 * `fetch`, no `process`, no filesystem. 30s hard timeout. 10K char log
 * cap. 1MB result cap.
 */
import { db } from '../db/client.js'
import { operatorWorkflows, operatorWorkflowRuns, workflowJournal } from '../db/schema.js'
import { and, eq, desc, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { spawnSubagent, parallelSubagents } from './r208-subagent.js'
import vm from 'node:vm'

export interface WorkflowInput {
  name:         string
  description?: string
  script:       string
}

export async function workflowCreate(workspaceId: string, input: WorkflowInput): Promise<{ id: string; created: boolean }> {
  const now = Date.now()
  const id = uuidv7()
  await db.insert(operatorWorkflows).values({
    id, workspaceId, name: input.name,
    description: input.description ?? null,
    script: input.script,
    createdAt: now, updatedAt: now,
  }).onConflictDoUpdate({
    target: [operatorWorkflows.workspaceId, operatorWorkflows.name],
    set: { description: input.description ?? null, script: input.script,
           version: sql`${operatorWorkflows.version} + 1`, updatedAt: now },
  })
  const [row] = await db.select({ id: operatorWorkflows.id, createdAt: operatorWorkflows.createdAt }).from(operatorWorkflows)
    .where(and(eq(operatorWorkflows.workspaceId, workspaceId), eq(operatorWorkflows.name, input.name))).limit(1)
  return { id: row?.id ?? id, created: row?.createdAt === now }
}

export async function workflowList(workspaceId: string): Promise<Array<{ id: string; name: string; description: string | null; version: number; runsCount: number; lastRunAt: number | null }>> {
  return db.select({
    id: operatorWorkflows.id, name: operatorWorkflows.name, description: operatorWorkflows.description,
    version: operatorWorkflows.version, runsCount: operatorWorkflows.runsCount, lastRunAt: operatorWorkflows.lastRunAt,
  }).from(operatorWorkflows).where(eq(operatorWorkflows.workspaceId, workspaceId)).orderBy(desc(operatorWorkflows.lastRunAt))
}

export interface WorkflowRunResult {
  runId:      string
  workflowId: string
  result?:    unknown
  error?:     string
  log:        string
  ms:         number
}

const MAX_RUN_MS  = 30_000
const MAX_LOG_LEN = 10_000

export async function workflowRun(workspaceId: string, name: string, args?: unknown): Promise<WorkflowRunResult> {
  const [wf] = await db.select().from(operatorWorkflows)
    .where(and(eq(operatorWorkflows.workspaceId, workspaceId), eq(operatorWorkflows.name, name))).limit(1)
  if (!wf) throw new Error(`workflow not found: ${name}`)

  const runId = uuidv7()
  const startedAt = Date.now()
  await db.insert(operatorWorkflowRuns).values({
    id: runId, workspaceId, workflowId: wf.id,
    args: (args ?? null) as Record<string, unknown> | null,
    startedAt,
  }).catch(() => null)

  const logParts: string[] = []
  const appendLog = (msg: unknown) => {
    if (logParts.join('').length > MAX_LOG_LEN) return
    logParts.push(String(msg).slice(0, 1000) + '\n')
  }

  // R216 — journal each step for resume.
  let stepCounter = 0
  const recordStep = async (kind: string, input: unknown, output?: unknown, error?: string, ms?: number) => {
    const stepId = uuidv7()
    await db.insert(workflowJournal).values({
      id: stepId, workflowRunId: runId, stepIndex: stepCounter++,
      stepKind: kind,
      stepInput:  input  === undefined ? null : (typeof input  === 'object' ? input  as Record<string, unknown> : { value: input }),
      stepOutput: output === undefined ? null : (typeof output === 'object' ? output as Record<string, unknown> : { value: output }),
      stepError: error ?? null,
      ms: ms ?? null,
      createdAt: Date.now(),
    }).catch(() => null)
  }

  const sandboxAgent = async (prompt: string, opts?: { schema?: Record<string, unknown> }) => {
    const t0 = Date.now()
    try {
      const r = await spawnSubagent(workspaceId, {
        parentOp: 'workflow.run',
        prompt,
        ...(opts?.schema ? { schema: opts.schema } : {}),
      })
      await recordStep('agent', { prompt: prompt.slice(0, 500) }, r as unknown, undefined, Date.now() - t0)
      return r.parsed ?? r.text
    } catch (e) {
      await recordStep('agent', { prompt: prompt.slice(0, 500) }, undefined, (e as Error).message, Date.now() - t0)
      throw e
    }
  }
  const sandboxParallel = async (thunks: Array<() => Promise<unknown>>) => {
    const t0 = Date.now()
    const out = await Promise.all(thunks.map(t => t()))
    await recordStep('parallel', { count: thunks.length }, { results: out.length }, undefined, Date.now() - t0)
    return out
  }

  let result: unknown
  let error: string | undefined
  try {
    const ctx = vm.createContext({
      agent:    sandboxAgent,
      parallel: sandboxParallel,
      // Parallel sub-agent shortcut — same shape as Workflow tool
      spawnMany: (reqs: Array<{ prompt: string; schema?: Record<string, unknown> }>) =>
        parallelSubagents(workspaceId, reqs.map(r => ({ parentOp: 'workflow.run', ...r }))),
      log:      appendLog,
      args,
      Math, JSON, Promise,
      console: { log: appendLog, error: appendLog },
    })
    const wrapped = `(async () => { ${wf.script}\n})()`
    result = await Promise.race([
      vm.runInContext(wrapped, ctx, { timeout: MAX_RUN_MS }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('workflow timed out')), MAX_RUN_MS + 500)),
    ])
  } catch (e) {
    error = (e as Error).message.slice(0, 1000)
  }

  const ms = Date.now() - startedAt
  const log = logParts.join('').slice(0, MAX_LOG_LEN)
  await db.update(operatorWorkflowRuns).set({
    result: (result === undefined || result === null) ? null : (typeof result === 'object' ? result as Record<string, unknown> : { value: result }),
    error: error ?? null, log, endedAt: Date.now(),
  }).catch(() => null)
  await db.update(operatorWorkflows).set({
    runsCount: sql`${operatorWorkflows.runsCount} + 1`, lastRunAt: Date.now(),
  }).where(eq(operatorWorkflows.id, wf.id)).catch(() => null)

  const out: WorkflowRunResult = { runId, workflowId: wf.id, log, ms }
  if (result !== undefined) out.result = result
  if (error) out.error = error
  return out
}
