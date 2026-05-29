/**
 * civilization-core.ts — the master loop tying together: wisdom layer,
 * executive recap, self-evolution, operator DNA, war-gaming, emergent
 * strategy, execution physics, and the world-model orchestration.
 *
 * Each subsystem is a focused function; the loop is intentionally
 * small so the brain can call individual pieces from chat or run the
 * full cycle on a cron.
 */

import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

// ─── Wisdom Layer ──────────────────────────────────────────────────────
// Asks: "should we even do this?" before optimization runs.
export interface WisdomVerdict {
  proceed: boolean
  caution: string[]
  reframe?: string
  meaningScore: number      // 0..1
}

export function wisdomCheck(input: {
  action: string
  expectedROI?: number
  riskLevel?: 'low' | 'medium' | 'high' | 'critical'
  reversible?: boolean
  affectedSystems?: number
}): WisdomVerdict {
  const caution: string[] = []
  let meaningScore = 0.6

  if ((input.expectedROI ?? 0) < 0)          { caution.push('negative ROI projected'); meaningScore -= 0.3 }
  if (input.riskLevel === 'critical')         { caution.push('critical-risk action'); meaningScore -= 0.4 }
  if (input.riskLevel === 'high')             { caution.push('high-risk action'); meaningScore -= 0.2 }
  if (input.reversible === false)             { caution.push('irreversible'); meaningScore -= 0.15 }
  if ((input.affectedSystems ?? 0) > 5)       { caution.push(`large blast radius (${input.affectedSystems} systems)`); meaningScore -= 0.15 }
  if (/optimize|automate|scale/i.test(input.action) && (input.expectedROI ?? 0) < 2) {
    caution.push('optimization with marginal ROI — wisdom favors restraint')
    meaningScore -= 0.1
  }

  const proceed = meaningScore >= 0.4 && !(input.riskLevel === 'critical' && input.reversible === false)
  const out: WisdomVerdict = { proceed, caution, meaningScore: Math.max(0, Math.min(1, meaningScore)) }
  if (!proceed) out.reframe = 'Consider: simpler manual approach, smaller scope, or do nothing.'
  return out
}

// ─── Operator DNA ──────────────────────────────────────────────────────
export interface OperatorPreference {
  workspaceId: string
  uiDensity:     'spacious' | 'balanced' | 'dense'
  riskTolerance: 'low' | 'medium' | 'high'
  communicationStyle: 'brief' | 'balanced' | 'detailed'
  workCadence:   'sprint' | 'sustained' | 'paced'
  designLanguage: 'minimal' | 'modern' | 'rich'
  preferredHours: number[]         // hours of day operator is active
  observedFromTurns: number
  updatedAt: number
}

