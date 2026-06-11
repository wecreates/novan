/**
 * R646a — Multi-step r646_plans with checkpoints.
 *
 *   plan.create(goal, steps?)  LLM-decompose goal into ordered steps,
 *                              persist as a plan with status='pending'.
 *   plan.run(planId)           Execute remaining steps in sequence,
 *                              each step calling a brain op (or LLM).
 *                              Survives container restart — every step
 *                              result + next-pointer is persisted.
 *   plan.resume(planId)        Same as run; explicit semantics for clarity.
 *   plan.list / .get / .cancel
 *
 * A plan step is { op?: string, brief: string, params?: {}, depends_on_step? }.
 * If `op` is set, plan.run dispatches via the brain registry. Otherwise the
 * step is a free-form note that just gets marked done.
 *
 * Checkpoints survive crashes because each step writes its result before
 * the next one starts. On resume, we skip any step whose status is 'done'.
 */
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'
import type { ChatMsg } from './chat-providers.js'

async function ensureTables(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS r646_plans (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      goal          TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      total_steps   INTEGER NOT NULL DEFAULT 0,
      completed_steps INTEGER NOT NULL DEFAULT 0,
      created_at    BIGINT NOT NULL,
      updated_at    BIGINT NOT NULL,
      completed_at  BIGINT,
      error         TEXT
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS plans_ws_idx ON r646_plans (workspace_id, status, created_at DESC)`).catch(() => {})
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS r646_plan_steps (
      id            TEXT PRIMARY KEY,
      plan_id       TEXT NOT NULL,
      workspace_id  TEXT NOT NULL,
      step_index    INTEGER NOT NULL,
      brief         TEXT NOT NULL,
      op            TEXT,
      params        JSONB NOT NULL DEFAULT '{}'::jsonb,
      depends_on    INTEGER,
      status        TEXT NOT NULL DEFAULT 'pending',
      result        JSONB,
      error         TEXT,
      started_at    BIGINT,
      finished_at   BIGINT,
      UNIQUE (plan_id, step_index)
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS plan_steps_pid_idx ON r646_plan_steps (plan_id, step_index)`).catch(() => {})
}

export interface PlanStep {
  brief:        string
  op?:          string
  params?:      Record<string, unknown>
  dependsOn?:   number      // step_index of prerequisite
}

async function llmDecompose(workspaceId: string, goal: string): Promise<PlanStep[]> {
  const { streamChat } = await import('./chat-providers.js')
  const msgs: ChatMsg[] = [
    {
      role: 'system',
      content: 'You are a planning AI. Decompose the given goal into 3-10 concrete, ordered steps that the Novan platform can execute. Output strict JSON: { "steps": [{ "brief": "short directive", "op": "brain.op.name", "params": {} }] }. The `op` field is OPTIONAL — only set it if a brain op clearly maps. Always include "brief". Available op families include: research.deep, vision.*, code.exec, image.free.*, audio.*, narrative.*, scrape.*, rag.*, app.*, kg.*, voice.lib.*, sms.*, channel.*. No markdown, no commentary.',
    },
    { role: 'user', content: `Goal: ${goal}` },
  ]
  let raw = ''
  const stream = streamChat(workspaceId, msgs, { skipUsageTracking: false })
  let next: IteratorResult<{ delta: string; done: boolean }, { tokens: number; costUsd: number; provider: string; model: string }>
  while (!(next = await stream.next()).done) if (next.value.delta) raw += next.value.delta

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const candidate = (fenced?.[1] ?? raw).trim()
  const m = candidate.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('planner returned no JSON')
  const parsed = JSON.parse(m[0]) as { steps?: PlanStep[] }
  return (parsed.steps ?? []).filter(s => s?.brief && typeof s.brief === 'string').slice(0, 30)
}

export interface CreateInput {
  goal:    string
  steps?:  PlanStep[]      // operator-supplied; skip LLM decomposition
}

export interface CreateResult {
  id:       string
  goal:     string
  steps:    Array<{ index: number; brief: string; op: string | null }>
}

