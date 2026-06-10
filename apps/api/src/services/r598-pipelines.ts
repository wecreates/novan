/**
 * R598 — End-to-end pipeline registry + runner + health monitor.
 *
 * Problem: Novan has dozens of brain ops but no first-class concept of a
 * named pipeline (e.g. "competitor → parity → self-dev → ship"). Each step
 * works in isolation; failures mid-chain go untracked; no single dashboard
 * tells the operator which automations are still running end-to-end vs
 * silently dead.
 *
 * R598 ships:
 *   - pipelines table: named, versioned, scheduled stage-graph definitions
 *   - pipeline_runs table: per-run telemetry (per-stage status + duration)
 *   - runPipeline() — executes stages against OPERATIONS, propagates output of
 *     stage N as `prev` into stage N+1's params template, retries on transient
 *     errors per stage, captures everything for replay
 *   - 4 seeded canonical pipelines wired to existing ops
 *   - health snapshot: success rate per stage, last-run age, dead-pipeline detector
 *
 * Pipeline stage shape (stored as JSONB):
 *   {
 *     op:            'category.action',         // must exist in OPERATIONS
 *     params:        { ... }                    // static params
 *     params_from?:  { paramName: 'prev.field.path' }  // pull from prev stage output
 *     gate?:         { op, expect }             // skip pipeline if gate returns falsy / mismatch
 *     retry_max?:    number                     // default 2
 *     retry_backoff_ms?: number                 // default 500
 *     optional?:     boolean                    // failure doesn't fail the pipeline
 *   }
 *
 * Resolution rule for params_from: dotted path on prev stage's RESULT (the
 * handler return), e.g. 'items.0.id'. Missing path → param omitted.
 */
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'

