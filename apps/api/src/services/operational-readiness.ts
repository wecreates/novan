/**
 * operational-readiness.ts — Catalog of the 50 operational-completeness
 * components from the operations spec.
 *
 * The spec itself says: "Most legal, financial, and HR items need
 * professional involvement... Claude Code is supporting human work
 * rather than executing autonomously." So this module does NOT
 * implement legal docs or HR procedures. It is a *tracking surface*
 * the operator uses to see what's done, what's deferred, and what
 * needs attention.
 *
 * Each item carries:
 *   - status: implemented | partial | deferred | not-started
 *   - owner: who is responsible (operator, legal, accounting, etc.)
 *   - evidence: pointers to the artifact proving it exists (doc path,
 *     event type, external system)
 *   - reviewedAt: when the operator last attested to the status
 *
 * The Compliance tab consumes `summarizeReadiness()` to render a
 * Kanban-style view + the operator clicks an item to update it.
 */

export type ReadinessStatus = 'implemented' | 'partial' | 'deferred' | 'not-started'

export type ReadinessOwner =
  | 'operator' | 'legal' | 'accounting' | 'hr' | 'security' | 'compliance' | 'engineering'

export interface ReadinessItem {
  id:           string    // e.g. "OC-01"
  layer:        number    // 1-12 from the spec
  layerName:    string
  name:         string
  spec:         string    // 1-line description
  status:       ReadinessStatus
  owner:        ReadinessOwner
  evidence?:    string[]  // doc paths or event refs
  priority:     'required-to-start' | 'required-to-scale' | 'mature-operation'
}

