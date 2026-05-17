/**
 * Tests for incident-triage.ts — pure classification (no DB).
 */
import { describe, it, expect } from 'vitest'
import { triageIncident } from '../services/incident-triage.js'
import type { IncidentCandidate } from '../services/incident-detector.js'

function base(type: IncidentCandidate['type'], severity: IncidentCandidate['severity'], sys: Record<string, unknown> = {}): IncidentCandidate {
  return {
    type, severity,
    title: 'x', summary: 'x',
    rootCauseHypothesis: 'x',
    affectedSystems: sys,
    linkedEventIds: [],
    signalCount: 1,
    detectedAt: Date.now(),
  }
}

describe('triageIncident: routing', () => {
  it('routes provider_outage to provider-failover-agent', () => {
    const r = triageIncident(base('provider_outage', 'critical', { providerId: 'openai' }))
    expect(r.assignedAgent).toBe('provider-failover-agent')
    expect(r.classification).toBe('external_dependency_failure')
    expect(r.impactedSystems).toContain('provider:openai')
  })

  it('routes worker_heartbeat_failure to worker-supervisor', () => {
    const r = triageIncident(base('worker_heartbeat_failure', 'warning', { workerId: 'w-1' }))
    expect(r.assignedAgent).toBe('worker-supervisor')
    expect(r.impactedSystems).toContain('worker:w-1')
  })

  it('routes queue_backlog to queue-recovery-agent', () => {
    const r = triageIncident(base('queue_backlog', 'warning', { queueName: 'workflow' }))
    expect(r.assignedAgent).toBe('queue-recovery-agent')
    expect(r.impactedSystems).toContain('queue:workflow')
  })

  it('routes budget_burn to cost-governor-agent and requires approval', () => {
    const r = triageIncident(base('budget_burn', 'critical', { alertType: 'monthly' }))
    expect(r.assignedAgent).toBe('cost-governor-agent')
    expect(r.requiresApproval).toBe(true)
  })

  it('routes rollback_failure to human escalation + requires approval', () => {
    const r = triageIncident(base('rollback_failure', 'critical', { jobId: 'j-1' }))
    expect(r.assignedAgent).toBe('human-escalation')
    expect(r.requiresApproval).toBe(true)
    expect(r.canAutoRepair).toBe(false)
  })

  it('routes failed_workflow_spike to workflow-recovery-agent', () => {
    const r = triageIncident(base('failed_workflow_spike', 'warning', { workflowId: 'wf-1' }))
    expect(r.assignedAgent).toBe('workflow-recovery-agent')
    expect(r.impactedSystems).toContain('workflow:wf-1')
  })

  it('routes replay_divergence to flaky-test-investigator', () => {
    const r = triageIncident(base('replay_divergence', 'warning', { jobId: 'j-1' }))
    expect(r.assignedAgent).toBe('flaky-test-investigator')
  })
})

describe('triageIncident: auto-repair safety set', () => {
  it('allows auto-repair for provider_outage at non-emergency severity', () => {
    const r = triageIncident(base('provider_outage', 'critical'))
    expect(r.canAutoRepair).toBe(true)
    expect(r.requiresApproval).toBe(false)
  })

  it('allows auto-repair for worker_heartbeat_failure', () => {
    const r = triageIncident(base('worker_heartbeat_failure', 'warning'))
    expect(r.canAutoRepair).toBe(true)
  })

  it('allows auto-repair for queue_backlog', () => {
    const r = triageIncident(base('queue_backlog', 'warning'))
    expect(r.canAutoRepair).toBe(true)
  })

  it('blocks auto-repair for failed_workflow_spike (not on safe list)', () => {
    const r = triageIncident(base('failed_workflow_spike', 'warning'))
    expect(r.canAutoRepair).toBe(false)
    expect(r.requiresApproval).toBe(true)
  })
})

describe('triageIncident: emergency severity override', () => {
  it('emergency severity forces approval even for normally-safe types', () => {
    const r = triageIncident(base('provider_outage', 'emergency'))
    expect(r.canAutoRepair).toBe(false)
    expect(r.requiresApproval).toBe(true)
  })

  it('emergency severity forces approval for worker_heartbeat_failure', () => {
    const r = triageIncident(base('worker_heartbeat_failure', 'emergency'))
    expect(r.canAutoRepair).toBe(false)
    expect(r.requiresApproval).toBe(true)
  })
})

describe('triageIncident: rationale', () => {
  it('rationale mentions the incident type', () => {
    const r = triageIncident(base('provider_outage', 'critical'))
    expect(r.rationale).toContain('provider_outage')
  })

  it('rationale mentions severity', () => {
    const r = triageIncident(base('queue_backlog', 'critical'))
    expect(r.rationale).toContain('critical')
  })
})

describe('triageIncident: impactedSystems aggregation', () => {
  it('includes file refs when affectedSystems.files is present', () => {
    const r = triageIncident(base('rollback_failure', 'critical', {
      files: ['src/auth.ts', 'src/billing.ts'],
    }))
    expect(r.impactedSystems).toContain('file:src/auth.ts')
    expect(r.impactedSystems).toContain('file:src/billing.ts')
  })

  it('returns empty impactedSystems when no known fields present', () => {
    const r = triageIncident(base('failed_workflow_spike', 'warning', {}))
    expect(r.impactedSystems).toEqual([])
  })
})
