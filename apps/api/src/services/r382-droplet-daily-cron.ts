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

  // R443 — bail entirely if operator engaged the autonomous_writes kill switch.
  // R494 — still record the "ran" row so we don't rerun on the next hourly tick.
  try {
    const { isAutonomyAllowed } = await import('./r443-autonomy-gate.js')
    if (!await isAutonomyAllowed(workspaceId)) {
      await db.execute(sql`
        INSERT INTO daily_cron_runs (workspace_id, day_yyyymmdd, ran_at, summary)
        VALUES (${workspaceId}, ${yyyymmdd}, ${Date.now()}, ${JSON.stringify({ skipped: 'autonomy_paused' })}::jsonb)
        ON CONFLICT (workspace_id, day_yyyymmdd) DO NOTHING
      `).catch(() => {/* best effort */})
      return { ok: true, workspaceId, yyyymmdd, alreadyRanToday: false,
        salesPersisted, pipelineGenerated: 0, pipelineQueued: 0, pipelineFailed: 0,
        durationMs: Date.now() - started }
    }
  } catch { /* tolerated */ }
  // R428 — abort the expensive pipeline run if today's AI spend already
  // exceeds the configured daily budget.
  try {
    const { isBudgetExhausted } = await import('./r428-ai-spend-tracker.js')
    if (await isBudgetExhausted(workspaceId)) {
      return {
        ok: true, workspaceId, yyyymmdd, alreadyRanToday: false,
        salesPersisted, pipelineGenerated: 0, pipelineQueued: 0, pipelineFailed: 0,
        durationMs: Date.now() - started,
      }
    }
  } catch { /* tolerated */ }

  let pipelineGenerated = 0, pipelineQueued = 0, pipelineFailed = 0
  try {
    // R415/R481 — real hysteresis. Promotion thresholds are 10% above
    // demotion thresholds; current budget tier is persisted in
    // workspace_settings so we don't oscillate when MRR brushes a boundary.
    let dailyBudget = 10
    try {
      const { projectMrr } = await import('./r414-mrr-projection.js')
      const { getNumSetting, setSetting } = await import('./r437-operator-timezone.js')
      const proj = await projectMrr(workspaceId)
      const mrr = proj.currentMrr30d
      const prev = await getNumSetting(workspaceId, 'r415_budget_tier', 10)
      // (current tier, promote-up MRR, demote-down MRR)
      const tiers: Array<{ budget: number; promoteAt: number; demoteAt: number }> = [
        { budget: 10, promoteAt: 110,    demoteAt: 0 },
        { budget: 15, promoteAt: 1_100,  demoteAt: 100 },
        { budget: 25, promoteAt: 5_500,  demoteAt: 1_000 },
        { budget: 40, promoteAt: 11_000, demoteAt: 5_000 },
        { budget: 50, promoteAt: Infinity, demoteAt: 10_000 },
      ]
      // Find current tier; promote if MRR >= promoteAt, demote if MRR < demoteAt
      let curIdx = tiers.findIndex(t => t.budget === prev)
      if (curIdx < 0) curIdx = 0
      while (curIdx < tiers.length - 1 && mrr >= tiers[curIdx]!.promoteAt) curIdx++
      while (curIdx > 0 && mrr < tiers[curIdx]!.demoteAt) curIdx--
      dailyBudget = tiers[curIdx]!.budget
      if (dailyBudget !== prev) await setSetting(workspaceId, 'r415_budget_tier', String(dailyBudget))
    } catch { /* tolerated */ }
    // R406 — use R405 niche-weight recommender to adapt pipeline counts to
    // observed performance. Falls back to the static 5/3/2 mix if R405 hasn't
    // got enough data yet.
    let provenCount = 5, breakoutCount = 3, nicheBreakoutCount = 2
    try {
      const { recommendNicheWeights } = await import('./r405-pipeline-niche-weighter.js')
      const rec = await recommendNicheWeights({ workspaceId, totalBudget: dailyBudget })
      const provenTotal = rec.recommendations.filter(r => r.reason.startsWith('proven')).reduce((a, r) => a + r.recommendedCount, 0)
      const exploreTotal = rec.recommendations.filter(r => r.reason.startsWith('unexplored') || r.reason.includes('winners yet')).reduce((a, r) => a + r.recommendedCount, 0)
      if (provenTotal > 0) {
        provenCount = provenTotal
        breakoutCount = Math.max(1, Math.floor(exploreTotal * 0.6))
        nicheBreakoutCount = Math.max(1, Math.floor(exploreTotal * 0.4))
      }
    } catch { /* fallback to defaults */ }
    const { runTrendingPipeline } = await import('./r351-trend-pipeline.js')
    const r = await runTrendingPipeline({ workspaceId, provenCount, breakoutCount, nicheBreakoutCount })
    pipelineGenerated = r.totals.designsGenerated
    pipelineQueued    = r.totals.queueItemsCreated
    pipelineFailed    = r.totals.designsFailed
    if (pipelineGenerated > 0) {
      try {
        const { recordSpend } = await import('./r428-ai-spend-tracker.js')
        await recordSpend(workspaceId, 'pipeline_design', pipelineGenerated * 4 /* ~$0.04 image-gen */)
      } catch { /* tolerated */ }
    }
  } catch (e) { console.error('[r382] pipeline:', (e as Error).message) }

  let selfTestSummary
  try {
    const { runCapabilitySelfTest } = await import('./r376-capability-self-test.js')
    const r = await runCapabilitySelfTest(workspaceId)
    selfTestSummary = r.summary
  } catch (e) { console.error('[r382] self-test:', (e as Error).message) }

  // R510 — 1099-K threshold watch fires push at 80% and 100% of per-source thresholds.
  try {
    const { watchTaxThresholds } = await import('./r510-tax-threshold-watch.js')
    await watchTaxThresholds()
  } catch (e) { console.error('[r382] tax watch:', (e as Error).message) }

  // R509 — refresh image-gen provider health probe so failover knows who's up.
  try {
    const { probeAllProviders } = await import('./r509-imagegen-failover.js')
    await probeAllProviders()
  } catch (e) { console.error('[r382] imagegen probe:', (e as Error).message) }

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
