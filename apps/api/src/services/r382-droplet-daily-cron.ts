/**
 * R382 — Server-side daily cron (no browser needed).
 *
 * Once per day on the droplet, runs the headless half of pnpm daily:
 *   - sales.sync_gumroad (if access token configured)
 *   - trends.run_pipeline (generate fresh designs + queue across platforms)
 *   - capability.self_test (health probe, emitted to events)
 *
 * The browser half (drain queue via Playwright) still runs on the operator's
 * machine when they invoke pnpm daily. This cron keeps the queue topped up
 * even on days the operator doesn't sit down at their laptop — when they do,
 * the agent has fresh work to drain.
 *
 * Idempotent via daily_cron_runs row keyed by (workspace_id, day_yyyymmdd).
 */
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS daily_cron_runs (
      workspace_id    TEXT NOT NULL,
      day_yyyymmdd    TEXT NOT NULL,
      ran_at          BIGINT NOT NULL,
      summary         JSONB,
      PRIMARY KEY (workspace_id, day_yyyymmdd)
    )
  `).catch(() => {})
}

function todayYYYYMMDD(): string {
  const d = new Date()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

export interface DailyCronResult {
  ok:                boolean
  workspaceId:       string
  yyyymmdd:          string
  alreadyRanToday:   boolean
  salesPersisted:    number
  pipelineGenerated: number
  pipelineQueued:    number
  pipelineFailed:    number
  selfTestSummary?:  { ok: number; degraded: number; missing: number; error: number; total: number }
  durationMs:        number
}

export async function runDailyCron(workspaceId: string, opts?: { force?: boolean }): Promise<DailyCronResult> {
  await ensureTable()
  const yyyymmdd = todayYYYYMMDD()
  const started = Date.now()

  if (!opts?.force) {
    const existsRows = await db.execute(sql`
      SELECT 1 FROM daily_cron_runs WHERE workspace_id = ${workspaceId} AND day_yyyymmdd = ${yyyymmdd} LIMIT 1
    `).catch(() => [] as unknown[])
    if (Array.isArray(existsRows) && existsRows.length > 0) {
      return {
        ok: true, workspaceId, yyyymmdd, alreadyRanToday: true,
        salesPersisted: 0, pipelineGenerated: 0, pipelineQueued: 0, pipelineFailed: 0,
        durationMs: Date.now() - started,
      }
    }
  }

  let salesPersisted = 0
  try {
    const { syncGumroadSales } = await import('./r367-gumroad-sales-sync.js')
    const r = await syncGumroadSales(workspaceId)
    salesPersisted = r.persisted
  } catch (e) { console.error('[r382] sales sync:', (e as Error).message) }

  let pipelineGenerated = 0, pipelineQueued = 0, pipelineFailed = 0
  try {
    const { runTrendingPipeline } = await import('./r351-trend-pipeline.js')
    const r = await runTrendingPipeline({ workspaceId, provenCount: 5, breakoutCount: 3, nicheBreakoutCount: 2 })
    pipelineGenerated = r.totals.designsGenerated
    pipelineQueued    = r.totals.queueItemsCreated
    pipelineFailed    = r.totals.designsFailed
  } catch (e) { console.error('[r382] pipeline:', (e as Error).message) }

  let selfTestSummary
  try {
    const { runCapabilitySelfTest } = await import('./r376-capability-self-test.js')
    const r = await runCapabilitySelfTest(workspaceId)
    selfTestSummary = r.summary
  } catch (e) { console.error('[r382] self-test:', (e as Error).message) }

  const summary = {
    salesPersisted, pipelineGenerated, pipelineQueued, pipelineFailed,
    ...(selfTestSummary ? { selfTestSummary } : {}),
  }

  await db.execute(sql`
    INSERT INTO daily_cron_runs (workspace_id, day_yyyymmdd, ran_at, summary)
    VALUES (${workspaceId}, ${yyyymmdd}, ${Date.now()}, ${JSON.stringify(summary)}::jsonb)
    ON CONFLICT (workspace_id, day_yyyymmdd) DO UPDATE SET ran_at = EXCLUDED.ran_at, summary = EXCLUDED.summary
  `).catch(() => {/* best effort */})

  // Emit an event so the dashboard activity stream shows it
  try {
    const id = uuidv7(), trace = uuidv7()
    await db.execute(sql`
      INSERT INTO events (id, type, workspace_id, payload, trace_id, correlation_id, source, version, created_at)
      VALUES (${id}, 'daily_cron.ran', ${workspaceId}, ${JSON.stringify(summary)}::jsonb,
              ${trace}, ${trace}, ${'r382-droplet-daily'}, 1, ${Date.now()})
    `)
  } catch { /* events optional */ }

  return {
    ok: true, workspaceId, yyyymmdd, alreadyRanToday: false,
    salesPersisted, pipelineGenerated, pipelineQueued, pipelineFailed,
    ...(selfTestSummary ? { selfTestSummary } : {}),
    durationMs: Date.now() - started,
  }
}
