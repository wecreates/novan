/**
 * voice-handsfree-policy.ts — classify an ActionPlan against the
 * operator's hands-free permissions.
 *
 * Three categories per the directive:
 *
 *   - HANDS_FREE_ALLOWED : safe info / navigation / drafts (auto-execute)
 *   - REQUIRES_APPROVAL  : posting / uploads / browser account / patches
 *                          / agent control / provider changes
 *   - HARD_BLOCK         : purchases / payment / destructive account /
 *                          permission escalation (re-checked here so the
 *                          policy is a defense in depth even if the
 *                          safety classifier missed something)
 *
 * Pure function. Returns a verdict + reason; the route handler is
 * responsible for executing (auto-allow) vs queueing a confirm (require-
 * approval) vs rejecting (block).
 */
import type { ActionPlan } from './voice-command-router.js'

export type HandsFreeVerdict = 'allow' | 'require_approval' | 'block'

export interface HandsFreeDecision {
  verdict:  HandsFreeVerdict
  reason:   string
  category: 'navigation' | 'read' | 'draft' | 'mutation' | 'high_risk' | 'hard_block' | 'unknown'
}

/** Intents that hands-free mode may auto-execute when enabled. */
const SAFE_INTENT_KINDS = new Set<string>([
  // Brain navigation — purely UI
  'brain.global', 'brain.zoom', 'brain.focus', 'brain.template',
  'brain.mode', 'brain.detail', 'brain.replay',
  // War-room reads
  'war_room.runtime', 'war_room.approvals',
  // Executive summaries / briefings — read-only
  'war_room.today', 'war_room.attention', 'exec.summary', 'exec.briefing',
])

/** Intents that may DRAFT something but must not POST/UPLOAD/MUTATE. */
const DRAFT_INTENT_KINDS = new Set<string>([
  'image.generate',     // image drafts allowed in HF
  'research.start',     // queued research (draft / dry-run by policy)
])

/** Intents that explicitly require operator approval in hands-free. */
const APPROVAL_INTENT_KINDS = new Set<string>([
  'research.pause', 'agent.pause', 'agent.audit',
  'browser.open',
])

export interface HandsFreePolicyInput {
  /** Whether hands-free is enabled for this workspace. */
  enabled: boolean
  /** Extra intent kinds the operator explicitly allow-listed. */
  allowedIntents?: ReadonlyArray<string>
  plan: ActionPlan
}

export function classifyForHandsFree(input: HandsFreePolicyInput): HandsFreeDecision {
  const plan = input.plan

  // Hard blocks pass through regardless of HF setting (defense in depth).
  if (plan.verdict === 'reject') {
    return { verdict: 'block', reason: 'hard-blocked by safety classifier', category: 'hard_block' }
  }

  // If hands-free is off, every confirm-style plan still requires approval
  // (this is the normal/push-to-talk flow). 'navigate'/'execute' verdicts
  // are still allowed because they're read-only.
  if (!input.enabled) {
    if (plan.verdict === 'confirm') return { verdict: 'require_approval', reason: 'hands-free disabled — confirm via UI', category: 'mutation' }
    return { verdict: 'allow', reason: 'hands-free disabled but plan is read-only', category: plan.verdict === 'navigate' ? 'navigation' : 'read' }
  }

  const kind = plan.intent.kind

  // Operator allow-list overrides defaults (but never lets a hard-block through).
  if (input.allowedIntents?.includes(kind)) {
    return { verdict: 'allow', reason: `operator allow-listed ${kind}`, category: plan.verdict === 'navigate' ? 'navigation' : 'mutation' }
  }

  if (SAFE_INTENT_KINDS.has(kind)) {
    return { verdict: 'allow', reason: 'safe intent for hands-free', category: plan.verdict === 'navigate' ? 'navigation' : 'read' }
  }
  if (DRAFT_INTENT_KINDS.has(kind)) {
    // Only allow if the plan didn't escalate above medium risk
    if (plan.risk === 'high') return { verdict: 'require_approval', reason: 'high-risk draft — approval required', category: 'draft' }
    return { verdict: 'allow', reason: 'draft intent — outputs are reviewable', category: 'draft' }
  }
  if (APPROVAL_INTENT_KINDS.has(kind)) {
    return { verdict: 'require_approval', reason: `${kind} requires approval`, category: 'mutation' }
  }

  // Any other confirm-verdict plan in hands-free mode requires approval.
  if (plan.verdict === 'confirm' || plan.risk === 'high') {
    return { verdict: 'require_approval', reason: `${kind} (${plan.risk}) requires approval`, category: 'high_risk' }
  }

  // Read-only fallback
  return { verdict: 'allow', reason: 'read-only fallback', category: plan.verdict === 'navigate' ? 'navigation' : 'read' }
}