export const READINESS_CATALOG: ReadinessItem[] = [
  // Layer 1 — Organizational Foundations
  { id: 'OC-01', layer: 1, layerName: 'Organizational', name: 'Operating Agreement', spec: 'Ownership, decision rights, escalation, RACI for the operating agreement itself.', status: 'partial', owner: 'legal', evidence: ['docs/NOVAN_OPERATING_DIRECTIVES.md'], priority: 'required-to-start' },
  { id: 'OC-02', layer: 1, layerName: 'Organizational', name: 'RACI Matrix', spec: 'Responsible/Accountable/Consulted/Informed for every significant area.', status: 'not-started', owner: 'operator', priority: 'required-to-scale' },
  { id: 'OC-03', layer: 1, layerName: 'Organizational', name: 'Meeting Cadence', spec: 'Daily / weekly / monthly / quarterly / annual rhythm.', status: 'partial', owner: 'operator', evidence: ['Monday briefing cron'], priority: 'required-to-start' },
  { id: 'OC-04', layer: 1, layerName: 'Organizational', name: 'Communication Norms', spec: 'Channels, response times, status updates.', status: 'partial', owner: 'operator', priority: 'required-to-start' },

  // Layer 2 — Financial Operations
  { id: 'OC-05', layer: 2, layerName: 'Financial', name: 'Chart of Accounts', spec: 'Multi-business reporting; platform vs business costs.', status: 'not-started', owner: 'accounting', priority: 'required-to-start' },
  { id: 'OC-06', layer: 2, layerName: 'Financial', name: 'Budget Process', spec: 'Annual budget + quarterly reforecasts + monthly variance.', status: 'partial', owner: 'accounting', evidence: ['services/cron-budget.ts'], priority: 'required-to-start' },
  { id: 'OC-07', layer: 2, layerName: 'Financial', name: 'Treasury Management', spec: 'Where money sits, cash flow forecasting, authorization tiers.', status: 'not-started', owner: 'accounting', priority: 'required-to-scale' },
  { id: 'OC-08', layer: 2, layerName: 'Financial', name: 'Tax Strategy', spec: 'Entity structure, jurisdictional planning, quarterly estimates.', status: 'not-started', owner: 'accounting', priority: 'required-to-scale' },
  { id: 'OC-09', layer: 2, layerName: 'Financial', name: 'Insurance Portfolio', spec: 'GL / Cyber / E&O / D&O as applicable.', status: 'not-started', owner: 'operator', priority: 'required-to-scale' },

  // Layer 3 — Legal Foundations
  { id: 'OC-10', layer: 3, layerName: 'Legal', name: 'Entity Structure', spec: 'Operating + holding + IP entities, annual filings.', status: 'partial', owner: 'legal', priority: 'required-to-start' },
  { id: 'OC-11', layer: 3, layerName: 'Legal', name: 'Contract Library', spec: 'Standard templates, approved redlines, approval authority.', status: 'not-started', owner: 'legal', priority: 'required-to-start' },
  { id: 'OC-12', layer: 3, layerName: 'Legal', name: 'IP Management', spec: 'Trademarks, copyrights, employee IP assignment, OSS compliance.', status: 'not-started', owner: 'legal', priority: 'required-to-scale' },
  { id: 'OC-13', layer: 3, layerName: 'Legal', name: 'Compliance Programs', spec: 'SOC2 + GDPR + CCPA per applicability.', status: 'partial', owner: 'compliance', evidence: ['services/compliance-soc2.ts'], priority: 'required-to-scale' },
  { id: 'OC-14', layer: 3, layerName: 'Legal', name: 'Privacy Operations', spec: 'Privacy policy, data inventory, DSR handling, breach proc.', status: 'partial', owner: 'compliance', evidence: ['services/data-governance.ts'], priority: 'required-to-start' },

  // Layer 4 — Human Operations
  { id: 'OC-15', layer: 4, layerName: 'Human', name: 'Hiring Process', spec: 'JD templates, sourcing, interview rubrics, offers.', status: 'not-started', owner: 'hr', priority: 'required-to-scale' },
  { id: 'OC-16', layer: 4, layerName: 'Human', name: 'Onboarding Procedures', spec: 'First day/week/month checklists, access provisioning.', status: 'not-started', owner: 'hr', priority: 'required-to-scale' },
  { id: 'OC-17', layer: 4, layerName: 'Human', name: 'Performance Management', spec: 'Goals, 1:1s, reviews, PIP, termination.', status: 'not-started', owner: 'hr', priority: 'required-to-scale' },
  { id: 'OC-18', layer: 4, layerName: 'Human', name: 'Compensation Philosophy', spec: 'Bands, equity, bonus, benefits, annual review.', status: 'not-started', owner: 'hr', priority: 'required-to-scale' },
  { id: 'OC-19', layer: 4, layerName: 'Human', name: 'Employee Handbook', spec: 'Policies, conduct, PTO, remote, IP, reporting.', status: 'not-started', owner: 'hr', priority: 'required-to-scale' },
  { id: 'OC-20', layer: 4, layerName: 'Human', name: 'Contractor Management', spec: 'Classification, agreements, onboarding, offboarding.', status: 'not-started', owner: 'hr', priority: 'required-to-scale' },

  // Layer 5 — Vendor & Partner
  { id: 'OC-21', layer: 5, layerName: 'Vendor', name: 'Vendor Selection Process', spec: 'Criteria, vetting, RFP, approval tiers.', status: 'not-started', owner: 'operator', priority: 'required-to-scale' },
  { id: 'OC-22', layer: 5, layerName: 'Vendor', name: 'Vendor Management', spec: 'Inventory, annual review, security assessments.', status: 'not-started', owner: 'security', priority: 'required-to-scale' },
  { id: 'OC-23', layer: 5, layerName: 'Vendor', name: 'Partnership Operations', spec: 'Partner selection, joint planning, performance.', status: 'not-started', owner: 'operator', priority: 'mature-operation' },

  // Layer 6 — Customer Operations
  { id: 'OC-24', layer: 6, layerName: 'Customer', name: 'Customer Lifecycle', spec: 'Acquisition / onboarding / success / renewal per business.', status: 'partial', owner: 'operator', evidence: ['services/business-portfolio.ts'], priority: 'required-to-scale' },
  { id: 'OC-25', layer: 6, layerName: 'Customer', name: 'Communication Standards', spec: 'Brand voice, SLAs, escalation, crisis protocols.', status: 'partial', owner: 'operator', priority: 'required-to-scale' },
  { id: 'OC-26', layer: 6, layerName: 'Customer', name: 'Feedback Loops', spec: 'NPS/CSAT/interviews → roadmap routing.', status: 'not-started', owner: 'operator', priority: 'required-to-scale' },
  { id: 'OC-27', layer: 6, layerName: 'Customer', name: 'Customer Data Management', spec: 'Storage, access controls, deletion, portability.', status: 'partial', owner: 'security', evidence: ['services/data-governance.ts'], priority: 'required-to-start' },

  // Layer 7 — Operational Excellence
  { id: 'OC-28', layer: 7, layerName: 'Ops Excellence', name: 'Service Level Objectives', spec: 'Availability + latency + error-budget per service.', status: 'partial', owner: 'engineering', evidence: ['routes/blueprint architecture overview'], priority: 'required-to-scale' },
  { id: 'OC-29', layer: 7, layerName: 'Ops Excellence', name: 'Incident Management', spec: 'Severity, on-call, war-room, postmortem.', status: 'implemented', owner: 'engineering', evidence: ['services/incident-service.ts', 'services/incident-detector.ts'], priority: 'required-to-start' },
  { id: 'OC-30', layer: 7, layerName: 'Ops Excellence', name: 'Change Management', spec: 'Classification, approval, windows, freezes.', status: 'implemented', owner: 'engineering', evidence: ['services/audit-log.ts', 'services/governance-core.ts'], priority: 'required-to-start' },
  { id: 'OC-31', layer: 7, layerName: 'Ops Excellence', name: 'Capacity Planning', spec: 'Demand forecasting, resource capacity, growth plan.', status: 'partial', owner: 'engineering', priority: 'required-to-scale' },
  { id: 'OC-32', layer: 7, layerName: 'Ops Excellence', name: 'Disaster Recovery', spec: 'RTO/RPO, DR procedures, quarterly drills.', status: 'partial', owner: 'engineering', evidence: ['docs/MULTI_REGION_FAILOVER_RUNBOOK.md', 'docs/runbooks/snapshot-rollback.md'], priority: 'required-to-scale' },
  { id: 'OC-33', layer: 7, layerName: 'Ops Excellence', name: 'Business Continuity', spec: 'Key-person dependency, succession, crisis decisions.', status: 'not-started', owner: 'operator', priority: 'mature-operation' },

  // Layer 8 — Strategic
  { id: 'OC-34', layer: 8, layerName: 'Strategic', name: 'Strategic Planning', spec: 'Annual review + quarterly check-ins + OKR framework.', status: 'partial', owner: 'operator', evidence: ['services/mission-charter.ts'], priority: 'required-to-scale' },
  { id: 'OC-35', layer: 8, layerName: 'Strategic', name: 'Portfolio Management', spec: 'Continuation / sunset / new-business criteria.', status: 'implemented', owner: 'operator', evidence: ['services/business-portfolio.ts', 'services/business-reality.ts'], priority: 'required-to-scale' },
  { id: 'OC-36', layer: 8, layerName: 'Strategic', name: 'Market Intelligence', spec: 'Competitor + industry + regulatory + tech monitoring.', status: 'not-started', owner: 'operator', priority: 'mature-operation' },
  { id: 'OC-37', layer: 8, layerName: 'Strategic', name: 'Innovation Process', spec: 'Idea evaluation, experiment budget, success criteria.', status: 'partial', owner: 'engineering', evidence: ['services/prompt-evolution.ts'], priority: 'mature-operation' },

  // Layer 9 — Trust & Safety
  { id: 'OC-38', layer: 9, layerName: 'Trust & Safety', name: 'AI Governance', spec: 'AI use disclosure, customer comms, bias monitoring, ethics review.', status: 'partial', owner: 'compliance', evidence: ['services/safety-policy.ts', 'services/model-governance.ts'], priority: 'required-to-start' },
  { id: 'OC-39', layer: 9, layerName: 'Trust & Safety', name: 'Customer-Facing T&S', spec: 'Content moderation, abuse reporting, user safety.', status: 'not-started', owner: 'compliance', priority: 'required-to-scale' },
  { id: 'OC-40', layer: 9, layerName: 'Trust & Safety', name: 'Reputation Management', spec: 'Brand monitoring, crisis comms, spokesperson.', status: 'not-started', owner: 'operator', priority: 'mature-operation' },

  // Layer 10 — Docs & Knowledge
  { id: 'OC-41', layer: 10, layerName: 'Docs', name: 'Documentation Standards', spec: 'Where docs live, freshness, review cycles, templates.', status: 'implemented', owner: 'engineering', evidence: ['docs/SPEC.md', 'docs/INSTRUCTIONS_FOR_CLAUDE.md', 'docs/runbooks/'], priority: 'required-to-start' },
  { id: 'OC-42', layer: 10, layerName: 'Docs', name: 'Institutional Knowledge', spec: 'Critical knowledge, cross-training, exit interviews.', status: 'partial', owner: 'operator', evidence: ['services/knowledge-curator-v2.ts'], priority: 'required-to-scale' },
  { id: 'OC-43', layer: 10, layerName: 'Docs', name: 'Training Programs', spec: 'Onboarding, role-specific, compliance, AI literacy.', status: 'not-started', owner: 'hr', priority: 'required-to-scale' },
  { id: 'OC-44', layer: 10, layerName: 'Docs', name: 'Internal Communications', spec: 'Newsletter, all-hands, strategy comms, cultural.', status: 'partial', owner: 'operator', evidence: ['Monday briefing'], priority: 'required-to-scale' },

  // Layer 11 — Reviews & Audits
  { id: 'OC-45', layer: 11, layerName: 'Audits', name: 'Internal Audit Function', spec: 'Process audits, findings tracking, remediation timeline.', status: 'partial', owner: 'compliance', evidence: ['services/repo-auditor.ts'], priority: 'required-to-scale' },
  { id: 'OC-46', layer: 11, layerName: 'Audits', name: 'External Audits', spec: 'Annual financial + SOC2 + pen test + framework audits.', status: 'not-started', owner: 'compliance', priority: 'mature-operation' },
  { id: 'OC-47', layer: 11, layerName: 'Audits', name: 'Board / Advisory', spec: 'Composition, cadence, decision authority (if applicable).', status: 'deferred', owner: 'operator', priority: 'mature-operation' },
  { id: 'OC-48', layer: 11, layerName: 'Audits', name: 'Investor Relations', spec: 'Reporting cadence, info rights (if applicable).', status: 'deferred', owner: 'operator', priority: 'mature-operation' },

  // Layer 12 — Continuous Improvement
  { id: 'OC-49', layer: 12, layerName: 'Continuous Improvement', name: 'Retrospective Practice', spec: 'Project + incident + quarterly retros, action tracking.', status: 'partial', owner: 'engineering', evidence: ['services/incident-service.ts postmortem'], priority: 'required-to-scale' },
  { id: 'OC-50', layer: 12, layerName: 'Continuous Improvement', name: 'Metrics & Analytics', spec: 'KPIs + dashboards + cadence + data quality.', status: 'implemented', owner: 'engineering', evidence: ['routes/blueprint architecture overview', 'services/metrics.ts'], priority: 'required-to-start' },
]

