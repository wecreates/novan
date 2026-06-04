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
import { runRetention, notifyCronAlerts } from './platform-hardening.js'
import { sweepStale }                          from './assumption-tracker.js'
import { stabilitySnapshot, emitGovernance, autoEngageThrottle, pauseUnstableAgents, autoDisengageThrottleIfStable } from './governance-core.js'
import { crossDivisionBlockers, type CrossDivisionBlocker } from './divisions.js'
import { notify }                            from './notifications.js'

const handles: NodeJS.Timeout[] = []

let _warnedAtCap = false
async function listWorkspaceIds(): Promise<string[]> {
  const rows = await db.select({ id: workspaces.id }).from(workspaces).limit(500)
  if (rows.length === 500 && !_warnedAtCap) {
    // Silent 500-cap was a footgun — workspaces beyond 500 never swept.
    _warnedAtCap = true
    console.warn('[learning-cron] listWorkspaceIds hit 500 cap — workspaces beyond limit are not being swept by any cron. Increase the cap + add pagination.')
  }
  return rows.map((r) => r.id)
}

async function emit(type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId: 'global', payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'learning-cron', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
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

async function runIssueAutoIngest() {
  try {
    const { autoIngestSignals } = await import('./issues.js')
    const ids = await listWorkspaceIds()
    let created = 0, appended = 0, scanned = 0
    for (const ws of ids) {
      const r = await autoIngestSignals(ws).catch(() => ({ created: 0, appended: 0, scanned: 0 }))
      created += r.created; appended += r.appended; scanned += r.scanned
    }
    await emit('cron.issue_ingest_completed', { workspaces: ids.length, created, appended, scanned })
  } catch (e) { await emit('cron.error', { task: 'issue_ingest', error: (e as Error).message }) }
}

async function runIssueAutoLoop() {
  try {
    const { runAutoLoopFor } = await import('./issue-auto-loop.js')
    const ids = await listWorkspaceIds()
    let promoted = 0, verified = 0
    for (const ws of ids) {
      const r = await runAutoLoopFor(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
      if (r) { promoted += r.promote.promoted; verified += r.reconcile.verified }
    }
    await emit('cron.issue_auto_loop_completed', { workspaces: ids.length, promoted, verified })
  } catch (e) { await emit('cron.error', { task: 'issue_auto_loop', error: (e as Error).message }) }
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
    for (const ws of ids) await detectSuspiciousActivity(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
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
    let findings = 0, blocking = 0, failedWorkspaces = 0
    for (const ws of ids) {
      // R146.13 — per-workspace error isolation. The inner runSecurityScan
      // calls persistFinding + emitEvent which can throw on pool exhaustion
      // / constraint violation. Previously the .catch(() => zero-counts)
      // silently swallowed which ws failed; after R146.12 surfacing, the
      // failure WILL now log loudly but we still need to record WHICH
      // workspace failed so the operator can correlate.
      try {
        const r = await runSecurityScan(ws)
        findings += r.findingsCreated; blocking += r.blockingCount
      } catch (e) {
        failedWorkspaces++
        await emit('cron.security_team_workspace_failed', {
          workspaceId: ws, error: (e as Error).message.slice(0, 500),
        })
      }
    }
    await emit('cron.security_team_scan_completed', { workspaces: ids.length, findings, blocking, failedWorkspaces })
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
      await runHourlyHealthReview(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
    }
  } catch (e) { await emit('cron.error', { task: 'executive_hourly', error: (e as Error).message }) }
}

async function runExecutiveSixHourly() {
  try {
    const ids = await listWorkspaceIds()
    let totalActions = 0
    for (const ws of ids) {
      const r = await runSixHourlyOperationalReview(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
      if (r) totalActions += r.actionsRecommended.length
      // Also reconcile recommendation outcomes while we're at it
      await reconcileRecommendationOutcomes(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
      // Multi-source outcome evaluator (incident resolution, forecast horizons, rollbacks)
      await evaluateOutcomes(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
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
          }).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
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
      await sweepStale(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
      const drift = await scanDrift(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
      if (drift) totalWarnings += drift.totalCreated
      const corr = await applyCorrections(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
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
      const evald = await evaluateEconomicOutcomes(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
      if (evald) { totalEvaluated += evald.evaluated; totalMatched += evald.matched }
      const rec   = await generateEconomicRecommendations(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
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
      const r = await runMindCycle(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
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

async function runCeoCycleCron() {
  try {
    const { runCeoCycle } = await import('./ceo-cycle.js')
    const ids = await listWorkspaceIds()
    let totalDelegations = 0, totalChains = 0, totalRed = 0, totalYellow = 0
    for (const ws of ids) {
      const r = await runCeoCycle(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
      if (r) {
        totalDelegations += r.delegationsCreated
        totalChains      += r.chainsRecorded
        totalRed         += r.divisionsRed
        totalYellow      += r.divisionsYellow
      }
    }
    if (totalDelegations + totalChains + totalRed + totalYellow > 0) {
      await emit('cron.ceo_cycle', { delegations: totalDelegations, chains: totalChains, red: totalRed, yellow: totalYellow, workspaces: ids.length })
    }
  } catch (e) { await emit('cron.error', { task: 'ceo_cycle', error: (e as Error).message }) }
}

async function runOpenJarvisMonitorsCron() {
  try {
    const { runMonitorCycle } = await import('./openjarvis-monitors.js')
    const ids = await listWorkspaceIds()
    let totalFired = 0, totalSkipped = 0
    for (const ws of ids) {
      const r = await runMonitorCycle(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
      if (r) {
        totalFired   += r.fired
        totalSkipped += r.skipped
      }
    }
    if (totalFired > 0) {
      await emit('cron.openjarvis_monitors', { fired: totalFired, skipped: totalSkipped, workspaces: ids.length })
    }
  } catch (e) { await emit('cron.error', { task: 'openjarvis_monitors', error: (e as Error).message }) }
}

async function runBrainBroadcastCron() {
  try {
    const { runBroadcastCycle } = await import('./brain-broadcast.js')
    const ids = await listWorkspaceIds()
    for (const ws of ids) {
      const r = await runBroadcastCycle(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
      if (r?.broadcasted) {
        await emit('brain.broadcast_posted', { workspace_id: ws, messageId: r.messageId, conversationId: r.conversationId })
      }
    }
    // Monday-morning briefing: once per workspace per Monday (UTC), the
    // brain posts the structured weekly action plan into the operator's
    // chat. Idempotency uses events table — we emit only if no
    // `brain.monday_briefing_posted` event landed in the last 6 days.
    // Without this the weekly review exists but the operator never sees
    // it unless they explicitly ask. With this, the brain proactively
    // surfaces the highest-leverage moment of the week.
    try {
      const now = new Date()
      if (now.getUTCDay() === 1) {   // Monday in UTC
        await runMondayBriefing(ids)
      }
    } catch (e) { await emit('cron.error', { task: 'monday_briefing', error: (e as Error).message }) }
  } catch (e) { await emit('cron.error', { task: 'brain_broadcast', error: (e as Error).message }) }
}

async function runEconomicHealth() {
  try {
    // Idempotency: 7-day cadence is process-timer; restart resets to 0.
    // Check events table for a prior emission within 6 days. Same pattern
    // as runWeeklyExecutiveBriefings (the only one done correctly before).
    const sinceCutoff = Date.now() - 6 * 86_400_000
    const recent = await db.select({ id: events.id }).from(events)
      .where(and(gte(events.createdAt, sinceCutoff), eq(events.type, 'civilization.economic_health')))
      .limit(1)
    if (recent.length > 0) return
    const { workspaceHealth } = await import('./economic-engine.js')
    const ids = await listWorkspaceIds()
    for (const ws of ids) {
      const h = await workspaceHealth(ws, 30).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
      if (h && h.totalProductions > 0) {
        await emit('civilization.economic_health', {
          workspace_id: ws, productions: h.totalProductions,
          roi: Number(h.aggregateRoi.toFixed(2)),
          winners: h.topWinners.length, wastes: h.biggestWastes.length,
        })
      }
    }
  } catch (e) { await emit('cron.error', { task: 'economic_health', error: (e as Error).message }) }
}

async function runEmergentPatterns() {
  try {
    const { discoverPatterns } = await import('./civilization-core.js')
    const ids = await listWorkspaceIds()
    for (const ws of ids) {
      const patterns = await discoverPatterns(ws).catch(() => [])
      const highLev = patterns.filter(p => p.leverage === 'high').length
      if (patterns.length > 0) await emit('civilization.emergent_patterns', {
        workspace_id: ws, total: patterns.length, high_leverage: highLev,
      })
    }
  } catch (e) { await emit('cron.error', { task: 'emergent_patterns', error: (e as Error).message }) }
}

async function runExecutionPhysics() {
  try {
    const { execPhysics } = await import('./civilization-core.js')
    const ids = await listWorkspaceIds()
    for (const ws of ids) {
      const phys = await execPhysics(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
      if (phys) await emit('civilization.execution_physics', {
        workspace_id: ws,
        velocity: Number(phys.velocity.toFixed(2)),
        friction: Number(phys.friction.toFixed(2)),
        bottlenecks: phys.bottlenecks.length,
      })
    }
  } catch (e) { await emit('cron.error', { task: 'execution_physics', error: (e as Error).message }) }
}

async function runRiskScan() {
  try {
    const { scanAll } = await import('./failure-detector.js')
    const ids = await listWorkspaceIds()
    for (const ws of ids) {
      const r = await scanAll(ws).catch(() => ({ alerts: [] }))
      const critical = r.alerts.filter(a => a.severity === 'critical').length
      if (r.alerts.length > 0) {
        await emit('risk.scan_completed', {
          workspace_id: ws, total: r.alerts.length, critical,
          categories: Array.from(new Set(r.alerts.map(a => a.category))),
        })
      }
    }
  } catch (e) { await emit('cron.error', { task: 'risk_scan', error: (e as Error).message }) }
}

async function runTwinSnapshot() {
  try {
    const { snapshotAllForWorkspace } = await import('./digital-twin.js')
    const ids = await listWorkspaceIds()
    for (const ws of ids) {
      const r = await snapshotAllForWorkspace(ws).catch(() => ({ count: 0, twins: [] }))
      if (r.count > 0) await emit('civilization.twin_snapshot', { workspace_id: ws, count: r.count })
    }
  } catch (e) { await emit('cron.error', { task: 'twin_snapshot', error: (e as Error).message }) }
}

async function runEvolutionDiscover() {
  try {
    const { discoverWeaknesses } = await import('./civilization-core.js')
    const ids = await listWorkspaceIds()
    for (const ws of ids) {
      const proposals = await discoverWeaknesses(ws).catch(() => [])
      if (proposals.length > 0) await emit('civilization.evolution_proposals', { workspace_id: ws, count: proposals.length })
    }
  } catch (e) { await emit('cron.error', { task: 'evolution_discover', error: (e as Error).message }) }
}

async function runDailyRecap() {
  try {
    const { generateRecap } = await import('./civilization-core.js')
    const { db } = await import('../db/client.js')
    const { memories } = await import('../db/schema.js')
    const { v7 } = await import('uuid')
    const ids = await listWorkspaceIds()
    for (const ws of ids) {
      const recap = await generateRecap(ws, 24).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
      if (!recap) continue
      // Persist as a memory tagged 'executive-recap' so the chat session-
      // start surface can pull it on the next operator return.
      try {
        const content = [
          `Executive Recap (${new Date().toISOString().slice(0, 10)})`,
          `Productions: ${recap.productions.total} (${recap.productions.succeeded} ok / ${recap.productions.failed} failed)`,
          recap.alerts.length > 0   ? `Alerts:\n- ${recap.alerts.join('\n- ')}` : '',
          recap.nextMoves.length > 0 ? `Next moves:\n- ${recap.nextMoves.join('\n- ')}` : '',
          recap.patterns.length > 0  ? `Patterns:\n- ${recap.patterns.map(p => p.pattern).join('\n- ')}` : '',
        ].filter(Boolean).join('\n\n')
        const now = Date.now()
        await db.insert(memories).values({
          id: v7(), workspaceId: ws, type: 'fact',
          content, confidence: 0.9,
          tags: ['executive-recap', 'civilization'],
          source: 'civilization-core',
          sourceRef: `recap:${new Date().toISOString().slice(0, 10)}`,
          createdAt: now, updatedAt: now,
        })
      } catch { /* */ }
      await emit('civilization.daily_recap', {
        workspace_id: ws,
        productions: recap.productions, alerts_count: recap.alerts.length,
        next_moves_count: recap.nextMoves.length,
      })
    }
  } catch (e) { await emit('cron.error', { task: 'daily_recap', error: (e as Error).message }) }
}

async function runScheduledProductionTick() {
  try {
    const { tick } = await import('./scheduled-production.js')
    const r = await tick()
    if (r.fired > 0 || r.errors.length > 0) {
      await emit('scheduled_production.tick', {
        checked: r.schedulesChecked, fired: r.fired,
        produced: r.produced, published: r.published,
        errors: r.errors.slice(0, 5),
      })
    }
  } catch (e) { await emit('cron.error', { task: 'scheduled_production', error: (e as Error).message }) }
}

async function runMetaLearning() {
  try {
    const ids = await listWorkspaceIds()
    let totalRecorded = 0
    for (const ws of ids) {
      const r = await recordCalibrationFindings(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
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
      const r = await captureGitState(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
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
      const r = await backfillEmbeddings(ws, 14).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
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
      const r = await linkCommitsToOutcomes(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
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
      const r = await autoRegisterCapabilities(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
      if (r) added += r.added
    }
    if (added > 0) await emit('cron.capability_auto_register', { added })
  } catch (e) { await emit('cron.error', { task: 'capability_auto_register', error: (e as Error).message }) }
}

async function runDataRetention() {
  try {
    const ids = await listWorkspaceIds()
    let totalDeleted = 0
    for (const ws of ids) {
      const r = await runRetention(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
      if (r) totalDeleted += r.reduce((s, x) => s + x.deleted, 0)
    }
    if (totalDeleted > 0) await emit('cron.retention', { totalDeleted })
  } catch (e) { await emit('cron.error', { task: 'data_retention', error: (e as Error).message }) }
}

async function runCronHealthAlerts() {
  try {
    const r = await notifyCronAlerts().catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
    if (r && r.alerted > 0) await emit('cron.health_alerts', { alerted: r.alerted })
  } catch (e) { await emit('cron.error', { task: 'cron_health_alerts', error: (e as Error).message }) }
}

async function runVoiceDryRunSweep() {
  try {
    const { sweepExpiredDryRuns } = await import('./voice-dry-run.js')
    const r = await sweepExpiredDryRuns().catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
    if (r && r.expired > 0) await emit('cron.voice_dry_run_sweep', { expired: r.expired })
  } catch (e) { await emit('cron.error', { task: 'voice_dry_run_sweep', error: (e as Error).message }) }
}

async function runSelfHealScan() {
  try {
    const { scanAndHeal } = await import('./self-healing.js')
    const r = await scanAndHeal().catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
    if (r && r.applied > 0) await emit('cron.self_heal', { applied: r.applied, byKind: r.byKind })
  } catch (e) { await emit('cron.error', { task: 'self_heal_scan', error: (e as Error).message }) }
}

async function runFailoverProbe() {
  try {
    const { runFailoverHealthCheck, getLastFailoverState } = await import('./db-failover.js')
    const prior = getLastFailoverState()
    const next = await runFailoverHealthCheck()
    // Emit only when the recommendation transitions — keeps the audit
    // log quiet during steady-state.
    if (!prior || prior.recommendation !== next.recommendation) {
      await emit('runtime.failover.alert', {
        recommendation: next.recommendation,
        reason:         next.reason,
        primary:        { status: next.primary.status, latencyMs: next.primary.latencyMs },
        replica:        next.replica ? { status: next.replica.status, latencyMs: next.replica.latencyMs } : null,
      })
    }
  } catch (e) { await emit('cron.error', { task: 'failover_probe', error: (e as Error).message }) }
}

// ── Platform self-check — runs the same smoke the operator can trigger
//    on demand. Hits every public GET route the UI uses. Persists each
//    run + detects regressions vs the prior run.
async function runPlatformSmokeAll() {
  try {
    const { runPlatformSmoke } = await import('./platform-smoke.js')
    const ids = await listWorkspaceIds()
    let totalFails = 0, totalSlow = 0, errored = 0
    for (const id of ids) {
      // Per-workspace try/catch — without this, one workspace's failure
      // (e.g. a 500 from an unreachable feature route) would abort the
      // entire tick and leave every later workspace unscanned for the
      // full INTERVALS.platformSmoke window.
      try {
        const r = await runPlatformSmoke(id, { source: 'cron' })
        totalFails += r.failCount
        totalSlow  += r.slowCount
      } catch (e) {
        errored++
        await emit('cron.platform_smoke_workspace_failed', { workspaceId: id, error: (e as Error).message })
      }
    }
    await emit('cron.platform_smoke_completed', { workspaces: ids.length, fails: totalFails, slow: totalSlow, errored })
  } catch (e) { await emit('cron.error', { task: 'platform_smoke', error: (e as Error).message }) }
}

async function runChaosDrill() {
  // Strictly opt-in: only fires when CHAOS_SAFE_WORKSPACE is set to a
  // specific tenant id. Production workspaces are NEVER affected.
  const target = process.env['CHAOS_SAFE_WORKSPACE']
  if (!target || target === 'global' || target === 'production') return
  try {
    const { drDrill } = await import('./dr-drill.js')
    const r = await drDrill(target).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
    if (r) await emit('cron.chaos_drill', { workspace: target, result: 'ok' })
  } catch (e) { await emit('cron.error', { task: 'chaos_drill', error: (e as Error).message }) }
}

async function runAnomalyScan() {
  try {
    // Use the file-local listWorkspaceIds (with cap warning) instead of
    // re-importing from platform-hardening — copy-paste leftover causing
    // potential divergence between cron iterations.
    const { scanAnomalies } = await import('./anomaly-detection.js')
    const ids = await listWorkspaceIds()
    let raised = 0, updated = 0
    for (const ws of ids) {
      const r = await scanAnomalies(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
      if (r) { raised += r.raised; updated += r.updated }
    }
    if (raised + updated > 0) await emit('cron.anomaly_scan', { raised, updated })
  } catch (e) { await emit('cron.error', { task: 'anomaly_scan', error: (e as Error).message }) }
}

async function runFabricSweep() {
  try {
    const ids = await listWorkspaceIds()
    let marked = 0, scaled = 0
    for (const ws of ids) {
      const sweep = await sweepStaleNodes(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
      if (sweep) marked += sweep.marked
      const cyc = await runScalingCycle(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
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
      const r = await autoDeriveTrust(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
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
      const r = await sweepDueReviews(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
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
      const c = await runCompression(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
      if (c) totalLessons += c.totalCreated
      const p = await extractPatterns(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
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
        .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
      if (recent) continue
      const report = await weeklyOperationalReport(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
      if (!report) continue
      await db.insert(events).values({
        id: uuidv7(), type: 'briefing.weekly_executive', workspaceId: ws,
        payload: report as unknown as Record<string, unknown>,
        traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
        source: 'learning-cron', version: 1, createdAt: Date.now(),
      }).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
      generated++
    }
    if (generated > 0) await emit('cron.weekly_briefings_generated', { count: generated })
  } catch (e) { await emit('cron.error', { task: 'weekly_briefings', error: (e as Error).message }) }
}

async function runStabilityScan() {
  try {
    const ids = await listWorkspaceIds()
    for (const ws of ids) {
      const snap = await stabilitySnapshot(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
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
          await autoEngageThrottle(ws, reason).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
        }
        await pauseUnstableAgents(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
      }

      // Auto-disengage: requires >=2 consecutive stable scans (≈10 min)
      await autoDisengageThrottleIfStable(ws, stableNow).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
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
      const r = await runDailyReview(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
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
      await seedResearchAgents(ws).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
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

// R146.71 — events table pruner. Audit + push + every emit() writes
// here. Without a pruner the table grows unbounded. Default keep
// window: 90 days. Operator can set EVENTS_RETENTION_DAYS to tune.
async function runEventsPrune() {
  try {
    const days = Math.max(7, Math.min(365, Number(process.env['EVENTS_RETENTION_DAYS'] ?? 90)))
    if (!Number.isFinite(days)) return
    const cutoff = Date.now() - days * 24 * 60 * 60_000
    const { db } = await import('../db/client.js')
    const { sql: _sql } = await import('drizzle-orm')
    // Use raw delete with a server-side filter to avoid loading any rows
    // into Node memory; Postgres handles the batch internally.
    const res = await db.execute(_sql`DELETE FROM events WHERE created_at < ${cutoff} RETURNING 1`)
    const rows = (res as unknown as { rows?: unknown[] }).rows ?? (Array.isArray(res) ? res as unknown[] : [])
    if (rows.length > 0) await emit('cron.events_pruned', { deleted: rows.length, retentionDays: days })
  } catch (e) { await emit('cron.error', { task: 'events_prune', error: (e as Error).message }) }
}

// R146.98 — strategic ops crons.

async function runStrategicCeoCycle() {
  try {
    const ids = await listWorkspaceIds()
    const { prioritizeBusinesses, diversificationCheck } = await import('./ceo-strategic.js')
    for (const ws of ids) {
      try {
        const ranked = await prioritizeBusinesses(ws)
        const div    = await diversificationCheck(ws)
        await emit('cron.strategic_ceo_completed', { workspaceId: ws, businessesScored: ranked.length, concentrationRisk: div.concentrationRisk })
      } catch (e) { await emit('cron.error', { task: 'strategic_ceo', workspaceId: ws, error: (e as Error).message }) }
    }
  } catch (e) { await emit('cron.error', { task: 'strategic_ceo', error: (e as Error).message }) }
}

async function runLessonDeprecation() {
  try {
    const ids = await listWorkspaceIds()
    const { deprecateStaleLessons } = await import('./learning-upgrades.js')
    let totalDeprecated = 0
    for (const ws of ids) {
      try {
        const r = await deprecateStaleLessons(ws, { olderThanDays: 180 })
        totalDeprecated += r.deprecated
      } catch (e) { await emit('cron.error', { task: 'lesson_deprecation', workspaceId: ws, error: (e as Error).message }) }
    }
    if (totalDeprecated > 0) await emit('cron.lessons_deprecated', { totalDeprecated })
  } catch (e) { await emit('cron.error', { task: 'lesson_deprecation', error: (e as Error).message }) }
}

async function runStageTransitionScan() {
  try {
    const ids = await listWorkspaceIds()
    const { db } = await import('../db/client.js')
    const { businesses } = await import('../db/schema.js')
    const { eq } = await import('drizzle-orm')
    const { suggestStageTransition } = await import('./business-arch.js')
    for (const ws of ids) {
      try {
        const bizRows = await db.select().from(businesses).where(eq(businesses.workspaceId, ws))
        const suggestions: Array<{ businessId: string; suggested: string | null; reason: string }> = []
        for (const b of bizRows) {
          const s = await suggestStageTransition(ws, b.id)
          if (s.suggestedStage) suggestions.push({ businessId: b.id, suggested: s.suggestedStage, reason: s.reason })
        }
        if (suggestions.length > 0) await emit('cron.stage_transitions_surfaced', { workspaceId: ws, count: suggestions.length, sample: suggestions.slice(0, 3) })
      } catch (e) { await emit('cron.error', { task: 'stage_transition_scan', workspaceId: ws, error: (e as Error).message }) }
    }
  } catch (e) { await emit('cron.error', { task: 'stage_transition_scan', error: (e as Error).message }) }
}

async function runStuckLoopScan() {
  try {
    const ids = await listWorkspaceIds()
    const { detectStuckLoop } = await import('./brain-upgrades.js')
    for (const ws of ids) {
      try {
        const r = await detectStuckLoop(ws, { windowMinutes: 60 })
        if (r.inLoop) await emit('cron.stuck_loop_detected', { workspaceId: ws, loopType: r.loopType, evidence: r.evidence, recommendedEscalation: r.recommendedEscalation })
      } catch (e) { await emit('cron.error', { task: 'stuck_loop_scan', workspaceId: ws, error: (e as Error).message }) }
    }
  } catch (e) { await emit('cron.error', { task: 'stuck_loop_scan', error: (e as Error).message }) }
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

// ─── Monday briefing ────────────────────────────────────────────────────────

/**
 * Compose the weekly action plan + post it as a brain-broadcast chat
 * message into the operator's most-recent conversation. Idempotent via
 * the events table: skips a workspace if `brain.monday_briefing_posted`
 * has already landed in the last 6 days.
 */
async function runMondayBriefing(workspaceIds: string[]): Promise<void> {
  const { db: _db } = await import('../db/client.js')
  const { events: _events, conversations, messages } = await import('../db/schema.js')
  const { eq, and: _and, gte: _gte, desc: _desc, sql: _sql } = await import('drizzle-orm')
  const { v7: _uuidv7 } = await import('uuid')
  const { improvePlan } = await import('./portfolio-improve.js')
  const sixDaysMs = 6 * 86_400_000

  for (const ws of workspaceIds) {
    try {
      // Postgres advisory lock per (workspace, 'monday_briefing') —
      // serialises concurrent invocations across processes. The previous
      // SELECT-then-INSERT was a TOCTOU window: two workers both saw no
      // event in the last 6 days and both posted a duplicate briefing.
      // `pg_try_advisory_lock` returns false if another session holds it,
      // letting us skip cleanly rather than block. Released explicitly
      // at the end of the iteration regardless of which branch returned.
      const lockKey = `monday_briefing:${ws}`
      const lockRows = await _db.execute(_sql`SELECT pg_try_advisory_lock(hashtext(${lockKey})) AS got`)
      const got = ((lockRows as unknown as { rows?: Array<{ got?: boolean }> }).rows?.[0]?.got) === true
      if (!got) continue
      try {
      // Idempotency check (now safe: only one session past the advisory lock at a time)
      const recent = await _db.select({ id: _events.id }).from(_events)
        .where(_and(
          eq(_events.workspaceId, ws),
          eq(_events.type, 'brain.monday_briefing_posted'),
          _gte(_events.createdAt, Date.now() - sixDaysMs),
        ))
        .limit(1)
      if (recent.length > 0) continue

      // Find the operator's most-recent conversation; skip if none.
      const conv = await _db.select({ id: conversations.id }).from(conversations)
        .where(_and(eq(conversations.workspaceId, ws), eq(conversations.archived, false)))
        .orderBy(_desc(conversations.updatedAt))
        .limit(1)
      if (conv.length === 0) continue
      const conversationId = conv[0]!.id

      // Compose the plan. Bail silently if the workspace has zero
      // businesses — operator hasn't onboarded yet.
      const plan = await improvePlan(ws)
      if (plan.reviewSummary.businessCount === 0) continue

      // Render as chat-friendly markdown
      const body = [
        `## Monday briefing — week of ${new Date().toISOString().slice(0, 10)}`,
        '',
        `**Portfolio state**: ${plan.reviewSummary.businessCount} businesses · $${plan.reviewSummary.totalMonthlyUsd.toFixed(0)}/mo vs $${plan.reviewSummary.totalTargetUsd.toFixed(0)} combined target · ${plan.reviewSummary.underperformingCount} need attention`,
        `**Gap to combined floor**: $${plan.reviewSummary.gapUsd.toFixed(0)}/mo`,
        '',
        '### Action items',
        ...plan.steps.slice(0, 5).map((s, i) =>
          `${i + 1}. **${s.priority === 'high' ? '🔴' : s.priority === 'medium' ? '🟡' : '⚪️'} ${s.action}**\n   _${s.rationale}_\n   Expected impact: ${s.expectedImpact}${s.suggestedOp ? ` · suggested op: \`${s.suggestedOp}\`` : ''}`
        ),
        '',
        '### Honest caveats',
        ...plan.honestCaveats.map(c => `- ${c}`),
        '',
        '_Reply with the number of any action item to expand it, or `skip` to dismiss._',
      ].join('\n')

      const messageId = _uuidv7()
      await _db.insert(messages).values({
        id: messageId,
        workspaceId: ws,
        conversationId,
        role: 'assistant',
        content: body,
        createdAt: Date.now(),
      }).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })

      await _db.insert(_events).values({
        id: _uuidv7(),
        type: 'brain.monday_briefing_posted',
        workspaceId: ws,
        payload: { conversationId, messageId, businessCount: plan.reviewSummary.businessCount, gapUsd: plan.reviewSummary.gapUsd },
        traceId: _uuidv7(), correlationId: _uuidv7(), causationId: null,
        source: 'learning-cron', version: 1, createdAt: Date.now(),
      }).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
      } finally {
        // Always release the advisory lock — Postgres holds it for the
        // session lifetime otherwise, blocking the next Monday cycle.
        await _db.execute(_sql`SELECT pg_advisory_unlock(hashtext(${lockKey}))`).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
      }
    } catch (e) {
      await emit('cron.monday_briefing_workspace_failed', { workspaceId: ws, error: (e as Error).message })
    }
  }
}

// ─── Continuous improvement: portfolio + prompt evolution ───────────────────

/**
 * Daily per-workspace portfolio review. Pulls the weekly-review struct
 * (gap to $10k/mo per business, sunset candidates, action items) and
 * persists it as a memory the operator's Monday briefing can render.
 * Emits a single `cron.portfolio_review_completed` event with the
 * aggregate gap-to-target across all businesses in the workspace.
 */
async function runPortfolioReview() {
  try {
    const { weeklyReview } = await import('./business-portfolio.js')
    const ids = await listWorkspaceIds()
    let totalGap = 0
    let underperformingCount = 0
    let touched = 0
    for (const ws of ids) {
      try {
        const review = await weeklyReview(ws)
        totalGap += Math.max(0, review.totalTargetUsd - review.totalMonthlyUsd)
        underperformingCount += review.underperforming.length
        touched++
        await emit('cron.portfolio_review', {
          workspaceId: ws,
          businessCount: review.businessCount,
          totalMonthlyUsd: review.totalMonthlyUsd,
          totalTargetUsd:  review.totalTargetUsd,
          pctToGoal:       review.pctToCombinedGoal,
          actionItems:     review.actionable.slice(0, 5),
        })
      } catch (e) {
        // Per-workspace try/catch — one workspace's failure does not
        // kill the rest of the sweep.
        await emit('cron.portfolio_review_failed', { workspaceId: ws, error: (e as Error).message })
      }
    }
    await emit('cron.portfolio_review_completed', {
      workspaces: touched, totalGapUsd: totalGap, underperformingCount,
    })
  } catch (e) { await emit('cron.error', { task: 'portfolio_review', error: (e as Error).message }) }
}

/**
 * Prompt-evolution tick: per workspace, pick at most one slot to evolve
 * (round-robin via `mod` over the slot list keyed on the day-of-year so
 * the same slot doesn't get hammered). Slot-internal idempotency (24h
 * lockout in evolvePrompt) handles the rest.
 *
 * The point of this cron is *steady drift* — every 6 hours, one slot
 * across the workspace tries one mutation. Over a week the system
 * cycles through ~28 mutations per workspace; over a month ~120. With
 * an exploration rate of 10% inside usePrompt, that's enough sample
 * size for a slot with > 10 uses/day to converge.
 */
async function runPromptEvolutionTick() {
  try {
    const { listSlots, evolvePrompt } = await import('./prompt-evolution.js')
    const { db } = await import('../db/client.js')
    const { killSwitches } = await import('../db/schema.js')
    const { and, eq } = await import('drizzle-orm')
    const ids = await listWorkspaceIds()
    let evolved = 0
    let retired = 0
    let skipped_ks = 0
    for (const ws of ids) {
      try {
        // R146.52 — per-workspace ai_request kill_switch check. R14
        // wired this into scheduled-production but prompt-evolution
        // also issues an LLM call per workspace per tick (evolvePrompt
        // mutates by sampling the existing prompt + asking the model
        // to rewrite). When the operator pulls the AI kill_switch for
        // emergency-stop, this loop should respect it too.
        const ks = await db.select({ enabled: killSwitches.enabled })
          .from(killSwitches)
          .where(and(eq(killSwitches.workspaceId, ws), eq(killSwitches.switchType, 'ai_request')))
          .limit(1).then(r => r[0]).catch(() => null)
        if (ks?.enabled) { skipped_ks++; continue }

        const slots = await listSlots(ws)
        if (slots.length === 0) continue
        // Pick the slot with the highest totalUses that's also reasonably
        // active (≥ 20 uses) — that's where one extra version actually
        // gets sampled. Fall back to the highest-uses slot if none clear
        // the 20-use bar.
        const candidates = slots.filter(s => s.totalUses >= 20)
        const pick = (candidates[0] ?? slots[0])
        if (!pick) continue
        const r = await evolvePrompt(ws, pick.slot)
        if (r.added)   evolved++
        if (r.retired) retired += r.retired
      } catch (e) {
        await emit('cron.prompt_evolution_failed', { workspaceId: ws, error: (e as Error).message })
      }
    }
    await emit('cron.prompt_evolution_completed', { workspaces: ids.length, evolved, retired, skipped_ks })
  } catch (e) { await emit('cron.error', { task: 'prompt_evolution', error: (e as Error).message }) }
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
  eventsPrune:  24 * 60 * 60_000, // 24 hours — drop events older than EVENTS_RETENTION_DAYS (90 default)
  // R146.98 — cadences for the new strategic ops
  strategicCeo:        6 * 60 * 60_000,   // every 6h — prioritize + diversification + reallocation proposal
  lessonDeprecation:  24 * 60 * 60_000,   // daily — deprecate stale non-evergreen memories
  stageTransitionScan: 12 * 60 * 60_000,  // 2x daily — surface stage transitions
  stuckLoopScan:           60 * 60_000,   // hourly — detect & surface stuck loops
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
  ceoCycle:         15 * 60_000,      // 15 min — CEO snapshots divisions + delegates remediation
  brainBroadcast:   5  * 60_000,      // 5 min — brain proactive chat digest to operator
  openjarvisMonitors: 15 * 60_000,    // 15 min — OpenJarvis monitor-operative agents (each has its own interval)
  metaLearning:     60 * 60_000,      // 1 hour — calibration auto-tune suggestions
  watchdog:         2  * 60_000,      // 2 min — best-effort in-process liveness check
  gitState:         15 * 60_000,      // 15 min — capture recent git commits
  embeddingsBackfill: 30 * 60_000,    // 30 min — index recent chains for semantic search
  commitLearning:   6  * 60 * 60_000, // 6 hours — link commits to outcomes
  capabilityAutoReg: 30 * 60_000,     // 30 min — auto-register discovered services
  trustAutoDerive:  60 * 60_000,      // 1 hour — adjust trust scores from observed signals
  fabricSweep:      2  * 60_000,      // 2 min — stale-node sweep + scaling decision cycle
  dataRetention:    24 * 60 * 60_000, // 24 hours — archive old events/chains/messages
  cronHealthAlerts: 60 * 60_000,      // 1 hour — alert if cron failing repeatedly
  voiceDryRunSweep: 60_000,           // 60 s — expire stale pending voice dry-runs
  selfHealScan:     2 * 60_000,       // 2 min — recover stuck sessions / dry-runs
  anomalyScan:      5 * 60_000,       // 5 min — behavioral anomaly detection
  chaosDrill:       7 * 86_400_000,   // weekly — only fires when CHAOS_SAFE_WORKSPACE is set
  failoverProbe:    60 * 60_000,      // 1 hour — probe primary + replica DB endpoints
  platformSmoke:    15 * 60_000,      // 15 min — exercise every public GET route the UI hits
  issueIngest:      5  * 60_000,      // 5 min — convert recent incidents + cron errors into issues
  issueAutoLoop:    10 * 60_000,      // 10 min — diagnosed→proposed; patched→verified (when proposal shipped)
  scheduledProduction: 15 * 60_000,   // 15 min — fire daily-quota video production schedules
  twinSnapshot:        30 * 60_000,   // 30 min — refresh digital-twin mirrors of channels + businesses
  evolutionDiscover:    6 * 60 * 60_000,  // 6 hours — discover self-evolution candidates
  recapDaily:          24 * 60 * 60_000,  // 24 hours — generate executive recap memory
  riskScan:            20 * 60_000,       // 20 min — active failure-mode scan against the 30-risk taxonomy
  economicHealth:      7 * 24 * 60 * 60_000, // weekly — workspace ROI rollup memory
  emergentPatterns:    24 * 60 * 60_000,     // daily — discover strategic patterns
  executionPhysics:    24 * 60 * 60_000,     // daily — momentum/friction snapshot
  portfolioReview:     24 * 60 * 60_000,     // daily — per-business gap to $10k/mo target + Monday weekly review
  promptEvolution:     6 * 60 * 60_000,      // 6h — pick one prompt slot per workspace and run evolvePrompt

  // Round 117 — Blueprint persistence cron wiring
  memoryDecay:         60 * 60_000,          // hourly — age + prune semantic memories
  knowledgeCurate:     6 * 60 * 60_000,      // 6h — surface curated patterns to operator
  cartographerSnapshot: 24 * 60 * 60_000,    // daily — refresh codebase map

  // Round 120-122
  evalDriftCheck:       6  * 60 * 60_000,    // 6h — output distribution drift
  evalProductionSample: 60 * 60_000,         // hourly — production-traffic eval sample
  curatorPeriodicReview: 24 * 60 * 60_000,   // daily — full curator cycle + auto-deprecate

  // Round 116 — self-improvement health check (SPEC §10.4)
  selfImprovementHealthCheck: 24 * 60 * 60_000,   // daily — 5 pathology detectors

  // Round 119 — SOC2 compliance + AI drift detection (BO17/BO19)
  complianceEvidence:   24 * 60 * 60_000,         // daily — collect SOC2 evidence
  cveScan:              24 * 60 * 60_000,         // daily — pnpm audit
  accessReviewCheck:    24 * 60 * 60_000,         // daily — fires quarterly when due
  aiDriftSample:         6 * 60 * 60_000,         // 6h — production AI drift detection

  // Round 120 — self-maintaining capabilities (Layer 5 lock integrity)
  lockIntegrityCheck:    6 * 60 * 60_000,         // 6h — hash + verify LOCKED_PATHS

  // Round 123 — close remaining wiring gaps (workers + consumers)
  mediaVideoWorker:      2 * 60_000,              // 2 min — drain video job queue
  recoveryExecutor:      5 * 60_000,              // 5 min — act on playbook suggestions
  secretsRotationDrain:  3 * 60_000,              // 3 min — drop cached rotated secrets

  // Round 146.105 — Novan Frontier Intelligence: 24/7 scan top AI breakthroughs,
  // distill, score, and auto-spawn prototypes for high-score findings.
  frontierIntel:         5 * 60_000,              // 5 min — one source + distill batch + spawn tasks
  // Round 146.107 — Frontier MAX tick: capability catalog + permanent advancement loop.
  // Runs every 60s; when MAX mode is OFF this is mostly a no-op (small batches).
  // When MAX mode is ON the operator-tunable batches go large.
  frontierMax:           60_000,
  // Round 146.108 — Frontier consumers: embedding backfill, dedup, write
  // prototype + advancement specs to disk, empirical capability scoring.
  frontierConsumer:      90_000,
  // Round 146.114 — Second Brain (cryptocita /raw → /wiki pipeline).
  // Three jobs: daily ingest (7am), daily review (6pm), weekly audit (Sun 9am).
  // We use a single 5-min tick + a "did this hour already run?" guard so
  // ops can change the schedule via config without restarting the process.
  secondBrainCron:       5 * 60_000,
  // R146.115 — Shortform pipeline cron: check enabled YT pipelines for new
  // uploads, clip them. Heavy job; runs hourly.
  shortformCron:         60 * 60_000,
  // R146.117 — Agent dispatch tick: bridge security findings + improvement
  // suggestions onto the agent_ops_board, then reflect board state in the
  // agent_roster status. Cheap, runs every 5 min.
  agentDispatch:         5 * 60_000,
  // R146.124 — pre-refresh OAuth tokens 30 min before expiry. Cheap.
  oauthRefresh:          15 * 60_000,
  // R146.124 — scan recent errors → improvement_suggestions. Hourly.
  suggestionsProducer:   60 * 60_000,
  // R146.128 — nightly DB backup. 24h interval is fine; the backup script
  // itself targets 04:00 UTC via cron-on-host. This tick is a safety net
  // for environments without host cron.
  nightlyBackup:         24 * 60 * 60_000,
  // R146.130 — morning briefing push at 7am UTC. 24h tick; gate inside
  // checks current UTC hour and fires once per day.
  morningBriefing:       60 * 60_000,
  // R146.159 — PKM maintenance: daily snapshot, weekly review (Monday),
  // concept maturity update. All gated by UTC time inside their handlers.
  pkmMaintenance:        60 * 60_000,
  // R146.161 — Social comment harvest every 30min; self-improve daily.
  socialCommentHarvest:  30 * 60_000,
  socialCommentImprove:  60 * 60_000,
  // R146.162 — Owned-audience: segment refresh + win-back detection.
  audienceMaint:         60 * 60_000,
  // R146.164 — Cart recovery sweep hourly.
  cartRecovery:          60 * 60_000,
  // R146.168 — Loop closure sweep hourly.
  loopClosure:           60 * 60_000,
  // R146.186 — Wire-up crons.
  proactiveScan:          5 * 60_000,
  radarScan:             10 * 60_000,
  moneyDailyOptimize:    60 * 60_000,    // gated to 07:00 UTC inside handler
  pentestWeekly:         60 * 60_000,    // gated to Mon 04:00 UTC inside handler
  sessionSyncPrune:      30 * 60_000,
}

/**
 * Schedule a cron job with a random start offset so 30+ jobs don't
 * collide at boot + at every minute-boundary. Without jitter, every
 * 2-min and 5-min job fires simultaneously at t=2:00, 4:00, 6:00, etc.
 * — saturating the event loop and starving HTTP requests for seconds.
 * Jitter spreads them across the interval so the load is amortized.
 *
 * Diagnosis: postgres was completely idle while /api/v1/workspaces
 * blocked for 6–8 s. The bottleneck was 100 % the Node event loop,
 * not the DB. Jitter is the safe minimal fix.
 */
// Self-rescheduling jittered scheduler with in-flight guard.
// REPLACES the broken setTimeout-then-setInterval pattern that produced
// 100 entries in handles[] (50 setTimeouts + 50 setIntervals) and let
// ticks overlap under slow DB. Now: single chained setTimeout per cron,
// re-jittered each tick (±10% spread breaks deterministic stacking),
// and an in-flight guard prevents tick-stacking when work runs long.
const _running = new Map<string, boolean>()
function scheduleJittered(fn: () => void | Promise<void>, intervalMs: number, name?: string): NodeJS.Timeout {
  // R142 — was `name ?? fn.name ?? fallback`. `??` only coalesces null/
  // undefined, but `fn.name` is the empty string for inline arrows
  // (every call site here passes an inline `() => void runX()`). Result:
  // every cron metric got tagged `task=""`. Use `||` so empty strings
  // fall through to the next candidate.
  const tag = name || fn.name || `cron-${Math.random().toString(36).slice(2, 8)}`
  let handle: NodeJS.Timeout | null = null
  const jitter = () => intervalMs + Math.floor((Math.random() - 0.5) * 0.2 * intervalMs)
  const tick = async (): Promise<void> => {
    if (_running.get(tag)) {
      // Previous tick still running — skip this one to avoid stacking.
      // Metrics surface stack-prevention so over-tight intervals are visible.
      void import('./metrics.js').then(m => m.incCounter('cron_tick_skipped_total', { task: tag })).catch(() => {})
    } else {
      _running.set(tag, true)
      const startedAt = Date.now()
      try {
        await fn()
        void import('./metrics.js').then(m => m.incCounter('cron_tick_succeeded_total', { task: tag })).catch(() => {})
      } catch {
        // Runners already emit cron.error to events; metrics also count.
        void import('./metrics.js').then(m => m.incCounter('cron_tick_failed_total', { task: tag })).catch(() => {})
      }
      finally {
        _running.set(tag, false)
        const dur = Date.now() - startedAt
        void import('./metrics.js').then(m => m.setGauge('cron_tick_last_duration_ms', dur, { task: tag })).catch(() => {})
      }
    }
    handle = setTimeout(() => void tick(), jitter())
  }
  // First fire: random startOffset within min(intervalMs, 60s)
  const startOffset = Math.floor(Math.random() * Math.min(intervalMs, 60_000))
  handle = setTimeout(() => void tick(), startOffset)
  // Return a wrapper handle the caller can clear. We expose a getter so
  // stopLearningCron can clear whichever timer is currently armed.
  const wrapper = handle as NodeJS.Timeout & { __getCurrent?: () => NodeJS.Timeout | null }
  ;(wrapper as { __getCurrent?: () => NodeJS.Timeout | null }).__getCurrent = () => handle
  return wrapper
}

// Round 117 cron runners — pull each service's main entry and emit
// telemetry so the cron-health-alerts sweep can spot regressions.
async function runMemoryDecaySweep(): Promise<void> {
  try {
    const { decaySweepAll } = await import('./memory-tiers.js')
    const r = await decaySweepAll()
    await emit('cron.memory_decay', r)
  } catch (e) { await emit('cron.error', { task: 'memory_decay', error: (e as Error).message }) }
}

async function runKnowledgeCurate(): Promise<void> {
  try {
    const { curate } = await import('./knowledge-curator.js')
    // Curate across all workspaces with recent activity.
    const { db: _db } = await import('../db/client.js')
    const { events: _events } = await import('../db/schema.js')
    const { sql: _sql, gte: _gte } = await import('drizzle-orm')
    const rows = await _db.select({ ws: _events.workspaceId })
      .from(_events)
      .where(_gte(_events.createdAt, Date.now() - 7 * 86_400_000))
      .groupBy(_events.workspaceId)
      .limit(50)
      .catch(() => [])
    let totalProposed = 0
    for (const r of rows) {
      const proposed = await curate(r.ws).catch(() => [])
      totalProposed += proposed.length
    }
    await emit('cron.knowledge_curate', { workspacesScanned: rows.length, totalProposed })
  } catch (e) { await emit('cron.error', { task: 'knowledge_curate', error: (e as Error).message }) }
}

// Round 120-122 cron runners
async function runEvalDriftCheck(): Promise<void> {
  try {
    const { detectDrift } = await import('./eval-system.js')
    const { db: _db } = await import('../db/client.js')
    const { workspaces } = await import('../db/schema.js')
    const rows = await _db.select({ id: workspaces.id }).from(workspaces).limit(50).catch(() => [])
    let drifted = 0
    for (const r of rows) {
      const d = await detectDrift({ workspaceId: r.id }).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
      if (d?.drifted) drifted++
    }
    await emit('cron.eval_drift', { workspacesScanned: rows.length, drifted })
  } catch (e) { await emit('cron.error', { task: 'eval_drift', error: (e as Error).message }) }
}

async function runEvalProductionSample(): Promise<void> {
  try {
    const { sampleProductionTraffic } = await import('./eval-system.js')
    const { db: _db } = await import('../db/client.js')
    const { workspaces } = await import('../db/schema.js')
    const rows = await _db.select({ id: workspaces.id }).from(workspaces).limit(20).catch(() => [])
    let totalConcerning = 0
    for (const r of rows) {
      const out = await sampleProductionTraffic({
        workspaceId: r.id,
        rubric:      { expectedBehavior: 'helpful, grounded in playbooks or operator data, citation when claiming facts, refusal when policy demands' },
      }).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
      if (out) totalConcerning += out.concerning.length
    }
    await emit('cron.eval_production_sample', { workspacesScanned: rows.length, totalConcerning })
  } catch (e) { await emit('cron.error', { task: 'eval_production_sample', error: (e as Error).message }) }
}

async function runCuratorPeriodicReview(): Promise<void> {
  try {
    const { runPeriodicReview } = await import('./knowledge-curator-v2.js')
    const { db: _db } = await import('../db/client.js')
    const { workspaces } = await import('../db/schema.js')
    const rows = await _db.select({ id: workspaces.id }).from(workspaces).limit(50).catch(() => [])
    let totalProposals = 0, totalDeprecated = 0
    for (const r of rows) {
      const out = await runPeriodicReview(r.id).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
      if (out) { totalProposals += out.newProposals; totalDeprecated += out.autoDeprecated }
    }
    await emit('cron.curator_periodic', { workspacesScanned: rows.length, totalProposals, totalDeprecated })
  } catch (e) { await emit('cron.error', { task: 'curator_periodic', error: (e as Error).message }) }
}

/** Self-improvement health check — runs all 5 pathology detectors from
 *  SPEC §10.4 daily across all workspaces. Surfaces critical-verdict
 *  workspaces as `governance.stability_alert` events so the brain
 *  pauses autonomous self-modification while operator reviews. */
async function runSelfImprovementHealthCheck(): Promise<void> {
  try {
    const { runAllImprovementHealthChecks } = await import('./self-improvement.js')
    const { db: _db } = await import('../db/client.js')
    const { workspaces } = await import('../db/schema.js')
    const rows = await _db.select({ id: workspaces.id }).from(workspaces).limit(50).catch(() => [])
    let healthy = 0, investigating = 0, paused = 0
    for (const r of rows) {
      const verdict = await runAllImprovementHealthChecks(r.id).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
      if (!verdict) continue
      if (verdict.overallVerdict === 'healthy')                 healthy++
      else if (verdict.overallVerdict === 'investigate')         investigating++
      else if (verdict.overallVerdict === 'pause_self_improvement') {
        paused++
        // Emit an explicit alert so the policy engine + autonomous-mind
        // see the pause signal in the event stream.
        await emit('governance.stability_alert', {
          workspaceId: r.id,
          source:      'self_improvement_health_check',
          verdict:     verdict.overallVerdict,
          detail: {
            capabilityNarrowing: verdict.capabilityNarrowing.narrowing,
            coordinationDrift:   verdict.coordinationDrift.drifted,
            compoundingErrors:   verdict.compoundingErrors.compounding,
            rewardHackingCount:  verdict.rewardHacking.suspiciousCount,
          },
        })
      }
    }
    await emit('cron.self_improvement_health', { workspacesScanned: rows.length, healthy, investigating, paused })
  } catch (e) { await emit('cron.error', { task: 'self_improvement_health', error: (e as Error).message }) }
}

// Round 119 — SOC2 + AI drift (BO17 / BO19)

async function runComplianceEvidence(): Promise<void> {
  try {
    const { runComplianceEvidenceCollection } = await import('./compliance-soc2.js')
    const out = await runComplianceEvidenceCollection()
    await emit('cron.compliance_evidence_completed', out)
  } catch (e) { await emit('cron.error', { task: 'compliance_evidence', error: (e as Error).message }) }
}

async function runCveScan(): Promise<void> {
  try {
    const { runDependencyCveScan } = await import('./compliance-soc2.js')
    const out = await runDependencyCveScan()
    if (out) await emit('cron.cve_scan_completed', out)
  } catch (e) { await emit('cron.error', { task: 'cve_scan', error: (e as Error).message }) }
}

async function runAccessReviewCheck(): Promise<void> {
  try {
    const { runQuarterlyAccessReviewCheck } = await import('./compliance-soc2.js')
    const out = await runQuarterlyAccessReviewCheck()
    if (out.due) await emit('cron.access_review_due', out)
  } catch (e) { await emit('cron.error', { task: 'access_review_check', error: (e as Error).message }) }
}

async function runAiDrift(): Promise<void> {
  try {
    const { runAiDriftSample } = await import('./ai-drift.js')
    const out = await runAiDriftSample()
    await emit('cron.ai_drift_completed', out)
  } catch (e) { await emit('cron.error', { task: 'ai_drift', error: (e as Error).message }) }
}

async function runLockIntegrity(): Promise<void> {
  try {
    const { runLockIntegrityCheck } = await import('./lock-integrity.js')
    const out = await runLockIntegrityCheck()
    await emit('cron.lock_integrity_completed', {
      checked: out.checked, matches: out.matches,
      tampered: out.tampered.length, bootstrapped: out.bootstrapped.length, missing: out.missing.length,
    })
  } catch (e) { await emit('cron.error', { task: 'lock_integrity', error: (e as Error).message }) }
}

async function runMediaVideoWorkerTick(): Promise<void> {
  try {
    const { runMediaVideoWorker } = await import('./media-video-worker.js')
    const out = await runMediaVideoWorker()
    if (out.processed > 0) await emit('cron.media_video_worker_completed', out)
  } catch (e) { await emit('cron.error', { task: 'media_video_worker', error: (e as Error).message }) }
}

async function runRecoveryExecutorTick(): Promise<void> {
  try {
    const { runRecoveryExecutor } = await import('./recovery-executor.js')
    const out = await runRecoveryExecutor()
    if (out.examined > 0) await emit('cron.recovery_executor_completed', out)
  } catch (e) { await emit('cron.error', { task: 'recovery_executor', error: (e as Error).message }) }
}

async function runSecretsRotationDrainTick(): Promise<void> {
  try {
    const { consumeSecretRotations } = await import('./secrets-provider.js')
    const out = await consumeSecretRotations()
    if (out.dropped.length > 0) await emit('cron.secrets_rotation_drained', out)
  } catch (e) { await emit('cron.error', { task: 'secrets_rotation_drain', error: (e as Error).message }) }
}

// R146.105 — Frontier Intelligence: scan top AI breakthrough sources 24/7,
// distill, score, queue prototypes for the high-scorers.
async function runFrontierIntelTick(): Promise<void> {
  if (process.env['DISABLE_FRONTIER_INTEL'] === '1') return
  try {
    const { frontierTick, seedDefaultSources } = await import('./frontier-intel.js')
    // Seed sources for the 'system' workspace on first run (idempotent via unique idx).
    await seedDefaultSources('system').catch(() => null)
    const out = await frontierTick('system')
    if (out.inserted > 0 || out.distilled > 0 || out.spawned > 0) {
      await emit('cron.frontier_intel_tick', out)
    }
  } catch (e) { await emit('cron.error', { task: 'frontier_intel', error: (e as Error).message }) }
}

// R146.159 — PKM maintenance: daily snapshot, weekly review (Monday 9am UTC),
// concept maturity update. Hourly tick gates by UTC time.
let lastSnapshotDay = -1
let lastConceptDay = -1
let lastWeeklyMonday = ''
async function runPkmMaintenance(): Promise<void> {
  if (process.env['DISABLE_PKM_MAINTENANCE'] === '1') return
  const now = new Date()
  const today = Math.floor(now.getTime() / (24 * 60 * 60_000))
  const utcHour = now.getUTCHours()
  const utcDay = now.getUTCDay()  // 0 = Sun, 1 = Mon

  // Daily memory snapshot at 4am UTC
  if (utcHour === 4 && lastSnapshotDay !== today) {
    lastSnapshotDay = today
    try {
      const { snapshotCapture } = await import('./r150-sb-c-tier.js')
      await snapshotCapture('system')
      await emit('cron.pkm_snapshot', { day: today })
    } catch (e) { await emit('cron.error', { task: 'pkm_snapshot', error: (e as Error).message }) }
  }

  // Concept maturity daily at 5am UTC
  if (utcHour === 5 && lastConceptDay !== today) {
    lastConceptDay = today
    try {
      const { conceptMaturityTick } = await import('./r149-sb-b-tier.js')
      const out = await conceptMaturityTick('system')
      await emit('cron.pkm_concept_maturity', out)
    } catch (e) { await emit('cron.error', { task: 'pkm_concept_maturity', error: (e as Error).message }) }
  }

  // Weekly review on Monday 9am UTC
  if (utcDay === 1 && utcHour === 9) {
    const monday = now.toISOString().slice(0, 10)
    if (lastWeeklyMonday !== monday) {
      lastWeeklyMonday = monday
      try {
        const { weeklyReviewGenerate } = await import('./r148-sb-a-tier.js')
        const out = await weeklyReviewGenerate('system')
        await emit('cron.pkm_weekly_review', { week: out.weekStarting })
      } catch (e) { await emit('cron.error', { task: 'pkm_weekly_review', error: (e as Error).message }) }
    }
  }
}

// R146.161 — Harvest comments across every active workspace's social
// accounts. Each workspace runs in its own try so one bad token doesn't
// poison the sweep.
async function runSocialCommentHarvest(): Promise<void> {
  if (process.env['DISABLE_SOCIAL_COMMENTS'] === '1') return
  try {
    const ids = await listWorkspaceIds()
    const { commentsHarvest, autoDraftBacklog } = await import('./r161-social-comments.js')
    let totalNew = 0
    for (const ws of ids) {
      try {
        const r = await commentsHarvest(ws)
        totalNew += r.new
        if (r.new > 0) await autoDraftBacklog(ws, 10).catch(() => null)
      } catch (e) { await emit('cron.error', { task: 'social_comment_harvest', workspace: ws, error: (e as Error).message }) }
    }
    if (totalNew > 0) await emit('cron.social_comment_harvest', { workspaces: ids.length, new: totalNew })
  } catch (e) { await emit('cron.error', { task: 'social_comment_harvest', error: (e as Error).message }) }
}

// R146.168 — Loop closure: lessons → prompts + funnel → outcomes.
async function runLoopClosure(): Promise<void> {
  if (process.env['DISABLE_LOOP_CLOSURE'] === '1') return
  try {
    const ids = await listWorkspaceIds()
    const { closeLoops } = await import('./r168-loop-closure.js')
    let lessons = 0, outcomes = 0
    for (const ws of ids) {
      try {
        const r = await closeLoops(ws)
        lessons += r.lessonsSeeded
        outcomes += r.outcomesFilled
      } catch (e) { await emit('cron.error', { task: 'loop_closure', workspace: ws, error: (e as Error).message }) }
    }
    if (lessons > 0 || outcomes > 0) await emit('cron.loop_closure', { workspaces: ids.length, lessons, outcomes })
  } catch (e) { await emit('cron.error', { task: 'loop_closure', error: (e as Error).message }) }
}

// R146.186 — Wire R183 proactive scan every 5 min across all workspaces.
// R146.190 — time-based heartbeat (survives restarts): emit when
// activity OR when ≥58 min has passed since the last heartbeat emit.
let _proactiveLastEmit = 0
async function runProactiveScan(): Promise<void> {
  if (process.env['DISABLE_PROACTIVE'] === '1') return
  try {
    const ids = await listWorkspaceIds()
    const { proactiveScan } = await import('./r183-proactive-radar.js')
    let totalMinted = 0, totalFired = 0
    for (const ws of ids) {
      try {
        const r = await proactiveScan(ws)
        totalMinted += r.minted
        totalFired  += r.fired
      } catch (e) { await emit('cron.error', { task: 'proactive_scan', workspace: ws, error: (e as Error).message }) }
    }
    const now = Date.now()
    if (totalMinted > 0 || totalFired > 0 || now - _proactiveLastEmit >= 58 * 60_000) {
      await emit('cron.proactive_scan', { workspaces: ids.length, minted: totalMinted, fired: totalFired })
      _proactiveLastEmit = now
    }
  } catch (e) { await emit('cron.error', { task: 'proactive_scan', error: (e as Error).message }) }
}

// R146.186 — Wire R183 radar snapshot every 10 min.
let _radarLastEmit = 0
async function runRadarScan(): Promise<void> {
  if (process.env['DISABLE_RADAR'] === '1') return
  try {
    const ids = await listWorkspaceIds()
    const { radarScan } = await import('./r183-proactive-radar.js')
    let totalOpen = 0, totalCrit = 0
    for (const ws of ids) {
      try {
        const snap = await radarScan(ws)
        totalOpen += snap.openTotal
        totalCrit += snap.criticalCount
      } catch (e) { await emit('cron.error', { task: 'radar_scan', workspace: ws, error: (e as Error).message }) }
    }
    const now = Date.now()
    if (totalOpen > 0 || totalCrit > 0 || now - _radarLastEmit >= 58 * 60_000) {
      await emit('cron.radar_scan', { workspaces: ids.length, openTotal: totalOpen, criticalCount: totalCrit })
      _radarLastEmit = now
    }
  } catch (e) { await emit('cron.error', { task: 'radar_scan', error: (e as Error).message }) }
}

// R146.186 — Wire R180 daily money optimize. Fires once per UTC day at 07:00.
let _lastMoneyDay = -1
async function runMoneyDailyOptimize(): Promise<void> {
  if (process.env['DISABLE_MONEY_OPTIMIZE'] === '1') return
  const now = new Date()
  if (now.getUTCHours() !== 7) return
  const today = Math.floor(now.getTime() / (24 * 60 * 60_000))
  if (_lastMoneyDay === today) return
  _lastMoneyDay = today
  try {
    const ids = await listWorkspaceIds()
    const { dailyOptimize } = await import('./r180-money-maximizer.js')
    for (const ws of ids) {
      try { await dailyOptimize(ws, 8) }
      catch (e) { await emit('cron.error', { task: 'money_daily_optimize', workspace: ws, error: (e as Error).message }) }
    }
  } catch (e) { await emit('cron.error', { task: 'money_daily_optimize', error: (e as Error).message }) }
}

// R146.186 — Wire R181 weekly auto-pentest. Fires Monday 04:00 UTC.
let _lastPentestWeek = ''
async function runPentestWeekly(): Promise<void> {
  if (process.env['DISABLE_PENTEST_WEEKLY'] === '1') return
  const now = new Date()
  if (now.getUTCDay() !== 1 || now.getUTCHours() !== 4) return
  const weekKey = now.toISOString().slice(0, 10)
  if (_lastPentestWeek === weekKey) return
  _lastPentestWeek = weekKey
  try {
    const ids = await listWorkspaceIds()
    const { runPentest } = await import('./r181-self-pentest.js')
    for (const ws of ids) {
      try { await runPentest(ws, { triggeredBy: 'cron' }) }
      catch (e) { await emit('cron.error', { task: 'pentest_weekly', workspace: ws, error: (e as Error).message }) }
    }
  } catch (e) { await emit('cron.error', { task: 'pentest_weekly', error: (e as Error).message }) }
}

// R146.186 — Prune R182 session_sync rows older than 7 days.
let _sessionPruneLastEmit = 0
async function runSessionSyncPrune(): Promise<void> {
  try {
    const { db } = await import('../db/client.js')
    const { sessionSync } = await import('../db/schema.js')
    const { sql: drizzleSql } = await import('drizzle-orm')
    const cutoff = Date.now() - 7 * 86_400_000
    const r = await db.delete(sessionSync).where(drizzleSql`${sessionSync.lastPingAt} < ${cutoff}`)
    const pruned = (r as { rowCount?: number }).rowCount ?? 0
    const now = Date.now()
    if (pruned > 0 || now - _sessionPruneLastEmit >= 23 * 60 * 60_000) {
      await emit('cron.session_sync_prune', { pruned })
      _sessionPruneLastEmit = now
    }
  } catch (e) { await emit('cron.error', { task: 'session_sync_prune', error: (e as Error).message }) }
}

// R146.164 — Cart recovery: per-workspace sweep for ≥1h abandoned carts.
async function runCartRecovery(): Promise<void> {
  if (process.env['DISABLE_CART_RECOVERY'] === '1') return
  try {
    const ids = await listWorkspaceIds()
    const { cartRecoverDrafts } = await import('./r164-funnel-cro.js')
    let totalDrafted = 0
    for (const ws of ids) {
      try {
        const r = await cartRecoverDrafts(ws)
        totalDrafted += r.drafted
      } catch (e) { await emit('cron.error', { task: 'cart_recovery', workspace: ws, error: (e as Error).message }) }
    }
    if (totalDrafted > 0) await emit('cron.cart_recovery', { workspaces: ids.length, drafted: totalDrafted })
  } catch (e) { await emit('cron.error', { task: 'cart_recovery', error: (e as Error).message }) }
}

// R146.162 — Audience maintenance: segment refresh + win-back drafting.
let _lastWinBackDay = -1
async function runAudienceMaint(): Promise<void> {
  if (process.env['DISABLE_AUDIENCE_MAINT'] === '1') return
  try {
    const ids = await listWorkspaceIds()
    const { segmentSync, winBackTick } = await import('./r162-owned-audience.js')
    const now = new Date()
    const today = Math.floor(now.getTime() / (24 * 60 * 60_000))
    const winBackHour = now.getUTCHours() === 8 && _lastWinBackDay !== today
    if (winBackHour) _lastWinBackDay = today
    for (const ws of ids) {
      try {
        await segmentSync(ws)
        if (winBackHour) await winBackTick(ws).catch(() => null)
      } catch (e) { await emit('cron.error', { task: 'audience_maint', workspace: ws, error: (e as Error).message }) }
    }
  } catch (e) { await emit('cron.error', { task: 'audience_maint', error: (e as Error).message }) }
}

// R146.161 — Self-improve once per UTC day at 06:00. Rolls up themes
// into PAI lessons so future content generation knows what the audience
// loves/dislikes/requests.
let _lastSocialImproveDay = -1
async function runSocialCommentImprove(): Promise<void> {
  if (process.env['DISABLE_SOCIAL_COMMENTS'] === '1') return
  const now = new Date()
  if (now.getUTCHours() !== 6) return
  const today = Math.floor(now.getTime() / (24 * 60 * 60_000))
  if (_lastSocialImproveDay === today) return
  _lastSocialImproveDay = today
  try {
    const ids = await listWorkspaceIds()
    const { commentsSelfImprove } = await import('./r161-social-comments.js')
    let totalLessons = 0
    for (const ws of ids) {
      try {
        const r = await commentsSelfImprove(ws)
        totalLessons += r.lessonsMinted
      } catch (e) { await emit('cron.error', { task: 'social_comment_improve', workspace: ws, error: (e as Error).message }) }
    }
    await emit('cron.social_comment_improve', { workspaces: ids.length, lessons: totalLessons })
  } catch (e) { await emit('cron.error', { task: 'social_comment_improve', error: (e as Error).message }) }
}

// R146.130 — Morning push briefing. Fires hourly but only sends if current
// UTC hour matches BRIEFING_HOUR (default 7) and not already sent today.
let lastBriefingDay = -1
async function runMorningBriefing(): Promise<void> {
  if (process.env['DISABLE_MORNING_BRIEFING'] === '1') return
  const targetHour = parseInt(process.env['BRIEFING_HOUR_UTC'] ?? '7', 10)
  const now = new Date()
  if (now.getUTCHours() !== targetHour) return
  const today = Math.floor(now.getTime() / (24 * 60 * 60_000))
  if (lastBriefingDay === today) return
  lastBriefingDay = today
  try {
    const { sendMorningBriefing } = await import('./r130-tier2.js')
    const out = await sendMorningBriefing('system')
    await emit('cron.morning_briefing', out)
  } catch (e) { await emit('cron.error', { task: 'morning_briefing', error: (e as Error).message }) }
}

// R146.128 — Nightly database backup. Fires once per 24h; the runBackup
// op itself is the kill-switch (returns "not configured" if env unset).
async function runNightlyBackup(): Promise<void> {
  if (process.env['DISABLE_NIGHTLY_BACKUP'] === '1') return
  try {
    const { runBackup } = await import('./r128-safety.js')
    const out = await runBackup()
    await emit('cron.nightly_backup', { status: out.status, sizeBytes: out.sizeBytes ?? 0 })
  } catch (e) { await emit('cron.error', { task: 'nightly_backup', error: (e as Error).message }) }
}

// R146.124 — Pre-refresh OAuth tokens that are within 30 min of expiry.
async function runOauthRefresh(): Promise<void> {
  if (process.env['DISABLE_OAUTH_REFRESH'] === '1') return
  try {
    const { oauthRefreshTick } = await import('./r124-autonomy.js')
    const out = await oauthRefreshTick()
    if (out.refreshed > 0) await emit('cron.oauth_refresh', out)
  } catch (e) { await emit('cron.error', { task: 'oauth_refresh', error: (e as Error).message }) }
}

// R146.124 — Producer for improvement_suggestions: scan recent error
// events and bucket recurring ones for Ali's queue.
async function runSuggestionsProducer(): Promise<void> {
  if (process.env['DISABLE_SUGGESTIONS_PRODUCER'] === '1') return
  try {
    const { suggestionsProducerTick } = await import('./r124-autonomy.js')
    const out = await suggestionsProducerTick('system')
    if (out.created > 0) await emit('cron.suggestions_producer', out)
  } catch (e) { await emit('cron.error', { task: 'suggestions_producer', error: (e as Error).message }) }
}

// R146.117 — Agent dispatch tick: findings → ops_board → agent_roster status.
async function runAgentDispatch(): Promise<void> {
  if (process.env['DISABLE_AGENT_DISPATCH'] === '1') return
  try {
    const { findingsBridgeTick } = await import('./r117-wiring-fixes.js')
    const out = await findingsBridgeTick('system')
    if (out.bridged + out.improvedBridged + out.dispatched > 0) {
      await emit('cron.agent_dispatch', out)
    }
  } catch (e) { await emit('cron.error', { task: 'agent_dispatch', error: (e as Error).message }) }
}

// R146.115 — Shortform cron: poll YT channels, clip new videos.
// R146.116 — also runs the auto-poster for approved pipelines.
async function runShortformCron(): Promise<void> {
  if (process.env['DISABLE_SHORTFORM'] === '1') return
  try {
    const { shortformCronTick } = await import('./r115-build-batch.js')
    const out = await shortformCronTick('system')
    if (out.newClips > 0 || out.pipelinesChecked > 0) await emit('cron.shortform_tick', out)
    // After clipping, post anything that's approved
    try {
      const { shortformPosterTick } = await import('./r116-gap-fixes.js')
      const post = await shortformPosterTick('system', 10)
      if (post.scanned > 0) await emit('cron.shortform_poster_tick', post)
    } catch (e) { await emit('cron.error', { task: 'shortform_poster', error: (e as Error).message }) }
  } catch (e) { await emit('cron.error', { task: 'shortform', error: (e as Error).message }) }
}

// R146.114 — Second Brain cron tick. Single 5-min tick that fires the right
// job (ingest / review / audit) when the configured hour matches the current
// hour AND we haven't already run it this hour. Falls back silently if the
// table isn't migrated yet.
const _sbLastRun: Record<string, number> = {}  // key=workspace|kind → epoch hour
async function runSecondBrainCron(): Promise<void> {
  if (process.env['DISABLE_SECOND_BRAIN'] === '1') return
  try {
    const { getConfig, dailyIngest, dailyReview, weeklyAudit } = await import('./second-brain.js')
    const cfg = await getConfig('system')
    if (!cfg.enabled) return
    const now = new Date()
    const hour = now.getHours()
    const dow = now.getDay()
    const epochHour = Math.floor(Date.now() / 3600_000)
    const ws = 'system'
    const fire = async (kind: string, fn: () => Promise<unknown>) => {
      const key = `${ws}|${kind}`
      if (_sbLastRun[key] === epochHour) return
      _sbLastRun[key] = epochHour
      const r = await fn()
      await emit('cron.second_brain_' + kind.replace(/-/g, '_'), r as Record<string, unknown>)
    }
    if (hour === cfg.dailyIngestHour) await fire('daily-ingest', () => dailyIngest(ws))
    if (hour === cfg.dailyReviewHour) await fire('daily-review', () => dailyReview(ws))
    if (hour === cfg.weeklyAuditHour && dow === cfg.weeklyAuditDay) await fire('weekly-audit', () => weeklyAudit(ws))
  } catch (e) { await emit('cron.error', { task: 'second_brain', error: (e as Error).message }) }
}

// R146.108 — Frontier consumers: embedding backfill, dedup, write specs to
// disk, empirical scoring. Closes the loop on prototype_requested +
// advancement_proposed events emitted by R146.105/107.
async function runFrontierConsumerTick(): Promise<void> {
  if (process.env['DISABLE_FRONTIER_INTEL'] === '1') return
  try {
    const { consumerTick } = await import('./frontier-consumers.js')
    const out = await consumerTick('system')
    if (out.embed.embedded > 0 || out.dedup.merged > 0 || out.proto.written > 0 || out.advance.written > 0 || out.bench.scored > 0 || !out.budget.allowed) {
      await emit('cron.frontier_consumer_tick', out)
    }
  } catch (e) { await emit('cron.error', { task: 'frontier_consumer', error: (e as Error).message }) }
}

// R146.107 — Frontier MAX tick: capability catalog + permanent advancement.
// Self-throttles based on per-workspace settings.scanIntervalMs so it only
// does real work when due; runs cheap no-op queries otherwise.
let _lastFrontierMaxRunMs = 0
let _maxBootstrapped = false
async function runFrontierMaxTick(): Promise<void> {
  if (process.env['DISABLE_FRONTIER_INTEL'] === '1') return
  try {
    const mod = await import('./frontier-max.js')
    // Auto-enable MAX mode on first boot (the operator-stated default).
    // Skip via FRONTIER_MAX_DEFAULT=0 to keep defaults.
    if (!_maxBootstrapped) {
      _maxBootstrapped = true
      if (process.env['FRONTIER_MAX_DEFAULT'] !== '0') {
        await mod.setMaxMode('system', true).catch(() => null)
      }
    }
    const { getSettings, frontierMaxTick } = mod
    const settings = await getSettings('system')
    if (Date.now() - _lastFrontierMaxRunMs < settings.scanIntervalMs) return
    _lastFrontierMaxRunMs = Date.now()
    const out = await frontierMaxTick('system')
    if (out.scan.inserted > 0 || out.distill.distilled > 0 || out.catalog.added > 0 || out.advance.proposed > 0) {
      await emit('cron.frontier_max_tick', {
        maxMode: settings.maxMode,
        scan: out.scan, distill: out.distill, prototype: out.prototype,
        catalog: out.catalog, advance: out.advance,
      })
    }
  } catch (e) { await emit('cron.error', { task: 'frontier_max', error: (e as Error).message }) }
}

async function runCartographerSnapshot(): Promise<void> {
  try {
    const { generateSnapshot } = await import('./codebase-cartographer.js')
    const { db: _db } = await import('../db/client.js')
    const { cartographerSnapshots } = await import('../db/schema.js')
    const { v7: uuidv7 } = await import('uuid')
    const snap = await generateSnapshot()
    // Persist as a 'system' workspace snapshot — UI reads the most recent
    // row to render the cartographer panel without re-scanning.
    await _db.insert(cartographerSnapshots).values({
      id:           uuidv7(),
      workspaceId:  'system',
      rootPath:     snap.rootPath,
      fileCount:    snap.fileCount,
      snapshot:     snap as unknown as Record<string, unknown>,
      generatedAt:  snap.generatedAt,
    }).catch((e: Error) => { console.error('[learning-cron]', e.message); return null })
    await emit('cron.cartographer_snapshot', { fileCount: snap.fileCount })
  } catch (e) { await emit('cron.error', { task: 'cartographer_snapshot', error: (e as Error).message }) }
}

export function startLearningCron(): void {
  if (process.env['DISABLE_LEARNING_CRON'] === '1') return
  if (handles.length > 0) return  // already started

  handles.push(scheduleJittered(runIncidentScans,    INTERVALS.incident))
  handles.push(scheduleJittered(runIssueAutoIngest,  INTERVALS.issueIngest))
  handles.push(scheduleJittered(runIssueAutoLoop,    INTERVALS.issueAutoLoop))
  handles.push(scheduleJittered(runImprovementScans, INTERVALS.improvement))
  handles.push(scheduleJittered(runSuspiciousScans,  INTERVALS.suspicious))
  handles.push(scheduleJittered(runOrchestratorSweep,INTERVALS.orchestrator))
  handles.push(scheduleJittered(runSecurityTeamScans,INTERVALS.securityTeam))
  handles.push(scheduleJittered(runBillingSweep,     INTERVALS.billing))
  handles.push(scheduleJittered(runFeedIngestion,    INTERVALS.feeds))
  handles.push(scheduleJittered(runStretchCachePurge,INTERVALS.stretchPurge))
  handles.push(scheduleJittered(runEventsPrune,       INTERVALS.eventsPrune))
  // R146.98 — wire the new strategic ops as crons so they actually fire.
  handles.push(scheduleJittered(runStrategicCeoCycle,  INTERVALS.strategicCeo))
  handles.push(scheduleJittered(runLessonDeprecation,  INTERVALS.lessonDeprecation))
  handles.push(scheduleJittered(runStageTransitionScan, INTERVALS.stageTransitionScan))
  handles.push(scheduleJittered(runStuckLoopScan,       INTERVALS.stuckLoopScan))
  handles.push(scheduleJittered(runResearchScans,    INTERVALS.research))
  handles.push(scheduleJittered(runDailyReviews,     INTERVALS.dailyReview))
  handles.push(scheduleJittered(runResearchToAction, INTERVALS.researchToAction))
  handles.push(scheduleJittered(runStabilityScan,    INTERVALS.stabilityScan))
  handles.push(scheduleJittered(runWeeklyExecutiveBriefings, INTERVALS.weeklyBriefing))
  handles.push(scheduleJittered(runCrossDivisionScan,        INTERVALS.crossDivision))
  handles.push(scheduleJittered(runExecutiveHourly,          INTERVALS.execHourly))
  handles.push(scheduleJittered(runExecutiveSixHourly,       INTERVALS.execSixHourly))
  handles.push(scheduleJittered(runDailyCompressionAndPatterns, INTERVALS.dailyCompression))
  handles.push(scheduleJittered(runRealityVerification,         INTERVALS.realityVerify))
  handles.push(scheduleJittered(runEconomicLearning,            INTERVALS.economicLearning))
  handles.push(scheduleJittered(runHorizonReviewSweep,          INTERVALS.horizonReview))
  handles.push(scheduleJittered(runAutonomousMind,              INTERVALS.autonomousMind))
  handles.push(scheduleJittered(runCeoCycleCron,                INTERVALS.ceoCycle))
  handles.push(scheduleJittered(runBrainBroadcastCron,          INTERVALS.brainBroadcast))
  handles.push(scheduleJittered(runScheduledProductionTick,     INTERVALS.scheduledProduction))
  handles.push(scheduleJittered(runTwinSnapshot,                INTERVALS.twinSnapshot))
  handles.push(scheduleJittered(runEvolutionDiscover,           INTERVALS.evolutionDiscover))
  handles.push(scheduleJittered(runDailyRecap,                  INTERVALS.recapDaily))
  handles.push(scheduleJittered(runRiskScan,                    INTERVALS.riskScan))
  handles.push(scheduleJittered(runEconomicHealth,              INTERVALS.economicHealth))
  handles.push(scheduleJittered(runEmergentPatterns,            INTERVALS.emergentPatterns))
  handles.push(scheduleJittered(runExecutionPhysics,            INTERVALS.executionPhysics))
  handles.push(scheduleJittered(runPortfolioReview,             INTERVALS.portfolioReview))
  handles.push(scheduleJittered(runPromptEvolutionTick,         INTERVALS.promptEvolution))
  handles.push(scheduleJittered(runOpenJarvisMonitorsCron,      INTERVALS.openjarvisMonitors))
  handles.push(scheduleJittered(runMetaLearning,                INTERVALS.metaLearning))
  handles.push(scheduleJittered(runWatchdog,                    INTERVALS.watchdog))
  handles.push(scheduleJittered(runGitStateCapture,             INTERVALS.gitState))
  handles.push(scheduleJittered(runEmbeddingsBackfill,          INTERVALS.embeddingsBackfill))
  handles.push(scheduleJittered(runCommitLearning,              INTERVALS.commitLearning))
  handles.push(scheduleJittered(runCapabilityAutoRegister,      INTERVALS.capabilityAutoReg))
  handles.push(scheduleJittered(runTrustAutoDerive,             INTERVALS.trustAutoDerive))
  handles.push(scheduleJittered(runFabricSweep,                 INTERVALS.fabricSweep))
  handles.push(scheduleJittered(runDataRetention,               INTERVALS.dataRetention))
  handles.push(scheduleJittered(runCronHealthAlerts,            INTERVALS.cronHealthAlerts))
  handles.push(scheduleJittered(runVoiceDryRunSweep,            INTERVALS.voiceDryRunSweep))
  handles.push(scheduleJittered(runSelfHealScan,                INTERVALS.selfHealScan))
  handles.push(scheduleJittered(runAnomalyScan,                 INTERVALS.anomalyScan))
  handles.push(scheduleJittered(runChaosDrill,                  INTERVALS.chaosDrill))
  handles.push(scheduleJittered(runFailoverProbe,               INTERVALS.failoverProbe))
  handles.push(scheduleJittered(runPlatformSmokeAll,            INTERVALS.platformSmoke))
  handles.push(scheduleJittered(runMemoryDecaySweep,            INTERVALS.memoryDecay))
  handles.push(scheduleJittered(runKnowledgeCurate,             INTERVALS.knowledgeCurate))
  handles.push(scheduleJittered(runCartographerSnapshot,        INTERVALS.cartographerSnapshot))
  handles.push(scheduleJittered(runEvalDriftCheck,              INTERVALS.evalDriftCheck))
  handles.push(scheduleJittered(runEvalProductionSample,        INTERVALS.evalProductionSample))
  handles.push(scheduleJittered(runCuratorPeriodicReview,       INTERVALS.curatorPeriodicReview))
  handles.push(scheduleJittered(runSelfImprovementHealthCheck,  INTERVALS.selfImprovementHealthCheck))
  handles.push(scheduleJittered(runComplianceEvidence,          INTERVALS.complianceEvidence))
  handles.push(scheduleJittered(runCveScan,                     INTERVALS.cveScan))
  handles.push(scheduleJittered(runAccessReviewCheck,           INTERVALS.accessReviewCheck))
  handles.push(scheduleJittered(runAiDrift,                     INTERVALS.aiDriftSample))
  handles.push(scheduleJittered(runLockIntegrity,               INTERVALS.lockIntegrityCheck))
  handles.push(scheduleJittered(runMediaVideoWorkerTick,        INTERVALS.mediaVideoWorker))
  handles.push(scheduleJittered(runRecoveryExecutorTick,        INTERVALS.recoveryExecutor))
  handles.push(scheduleJittered(runSecretsRotationDrainTick,    INTERVALS.secretsRotationDrain))
  handles.push(scheduleJittered(runFrontierIntelTick,           INTERVALS.frontierIntel))
  handles.push(scheduleJittered(runFrontierMaxTick,             INTERVALS.frontierMax))
  handles.push(scheduleJittered(runFrontierConsumerTick,        INTERVALS.frontierConsumer))
  handles.push(scheduleJittered(runSecondBrainCron,             INTERVALS.secondBrainCron))
  handles.push(scheduleJittered(runShortformCron,               INTERVALS.shortformCron))
  handles.push(scheduleJittered(runAgentDispatch,               INTERVALS.agentDispatch))
  handles.push(scheduleJittered(runOauthRefresh,                INTERVALS.oauthRefresh))
  handles.push(scheduleJittered(runSuggestionsProducer,         INTERVALS.suggestionsProducer))
  handles.push(scheduleJittered(runNightlyBackup,               INTERVALS.nightlyBackup))
  handles.push(scheduleJittered(runMorningBriefing,             INTERVALS.morningBriefing))
  handles.push(scheduleJittered(runPkmMaintenance,              INTERVALS.pkmMaintenance))
  handles.push(scheduleJittered(runSocialCommentHarvest,        INTERVALS.socialCommentHarvest))
  handles.push(scheduleJittered(runSocialCommentImprove,        INTERVALS.socialCommentImprove))
  handles.push(scheduleJittered(runAudienceMaint,               INTERVALS.audienceMaint))
  handles.push(scheduleJittered(runCartRecovery,                INTERVALS.cartRecovery))
  handles.push(scheduleJittered(runLoopClosure,                 INTERVALS.loopClosure))
  handles.push(scheduleJittered(runProactiveScan,               INTERVALS.proactiveScan))
  handles.push(scheduleJittered(runRadarScan,                   INTERVALS.radarScan))
  handles.push(scheduleJittered(runMoneyDailyOptimize,          INTERVALS.moneyDailyOptimize))
  handles.push(scheduleJittered(runPentestWeekly,               INTERVALS.pentestWeekly))
  handles.push(scheduleJittered(runSessionSyncPrune,            INTERVALS.sessionSyncPrune))

  // Don't keep the event loop alive just for cron
  for (const h of handles) h.unref?.()

  void emit('cron.started', { intervals: INTERVALS })
}

export function stopLearningCron(): void {
  for (const h of handles) {
    // Each handle is a setTimeout wrapper with __getCurrent() returning
    // the currently-armed timer. clearTimeout works on both setInterval
    // and setTimeout handles in Node, so we cover both paths.
    const getter = (h as { __getCurrent?: () => NodeJS.Timeout | null }).__getCurrent
    if (getter) {
      const cur = getter()
      if (cur) clearTimeout(cur)
    }
    clearTimeout(h)
    clearInterval(h)
  }
  handles.length = 0
  // R146.15 — DO NOT zero _running synchronously. The map tracks which
  // ticks are currently mid-flight; in-flight ticks will set their tag
  // back to false when they finish. Caller (`drainLearningCron`) polls
  // it to know when it's safe to close the DB pool.
}

/** R146.15 — wait for in-flight ticks to drain before letting the
 *  process exit. Without this, shutdown clears timers but lets running
 *  ticks keep writing against `app.close()`'d resources and ultimately
 *  get terminated mid-`for (const ws of ids)` by `process.exit(0)`,
 *  with silent half-applied state. Polls `_running` until empty or
 *  `timeoutMs` elapses, then returns regardless so a stuck tick can't
 *  hang shutdown indefinitely. */
export async function drainLearningCron(timeoutMs = 5_000): Promise<{ drained: boolean; remaining: string[] }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const stillRunning = [..._running.entries()].filter(([, v]) => v).map(([k]) => k)
    if (stillRunning.length === 0) { _running.clear(); return { drained: true, remaining: [] } }
    await new Promise(r => setTimeout(r, 100))
  }
  const remaining = [..._running.entries()].filter(([, v]) => v).map(([k]) => k)
  _running.clear()
  return { drained: false, remaining }
}

/** Number of active cron handles — used by runtime-heartbeat to detect drift. */
export function learningCronHandleCount(): number {
  return handles.length
}

/** Trigger a one-shot run of the meta-loop on boot, so the platform begins
 *  thinking immediately rather than waiting for the first interval tick. */
export async function bootKick(): Promise<void> {
  // Fire each long-interval task once on boot so cold start isn't silent.
  // Previously only 3 of 50 crons were kicked — daily/weekly jobs waited
  // their full interval after boot (up to 24h of silence).
  // Idempotency is enforced inside each runner (daily-recap/etc. check
  // for prior emission within window) so re-kicking is safe.
  void runAutonomousMind()
  void runMetaLearning()
  void runHorizonReviewSweep()
  // Daily-cadence jobs — kick on boot so a freshly-restarted pod doesn't
  // wait up to 24h before producing its first recap/health/patterns.
  void runDailyRecap()
  void runEconomicHealth()
  void runEmergentPatterns()
  void runExecutionPhysics()
  void runDailyReviews()
  void runDailyCompressionAndPatterns()
  void runWeeklyExecutiveBriefings()
}