let _dnaEnsured = false
async function ensureDna(): Promise<void> {
  if (_dnaEnsured) return
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS operator_dna (
      workspace_id TEXT PRIMARY KEY,
      ui_density TEXT NOT NULL DEFAULT 'balanced',
      risk_tolerance TEXT NOT NULL DEFAULT 'medium',
      communication_style TEXT NOT NULL DEFAULT 'balanced',
      work_cadence TEXT NOT NULL DEFAULT 'sustained',
      design_language TEXT NOT NULL DEFAULT 'modern',
      preferred_hours JSONB NOT NULL DEFAULT '[]'::jsonb,
      observed_from_turns INT NOT NULL DEFAULT 0,
      updated_at BIGINT NOT NULL
    )`)
  _dnaEnsured = true
}

export async function getOperatorDna(workspaceId: string): Promise<OperatorPreference> {
  await ensureDna()
  const rows = await db.execute(sql`SELECT * FROM operator_dna WHERE workspace_id = ${workspaceId}`)
  const r = (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows?.[0]
  if (!r) {
    const seed: OperatorPreference = {
      workspaceId, uiDensity: 'balanced', riskTolerance: 'medium',
      communicationStyle: 'balanced', workCadence: 'sustained',
      designLanguage: 'modern', preferredHours: [], observedFromTurns: 0,
      updatedAt: Date.now(),
    }
    await db.execute(sql`
      INSERT INTO operator_dna (workspace_id, updated_at)
      VALUES (${workspaceId}, ${seed.updatedAt}) ON CONFLICT DO NOTHING`)
    return seed
  }
  return {
    workspaceId,
    uiDensity: r['ui_density'] as OperatorPreference['uiDensity'],
    riskTolerance: r['risk_tolerance'] as OperatorPreference['riskTolerance'],
    communicationStyle: r['communication_style'] as OperatorPreference['communicationStyle'],
    workCadence: r['work_cadence'] as OperatorPreference['workCadence'],
    designLanguage: r['design_language'] as OperatorPreference['designLanguage'],
    preferredHours: r['preferred_hours'] as number[],
    observedFromTurns: Number(r['observed_from_turns']),
    updatedAt: Number(r['updated_at']),
  }
}

/** Update DNA from observed turn — call once per message exchange. */
export async function observeTurn(workspaceId: string, signals: {
  messageLength?: number
  userClarifiedRisk?: boolean
  hourOfDay?: number
  rejectedAutomation?: boolean
}): Promise<void> {
  await ensureDna()
  const dna = await getOperatorDna(workspaceId)
  // Determine derived values; only apply changed ones via individual
  // drizzle-parameterized statements so values are properly escaped.
  // (Previous sql.raw with positional $-params was broken — drizzle's
  // sql.raw doesn't bind external params.)
  let commStyle: string | null = null
  if (signals.messageLength !== undefined) {
    if (signals.messageLength < 80 && dna.observedFromTurns > 5) commStyle = 'brief'
    else if (signals.messageLength > 400) commStyle = 'detailed'
  }
  const riskTol = (signals.userClarifiedRisk || signals.rejectedAutomation) ? 'low' : null
  let prefHours: number[] | null = null
  if (signals.hourOfDay !== undefined) {
    const hrs = dna.preferredHours.slice()
    if (!hrs.includes(signals.hourOfDay)) hrs.push(signals.hourOfDay)
    prefHours = hrs.slice(-24)
  }
  const now = Date.now()
  if (commStyle) {
    await db.execute(sql`UPDATE operator_dna SET communication_style = ${commStyle} WHERE workspace_id = ${workspaceId}`)
  }
  if (riskTol) {
    await db.execute(sql`UPDATE operator_dna SET risk_tolerance = ${riskTol} WHERE workspace_id = ${workspaceId}`)
  }
  if (prefHours) {
    await db.execute(sql`UPDATE operator_dna SET preferred_hours = ${JSON.stringify(prefHours)}::jsonb WHERE workspace_id = ${workspaceId}`)
  }
  await db.execute(sql`UPDATE operator_dna SET observed_from_turns = observed_from_turns + 1, updated_at = ${now} WHERE workspace_id = ${workspaceId}`)
}

// ─── Execution Physics ─────────────────────────────────────────────────
export interface MomentumState {
  workspaceId: string
  velocity:        number     // ops completed per day, last 7d
  friction:        number     // 0..1; fraction of ops that failed/cancelled
  bottlenecks:     string[]
  leveragePoints:  string[]   // ops with high impact:cost ratio
  recommendation:  string
}

export async function execPhysics(workspaceId: string): Promise<MomentumState> {
  const { listEvents } = await import('./production-log.js')
  const events = await listEvents({ workspaceId, days: 7, limit: 500 })
  const completed = events.filter(e => e.status === 'completed').length
  const failed    = events.filter(e => e.status === 'failed').length
  const cancelled = events.filter(e => e.status === 'cancelled').length
  const total     = events.length || 1
  const velocity  = completed / 7
  const friction  = (failed + cancelled) / total

  // Bottlenecks: count failures by op family
  const failByKind: Record<string, number> = {}
  for (const e of events.filter(x => x.status === 'failed')) failByKind[e.kind] = (failByKind[e.kind] ?? 0) + 1
  const bottlenecks = Object.entries(failByKind).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k}×${n}`)

  // Leverage: kinds with highest completion ratio
  const compByKind: Record<string, { ok: number; total: number }> = {}
  for (const e of events) {
    const s = compByKind[e.kind] ?? { ok: 0, total: 0 }
    s.total++
    if (e.status === 'completed') s.ok++
    compByKind[e.kind] = s
  }
  const leveragePoints = Object.entries(compByKind)
    .filter(([, s]) => s.total > 3)
    .sort((a, b) => (b[1].ok / b[1].total) - (a[1].ok / a[1].total))
    .slice(0, 3)
    .map(([k, s]) => `${k} (${Math.round(s.ok / s.total * 100)}% success)`)

  let recommendation = ''
  if (velocity < 1)         recommendation = 'Velocity low. Identify single highest-leverage action and ship it.'
  else if (friction > 0.3)  recommendation = `Friction high (${(friction * 100).toFixed(0)}%). Fix bottlenecks: ${bottlenecks.join(', ')}.`
  else if (velocity > 10)   recommendation = 'Sustained high velocity. Watch for burnout; preserve cadence.'
  else                      recommendation = 'Healthy momentum. Compound by doubling down on leverage points.'

  return { workspaceId, velocity, friction, bottlenecks, leveragePoints, recommendation }
}

