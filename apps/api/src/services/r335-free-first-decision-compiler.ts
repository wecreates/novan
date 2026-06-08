/**
 * R146.335 — Free-First Decision Compiler (closes reasoning.strategy_selection
 *                                          4→8, R333 strategy.free_first_compiler)
 *
 * R332 demonstrated this pattern five times manually:
 *   "free first, then cheap (<$10), then escalate"
 *   path A vs B vs C with cost projections
 *
 * This module codifies it. Any op that has multiple paths to satisfy a
 * requirement passes the paths through `decide()`, which scores each
 * against operator constraints (persisted as workspace_memory.constraints.*)
 * and returns the recommended path with rationale.
 *
 * Output is a structured DecisionRecord — auditable, replayable, and fed
 * to prompt-evolution to learn from outcomes over time.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { v7 as uuidv7 } from 'uuid'

export interface DecisionPath {
  id:            string                 // 'replicate_topup', 'public_domain_pivot', etc.
  description:   string
  costUsd:       number                 // 0 for free
  timeMinutes:   number                  // time to ready
  qualityScore:  number                  // 0-1 (1 = production-ready)
  blockers:      string[]                // what would need to be true to use this
  recurring:     boolean                 // does this become a monthly/recurring cost?
  privacyRisk:   'none' | 'low' | 'medium' | 'high'
}

export interface OperatorConstraints {
  freeFirstThresholdUsd?: number         // default 10 — below this is "cheap"
  privacyCeiling?:        'none' | 'low' | 'medium'  // refuse paths above this
  qualityFloor?:          number          // refuse paths below (default 0.7)
  excludeRecurring?:      boolean         // refuse monthly costs in phase 1
  phaseTriggerMrr?:       number          // current MRR; unlocks higher tiers
}

export interface DecisionRecord {
  id:              string
  question:        string
  paths:           DecisionPath[]
  scored:          Array<{ path: DecisionPath; score: number; reasons: string[] }>
  recommended:     DecisionPath
  rationale:       string
  decidedAt:       number
  constraintsUsed: OperatorConstraints
}

// ─── Constraint loader ──────────────────────────────────────────────────────

export async function loadConstraints(workspaceId: string): Promise<OperatorConstraints> {
  try {
    const rows = await db.execute(sql`
      SELECT key, value FROM workspace_memory
      WHERE workspace_id = ${workspaceId}
        AND (key LIKE 'constraint.%' OR key = 'strategy.return_address_path' OR key LIKE 'strategy.%')
    `) as unknown as Array<{ key: string; value: string }>

    const c: OperatorConstraints = {
      freeFirstThresholdUsd: 10,
      privacyCeiling:        'low',
      qualityFloor:          0.7,
      excludeRecurring:      true,
      phaseTriggerMrr:       0,
    }
    for (const row of rows) {
      if (row.key === 'constraint.free_first_threshold_usd') c.freeFirstThresholdUsd = Number(row.value)
      if (row.key === 'constraint.privacy_ceiling') c.privacyCeiling = row.value as 'none' | 'low' | 'medium'
      if (row.key === 'constraint.quality_floor') c.qualityFloor = Number(row.value)
      if (row.key === 'constraint.exclude_recurring') c.excludeRecurring = row.value === 'true'
      if (row.key === 'business.current_mrr_usd') c.phaseTriggerMrr = Number(row.value)
    }
    return c
  } catch {
    return { freeFirstThresholdUsd: 10, privacyCeiling: 'low', qualityFloor: 0.7, excludeRecurring: true, phaseTriggerMrr: 0 }
  }
}

// ─── Scoring ────────────────────────────────────────────────────────────────

function scorePath(path: DecisionPath, c: OperatorConstraints): { score: number; reasons: string[] } {
  const reasons: string[] = []
  let score = 100

  // Free-first heavily preferred
  if (path.costUsd === 0) { score += 30; reasons.push('+30 free') }
  else if (path.costUsd <= (c.freeFirstThresholdUsd ?? 10)) { score += 10; reasons.push(`+10 cheap (≤$${c.freeFirstThresholdUsd ?? 10})`) }
  else { score -= path.costUsd; reasons.push(`-${path.costUsd} cost`) }

  // Quality floor
  if ((path.qualityScore ?? 0) < (c.qualityFloor ?? 0.7)) {
    score -= 50; reasons.push(`-50 quality below floor`)
  } else {
    score += Math.round((path.qualityScore - (c.qualityFloor ?? 0.7)) * 20)
    reasons.push(`+${Math.round((path.qualityScore - (c.qualityFloor ?? 0.7)) * 20)} quality margin`)
  }

  // Speed preference
  if (path.timeMinutes <= 5) { score += 15; reasons.push('+15 fast (≤5min)') }
  else if (path.timeMinutes >= 60) { score -= Math.min(30, Math.round(path.timeMinutes / 60) * 5); reasons.push(`-time ${path.timeMinutes}min`) }

  // Recurring cost penalty in phase 1
  if (path.recurring && c.excludeRecurring && (c.phaseTriggerMrr ?? 0) < 200) {
    score -= 40; reasons.push('-40 recurring cost, MRR not at phase 2')
  }

  // Privacy ceiling enforcement (hard)
  const privacyRank = { none: 0, low: 1, medium: 2, high: 3 }
  if (privacyRank[path.privacyRisk] > privacyRank[c.privacyCeiling ?? 'low']) {
    score = -1000; reasons.push('blocked by privacy ceiling')
  }

  // Blockers (hard)
  if (path.blockers.length > 0) {
    score -= 25 * path.blockers.length
    reasons.push(`-${25 * path.blockers.length} blockers: ${path.blockers.join(', ')}`)
  }

  return { score, reasons }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function decide(input: {
  workspaceId: string
  question:    string
  paths:       DecisionPath[]
  persist?:    boolean
}): Promise<DecisionRecord> {
  const c = await loadConstraints(input.workspaceId)
  const scored = input.paths.map(p => ({ path: p, ...scorePath(p, c) }))
  scored.sort((a, b) => b.score - a.score)
  const winner = scored[0]
  if (!winner) {
    // Won't happen unless caller passed empty array; we synthesize an empty "no-path" record.
    return {
      id:              uuidv7(),
      question:        input.question,
      paths:           [],
      scored:          [],
      recommended:     { id: 'none', description: 'no paths provided', costUsd: 0, timeMinutes: 0, qualityScore: 0, blockers: ['caller_passed_no_paths'], recurring: false, privacyRisk: 'none' },
      rationale:       'No paths provided to decide()',
      decidedAt:       Date.now(),
      constraintsUsed: c,
    }
  }
  const record: DecisionRecord = {
    id:              uuidv7(),
    question:        input.question,
    paths:           input.paths,
    scored,
    recommended:     winner.path,
    rationale:       `Top score ${winner.score}: ${winner.reasons.join('; ')}`,
    decidedAt:       Date.now(),
    constraintsUsed: c,
  }
  if (input.persist) {
    try {
      await db.execute(sql`
        INSERT INTO workspace_memory (workspace_id, key, value, scope, importance, updated_at)
        VALUES (
          ${input.workspaceId},
          ${`decision.${record.id}`},
          ${JSON.stringify({ question: record.question, recommended: record.recommended.id, rationale: record.rationale, decidedAt: record.decidedAt })},
          'decisions',
          70,
          ${record.decidedAt}
        )
        ON CONFLICT (workspace_id, key) DO NOTHING
      `)
    } catch { /* ignore */ }
  }
  return record
}