export async function createPlan(workspaceId: string, input: CreateInput): Promise<CreateResult> {
  await ensureTables()
  if (!input.goal?.trim()) throw new Error('goal required')
  const steps = (input.steps && input.steps.length > 0) ? input.steps : await llmDecompose(workspaceId, input.goal)
  if (steps.length === 0) throw new Error('no steps could be produced')

  const id = uuidv7()
  const now = Date.now()
  await db.execute(sql`
    INSERT INTO r646_plans (id, workspace_id, goal, total_steps, created_at, updated_at)
    VALUES (${id}, ${workspaceId}, ${input.goal.slice(0, 1000)}, ${steps.length}, ${now}, ${now})
  `).catch(() => {})
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    if (!s) continue
    await db.execute(sql`
      INSERT INTO r646_plan_steps (id, plan_id, workspace_id, step_index, brief, op, params, depends_on)
      VALUES (${uuidv7()}, ${id}, ${workspaceId}, ${i}, ${s.brief.slice(0, 500)}, ${s.op ?? null},
              ${JSON.stringify(s.params ?? {})}::jsonb, ${typeof s.dependsOn === 'number' ? s.dependsOn : null})
    `).catch(() => {})
  }
  return {
    id, goal: input.goal,
    steps: steps.map((s, i) => ({ index: i, brief: s.brief, op: s.op ?? null })),
  }
}

interface BrainHandle {
  dispatch: (op: string, workspaceId: string, params: Record<string, unknown>) => Promise<unknown>
}

async function getBrainDispatcher(): Promise<BrainHandle> {
  const mod = await import('./brain-task.js') as unknown as { OPERATIONS?: Record<string, { handler: (ws: string, params: Record<string, unknown>) => Promise<unknown> }> }
  const ops = mod.OPERATIONS
  if (!ops) throw new Error('OPERATIONS registry not exported')
  return {
    dispatch: async (op, ws, params) => {
      const entry = ops[op]
      if (!entry) throw new Error(`unknown op: ${op}`)
      return entry.handler(ws, params)
    },
  }
}

export interface RunResult {
  id:              string
  status:          'running' | 'done' | 'failed' | 'cancelled'
  totalSteps:      number
  completedSteps:  number
  durationMs:      number
  stepsRun:        Array<{ index: number; brief: string; ok: boolean; error?: string }>
}

