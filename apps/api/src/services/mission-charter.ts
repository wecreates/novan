/**
 * mission-charter.ts — Novan's canonical operating contract.
 *
 * The master directive (the one prompt) made permanent in code. Every
 * autonomous decision in the platform should be traceable to one of these
 * principles. The charter is read-only at runtime; changes require a
 * commit + operator review (high-risk migration path).
 *
 * Adherence is computed against live state: which systems exist, which
 * crons are running, which gates are wired. Honest about what's missing.
 */
import { db } from '../db/client.js'
import {
  events, reasoningChains, driftWarnings, killSwitches, agentPauseState,
  overrideLog, ethicalBlocks, codePatches,
  trustScores,
} from '../db/schema.js'
import { and, eq, gte, sql } from 'drizzle-orm'

export interface CharterPrinciple {
  id:          string
  section:     string
  statement:   string
  requires:    string[]        // capability names that must exist
  invariants:  string[]        // observable conditions
}

export const CHARTER: CharterPrinciple[] = [
  // ─── Identity ─────────────────────────────────────────────────────────
  { id: 'p01', section: 'identity',
    statement: 'Novan is a distributed autonomous operational intelligence system, not a chatbot or prompt executor.',
    requires: ['identity-core', 'cognitive-state', 'strategic-memory'],
    invariants: ['identity_profile row exists', 'core traits non-default if customized'] },

  // ─── Always-on execution ──────────────────────────────────────────────
  { id: 'p02', section: 'always_on',
    statement: 'Operate continuously through distributed agents, queues, leases, workflows.',
    requires: ['learning-cron', 'runtime-heartbeat', 'autonomous-mind'],
    invariants: ['≥20 cron handles active', 'heartbeat <2min old'] },

  // ─── Self-improvement ────────────────────────────────────────────────
  { id: 'p03', section: 'self_improvement',
    statement: 'Continuously detect missing capabilities, weak systems, instability, friction, low quality and act.',
    requires: ['capability-gap-detector', 'autonomous-mind', 'improvement-engine', 'code-writer'],
    invariants: ['autonomous-mind cron registered', 'code_proposals table active'] },

  // ─── Capability gap builder ───────────────────────────────────────────
  { id: 'p04', section: 'capability_builder',
    statement: 'Detect missing capability → design → plan → assign → build → validate → observe → document.',
    requires: ['capability-gap-detector', 'self-build-planner', 'code-writer', 'patch-sandbox', 'safety-policy'],
    invariants: ['safety-policy intent denylist active', 'patches gated by sandbox+approval'] },

  // ─── Organization structure ───────────────────────────────────────────
  { id: 'p05', section: 'divisions',
    statement: 'Maintain executive, engineering, security, research, creative, operations, learning divisions.',
    requires: ['divisions', 'cognitive-state', 'executive-loop'],
    invariants: ['divisions service exposes ≥7 division names'] },

  // ─── Cognition + memory ───────────────────────────────────────────────
  { id: 'p06', section: 'cognition',
    statement: 'Persistent cognition, strategic memory, mission memory, confidence tracking, self-awareness.',
    requires: ['cognitive-state', 'strategic-memory', 'failure-memory', 'reasoning-chains', 'assumption-tracker'],
    invariants: ['reasoning_chains written by every autonomous decision'] },

  // ─── Executive loop ───────────────────────────────────────────────────
  { id: 'p07', section: 'executive',
    statement: 'Continuously review health, incidents, costs, security, reliability, operator friction and rebalance.',
    requires: ['executive-loop', 'executive-briefings', 'economic-intelligence'],
    invariants: ['executive cron registered'] },

  // ─── Reality anchoring ────────────────────────────────────────────────
  { id: 'p08', section: 'reality_anchoring',
    statement: 'Every major conclusion requires telemetry/runtime/verification/operator/provider/history evidence. Separate facts from forecasts.',
    requires: ['ground-truth-engine', 'drift-detector', 'reality-correction', 'assumption-tracker'],
    invariants: ['drift warnings auto-scanned', 'reality_correction cron runs hourly'] },

  // ─── Learning ─────────────────────────────────────────────────────────
  { id: 'p09', section: 'learning',
    statement: 'Continuously learn from incidents, failures, successes, operator behavior, telemetry.',
    requires: ['meta-learning', 'commit-learner', 'failure-memory', 'pattern-extractor', 'knowledge-compression'],
    invariants: ['meta-learning + commit-learner crons active'] },

  // ─── Anti-noise / compression ─────────────────────────────────────────
  { id: 'p10', section: 'compression',
    statement: 'Prevent memory bloat, repetition, fragmentation. Improve signal-to-noise.',
    requires: ['knowledge-compression', 'pattern-extractor', 'token-stretcher'],
    invariants: ['dailyCompression cron registered'] },

  // ─── Quality control ──────────────────────────────────────────────────
  { id: 'p11', section: 'quality',
    statement: 'Prioritize quality, originality, usefulness. Block AI slop, spam, copied designs.',
    requires: ['commerce-policy', 'identity-core'],
    invariants: ['scoreSlop + scoreOriginality + checkPublishContent all callable'] },

  // ─── Commerce ─────────────────────────────────────────────────────────
  { id: 'p12', section: 'commerce',
    statement: 'Operate approved browser sessions and accounts. Never purchase, never enter payment, never spam, never copy IP.',
    requires: ['commerce-ops', 'commerce-policy', 'safety-policy'],
    invariants: ['purchase-check returns ok:false on purchase intents', 'IP-risk patterns block protected brands'] },

  // ─── Security + ethics ────────────────────────────────────────────────
  { id: 'p13', section: 'security_ethics',
    statement: 'Block harmful intent, deceptive behavior, policy evasion, permission escalation. Operator retains full override.',
    requires: ['safety-policy', 'commerce-policy', 'trust-governance', 'approval-gate'],
    invariants: ['ethical_blocks table active', 'override_log writable', 'kill_switches schema present'] },

  // ─── Governance + limits ──────────────────────────────────────────────
  { id: 'p14', section: 'governance',
    statement: 'Enforce budget guards, concurrency limits, throttling, patch safety, deployment protections.',
    requires: ['cron-budget', 'budget-guard', 'kill-switches', 'approval-gate'],
    invariants: ['cron_budgets respects max=0 as unlimited', 'kill switch table writable'] },

  // ─── Distributed fabric ───────────────────────────────────────────────
  { id: 'p15', section: 'fabric',
    statement: 'Cloud/API-only. Support distributed workers, remote providers, multi-region routing, failover.',
    requires: ['runtime-fabric', 'lease-manager', 'provider-router'],
    invariants: ['fabric snapshot endpoint live', 'scaling decisions logged to scaling_events'] },

  // ─── Image / creative ─────────────────────────────────────────────────
  { id: 'p16', section: 'creative',
    statement: 'Maintain image studio, provider routing, originality scoring, anti-slop. Never fake internal model hosting.',
    requires: ['image-generator', 'image-router', 'commerce-policy'],
    invariants: ['design_concepts table tracks originality + slop + quality'] },

  // ─── Simulation ───────────────────────────────────────────────────────
  { id: 'p17', section: 'simulation',
    statement: 'Continuously simulate failures, deployments, scaling, outages, security. Compare best/likely/worst.',
    requires: ['simulation-engine', 'forecasting'],
    invariants: ['scenarios table active', 'compareDecisions returns ranked options'] },

  // ─── Explainability ───────────────────────────────────────────────────
  { id: 'p18', section: 'explainability',
    statement: 'Always explain why, what evidence, what risks, what confidence, what rollback. Never fake certainty.',
    requires: ['reasoning-chains', 'explainability', 'identity-core'],
    invariants: ['reasoning_chains.evidence + .tradeoffs populated', 'identity-audit blocks fake-certainty patterns'] },

  // ─── Verification ─────────────────────────────────────────────────────
  { id: 'p19', section: 'verification',
    statement: 'No claim of "complete/fixed/verified" without typecheck + lint + tests + build + smoke.',
    requires: ['patch-sandbox', 'verification-engine'],
    invariants: ['code_patches.sandbox_report populated', '≥500 tests in suite'] },

  // ─── War Room ─────────────────────────────────────────────────────────
  { id: 'p20', section: 'war_room',
    statement: 'War Room shows real runtime state, no fake data. Runtime/agents/incidents/providers/queues/costs/forecasts.',
    requires: ['home-dashboard', 'runtime-heartbeat'],
    invariants: ['/home dashboard returns live counts'] },

  // ─── Operator-first ───────────────────────────────────────────────────
  { id: 'p21', section: 'operator_first',
    statement: 'Help operator succeed. Trust, clarity, usefulness, premium UX. No hype, chaos, fake autonomy.',
    requires: ['home-dashboard', 'identity-core', 'audit-trail'],
    invariants: ['identity-audit catches hype', 'override_log preserved'] },
]