/**
 * Build the canonical "we're out of image-gen credit" decision tree.
 * Used by image router when all providers are dead.
 */
export function imageGenFallbackPaths(): DecisionPath[] {
  return [
    {
      id: 'public_domain_router',
      description: 'Pivot to public-domain art from Met/NYPL/Smithsonian/LoC',
      costUsd: 0, timeMinutes: 5, qualityScore: 0.95,
      blockers: [], recurring: false, privacyRisk: 'none',
    },
    {
      id: 'replicate_topup_5',
      description: 'Top up Replicate $5 → ~500 Flux Schnell generations',
      costUsd: 5, timeMinutes: 3, qualityScore: 0.75,
      blockers: ['operator_must_complete_billing'], recurring: false, privacyRisk: 'none',
    },
    {
      id: 'fal_key_regen',
      description: 'Generate fresh FAL key (free signup credit ~$0.50)',
      costUsd: 0, timeMinutes: 5, qualityScore: 0.75,
      blockers: ['operator_must_log_into_fal'], recurring: false, privacyRisk: 'none',
    },
    {
      id: 'gemini_cap_raise',
      description: 'Raise Gemini project spend cap to $5/mo',
      costUsd: 5, timeMinutes: 3, qualityScore: 0.85,
      blockers: ['operator_must_visit_ai_studio'], recurring: true, privacyRisk: 'none',
    },
    {
      id: 'midjourney_subscribe',
      description: 'Subscribe Midjourney $10/mo (premium quality, manual Discord ops)',
      costUsd: 10, timeMinutes: 5, qualityScore: 0.95,
      blockers: [], recurring: true, privacyRisk: 'none',
    },
  ]
}

/**
 * Canonical return-address-strategy decision.
 */
export function returnAddressPaths(): DecisionPath[] {
  return [
    {
      id: 'case_by_case_no_public_listing',
      description: 'Phase 1: no public return address, handle case-by-case via DMs',
      costUsd: 0, timeMinutes: 1, qualityScore: 0.7,
      blockers: [], recurring: false, privacyRisk: 'none',
    },
    {
      id: 'virtual_mailbox_stable',
      description: 'Stable virtual mailbox ~$10/mo, real street address',
      costUsd: 10, timeMinutes: 15, qualityScore: 0.95,
      blockers: [], recurring: true, privacyRisk: 'none',
    },
    {
      id: 'po_box_usps',
      description: 'USPS PO Box $5-15/mo, doesn\'t accept all carriers',
      costUsd: 8, timeMinutes: 60, qualityScore: 0.7,
      blockers: [], recurring: true, privacyRisk: 'none',
    },
    {
      id: 'home_address',
      description: 'Use home address (privacy hazard)',
      costUsd: 0, timeMinutes: 1, qualityScore: 0.9,
      blockers: [], recurring: false, privacyRisk: 'high',
    },
  ]
}
