/**
 * incident-triage.ts — Auto-triage agent (pure logic).
 *
 * Given an IncidentCandidate, produces a TriageOutcome:
 * - classified failure type
 * - identified impacted systems
 * - recommended next action
 * - assigned best repair agent
 * - whether a patch task is safe to auto-create
 * - whether approval is required
 */
import type { IncidentCandidate, IncidentType, Severity } from './incident-detector.js'

export interface TriageOutcome {
  classification:    string
  impactedSystems:   string[]
  recommendedAction: string
  assignedAgent:     string
  canAutoRepair:     boolean
  requiresApproval:  boolean
  rationale:         string
}

// ─── Routing tables ───────────────────────────────────────────────────────────

const AGENT_BY_TYPE: Record<IncidentType, string> = {
  failed_workflow_spike:    'workflow-recovery-agent',
  provider_outage:          'provider-failover-agent',
  worker_heartbeat_failure: 'worker-supervisor',
  queue_backlog:            'queue-recovery-agent',
  budget_burn:              'cost-governor-agent',
  replay_divergence:        'flaky-test-investigator',
  rollback_failure:         'human-escalation',
}

const ACTIONS_BY_TYPE: Record<IncidentType, string> = {
  failed_workflow_spike:    'Inspect recent failed runs, identify common error, pause workflow if regression is confirmed',
  provider_outage:          'Activate provider failover chain; route traffic to healthy provider; notify on-call',
  worker_heartbeat_failure: 'Restart worker process; reclaim leases; investigate logs for crash cause',
  queue_backlog:            'Scale workers, replay dead-letter jobs in batches, identify systematic failure pattern',
  budget_burn:              'Throttle non-critical AI jobs; review most expensive recent jobs; raise budget if growth is intentional',
  replay_divergence:        'Mark test as flaky, capture environment diff, escalate to test-stability owner',
  rollback_failure:         'Halt auto-repair loop, lock affected files, require human review — repair pipeline is diverging',
}

const CLASSIFICATION_BY_TYPE: Record<IncidentType, string> = {
  failed_workflow_spike:    'application_failure',
  provider_outage:          'external_dependency_failure',
  worker_heartbeat_failure: 'infrastructure_failure',
  queue_backlog:            'capacity_failure',
  budget_burn:              'cost_anomaly',
  replay_divergence:        'reliability_failure',
  rollback_failure:         'repair_loop_failure',
}

// ─── Auto-repair safety ───────────────────────────────────────────────────────

/**
 * Types where the system MAY attempt auto-repair without human approval.
 * Risky types (security, payments, repair loops) always require approval.
 */
const AUTO_REPAIR_SAFE_TYPES: ReadonlySet<IncidentType> = new Set<IncidentType>([
  'provider_outage',          // failover is safe and idempotent
  'worker_heartbeat_failure', // restart workers is safe
  'queue_backlog',            // replaying jobs is bounded
])

/**
 * Types that ALWAYS require human approval before any repair action.
 */
const APPROVAL_REQUIRED_TYPES: ReadonlySet<IncidentType> = new Set<IncidentType>([
  'rollback_failure',  // repair is already failing — escalate
  'budget_burn',       // throttling has business impact
])

// ─── Severity escalation ──────────────────────────────────────────────────────

function escalateForSeverity(base: { canAutoRepair: boolean; requiresApproval: boolean }, severity: Severity) {
  // Emergency severity always requires approval, even for normally-safe types
  if (severity === 'emergency') {
    return { canAutoRepair: false, requiresApproval: true }
  }
  return base
}

// ─── Triage entry point ───────────────────────────────────────────────────────

export function triageIncident(candidate: IncidentCandidate): TriageOutcome {
  const t = candidate.type
  const classification    = CLASSIFICATION_BY_TYPE[t]
  const recommendedAction = ACTIONS_BY_TYPE[t]
  const assignedAgent     = AGENT_BY_TYPE[t]

  const impactedSystems: string[] = []
  const sys = candidate.affectedSystems
  if (sys['workflowId'])  impactedSystems.push(`workflow:${sys['workflowId']}`)
  if (sys['providerId'])  impactedSystems.push(`provider:${sys['providerId']}`)
  if (sys['workerId'])    impactedSystems.push(`worker:${sys['workerId']}`)
  if (sys['queueName'])   impactedSystems.push(`queue:${sys['queueName']}`)
  if (sys['jobId'])       impactedSystems.push(`job:${sys['jobId']}`)
  if (sys['alertType'])   impactedSystems.push(`budget:${sys['alertType']}`)
  if (sys['files'] && Array.isArray(sys['files'])) {
    for (const f of sys['files'] as string[]) impactedSystems.push(`file:${f}`)
  }

  const baseFlags = {
    canAutoRepair:    AUTO_REPAIR_SAFE_TYPES.has(t) && !APPROVAL_REQUIRED_TYPES.has(t),
    requiresApproval: APPROVAL_REQUIRED_TYPES.has(t) || !AUTO_REPAIR_SAFE_TYPES.has(t),
  }
  const flags = escalateForSeverity(baseFlags, candidate.severity)

  const rationale = flags.requiresApproval
    ? `Type '${t}' at severity '${candidate.severity}' requires human approval before any repair action`
    : `Type '${t}' at severity '${candidate.severity}' is safe for bounded auto-repair via agent '${assignedAgent}'`

  return {
    classification,
    impactedSystems,
    recommendedAction,
    assignedAgent,
    canAutoRepair:    flags.canAutoRepair,
    requiresApproval: flags.requiresApproval,
    rationale,
  }
}