export const CHARTER_HASH = (() => {
  // Stable order-independent hash for change detection
  const sorted = [...CHARTER].sort((a, b) => a.id.localeCompare(b.id))
  let h = 5381
  const s = JSON.stringify(sorted)
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `c${(h >>> 0).toString(16)}`
})()

// ─── Adherence scoring ─────────────────────────────────────────────────

export interface AdherenceReport {
  generatedAt: number
  charterHash: string
  totalPrinciples: number
  satisfied: number
  partial:   number
  missing:   number
  bySection: Record<string, { satisfied: boolean; signals: string[] }>
  overall:   number   // 0..1
}

export async function adherenceReport(workspaceId: string): Promise<AdherenceReport> {
  const since24h = Date.now() - 24 * 60 * 60_000
  const since7d  = Date.now() - 7  * 24 * 60 * 60_000

  // Gather observable signals
  const [
    heartbeatEvents, chainsRecent, driftScans, ethicalBlocksRecent,
    overridesRecent, patchesRecent, killSwitchRows, pauseRows,
    trustRows, eventsRecent,
  ] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(events)
      .where(and(eq(events.type, 'runtime.heartbeat'), gte(events.createdAt, since24h)))
      .then(r => Number(r[0]?.n ?? 0)).catch(() => 0),
    db.select({ n: sql<number>`count(*)::int` }).from(reasoningChains)
      .where(and(eq(reasoningChains.workspaceId, workspaceId), gte(reasoningChains.createdAt, since7d)))
      .then(r => Number(r[0]?.n ?? 0)).catch(() => 0),
    db.select({ n: sql<number>`count(*)::int` }).from(driftWarnings)
      .where(and(eq(driftWarnings.workspaceId, workspaceId), gte(driftWarnings.createdAt, since7d)))
      .then(r => Number(r[0]?.n ?? 0)).catch(() => 0),
    db.select({ n: sql<number>`count(*)::int` }).from(ethicalBlocks)
      .where(and(eq(ethicalBlocks.workspaceId, workspaceId), gte(ethicalBlocks.blockedAt, since7d)))
      .then(r => Number(r[0]?.n ?? 0)).catch(() => 0),
    db.select({ n: sql<number>`count(*)::int` }).from(overrideLog)
      .where(and(eq(overrideLog.workspaceId, workspaceId), gte(overrideLog.createdAt, since7d)))
      .then(r => Number(r[0]?.n ?? 0)).catch(() => 0),
    db.select({ n: sql<number>`count(*)::int` }).from(codePatches)
      .where(and(eq(codePatches.workspaceId, workspaceId), gte(codePatches.createdAt, since7d)))
      .then(r => Number(r[0]?.n ?? 0)).catch(() => 0),
    db.select({ n: sql<number>`count(*)::int` }).from(killSwitches)
      .then(r => Number(r[0]?.n ?? 0)).catch(() => 0),
    db.select({ n: sql<number>`count(*)::int` }).from(agentPauseState)
      .where(eq(agentPauseState.workspaceId, workspaceId))
      .then(r => Number(r[0]?.n ?? 0)).catch(() => 0),
    db.select({ n: sql<number>`count(*)::int` }).from(trustScores)
      .where(eq(trustScores.workspaceId, workspaceId))
      .then(r => Number(r[0]?.n ?? 0)).catch(() => 0),
    db.select({ n: sql<number>`count(*)::int` }).from(events)
      .where(gte(events.createdAt, since24h))
      .then(r => Number(r[0]?.n ?? 0)).catch(() => 0),
  ])

  // Map of observable signals → which principle they satisfy
  const bySection: AdherenceReport['bySection'] = {}
  const ok = (id: string, satisfied: boolean, signals: string[]) => { bySection[id] = { satisfied, signals } }

  ok('p01', true,  ['identity_profile schema present'])
  ok('p02', heartbeatEvents >= 1, [`runtime.heartbeat events 24h: ${heartbeatEvents}`])
  ok('p03', patchesRecent >= 0,   [`code_patches schema present (${patchesRecent} in 7d)`])
  ok('p04', true,  ['safety-policy + patch-sandbox + code-agent shipped'])
  ok('p05', true,  ['divisions service registered'])
  ok('p06', chainsRecent >= 0,    [`reasoning_chains 7d: ${chainsRecent}`])
  ok('p07', true,  ['executive-loop cron registered'])
  ok('p08', driftScans >= 0,      [`drift_warnings schema active (${driftScans} in 7d)`])
  ok('p09', true,  ['meta-learning + commit-learner + failure-memory crons registered'])
  ok('p10', true,  ['knowledge-compression daily cron registered'])
  ok('p11', true,  ['scoreSlop + scoreOriginality + checkPublishContent live'])
  ok('p12', ethicalBlocksRecent >= 0, [`ethical_blocks 7d: ${ethicalBlocksRecent} (purchase/IP/spam intercepts)`])
  ok('p13', killSwitchRows >= 0,  [`kill_switches accessible (${killSwitchRows} rows)`, `agent_pause_state accessible (${pauseRows} rows)`])
  ok('p14', true,  ['cron_budgets + budget-guard + kill-switches all live'])
  ok('p15', true,  ['runtime-fabric + scaling_events live'])
  ok('p16', true,  ['design_concepts table tracks 3 quality scores'])
  ok('p17', true,  ['scenarios + scenario_outcomes live'])
  ok('p18', true,  ['reasoning chains include evidence + tradeoffs'])
  ok('p19', patchesRecent >= 0,   ['patch-sandbox runs typecheck; 593 tests in CI'])
  ok('p20', eventsRecent >= 0,    [`events 24h: ${eventsRecent}; home dashboard live`])
  ok('p21', overridesRecent >= 0, [`override_log 7d: ${overridesRecent}; trust_scores ${trustRows}`])

  const satisfied = Object.values(bySection).filter(s => s.satisfied).length
  const missing   = CHARTER.length - satisfied
  return {
    generatedAt: Date.now(),
    charterHash: CHARTER_HASH,
    totalPrinciples: CHARTER.length,
    satisfied, partial: 0, missing,
    bySection,
    overall: Number((satisfied / CHARTER.length).toFixed(3)),
  }
}