// ─── Self-Evolution Engine ─────────────────────────────────────────────
export interface EvolutionProposal {
  id:           string
  workspaceId:  string
  area:         'workflow' | 'connector' | 'governance' | 'infrastructure' | 'strategy'
  weakness:     string
  proposal:     string
  expectedGain: string
  risk:         'low' | 'medium' | 'high'
  reversible:   boolean
}

export async function discoverWeaknesses(workspaceId: string): Promise<EvolutionProposal[]> {
  const proposals: EvolutionProposal[] = []
  // 1. Broken trust subjects → propose replacement / disable
  try {
    const { listTopBroken } = await import('./trust-reputation.js')
    const broken = await listTopBroken(workspaceId, 5)
    for (const b of broken.filter(x => x.classification === 'broken')) {
      proposals.push({
        id: `evolve-trust-${b.subject}`, workspaceId, area: 'workflow',
        weakness: `${b.subject} has ${(b.score * 100).toFixed(0)}% trust (${b.failures}/${b.totalCalls} failed)`,
        proposal: `Disable ${b.subject} or replace with a higher-trust alternative.`,
        expectedGain: 'Removes a known-broken dependency from the critical path.',
        risk: 'low', reversible: true,
      })
    }
  } catch { /* */ }
  // 2. Idle channels with stale content
  try {
    const { listChannels } = await import('./channel-manager.js')
    const channels = await listChannels(workspaceId)
    for (const c of channels) {
      const sinceMs = c.createdAt
      if (Date.now() - sinceMs > 30 * 86_400_000) {
        proposals.push({
          id: `evolve-idle-${c.id}`, workspaceId, area: 'strategy',
          weakness: `Channel "${c.label}" has been configured for ${Math.floor((Date.now() - sinceMs) / 86_400_000)} days`,
          proposal: 'Either start a scheduled-production for this channel or archive it.',
          expectedGain: 'Removes dead weight or activates an asset.',
          risk: 'low', reversible: true,
        })
      }
    }
  } catch { /* */ }
  // 3. High-friction workflow areas
  try {
    const phys = await execPhysics(workspaceId)
    if (phys.friction > 0.25 && phys.bottlenecks.length > 0) {
      proposals.push({
        id: `evolve-friction-${Date.now()}`, workspaceId, area: 'infrastructure',
        weakness: `${(phys.friction * 100).toFixed(0)}% of recent ops failed in: ${phys.bottlenecks.join(', ')}`,
        proposal: 'Stabilize the bottleneck families before adding new automation.',
        expectedGain: 'Restores momentum; compounds throughput gains.',
        risk: 'low', reversible: true,
      })
    }
  } catch { /* */ }
  return proposals
}

// ─── War-Gaming / Strategic Simulation ─────────────────────────────────
export type ScenarioKind =
  | 'platform-ban' | 'api-rate-limit' | 'competitor-launch' | 'cost-spike'
  | 'viral-spike'  | 'team-loss'      | 'security-breach'   | 'infra-outage'

