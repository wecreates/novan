/**
 * @ops/policy-engine — runtime policy evaluation, approval lifecycle, blocked-action logging.
 *
 * Core concepts:
 *   - PolicyContext: what action is being requested, by whom, at what autonomy level
 *   - Policy: a rule that returns allow | deny | require_approval
 *   - PolicyEvaluationReport: full evaluation with events + approval/blocked data
 *   - AutonomyLevel: how much autonomy the agent has (observe_only → restricted_supervised_orchestration)
 *
 * Usage:
 *   import { evaluatePolicy, AUTONOMY_LEVELS, extractActionCategory } from '@ops/policy-engine'
 *
 *   const report = evaluatePolicy({
 *     workspaceId:    'ws-123',
 *     action:         'browser.navigate',
 *     actionCategory: 'browser',
 *     autonomyLevel:  'approval_required_execution',
 *     subject:        'https://example.com',
 *     traceId:        'trace-456',
 *   })
 *
 *   if (report.verdict === 'deny') { throw new Error('Action blocked') }
 *   if (report.verdict === 'require_approval') {
 *     // persist report.approvalRequest to DB
 *   }
 *   // emit report.events
 */

// ─── Core types ────────────────────────────────────────────────────────────────
export type {
  RiskLevel, PolicyVerdict, AutonomyLevel, ActionCategory,
  PolicyContext, PolicyResult, Policy,
  PolicyEvaluationReport, PolicyEvent,
  ApprovalRequestData, BlockedActionData,
} from './types.js'
export { AUTONOMY_LEVELS, ACTION_CATEGORIES, extractActionCategory } from './types.js'

// ─── Autonomy permissions ──────────────────────────────────────────────────────
export { AUTONOMY_PERMISSIONS, canAutoExecute, canExecute } from './autonomy.js'
export type { AutonomyPermissions } from './autonomy.js'

// ─── Policies ─────────────────────────────────────────────────────────────────
export {
  browserExecutionPolicy,
  fileActionPolicy,
  contentPublishingPolicy,
  financialActionPolicy,
  workflowExecutionPolicy,
  automationFrequencyPolicy,
  providerUsagePolicy,
  POLICIES_BY_CATEGORY,
  ALL_POLICIES,
} from './policies/index.js'

// ─── Engine ───────────────────────────────────────────────────────────────────
export { evaluatePolicy } from './engine.js'

// ─── Approval lifecycle ────────────────────────────────────────────────────────
export {
  buildApprovalRequest,
  buildApprovalApprovedEvent,
  buildApprovalDeniedEvent,
} from './approval.js'
export type { ApprovalStatus, ApprovalResolution } from './approval.js'

// ─── Blocked actions ───────────────────────────────────────────────────────────
export { buildBlockedAction } from './blocked-actions.js'

// ─── Legacy compat (preserves existing imports) ────────────────────────────────
export { evaluatePolicies, ALLOW_ALL_POLICY } from './legacy.js'
