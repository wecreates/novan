/**
 * learning-cron.ts — Periodic background scans.
 *
 * Drives the closed learning loop on a timer:
 * - Incident detector       (5 min)
 * - Improvement engine      (15 min)
 * - Suspicious activity     (5 min)
 * - Stuck assignment sweep  (2 min)
 * - Trial expiry            (1 hour)
 *
 * Lightweight setInterval — no external scheduler dependency.
 * All scans are workspace-scoped: they fan out over all workspaces.
 */
import { db }                       from '../db/client.js'
import { workspaces, events }       from '../db/schema.js'
import { and, eq, gte }             from 'drizzle-orm'
import { v7 as uuidv7 }             from 'uuid'
import { scanAndOpenIncidents }     from './incident-service.js'
import { runImprovementScan }       from './improvement-engine.js'
import { detectSuspiciousActivity } from './security-monitor.js'
import { failStuckAssignments, detectStuckAgents } from './orchestrator.js'
import { recoverStaleLocks }        from './lock-manager.js'
import { expireTrials }             from './billing.js'
import { runSecurityScan }          from './security-team.js'
import { pollDueFeeds }             from './feed-ingester.js'
import { purgeExpired as purgeStretchCache } from './token-stretcher.js'
import { runDueTopics, seedResearchAgents } from './research-engine.js'
import { runDailyReview }                    from './daily-review.js'
import { convertFindings }                   from './research-to-action.js'
import { weeklyOperationalReport }            from './executive-briefings.js'
import { runHourlyHealthReview, runSixHourlyOperationalReview } from './executive-loop.js'
import { reconcileRecommendationOutcomes }    from './reasoning-chains.js'
import { evaluateOutcomes }                    from './outcome-evaluator.js'
import { runCompression }                      from './knowledge-compression.js'
import { extractPatterns }                     from './pattern-extractor.js'
import { scanDrift }                           from './drift-detector.js'
import { applyCorrections }                    from './reality-correction.js'
import { evaluateEconomicOutcomes, generateEconomicRecommendations } from './economic-intelligence.js'
import { sweepDueReviews }            from './strategic-horizons.js'
import { checkBudget, consume }       from './cron-budget.js'
import { runMindCycle }               from './autonomous-mind.js'
import { recordCalibrationFindings }  from './meta-learning.js'
import { watchdogTick }                from './external-watchdog.js'
import { captureGitState }             from './git-state.js'
import { backfillRecent as backfillEmbeddings } from './semantic-search.js'
import { linkCommitsToOutcomes }       from './commit-learner.js'
import { autoRegister as autoRegisterCapabilities } from './capability-auto-register.js'
import { autoDeriveTrust }             from './trust-governance.js'
import { sweepStaleNodes, runScalingCycle } from './runtime-fabric.js'
import { sweepStale }                          from './assumption-tracker.js'
import { stabilitySnapshot, emitGovernance, autoEngageThrottle, pauseUnstableAgents, autoDisengageThrottleIfStable } from './governance-core.js'
import { crossDivisionBlockers, type CrossDivisionBlocker } from './divisions.js'
import { notify }                            from './notifications.js'

const handles: NodeJS.Timeout[] = []

async function listWorkspaceIds(): Promise<string[]> {
  const rows = await db.select({ id: workspaces.id }).from(workspaces).limit(500)
  return rows.map((r) => r.id)
}