export async function runPlan(workspaceId: string, planId: string): Promise<RunResult> {
  await ensureTables()
  const t0 = Date.now()
  const rows = await db.execute(sql`SELECT * FROM r646_plan_steps WHERE workspace_id = ${workspaceId} AND plan_id = ${planId} ORDER BY step_index`).catch(() => [] as unknown[])
  const steps = rows as Array<Record<string, unknown>>
  if (steps.length === 0) throw new Error('plan not found or has no steps')

  // Check plan-level status
  const planRow = await db.execute(sql`SELECT status, total_steps FROM r646_plans WHERE workspace_id = ${workspaceId} AND id = ${planId}`).catch(() => [] as unknown[])
  const plan = (planRow as Array<Record<string, unknown>>)[0]
  if (plan && String(plan['status']) === 'cancelled') {
    return { id: planId, status: 'cancelled', totalSteps: Number(plan['total_steps'] ?? steps.length), completedSteps: 0, durationMs: Date.now() - t0, stepsRun: [] }
  }
  await db.execute(sql`UPDATE r646_plans SET status = 'running', updated_at = ${Date.now()} WHERE id = ${planId} AND workspace_id = ${workspaceId}`).catch(() => {})

  const dispatcher = await getBrainDispatcher()
  const stepsRun: RunResult['stepsRun'] = []
  let completedCount = 0
  for (const s of steps) {
    const stepStatus = String(s['status'])
    if (stepStatus === 'done') { completedCount++; continue }

    const idx = Number(s['step_index'])
    const stepId = String(s['id'])
    const brief = String(s['brief'])
    const op = s['op'] != null ? String(s['op']) : null
    const params = (s['params'] as Record<string, unknown>) ?? {}

    await db.execute(sql`UPDATE r646_plan_steps SET status = 'running', started_at = ${Date.now()} WHERE id = ${stepId}`).catch(() => {})

    try {
      let result: unknown = null
      if (op) {
        result = await dispatcher.dispatch(op, workspaceId, params)
      } else {
        // Free-form step — mark done without action
        result = { skipped: 'no-op step (informational only)' }
      }
      await db.execute(sql`
        UPDATE r646_plan_steps SET status = 'done', result = ${JSON.stringify(result)}::jsonb,
          finished_at = ${Date.now()}
        WHERE id = ${stepId}
      `).catch(() => {})
      completedCount++
      stepsRun.push({ index: idx, brief, ok: true })
      await db.execute(sql`UPDATE r646_plans SET completed_steps = ${completedCount}, updated_at = ${Date.now()} WHERE id = ${planId}`).catch(() => {})
    } catch (e) {
      const err = (e as Error).message
      await db.execute(sql`
        UPDATE r646_plan_steps SET status = 'failed', error = ${err.slice(0, 1000)}, finished_at = ${Date.now()}
        WHERE id = ${stepId}
      `).catch(() => {})
      stepsRun.push({ index: idx, brief, ok: false, error: err })
      await db.execute(sql`
        UPDATE r646_plans SET status = 'failed', error = ${err.slice(0, 500)}, updated_at = ${Date.now()}, completed_at = ${Date.now()}
        WHERE id = ${planId}
      `).catch(() => {})
      return { id: planId, status: 'failed', totalSteps: steps.length, completedSteps: completedCount, durationMs: Date.now() - t0, stepsRun }
    }
  }

  await db.execute(sql`UPDATE r646_plans SET status = 'done', completed_at = ${Date.now()}, updated_at = ${Date.now()} WHERE id = ${planId}`).catch(() => {})
  return { id: planId, status: 'done', totalSteps: steps.length, completedSteps: completedCount, durationMs: Date.now() - t0, stepsRun }
}

export interface PlanRow {
  id:             string
  goal:           string
  status:         string
  totalSteps:     number
  completedSteps: number
  createdAt:      number
  updatedAt:      number
  completedAt:    number | null
  error:          string | null
}

export async function listPlans(workspaceId: string, limit = 50): Promise<PlanRow[]> {
  await ensureTables()
  const r = await db.execute(sql`SELECT * FROM r646_plans WHERE workspace_id = ${workspaceId} ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(200, limit))}`).catch(() => [] as unknown[])
  return (r as Array<Record<string, unknown>>).map(row => ({
    id:             String(row['id']),
    goal:           String(row['goal']),
    status:         String(row['status']),
    totalSteps:     Number(row['total_steps']),
    completedSteps: Number(row['completed_steps']),
    createdAt:      Number(row['created_at']),
    updatedAt:      Number(row['updated_at']),
    completedAt:    row['completed_at'] != null ? Number(row['completed_at']) : null,
    error:          row['error'] != null ? String(row['error']) : null,
  }))
}

export async function getPlan(workspaceId: string, id: string): Promise<{ plan: PlanRow; steps: Array<{ index: number; brief: string; op: string | null; status: string; error: string | null; result: unknown }> } | null> {
  await ensureTables()
  const planR = await db.execute(sql`SELECT * FROM r646_plans WHERE workspace_id = ${workspaceId} AND id = ${id}`).catch(() => [] as unknown[])
  const planRow = (planR as Array<Record<string, unknown>>)[0]
  if (!planRow) return null
  const stepsR = await db.execute(sql`SELECT step_index, brief, op, status, error, result FROM r646_plan_steps WHERE plan_id = ${id} AND workspace_id = ${workspaceId} ORDER BY step_index`).catch(() => [] as unknown[])
  const steps = (stepsR as Array<Record<string, unknown>>).map(s => ({
    index:  Number(s['step_index']),
    brief:  String(s['brief']),
    op:     s['op'] != null ? String(s['op']) : null,
    status: String(s['status']),
    error:  s['error'] != null ? String(s['error']) : null,
    result: s['result'] ?? null,
  }))
  return {
    plan: {
      id:             String(planRow['id']),
      goal:           String(planRow['goal']),
      status:         String(planRow['status']),
      totalSteps:     Number(planRow['total_steps']),
      completedSteps: Number(planRow['completed_steps']),
      createdAt:      Number(planRow['created_at']),
      updatedAt:      Number(planRow['updated_at']),
      completedAt:    planRow['completed_at'] != null ? Number(planRow['completed_at']) : null,
      error:          planRow['error'] != null ? String(planRow['error']) : null,
    },
    steps,
  }
}