export interface SimulationResult {
  scenario: ScenarioKind
  survivable: boolean
  affectedSystems: string[]
  estimatedDowntimeHours: number
  mitigations: string[]
  preBuildRecommendations: string[]
}

export function simulateScenario(scenario: ScenarioKind, currentState: { channels: number; dependencies: string[]; reserveBudgetUsd?: number }): SimulationResult {
  const out: SimulationResult = {
    scenario, survivable: true, affectedSystems: [], estimatedDowntimeHours: 0,
    mitigations: [], preBuildRecommendations: [],
  }
  switch (scenario) {
    case 'platform-ban':
      out.affectedSystems = ['publishing', 'analytics', 'audience']
      out.estimatedDowntimeHours = 72
      out.survivable = currentState.channels >= 2
      out.mitigations = ['shift production to remaining platforms', 'open appeal', 'rebuild from email list']
      out.preBuildRecommendations = ['always run ≥2 channels', 'export email list weekly', 'backup audience to owned domain']
      break
    case 'api-rate-limit':
      out.affectedSystems = ['voiceover', 'transcription', 'AI b-roll']
      out.estimatedDowntimeHours = 24
      out.mitigations = ['rotate to fallback provider chain', 'cache aggressively', 'queue + retry']
      out.preBuildRecommendations = ['ensure 3+ provider chain per category', 'monitor rate-limit headroom']
      break
    case 'competitor-launch':
      out.affectedSystems = ['acquisition', 'positioning']
      out.estimatedDowntimeHours = 0
      out.mitigations = ['ship a counter-positioning post within 48h', 'highlight differentiator']
      out.preBuildRecommendations = ['maintain clear differentiator narrative', 'reserve a launch-week capacity']
      break
    case 'cost-spike':
      out.affectedSystems = ['margin', 'cash flow']
      out.estimatedDowntimeHours = 0
      out.survivable = (currentState.reserveBudgetUsd ?? 0) > 500
      out.mitigations = ['lower TTS budget cap', 'pause AI b-roll generation', 'shift to draft tier']
      out.preBuildRecommendations = ['set hard budget caps per provider', 'maintain ≥30d reserve']
      break
    case 'viral-spike':
      out.affectedSystems = ['cdn', 'comments queue', 'support']
      out.estimatedDowntimeHours = 6
      out.mitigations = ['cache static assets', 'auto-throttle comments', 'pre-write FAQ replies']
      out.preBuildRecommendations = ['load-test publishing pipeline', 'pre-author engagement templates']
      break
    case 'team-loss':
    case 'security-breach':
    case 'infra-outage':
    default:
      out.estimatedDowntimeHours = 12
      out.mitigations = ['follow incident runbook', 'rotate credentials', 'restore from backup']
      out.preBuildRecommendations = ['runbook current', 'backup tested monthly', 'auth + secrets rotation policy']
  }
  return out
}

// ─── Emergent Strategy ─────────────────────────────────────────────────
export interface EmergentPattern {
  pattern:     string
  evidence:    string[]
  leverage:    'low' | 'medium' | 'high'
  recommendation: string
}