async function ensureTables(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS pipelines (
      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL,
      business_id     TEXT,
      name            TEXT NOT NULL,
      description     TEXT,
      stages          JSONB NOT NULL,
      schedule_cron   TEXT,
      enabled         BOOLEAN NOT NULL DEFAULT TRUE,
      created_at      BIGINT NOT NULL,
      updated_at      BIGINT NOT NULL,
      last_run_at     BIGINT,
      last_run_status TEXT
    )
  `).catch(() => {})
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS pipelines_ws_name_idx ON pipelines (workspace_id, name)`).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS pipelines_ws_biz_idx ON pipelines (workspace_id, business_id) WHERE business_id IS NOT NULL`).catch(() => {})

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id                TEXT PRIMARY KEY,
      workspace_id      TEXT NOT NULL,
      pipeline_id       TEXT NOT NULL,
      pipeline_name     TEXT NOT NULL,
      started_at        BIGINT NOT NULL,
      ended_at          BIGINT,
      status            TEXT NOT NULL,           -- running|success|partial|failed|skipped
      stage_count       INT NOT NULL DEFAULT 0,
      success_stages    INT NOT NULL DEFAULT 0,
      failed_stages     INT NOT NULL DEFAULT 0,
      error             TEXT,
      stage_results     JSONB NOT NULL DEFAULT '[]'::jsonb,
      trigger           TEXT NOT NULL DEFAULT 'manual'  -- manual|cron|chain
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS pipeline_runs_ws_pid_started_idx ON pipeline_runs (workspace_id, pipeline_id, started_at DESC)`).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS pipeline_runs_status_idx ON pipeline_runs (workspace_id, status, started_at DESC)`).catch(() => {})
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PipelineStage {
  op:                string
  params?:           Record<string, unknown>
  params_from?:      Record<string, string>     // { dst: 'prev.path' }
  gate?:             { op: string; expect?: unknown }
  retry_max?:        number
  retry_backoff_ms?: number
  optional?:         boolean
  label?:            string
}

export interface Pipeline {
  id:             string
  workspaceId:    string
  businessId:     string | null
  name:           string
  description:    string | null
  stages:         PipelineStage[]
  scheduleCron:   string | null
  enabled:        boolean
  createdAt:      number
  updatedAt:      number
  lastRunAt:      number | null
  lastRunStatus:  string | null
}

export interface StageResult {
  stageIndex: number
  op:         string
  label?:     string
  status:     'success' | 'failed' | 'skipped' | 'gate_blocked'
  durationMs: number
  output?:    unknown
  error?:     string
  attempts:   number
}

export interface PipelineRun {
  id:           string
  pipelineId:   string
  pipelineName: string
  startedAt:    number
  endedAt:      number | null
  status:       'running' | 'success' | 'partial' | 'failed' | 'skipped'
  stageCount:   number
  successStages:number
  failedStages: number
  error:        string | null
  stageResults: StageResult[]
  trigger:      string
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

function rowToPipeline(r: any): Pipeline {
  return {
    id: r.id, workspaceId: r.workspace_id, businessId: r.business_id,
    name: r.name, description: r.description,
    stages: Array.isArray(r.stages) ? r.stages : [],
    scheduleCron: r.schedule_cron, enabled: !!r.enabled,
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    lastRunAt: r.last_run_at == null ? null : Number(r.last_run_at),
    lastRunStatus: r.last_run_status,
  }
}

export interface DefinePipelineInput {
  name:         string
  description?: string
  stages:       PipelineStage[]
  scheduleCron?:string
  businessId?:  string
  enabled?:     boolean
}

export async function definePipeline(workspaceId: string, input: DefinePipelineInput): Promise<Pipeline> {
  await ensureTables()
  if (!input.name || !Array.isArray(input.stages) || input.stages.length === 0) {
    throw new Error('name + non-empty stages required')
  }
  for (const s of input.stages) {
    if (!s.op || typeof s.op !== 'string') throw new Error(`stage missing op: ${JSON.stringify(s).slice(0, 100)}`)
  }
  const now = Date.now()
  // Upsert by (workspace, name).
  const existing = await db.execute(sql`SELECT id FROM pipelines WHERE workspace_id = ${workspaceId} AND name = ${input.name} LIMIT 1`).catch(() => [] as unknown[])
  const existingRow = (existing as Array<{ id: string }>)[0]
  const id = existingRow?.id ?? uuidv7()
  if (existingRow) {
    await db.execute(sql`
      UPDATE pipelines SET
        description    = ${input.description ?? null},
        stages         = ${JSON.stringify(input.stages)}::jsonb,
        schedule_cron  = ${input.scheduleCron ?? null},
        business_id    = ${input.businessId ?? null},
        enabled        = ${input.enabled ?? true},
        updated_at     = ${now}
      WHERE id = ${id}
    `).catch(() => {})
  } else {
    await db.execute(sql`
      INSERT INTO pipelines (id, workspace_id, business_id, name, description, stages, schedule_cron, enabled, created_at, updated_at)
      VALUES (${id}, ${workspaceId}, ${input.businessId ?? null}, ${input.name}, ${input.description ?? null},
              ${JSON.stringify(input.stages)}::jsonb, ${input.scheduleCron ?? null}, ${input.enabled ?? true}, ${now}, ${now})
    `).catch(() => {})
  }
  const r = await db.execute(sql`SELECT * FROM pipelines WHERE id = ${id} LIMIT 1`).catch(() => [] as unknown[])
  return rowToPipeline((r as any[])[0])
}

export async function listPipelines(workspaceId: string): Promise<Pipeline[]> {
  await ensureTables()
  const r = await db.execute(sql`SELECT * FROM pipelines WHERE workspace_id = ${workspaceId} ORDER BY name`).catch(() => [] as unknown[])
  return (r as any[]).map(rowToPipeline)
}

export async function getPipelineByName(workspaceId: string, name: string): Promise<Pipeline | null> {
  await ensureTables()
  const r = await db.execute(sql`SELECT * FROM pipelines WHERE workspace_id = ${workspaceId} AND name = ${name} LIMIT 1`).catch(() => [] as unknown[])
  const row = (r as any[])[0]
  return row ? rowToPipeline(row) : null
}

export async function setEnabled(workspaceId: string, name: string, enabled: boolean): Promise<{ ok: boolean }> {
  await ensureTables()
  await db.execute(sql`UPDATE pipelines SET enabled = ${enabled}, updated_at = ${Date.now()} WHERE workspace_id = ${workspaceId} AND name = ${name}`).catch(() => {})
  return { ok: true }
}

// ─── Runner ──────────────────────────────────────────────────────────────────

function getPath(obj: unknown, path: string): unknown {
  if (!path) return undefined
  const parts = path.replace(/^prev\.?/, '').split('.').filter(Boolean)
  let cur: any = obj
  for (const p of parts) {
    if (cur == null) return undefined
    cur = cur[p]
  }
  return cur
}

function isTransientError(msg: string): boolean {
  const m = msg.toLowerCase()
  return m.includes('econnreset') || m.includes('etimedout') || m.includes('socket hang up') ||
    m.includes('503') || m.includes('502') || m.includes('429') || m.includes('rate limit') ||
    m.includes('temporarily') || m.includes('timeout')
}

async function sleep(ms: number): Promise<void> { return new Promise(res => setTimeout(res, ms)) }

export interface RunOptions {
  trigger?: string
  params?:  Record<string, unknown>   // injected as `pipeline` context, addressable via `pipeline.foo`
}

export async function runPipeline(workspaceId: string, name: string, opts: RunOptions = {}): Promise<PipelineRun> {
  await ensureTables()
  const pipeline = await getPipelineByName(workspaceId, name)
  if (!pipeline) throw new Error(`pipeline not found: ${name}`)

  // Late-import OPERATIONS to avoid a top-level cycle.
  const { OPERATIONS } = await import('./brain-task.js') as { OPERATIONS: Record<string, { handler: (ws: string, params: Record<string, unknown>) => Promise<unknown>; risk?: string }> }

  const runId = uuidv7()
  const startedAt = Date.now()
  const stageResults: StageResult[] = []
  let lastOutput: unknown = opts.params ?? {}

  await db.execute(sql`
    INSERT INTO pipeline_runs (id, workspace_id, pipeline_id, pipeline_name, started_at, status, stage_count, trigger)
    VALUES (${runId}, ${workspaceId}, ${pipeline.id}, ${pipeline.name}, ${startedAt}, 'running', ${pipeline.stages.length}, ${opts.trigger ?? 'manual'})
  `).catch(() => {})

  let success = 0, failed = 0, runError: string | null = null

  for (let i = 0; i < pipeline.stages.length; i++) {
    const stage = pipeline.stages[i]!
    const stageStart = Date.now()

    // Gate check.
    if (stage.gate) {
      const gateSpec = OPERATIONS[stage.gate.op]
      if (gateSpec) {
        try {
          const gateOut = await gateSpec.handler(workspaceId, {})
          if (stage.gate.expect !== undefined && gateOut !== stage.gate.expect) {
            stageResults.push({ stageIndex: i, op: stage.op, label: stage.label, status: 'gate_blocked', durationMs: Date.now() - stageStart, output: gateOut, attempts: 0 })
            continue
          }
          if (stage.gate.expect === undefined && !gateOut) {
            stageResults.push({ stageIndex: i, op: stage.op, label: stage.label, status: 'gate_blocked', durationMs: Date.now() - stageStart, output: gateOut, attempts: 0 })
            continue
          }
        } catch (e) {
          stageResults.push({ stageIndex: i, op: stage.op, label: stage.label, status: 'gate_blocked', durationMs: Date.now() - stageStart, error: `gate threw: ${(e as Error).message.slice(0, 200)}`, attempts: 0 })
          continue
        }
      }
    }

    // Resolve params from previous stage output.
    const params: Record<string, unknown> = { ...(stage.params ?? {}) }
    if (stage.params_from) {
      for (const [dst, srcPath] of Object.entries(stage.params_from)) {
        const v = getPath(lastOutput, srcPath)
        if (v !== undefined) params[dst] = v
      }
    }

    const spec = OPERATIONS[stage.op]
    if (!spec) {
      const r: StageResult = { stageIndex: i, op: stage.op, label: stage.label, status: 'failed', durationMs: Date.now() - stageStart, error: `unknown op: ${stage.op}`, attempts: 0 }
      stageResults.push(r)
      if (stage.optional) continue
      failed++; runError = r.error!
      break
    }

    const maxRetry = stage.retry_max ?? 2
    const backoff = stage.retry_backoff_ms ?? 500
    let attempts = 0, lastErr: string | null = null, out: unknown = null, ok = false
    while (attempts <= maxRetry) {
      attempts++
      try {
        out = await spec.handler(workspaceId, params)
        ok = true; break
      } catch (e) {
        lastErr = (e as Error).message.slice(0, 500)
        if (attempts > maxRetry || !isTransientError(lastErr)) break
        await sleep(backoff * attempts)
      }
    }

    if (ok) {
      success++
      stageResults.push({ stageIndex: i, op: stage.op, label: stage.label, status: 'success', durationMs: Date.now() - stageStart, output: out, attempts })
      lastOutput = out
    } else {
      stageResults.push({ stageIndex: i, op: stage.op, label: stage.label, status: 'failed', durationMs: Date.now() - stageStart, error: lastErr ?? 'unknown', attempts })
      if (stage.optional) continue
      failed++; runError = lastErr ?? 'stage failed'
      break
    }
  }

  const endedAt = Date.now()
  const status: PipelineRun['status'] =
    failed === 0 && success === pipeline.stages.length ? 'success' :
    failed > 0 && success > 0 ? 'partial' :
    failed > 0 ? 'failed' : 'skipped'

  await db.execute(sql`
    UPDATE pipeline_runs SET ended_at = ${endedAt}, status = ${status},
      success_stages = ${success}, failed_stages = ${failed},
      error = ${runError}, stage_results = ${JSON.stringify(stageResults)}::jsonb
    WHERE id = ${runId}
  `).catch(() => {})
  await db.execute(sql`UPDATE pipelines SET last_run_at = ${endedAt}, last_run_status = ${status} WHERE id = ${pipeline.id}`).catch(() => {})

  return {
    id: runId, pipelineId: pipeline.id, pipelineName: pipeline.name,
    startedAt, endedAt, status, stageCount: pipeline.stages.length,
    successStages: success, failedStages: failed, error: runError,
    stageResults, trigger: opts.trigger ?? 'manual',
  }
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function listRuns(workspaceId: string, name?: string, limit = 20): Promise<PipelineRun[]> {
  await ensureTables()
  const r = name
    ? await db.execute(sql`
        SELECT r.* FROM pipeline_runs r
        JOIN pipelines p ON p.id = r.pipeline_id
        WHERE r.workspace_id = ${workspaceId} AND p.name = ${name}
        ORDER BY r.started_at DESC LIMIT ${Math.min(limit, 100)}
      `)
    : await db.execute(sql`SELECT * FROM pipeline_runs WHERE workspace_id = ${workspaceId} ORDER BY started_at DESC LIMIT ${Math.min(limit, 100)}`)
  return (r as any[]).map((x): PipelineRun => ({
    id: x.id, pipelineId: x.pipeline_id, pipelineName: x.pipeline_name,
    startedAt: Number(x.started_at), endedAt: x.ended_at == null ? null : Number(x.ended_at),
    status: x.status, stageCount: Number(x.stage_count),
    successStages: Number(x.success_stages), failedStages: Number(x.failed_stages),
    error: x.error, stageResults: Array.isArray(x.stage_results) ? x.stage_results : [], trigger: x.trigger,
  }))
}

export interface PipelineHealth {
  name:             string
  enabled:          boolean
  lastRunAt:        number | null
  lastStatus:       string | null
  lastRunAgeHours:  number | null
  runs7d:           number
  successRate7d:    number          // 0..1
  partialRate7d:    number
  failureRate7d:    number
  staleness:        'fresh' | 'aging' | 'dead'    // <24h | <7d | >=7d
}

export async function health(workspaceId: string): Promise<PipelineHealth[]> {
  await ensureTables()
  const pipelines = await listPipelines(workspaceId)
  const out: PipelineHealth[] = []
  const sevenDayAgo = Date.now() - 7 * 24 * 60 * 60_000
  for (const p of pipelines) {
    const r = await db.execute(sql`
      SELECT status, COUNT(*)::int AS n FROM pipeline_runs
      WHERE workspace_id = ${workspaceId} AND pipeline_id = ${p.id} AND started_at >= ${sevenDayAgo}
      GROUP BY status
    `).catch(() => [] as unknown[])
    const byStatus: Record<string, number> = {}
    for (const x of r as Array<{ status: string; n: number }>) byStatus[x.status] = Number(x.n)
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0)
    const lastAge = p.lastRunAt ? (Date.now() - p.lastRunAt) / (60 * 60_000) : null
    out.push({
      name: p.name, enabled: p.enabled,
      lastRunAt: p.lastRunAt, lastStatus: p.lastRunStatus,
      lastRunAgeHours: lastAge,
      runs7d: total,
      successRate7d: total > 0 ? (byStatus['success'] ?? 0) / total : 0,
      partialRate7d: total > 0 ? (byStatus['partial'] ?? 0) / total : 0,
      failureRate7d: total > 0 ? (byStatus['failed'] ?? 0) / total : 0,
      staleness: !lastAge ? 'dead' : lastAge < 24 ? 'fresh' : lastAge < 168 ? 'aging' : 'dead',
    })
  }
  return out
}

// ─── Seeds ───────────────────────────────────────────────────────────────────

export async function seedPipelines(workspaceId: string): Promise<{ defined: string[] }> {
  const seeds: DefinePipelineInput[] = [
    {
      name: 'competitor-to-shipproposal',
      description: 'R579 scan → R584 score → R590 file high-confidence as self_dev_proposal draft.',
      stages: [
        { op: 'competitor.scan_all',    label: 'scan feeds',    params: {}, retry_max: 1 },
        { op: 'competitor.score_batch', label: 'score entries', params: { max: 50 } },
        { op: 'parity.file_self_dev',   label: 'file drafts',   params: { minScore: 90, max: 5 }, optional: true },
      ],
      scheduleCron: '0 6 * * *',    // 06:00 UTC daily
      enabled: true,
    },
    {
      name: 'daily-business-summary',
      description: 'Per-business: collect reserves + email stats + competitor intel → emit cron.daily_summary event.',
      stages: [
        { op: 'finance.reserve_for_business_all', label: 'recompute reserves',     params: { windowDays: 90 }, optional: true },
        { op: 'dashboard.snapshot',               label: 'snapshot dashboard',     params: {} },
      ],
      scheduleCron: '0 14 * * *',   // 14:00 UTC daily
      enabled: true,
    },
    {
      name: 'memory-flush-and-recall',
      description: 'Compact low-importance memories + backfill embeddings + verify recall.',
      stages: [
        { op: 'memory.compact',         label: 'compact stale',          params: {}, optional: true },
        { op: 'memory.embed_backfill',  label: 'backfill embeddings',    params: { max: 25 }, optional: true },
        { op: 'memory.recall_stats',    label: 'stats',                  params: {} },
      ],
      scheduleCron: '*/30 * * * *',
      enabled: true,
    },
    {
      name: 'song-to-music-video',
      description: 'R600 end-to-end: ACE-Step replicate + vocal enhance + master, then LTX-2 audio-to-video using the mastered track. Operator passes url + instructions + ltxPrompt via pipeline.run params.',
      stages: [
        { op: 'music.mixcraft',       label: 'replicate + master',  params: {}, params_from: { url: 'pipeline.url', instructions: 'pipeline.instructions' } },
        { op: 'video.ltx.audio2video',label: 'generate music video',params: { durationSec: 8 }, params_from: { audioUrl: 'prev.masteredPath', prompt: 'pipeline.ltxPrompt' }, optional: true },
      ],
      enabled: true,
    },
    {
      name: 'standards-self-audit',
      description: 'Re-discover repo standards + re-seed brain memory recall keys.',
      stages: [
        { op: 'standards.discover',     label: 'scan repo',  params: {} },
        { op: 'standards.list',         label: 'list current',params: {} },
        { op: 'dashboard.snapshot',     label: 'snapshot',   params: {} },
      ],
      scheduleCron: '0 3 * * 0',   // weekly Sunday 03:00 UTC
      enabled: true,
    },
  ]
  const defined: string[] = []
  for (const s of seeds) {
    try {
      const p = await definePipeline(workspaceId, s)
      defined.push(p.name)
    } catch { /* tolerated — one bad seed can't block others */ }
  }
  return { defined }
}

/** For the cron tick: list enabled pipelines whose cron expression matches now. */
export async function pipelinesDueNow(workspaceId: string, now = Date.now()): Promise<Pipeline[]> {
  const all = await listPipelines(workspaceId)
  const d = new Date(now)
  const min = d.getUTCMinutes(), hr = d.getUTCHours(), dom = d.getUTCDate(), mon = d.getUTCMonth() + 1, dow = d.getUTCDay()
  return all.filter(p => {
    if (!p.enabled || !p.scheduleCron) return false
    const parts = p.scheduleCron.trim().split(/\s+/)
    if (parts.length !== 5) return false
    const [cm, ch, cdom, cmon, cdow] = parts as [string, string, string, string, string]
    const matchField = (field: string, value: number): boolean => {
      if (field === '*') return true
      // step "*/N"
      const stepMatch = field.match(/^\*\/(\d+)$/)
      if (stepMatch) return value % Number(stepMatch[1]) === 0
      // explicit list "1,3,5"
      if (field.includes(',')) return field.split(',').map(Number).includes(value)
      return Number(field) === value
    }
    return matchField(cm, min) && matchField(ch, hr) && matchField(cdom, dom) && matchField(cmon, mon) && matchField(cdow, dow)
  })
}