async function emit(type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId: 'global', payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'learning-cron', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

async function runIncidentScans() {
  try {
    const ids = await listWorkspaceIds()
    let opened = 0, updated = 0
    for (const ws of ids) {
      const r = await scanAndOpenIncidents(ws).catch(() => ({ opened: 0, updated: 0 }))
      opened += r.opened; updated += r.updated
    }
    await emit('cron.incident_scan_completed', { workspaces: ids.length, opened, updated })
  } catch (e) { await emit('cron.error', { task: 'incident', error: (e as Error).message }) }
}

async function runImprovementScans() {
  try {
    const ids = await listWorkspaceIds()
    let created = 0, refreshed = 0
    for (const ws of ids) {
      const r = await runImprovementScan(ws).catch(() => ({ created: 0, refreshed: 0 }))
      created += r.created; refreshed += r.refreshed
    }
    await emit('cron.improvement_scan_completed', { workspaces: ids.length, created, refreshed })
  } catch (e) { await emit('cron.error', { task: 'improvement', error: (e as Error).message }) }
}

async function runSuspiciousScans() {
  try {
    const ids = await listWorkspaceIds()
    for (const ws of ids) await detectSuspiciousActivity(ws).catch(() => null)
    await emit('cron.suspicious_scan_completed', { workspaces: ids.length })
  } catch (e) { await emit('cron.error', { task: 'suspicious', error: (e as Error).message }) }
}

async function runOrchestratorSweep() {
  try {
    const ids = await listWorkspaceIds()
    let stuck = 0, downAgents = 0, locksRecovered = 0
    for (const ws of ids) {
      stuck          += await failStuckAssignments(ws).catch(() => 0)
      downAgents     += await detectStuckAgents(ws).catch(() => 0)
      locksRecovered += await recoverStaleLocks(ws).catch(() => 0)
    }
    if (stuck + downAgents + locksRecovered > 0) {
      await emit('cron.orchestrator_sweep_completed', { stuck, downAgents, locksRecovered })
    }
  } catch (e) { await emit('cron.error', { task: 'orchestrator', error: (e as Error).message }) }
}

async function runSecurityTeamScans() {
  try {
    const ids = await listWorkspaceIds()
    let findings = 0, blocking = 0
    for (const ws of ids) {
      const r = await runSecurityScan(ws).catch(() => ({ findingsCreated: 0, blockingCount: 0 }))
      findings += r.findingsCreated; blocking += r.blockingCount
    }
    await emit('cron.security_team_scan_completed', { workspaces: ids.length, findings, blocking })
  } catch (e) { await emit('cron.error', { task: 'security_team', error: (e as Error).message }) }
}

async function runBillingSweep() {
  try {
    const expired = await expireTrials().catch(() => 0)
    if (expired > 0) await emit('cron.trials_expired', { count: expired })
  } catch (e) { await emit('cron.error', { task: 'billing', error: (e as Error).message }) }
}

async function runExecutiveHourly() {
  try {
    const ids = await listWorkspaceIds()
    for (const ws of ids) {
      await runHourlyHealthReview(ws).catch(() => null)
    }
  } catch (e) { await emit('cron.error', { task: 'executive_hourly', error: (e as Error).message }) }
}

async function runExecutiveSixHourly() {
  try {
    const ids = await listWorkspaceIds()
    let totalActions = 0
    for (const ws of ids) {
      const r = await runSixHourlyOperationalReview(ws).catch(() => null)
      if (r) totalActions += r.actionsRecommended.length
      // Also reconcile recommendation outcomes while we're at it
      await reconcileRecommendationOutcomes(ws).catch(() => null)
      // Multi-source outcome evaluator (incident resolution, forecast horizons, rollbacks)
      await evaluateOutcomes(ws).catch(() => null)
    }
    if (totalActions > 0) await emit('cron.executive_six_hourly_completed', { totalActions })
  } catch (e) { await emit('cron.error', { task: 'executive_six_hourly', error: (e as Error).message }) }
}

async function runCrossDivisionScan() {
  try {
    const ids = await listWorkspaceIds()
    for (const ws of ids) {
      const blockers: CrossDivisionBlocker[] = await crossDivisionBlockers(ws).catch(() => [])
      for (const b of blockers) {
        // Notify on high/critical only — the dedup-window inside notify()
        // collapses repeats within 5 min.
        if (b.severity === 'critical' || b.severity === 'high') {
          await notify({
            workspaceId: ws,
            type:        'cross_division.blocker',
            title:       `Cross-division blocker (${b.severity}): ${b.from} → ${b.to.join(', ')}`,
            body:        b.title,
            severity:    b.severity === 'critical' ? 'critical' : 'high',
            signature:   `xdiv:${b.blockerId}`,
          }).catch(() => null)
        }
      }
    }
  } catch (e) { await emit('cron.error', { task: 'cross_division', error: (e as Error).message }) }
}

async function runRealityVerification() {
  try {
    const ids = await listWorkspaceIds()
    let totalWarnings = 0, totalCorrections = 0
    for (const ws of ids) {
      await sweepStale(ws).catch(() => null)
      const drift = await scanDrift(ws).catch(() => null)
      if (drift) totalWarnings += drift.totalCreated
      const corr = await applyCorrections(ws).catch(() => null)
      if (corr) totalCorrections += corr.warningsHandled
    }
    if (totalWarnings + totalCorrections > 0) {
      await emit('cron.reality_verification', { newWarnings: totalWarnings, correctionsApplied: totalCorrections })
    }
  } catch (e) { await emit('cron.error', { task: 'reality_verification', error: (e as Error).message }) }
}

async function runEconomicLearning() {
  try {
    // Budget ceiling: at most 200 ops / 6h for economic learning
    const budget = await checkBudget('economic_learning', {
      maxCalls: 200, maxTokens: 200_000, maxCostUsd: 1.0, windowMs: 6 * 60 * 60_000,
    })
    if (!budget.ok) {
      await emit('cron.budget_blocked', { task: 'economic_learning', reason: budget.reason })
      return
    }
    const ids = await listWorkspaceIds()
    let totalEvaluated = 0, totalMatched = 0, totalRecs = 0, calls = 0
    for (const ws of ids) {
      const evald = await evaluateEconomicOutcomes(ws).catch(() => null)
      if (evald) { totalEvaluated += evald.evaluated; totalMatched += evald.matched }
      const rec   = await generateEconomicRecommendations(ws).catch(() => null)
      if (rec)   totalRecs += rec.chainsRecorded
      calls += 2
    }
    await consume('economic_learning', { calls })
    if (totalEvaluated + totalRecs > 0) {
      await emit('cron.economic_learning', { evaluated: totalEvaluated, matched: totalMatched, recsRecorded: totalRecs })
    }
  } catch (e) { await emit('cron.error', { task: 'economic_learning', error: (e as Error).message }) }
}

async function runAutonomousMind() {
  try {
    const budget = await checkBudget('autonomous_mind', {
      maxCalls: 500, maxTokens: 0, maxCostUsd: 0.50, windowMs: 60 * 60_000,
    })
    if (!budget.ok) {
      await emit('cron.budget_blocked', { task: 'autonomous_mind', reason: budget.reason })
      return
    }
    const ids = await listWorkspaceIds()
    let totalGaps = 0, totalPlans = 0, totalChains = 0
    for (const ws of ids) {
      const r = await runMindCycle(ws).catch(() => null)
      if (r) {
        totalGaps   += r.gapsDetected
        totalPlans  += r.buildPlansCreated
        totalChains += r.chainsRecorded
      }
    }
    await consume('autonomous_mind', { calls: ids.length })
    if (totalGaps + totalPlans + totalChains > 0) {
      await emit('cron.autonomous_mind', { gaps: totalGaps, plans: totalPlans, chainsRecorded: totalChains })
    }
  } catch (e) { await emit('cron.error', { task: 'autonomous_mind', error: (e as Error).message }) }
}

async function runMetaLearning() {
  try {
    const ids = await listWorkspaceIds()
    let totalRecorded = 0
    for (const ws of ids) {
      const r = await recordCalibrationFindings(ws).catch(() => null)
      if (r) totalRecorded += r.recorded
    }
    if (totalRecorded > 0) await emit('cron.meta_learning', { findingsRecorded: totalRecorded })
  } catch (e) { await emit('cron.error', { task: 'meta_learning', error: (e as Error).message }) }
}

async function runWatchdog() {
  try { await watchdogTick() }
  catch (e) { await emit('cron.error', { task: 'watchdog', error: (e as Error).message }) }
}

async function runGitStateCapture() {
  try {
    const ids = await listWorkspaceIds()
    let totalCaptured = 0
    for (const ws of ids) {
      const r = await captureGitState(ws).catch(() => null)
      if (r) totalCaptured += r.captured
    }
    if (totalCaptured > 0) await emit('cron.git_state_captured', { snapshots: totalCaptured })
  } catch (e) { await emit('cron.error', { task: 'git_state', error: (e as Error).message }) }
}

async function runEmbeddingsBackfill() {
  try {
    const ids = await listWorkspaceIds()
    let totalIndexed = 0
    for (const ws of ids) {
      const r = await backfillEmbeddings(ws, 14).catch(() => null)
      if (r) totalIndexed += r.indexed
    }
    if (totalIndexed > 0) await emit('cron.embeddings_indexed', { indexed: totalIndexed })
  } catch (e) { await emit('cron.error', { task: 'embeddings_backfill', error: (e as Error).message }) }
}

async function runCommitLearning() {
  try {
    const ids = await listWorkspaceIds()
    let totals = { evaluated: 0, regressions: 0, positives: 0 }
    for (const ws of ids) {
      const r = await linkCommitsToOutcomes(ws).catch(() => null)
      if (r) {
        totals.evaluated += r.evaluated
        totals.regressions += r.regressions
        totals.positives += r.positives
      }
    }
    if (totals.evaluated > 0) await emit('cron.commit_learning', totals)
  } catch (e) { await emit('cron.error', { task: 'commit_learning', error: (e as Error).message }) }
}

async function runCapabilityAutoRegister() {
  try {
    const ids = await listWorkspaceIds()
    let added = 0
    for (const ws of ids) {
      const r = await autoRegisterCapabilities(ws).catch(() => null)
      if (r) added += r.added
    }
    if (added > 0) await emit('cron.capability_auto_register', { added })
  } catch (e) { await emit('cron.error', { task: 'capability_auto_register', error: (e as Error).message }) }
}

async function runFabricSweep() {
  try {
    const ids = await listWorkspaceIds()
    let marked = 0, scaled = 0
    for (const ws of ids) {
      const sweep = await sweepStaleNodes(ws).catch(() => null)
      if (sweep) marked += sweep.marked
      const cyc = await runScalingCycle(ws).catch(() => null)
      if (cyc) scaled += cyc.recorded
    }
    if (marked + scaled > 0) await emit('cron.fabric_sweep', { staleNodes: marked, scalingEvents: scaled })
  } catch (e) { await emit('cron.error', { task: 'fabric_sweep', error: (e as Error).message }) }
}

async function runTrustAutoDerive() {
  try {
    const ids = await listWorkspaceIds()
    let totalAdjustments = 0
    for (const ws of ids) {
      const r = await autoDeriveTrust(ws).catch(() => null)
      if (r) totalAdjustments += r.adjustments
    }
    if (totalAdjustments > 0) await emit('cron.trust_derived', { adjustments: totalAdjustments })
  } catch (e) { await emit('cron.error', { task: 'trust_derive', error: (e as Error).message }) }
}

async function runHorizonReviewSweep() {
  try {
    const ids = await listWorkspaceIds()
    let totalNotified = 0
    for (const ws of ids) {
      const r = await sweepDueReviews(ws).catch(() => null)
      if (r) totalNotified += r.notified
    }
    if (totalNotified > 0) await emit('cron.horizon_reviews', { notified: totalNotified })
  } catch (e) { await emit('cron.error', { task: 'horizon_review', error: (e as Error).message }) }
}

async function runDailyCompressionAndPatterns() {
  try {
    const ids = await listWorkspaceIds()
    let totalLessons = 0, totalPatterns = 0
    for (const ws of ids) {
      const c = await runCompression(ws).catch(() => null)
      if (c) totalLessons += c.totalCreated
      const p = await extractPatterns(ws).catch(() => null)
      if (p) totalPatterns += p.preventiveRecsCreated
    }
    if (totalLessons + totalPatterns > 0) {
      await emit('cron.compression_completed', { totalLessons, totalPatterns })
    }
  } catch (e) { await emit('cron.error', { task: 'daily_compression', error: (e as Error).message }) }
}

async function runWeeklyExecutiveBriefings() {
  try {
    const ids = await listWorkspaceIds()
    let generated = 0
    for (const ws of ids) {
      // Only emit once per 6 days — idempotent via events check
      const day6 = Date.now() - 6 * 24 * 60 * 60_000
      const recent = await db.select({ id: events.id }).from(events)
        .where(and(eq(events.workspaceId, ws), eq(events.type, 'briefing.weekly_executive'), gte(events.createdAt, day6)))
        .limit(1).then(r => r[0]).catch(() => null)
      if (recent) continue
      const report = await weeklyOperationalReport(ws).catch(() => null)
      if (!report) continue
      await db.insert(events).values({
        id: uuidv7(), type: 'briefing.weekly_executive', workspaceId: ws,
        payload: report as unknown as Record<string, unknown>,
        traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
        source: 'learning-cron', version: 1, createdAt: Date.now(),
      }).catch(() => null)
      generated++
    }
    if (generated > 0) await emit('cron.weekly_briefings_generated', { count: generated })
  } catch (e) { await emit('cron.error', { task: 'weekly_briefings', error: (e as Error).message }) }
}

async function runStabilityScan() {
  try {
    const ids = await listWorkspaceIds()
    for (const ws of ids) {
      const snap = await stabilitySnapshot(ws).catch(() => null)
      if (!snap) continue
      const stableNow = snap.overall === 'stable' && !snap.recommendedThrottle

      if (!stableNow) {
        const unstableIndicators = snap.indicators.filter(i => i.unstable)
        await emitGovernance(ws, 'stability_alert', {
          overall: snap.overall,
          recommendedThrottle: snap.recommendedThrottle,
          unstableIndicators,
        })

        // Enforce when severe — engage kill switches + pause unstable agents.
        if (snap.recommendedThrottle) {
          const reason = `auto-throttle: ${unstableIndicators.map(i => i.name).join(', ')}`
          await autoEngageThrottle(ws, reason).catch(() => null)
        }
        await pauseUnstableAgents(ws).catch(() => null)
      }

      // Auto-disengage: requires >=2 consecutive stable scans (≈10 min)
      await autoDisengageThrottleIfStable(ws, stableNow).catch(() => null)
    }
  } catch (e) { await emit('cron.error', { task: 'stability_scan', error: (e as Error).message }) }
}

async function runResearchToAction() {
  try {
    const ids = await listWorkspaceIds()
    let totalCreated = 0
    for (const ws of ids) {
      const r = await convertFindings(ws, { maxFindings: 10 }).catch(() => ({ created: 0 } as { created: number }))
      totalCreated += r.created
    }
    if (totalCreated > 0) await emit('cron.research_to_action_completed', { created: totalCreated })
  } catch (e) { await emit('cron.error', { task: 'research_to_action', error: (e as Error).message }) }
}

async function runDailyReviews() {
  try {
    const ids = await listWorkspaceIds()
    let generated = 0
    for (const ws of ids) {
      const r = await runDailyReview(ws).catch(() => null)
      if (r) generated++
    }
    if (generated > 0) await emit('cron.daily_reviews_generated', { count: generated })
  } catch (e) { await emit('cron.error', { task: 'daily_review', error: (e as Error).message }) }
}

async function runResearchScans() {
  try {
    const ids = await listWorkspaceIds()
    let totalRuns = 0, totalFindings = 0
    for (const ws of ids) {
      // Seed research agents on first run (idempotent)
      await seedResearchAgents(ws).catch(() => null)
      const r = await runDueTopics(ws).catch(() => ({ ran: 0, results: [] as Array<{ findingsAdded: number }> }))
      totalRuns += r.ran
      totalFindings += r.results.reduce((n, x) => n + (x.findingsAdded ?? 0), 0)
    }
    if (totalRuns > 0) await emit('cron.research_scan_completed', { runs: totalRuns, findings: totalFindings })
  } catch (e) { await emit('cron.error', { task: 'research', error: (e as Error).message }) }
}

async function runStretchCachePurge() {
  try {
    const purged = await purgeStretchCache()
    if (purged > 0) await emit('cron.stretch_cache_purged', { purged })
  } catch (e) { await emit('cron.error', { task: 'stretch_purge', error: (e as Error).message }) }
}

async function runFeedIngestion() {
  try {
    const ids = await listWorkspaceIds()
    let polled = 0, ingested = 0
    for (const ws of ids) {
      const r = await pollDueFeeds(ws).catch(() => ({ polled: 0, results: [] as Array<{ itemsIngested: number }> }))
      polled += r.polled
      ingested += r.results.reduce((n, x) => n + (x.itemsIngested ?? 0), 0)
    }
    if (polled > 0) await emit('cron.feeds_polled', { polled, ingested })
  } catch (e) { await emit('cron.error', { task: 'feeds', error: (e as Error).message }) }
}

// ─── Public boot/stop ─────────────────────────────────────────────────────────

const INTERVALS = {
  incident:     5  * 60_000,   // 5 min
  improvement:  15 * 60_000,   // 15 min
  suspicious:   5  * 60_000,   // 5 min
  orchestrator: 2  * 60_000,   // 2 min
  securityTeam: 10 * 60_000,   // 10 min — full security team sweep
  billing:      60 * 60_000,   // 1 hour
  feeds:        10 * 60_000,   // 10 min — RSS/Atom ingestion (per-feed intervals enforced inside)
  stretchPurge: 60 * 60_000,   // 1 hour — expire stale AI cache rows
  research:     15 * 60_000,   // 15 min — research topic polling (per-topic intervals enforced inside)
  dailyReview:  60 * 60_000,   // 1 hour — emits at most one review/24h via idempotency check
  researchToAction: 30 * 60_000, // 30 min — convert recent findings → roadmap tasks
  stabilityScan:    5  * 60_000, // 5 min — emit governance.stability_alert when unstable
  weeklyBriefing:   60 * 60_000, // 1 hour tick — actually emits once per 6 days via idempotency
  crossDivision:    10 * 60_000, // 10 min — scan cross-division blockers and notify on critical
  execHourly:       60 * 60_000, // 1 hour — executive hourly health review
  execSixHourly:    6  * 60 * 60_000, // 6 hours — executive ops optimization review
  dailyCompression: 24 * 60 * 60_000, // 24 hours — knowledge compression + pattern extraction
  realityVerify:    60 * 60_000,      // 1 hour — drift scan + safe corrections + assumption staleness
  economicLearning: 6  * 60 * 60_000, // 6 hours — evaluate past predictions + regenerate recommendations
  horizonReview:    60 * 60_000,      // 1 hour — sweep due strategic horizon reviews
  autonomousMind:   10 * 60_000,      // 10 min — capability-gap → build-plan meta-loop
  metaLearning:     60 * 60_000,      // 1 hour — calibration auto-tune suggestions
  watchdog:         2  * 60_000,      // 2 min — best-effort in-process liveness check
  gitState:         15 * 60_000,      // 15 min — capture recent git commits
  embeddingsBackfill: 30 * 60_000,    // 30 min — index recent chains for semantic search
  commitLearning:   6  * 60 * 60_000, // 6 hours — link commits to outcomes
  capabilityAutoReg: 30 * 60_000,     // 30 min — auto-register discovered services
  trustAutoDerive:  60 * 60_000,      // 1 hour — adjust trust scores from observed signals
  fabricSweep:      2  * 60_000,      // 2 min — stale-node sweep + scaling decision cycle
}

export function startLearningCron(): void {
  if (process.env['DISABLE_LEARNING_CRON'] === '1') return
  if (handles.length > 0) return  // already started

  handles.push(setInterval(() => void runIncidentScans(),    INTERVALS.incident))
  handles.push(setInterval(() => void runImprovementScans(), INTERVALS.improvement))
  handles.push(setInterval(() => void runSuspiciousScans(),  INTERVALS.suspicious))
  handles.push(setInterval(() => void runOrchestratorSweep(),INTERVALS.orchestrator))
  handles.push(setInterval(() => void runSecurityTeamScans(),INTERVALS.securityTeam))
  handles.push(setInterval(() => void runBillingSweep(),     INTERVALS.billing))
  handles.push(setInterval(() => void runFeedIngestion(),    INTERVALS.feeds))
  handles.push(setInterval(() => void runStretchCachePurge(),INTERVALS.stretchPurge))
  handles.push(setInterval(() => void runResearchScans(),    INTERVALS.research))
  handles.push(setInterval(() => void runDailyReviews(),     INTERVALS.dailyReview))
  handles.push(setInterval(() => void runResearchToAction(), INTERVALS.researchToAction))
  handles.push(setInterval(() => void runStabilityScan(),    INTERVALS.stabilityScan))
  handles.push(setInterval(() => void runWeeklyExecutiveBriefings(), INTERVALS.weeklyBriefing))
  handles.push(setInterval(() => void runCrossDivisionScan(),        INTERVALS.crossDivision))
  handles.push(setInterval(() => void runExecutiveHourly(),          INTERVALS.execHourly))
  handles.push(setInterval(() => void runExecutiveSixHourly(),       INTERVALS.execSixHourly))
  handles.push(setInterval(() => void runDailyCompressionAndPatterns(), INTERVALS.dailyCompression))
  handles.push(setInterval(() => void runRealityVerification(),         INTERVALS.realityVerify))
  handles.push(setInterval(() => void runEconomicLearning(),            INTERVALS.economicLearning))
  handles.push(setInterval(() => void runHorizonReviewSweep(),          INTERVALS.horizonReview))
  handles.push(setInterval(() => void runAutonomousMind(),              INTERVALS.autonomousMind))
  handles.push(setInterval(() => void runMetaLearning(),                INTERVALS.metaLearning))
  handles.push(setInterval(() => void runWatchdog(),                    INTERVALS.watchdog))
  handles.push(setInterval(() => void runGitStateCapture(),             INTERVALS.gitState))
  handles.push(setInterval(() => void runEmbeddingsBackfill(),          INTERVALS.embeddingsBackfill))
  handles.push(setInterval(() => void runCommitLearning(),              INTERVALS.commitLearning))
  handles.push(setInterval(() => void runCapabilityAutoRegister(),      INTERVALS.capabilityAutoReg))
  handles.push(setInterval(() => void runTrustAutoDerive(),             INTERVALS.trustAutoDerive))
  handles.push(setInterval(() => void runFabricSweep(),                 INTERVALS.fabricSweep))

  // Don't keep the event loop alive just for cron
  for (const h of handles) h.unref?.()

  void emit('cron.started', { intervals: INTERVALS })
}

export function stopLearningCron(): void {
  for (const h of handles) clearInterval(h)
  handles.length = 0
}

/** Number of active cron handles — used by runtime-heartbeat to detect drift. */
export function learningCronHandleCount(): number {
  return handles.length
}

/** Trigger a one-shot run of the meta-loop on boot, so the platform begins
 *  thinking immediately rather than waiting for the first interval tick. */
export async function bootKick(): Promise<void> {
  // Fire each long-interval task once on boot so cold start isn't silent.
  void runAutonomousMind()
  void runMetaLearning()
  void runHorizonReviewSweep()
}