export async function discoverPatterns(workspaceId: string): Promise<EmergentPattern[]> {
  const patterns: EmergentPattern[] = []
  // Pattern 1: Recurring winners share a theme
  try {
    const rows = await db.execute(sql`
      SELECT content FROM memories
      WHERE workspace_id = ${workspaceId}
        AND tags @> ARRAY['winner']
      ORDER BY confidence DESC LIMIT 10`)
    const winners = ((rows as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [])
      .map(r => String(r['content']))
    if (winners.length >= 3) {
      const briefs = winners.map(w => w.match(/brief:\s*"([^"]+)"/)?.[1]).filter((s): s is string => !!s)
      const tokens = briefs.flatMap(b => b.toLowerCase().split(/\s+/).filter(t => t.length > 4))
      const counts: Record<string, number> = {}
      for (const t of tokens) counts[t] = (counts[t] ?? 0) + 1
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).filter(([, n]) => n >= 2)
      if (top.length > 0) {
        patterns.push({
          pattern: `Recurring winning theme: ${top.map(([t]) => t).join(', ')}`,
          evidence: [`${winners.length} winners`, `keywords appear ${top[0]![1]}+ times`],
          leverage: 'high',
          recommendation: `Schedule a batch of 5 more pieces around: ${top.map(([t]) => t).join(', ')}.`,
        })
      }
    }
  } catch { /* */ }
  // Pattern 2: Underused but high-trust ops
  try {
    const { listTopBroken } = await import('./trust-reputation.js')
    const broken = await listTopBroken(workspaceId, 50)
    const highTrust = broken.filter(b => b.classification === 'high' && b.totalCalls > 10).slice(0, 3)
    if (highTrust.length > 0) {
      patterns.push({
        pattern: 'High-trust workflows are being underused',
        evidence: highTrust.map(b => `${b.subject}: ${b.totalCalls} calls, ${(b.score * 100).toFixed(0)}% trust`),
        leverage: 'medium',
        recommendation: 'Increase reliance on these proven paths in your next plan.',
      })
    }
  } catch { /* */ }
  // Pattern 3: Causal-chain bottlenecks from world-model — find nodes
  // that BLOCK or are DEPENDED-ON-BY many downstream nodes; failure here
  // has high blast radius.
  try {
    const { listNodes, causalChain } = await import('./world-model.js')
    const nodes = await listNodes(workspaceId)
    const highImpact = nodes.filter(n => n.importance >= 0.7).slice(0, 10)
    for (const n of highImpact) {
      const downstream = await causalChain(workspaceId, n.id, 'downstream', 3).catch(() => [])
      if (downstream.length >= 3 && n.health < 0.7) {
        patterns.push({
          pattern: `"${n.label}" is a fragile single point of failure`,
          evidence: [`health ${(n.health * 100).toFixed(0)}%`, `${downstream.length} downstream nodes affected if it fails`],
          leverage: 'high',
          recommendation: `Stabilize ${n.label} (or add redundancy) before scaling anything downstream.`,
        })
      }
    }
  } catch { /* */ }
  return patterns
}

// ─── Executive Recap ───────────────────────────────────────────────────
export interface ExecutiveRecap {
  workspaceId: string
  since:       number
  highlights:  string[]
  productions: { total: number; succeeded: number; failed: number }
  patterns:    EmergentPattern[]
  proposals:   EvolutionProposal[]
  alerts:      string[]
  nextMoves:   string[]
}

export async function generateRecap(workspaceId: string, sinceHoursAgo = 24): Promise<ExecutiveRecap> {
  const since = Date.now() - sinceHoursAgo * 3_600_000
  const { listEvents } = await import('./production-log.js')
  const events = await listEvents({ workspaceId, days: Math.ceil(sinceHoursAgo / 24), limit: 500 })
  const recent = events.filter(e => e.startedAt >= since)
  const succeeded = recent.filter(e => e.status === 'completed').length
  const failed    = recent.filter(e => e.status === 'failed').length

  const highlights: string[] = []
  if (recent.length > 0) highlights.push(`${recent.length} production events`)
  if (succeeded > 0)     highlights.push(`${succeeded} completed`)
  if (failed > 0)        highlights.push(`${failed} failed`)

  const patterns = await discoverPatterns(workspaceId).catch(() => [])
  const proposals = await discoverWeaknesses(workspaceId).catch(() => [])
  const phys = await execPhysics(workspaceId).catch((e: Error) => { console.error('[civilization-core]', e.message); return null })

  const alerts: string[] = []
  if (phys && phys.friction > 0.3) alerts.push(phys.recommendation)
  if (proposals.length > 5) alerts.push(`${proposals.length} weakness candidates discovered`)

  const nextMoves: string[] = []
  for (const p of patterns.filter(x => x.leverage === 'high').slice(0, 2)) nextMoves.push(p.recommendation)
  for (const pr of proposals.filter(x => x.risk === 'low' && x.reversible).slice(0, 2)) nextMoves.push(pr.proposal)

  return {
    workspaceId, since, highlights,
    productions: { total: recent.length, succeeded, failed },
    patterns, proposals, alerts, nextMoves,
  }
}