export async function cancelPlan(workspaceId: string, id: string): Promise<{ ok: boolean }> {
  await ensureTables()
  await db.execute(sql`UPDATE r646_plans SET status = 'cancelled', updated_at = ${Date.now()}, completed_at = ${Date.now()} WHERE id = ${id} AND workspace_id = ${workspaceId} AND status IN ('pending','running')`).catch(() => {})
  return { ok: true }
}

// ─── /ops/r646_plans HTML ────────────────────────────────────────────────────────

function esc(s: unknown): string { return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!)) }
function fmtAgo(ts: number | null): string { if (!ts) return ''; const ms = Date.now() - ts; if (ms < 60_000) return `${Math.round(ms/1000)}s`; if (ms < 3600_000) return `${Math.round(ms/60_000)}m`; if (ms < 86_400_000) return `${Math.round(ms/3600_000)}h`; return `${Math.round(ms/86_400_000)}d` }

const STYLE = `body{font:14px/1.45 -apple-system,BlinkMacSystemFont,sans-serif;max-width:980px;margin:24px auto;padding:0 16px;color:#222}h1,h2{margin:.6em 0 .3em}h1{font-size:20px}table{border-collapse:collapse;width:100%}th,td{padding:6px 10px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}th{background:#f6f7f9;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em}.meta{color:#6b7280;font-size:12px;margin-bottom:8px}.dim{color:#9ca3af}.good{color:#059669}.bad{color:#b91c1c}.tag{display:inline-block;padding:2px 6px;border-radius:4px;background:#eef2ff;color:#3730a3;font-size:11px}.progress{display:inline-block;width:80px;height:8px;background:#e5e7eb;border-radius:4px;overflow:hidden;vertical-align:middle;margin-right:6px}.progress .bar{height:100%;background:#3b82f6;transition:width .3s}code{font:12.5px/1 ui-monospace,monospace;background:#f3f4f6;padding:1px 4px;border-radius:3px}`

export async function renderPlansHtml(workspaceId: string): Promise<string> {
  const r646_plans = await listPlans(workspaceId, 50)
  const rows = r646_plans.map(p => {
    const pct = p.totalSteps > 0 ? Math.round((p.completedSteps / p.totalSteps) * 100) : 0
    const cls = p.status === 'done' ? 'good' : p.status === 'failed' ? 'bad' : 'dim'
    return `<tr>
      <td><code>${esc(p.id.slice(0, 8))}</code> ${esc(p.goal.slice(0, 100))}</td>
      <td><span class="progress"><span class="bar" style="width:${pct}%"></span></span>${p.completedSteps}/${p.totalSteps}</td>
      <td class="${cls}">${esc(p.status)}</td>
      <td class="dim">${fmtAgo(p.createdAt)}</td>
      <td class="bad">${esc((p.error ?? '').slice(0, 120))}</td>
    </tr>`
  }).join('')
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="20"><title>Plans · Novan</title><style>${STYLE}</style>
<h1>Plans</h1>
<div class="meta">workspace=${esc(workspaceId)} · ${r646_plans.length} plan(s) · refresh 20s · use <code>plan.create</code> + <code>plan.run</code> brain ops</div>
<table><thead><tr><th>goal</th><th>progress</th><th>status</th><th>age</th><th>error</th></tr></thead><tbody>
${rows || '<tr><td colspan="5" class="dim">No r646_plans yet.</td></tr>'}
</tbody></table>`
}