export function listReadinessItems(): ReadinessItem[] {
  return READINESS_CATALOG
}

export function summarizeReadiness(): {
  total: number
  byStatus: Record<ReadinessStatus, number>
  byLayer:  Record<number, number>
  byPriority: Record<ReadinessItem['priority'], number>
  requiredToStartGap: number
} {
  const byStatus: Record<ReadinessStatus, number> = { implemented: 0, partial: 0, deferred: 0, 'not-started': 0 }
  const byLayer: Record<number, number> = {}
  const byPriority: Record<ReadinessItem['priority'], number> = {
    'required-to-start': 0, 'required-to-scale': 0, 'mature-operation': 0,
  }
  let requiredToStartGap = 0
  for (const item of READINESS_CATALOG) {
    byStatus[item.status]++
    byLayer[item.layer] = (byLayer[item.layer] ?? 0) + 1
    byPriority[item.priority]++
    if (item.priority === 'required-to-start' && (item.status === 'not-started' || item.status === 'partial')) {
      requiredToStartGap++
    }
  }
  return { total: READINESS_CATALOG.length, byStatus, byLayer, byPriority, requiredToStartGap }
}

/** Update item status via operator attestation. Records an event for
 *  audit so future reviewers see who marked what when. */
export async function attestReadinessItem(
  itemId: string,
  status: ReadinessStatus,
  attestedBy: string,
  note?: string,
): Promise<{ updated: boolean }> {
  const item = READINESS_CATALOG.find(i => i.id === itemId)
  if (!item) return { updated: false }
  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    const { v7: uuidv7 } = await import('uuid')
    await db.insert(events).values({
      id: uuidv7(), type: 'operational_readiness.attested', workspaceId: 'global',
      payload: { itemId, previousStatus: item.status, newStatus: status, attestedBy, note: note ?? null },
      traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
      source: 'operational-readiness', version: 1, createdAt: Date.now(),
    }).catch((e: Error) => { console.error('[operational-readiness]', e.message); return null })
  } catch { /* tolerated */ }
  // In-memory mutation: persisted attestations are read by the
  // Compliance tab via event timeline replay; the catalog itself
  // remains the canonical default state.
  item.status = status
  return { updated: true }
}
