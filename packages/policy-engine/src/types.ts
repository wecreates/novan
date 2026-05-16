/**
 * Core policy engine types.
 * Pure types — no external runtime dependencies.
 */

export type RiskLevel     = 'low' | 'medium' | 'high' | 'critical'
export type PolicyVerdict = 'allow' | 'deny' | 'require_approval'

// ─── Autonomy levels ───────────────────────────────────────────────────────────

export const AUTONOMY_LEVELS = {
  OBSERVE_ONLY:                          'observe_only',
  RECOMMEND_ONLY:                        'recommend_only',
  SAFE_LOW_RISK_AUTOMATION:              'safe_low_risk_automation',
  APPROVAL_REQUIRED_EXECUTION:           'approval_required_execution',
  RESTRICTED_SUPERVISED_ORCHESTRATION:   'restricted_supervised_orchestration',
} as const

export type AutonomyLevel = typeof AUTONOMY_LEVELS[keyof typeof AUTONOMY_LEVELS]

// ─── Action categories ─────────────────────────────────────────────────────────

export const ACTION_CATEGORIES = {
  BROWSER:    'browser',
  FILE:       'file',
  PUBLISH:    'publish',
  FINANCIAL:  'financial',
  WORKFLOW:   'workflow',
  AUTOMATION: 'automation',
  PROVIDER:   'provider',
  MEMORY:     'memory',
  AGENT:      'agent',
} as const

export type ActionCategory = typeof ACTION_CATEGORIES[keyof typeof ACTION_CATEGORIES]

// ─── Policy context ────────────────────────────────────────────────────────────

export interface PolicyContext {
  workspaceId:     string
  action:          string          // e.g. 'browser.navigate', 'file.delete', 'financial.transfer'
  actionCategory:  ActionCategory  // extracted from action prefix
  subject?:        string          // target resource or URL
  metadata?:       Record<string, unknown>
  autonomyLevel:   AutonomyLevel
  agentId?:        string
  traceId?:        string
  requestedBy?:    string
  // Browser-specific
  targetDomain?:        string
  allowlistedDomains?:  string[]
  // Frequency-specific
  recentActionCount?:   number
  frequencyWindowMs?:   number
  maxActionsPerWindow?: number
  // Provider-specific
  providerId?:          string
  tokenBudget?:         number
  tokenUsed?:           number
}

// ─── Policy result ─────────────────────────────────────────────────────────────

export interface PolicyResult {
  verdict:      PolicyVerdict
  policyId:     string
  policyName:   string
  reason:       string
  riskLevel:    RiskLevel
  approvalContext?: {
    operationLabel: string
    risk:           RiskLevel
    expiresInMs:    number
    metadata:       Record<string, unknown>
  }
  blockedContext?: {
    reason:  string
    context: Record<string, unknown>
  }
}

// ─── Policy definition ─────────────────────────────────────────────────────────

export interface Policy {
  id:          string
  name:        string
  description: string
  category:    ActionCategory | 'global'
  evaluate:    (ctx: PolicyContext) => PolicyResult
}

// ─── Evaluation report ─────────────────────────────────────────────────────────

export interface PolicyEvaluationReport {
  context:        PolicyContext
  results:        PolicyResult[]
  verdict:        PolicyVerdict
  decidingPolicy: PolicyResult
  events:         PolicyEvent[]
  approvalRequest?: ApprovalRequestData
  blockedAction?:   BlockedActionData
}

export interface PolicyEvent {
  type:    string
  payload: Record<string, unknown>
}

// ─── Approval request ──────────────────────────────────────────────────────────

export interface ApprovalRequestData {
  id:             string
  workspaceId:    string
  action:         string
  subject?:       string
  operationLabel: string
  risk:           RiskLevel
  requestedBy?:   string
  agentId?:       string
  traceId?:       string
  context:        Record<string, unknown>
  expiresAt:      number
  policyId:       string
  policyName:     string
}

// ─── Blocked action ────────────────────────────────────────────────────────────

export interface BlockedActionData {
  id:          string
  workspaceId: string
  action:      string
  subject?:    string
  reason:      string
  policyId:    string
  policyName:  string
  riskLevel:   RiskLevel
  agentId?:    string
  traceId?:    string
  blockedAt:   number
  context:     Record<string, unknown>
}

// ─── Helper: extract action category from action string ────────────────────────

export function extractActionCategory(action: string): ActionCategory {
  const prefix = action.split('.')[0] ?? ''
  const map: Record<string, ActionCategory> = {
    browser:    'browser',
    file:       'file',
    publish:    'publish',
    financial:  'financial',
    workflow:   'workflow',
    automation: 'automation',
    provider:   'provider',
    memory:     'memory',
    agent:      'agent',
  }
  return map[prefix] ?? 'agent'
}
