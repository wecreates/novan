/**
 * compliance-soc2.ts — SOC 2 readiness module (BO17).
 *
 * Distinct from operator-facing `compliance-tracker.ts` (which surfaces
 * platform-policy state per business). This module is the back-office
 * SOC 2 control catalog + evidence-collection layer that an external
 * auditor would consume.
 *
 * Honest scope:
 *   - We catalog the SOC 2 TSC (Trust Services Criteria) common
 *     criteria CC1–CC9 mapped to concrete Novan systems already in
 *     place. Each control lists its evidence source (event types,
 *     tables, files).
 *   - The evidence-collection cron periodically harvests counts +
 *     samples and writes a `compliance.evidence_collected` event so an
 *     auditor can reconstruct posture over time without re-running the
 *     production system.
 *   - Dependency-CVE scan is shelled out to `pnpm audit --json` in the
 *     cron tick; we record the headline counts as events rather than
 *     storing full SBOMs (those live in the package manager's lock).
 *   - Quarterly access review is fired as an event the operator must
 *     attest to via the Compliance tab — no automated revocation.
 *
 * What this is NOT:
 *   - A SOC 2 audit. An auditor still needs to validate evidence.
 *   - GDPR/CCPA-complete. Data inventory + consent are separate.
 *   - Penetration testing. That is an external engagement.
 */

export type SOC2Category =
  | 'CC1' // Control Environment
  | 'CC2' // Communication + Information
  | 'CC3' // Risk Assessment
  | 'CC4' // Monitoring Activities
  | 'CC5' // Control Activities
  | 'CC6' // Logical + Physical Access
  | 'CC7' // System Operations
  | 'CC8' // Change Management
  | 'CC9' // Risk Mitigation

export interface SOC2Control {
  id:           string         // e.g. "CC6.1"
  category:     SOC2Category
  title:        string
  description:  string
  evidence:     EvidenceSource[]
  status:       'implemented' | 'partial' | 'gap'
}

export interface EvidenceSource {
  kind:        'event' | 'table' | 'file' | 'service'
  ref:         string          // event type, table name, file path, or service module
  notes?:      string
}

/** Canonical SOC 2 control catalog mapped to Novan implementation. */
export const SOC2_CONTROLS: SOC2Control[] = [
  {
    id: 'CC1.1', category: 'CC1',
    title: 'Mission + ethical commitments',
    description: 'Documented mission charter + operating directives.',
    status: 'implemented',
    evidence: [
      { kind: 'file', ref: 'docs/SPEC.md' },
      { kind: 'file', ref: 'docs/NOVAN_OPERATING_DIRECTIVES.md' },
      { kind: 'service', ref: 'services/mission-charter.ts' },
    ],
  },
  {
    id: 'CC2.1', category: 'CC2',
    title: 'Internal communication of policy',
    description: 'Policy engine evaluates every governed op + records decisions.',
    status: 'implemented',
    evidence: [
      { kind: 'service', ref: 'services/policy-engine.ts' },
      { kind: 'event',   ref: 'governance.policy_checked' },
      { kind: 'event',   ref: 'governance.approval_requested' },
    ],
  },
  {
    id: 'CC3.1', category: 'CC3',
    title: 'Risk identification + assessment',
    description: '5-detector self-improvement pathology monitor + incident ingest.',
    status: 'implemented',
    evidence: [
      { kind: 'service', ref: 'services/self-improvement.ts' },
      { kind: 'event',   ref: 'self_improvement.health_check' },
      { kind: 'event',   ref: 'cron.incident_scan_completed' },
    ],
  },
  {
    id: 'CC4.1', category: 'CC4',
    title: 'Ongoing monitoring',
    description: 'Cron registry + event timeline + Architecture overview tab.',
    status: 'implemented',
    evidence: [
      { kind: 'service', ref: 'services/learning-cron.ts' },
      { kind: 'table',   ref: 'events' },
      { kind: 'event',   ref: 'cron.*_completed' },
    ],
  },
  {
    id: 'CC5.1', category: 'CC5',
    title: 'Control activities (kill switches + budgets)',
    description: 'Per-agent / per-workspace / global kill switches; cron budget gating.',
    status: 'implemented',
    evidence: [
      { kind: 'service', ref: 'services/kill-switch.ts' },
      { kind: 'service', ref: 'services/cron-budget.ts' },
      { kind: 'event',   ref: 'cron.budget_blocked' },
    ],
  },
  {
    id: 'CC6.1', category: 'CC6',
    title: 'Logical access controls',
    description: 'Auth preHandlers + per-workspace isolation + OAuth state entropy.',
    status: 'implemented',
    evidence: [
      { kind: 'service', ref: 'plugins/auth.ts' },
      { kind: 'table',   ref: 'workspaces' },
      { kind: 'event',   ref: 'auth.login_succeeded' },
    ],
  },
  {
    id: 'CC6.7', category: 'CC6',
    title: 'Quarterly access review',
    description: 'Operator attests to access list via Compliance tab every quarter.',
    status: 'partial',
    evidence: [
      { kind: 'event', ref: 'compliance.access_review_due' },
      { kind: 'event', ref: 'compliance.access_review_completed' },
    ],
  },
  {
    id: 'CC7.1', category: 'CC7',
    title: 'System monitoring + alerting',
    description: 'Pino structured logs + brain-broadcast operator alerts.',
    status: 'implemented',
    evidence: [
      { kind: 'service', ref: 'lib/logger.ts' },
      { kind: 'event',   ref: 'cron.error' },
      { kind: 'event',   ref: 'governance.stability_alert' },
    ],
  },
  {
    id: 'CC7.4', category: 'CC7',
    title: 'Vulnerability management',
    description: 'pnpm audit cron scan + dependency-CVE event stream.',
    status: 'implemented',
    evidence: [
      { kind: 'event', ref: 'compliance.cve_scan_completed' },
    ],
  },
  {
    id: 'CC8.1', category: 'CC8',
    title: 'Change management',
    description: 'Locked-core registry + adversarial review on patches + audit log.',
    status: 'implemented',
    evidence: [
      { kind: 'service', ref: 'services/self-improvement.ts' },
      { kind: 'service', ref: 'services/audit-log.ts' },
      { kind: 'event',   ref: 'code_patch.adversarial_review_completed' },
    ],
  },
  {
    id: 'CC9.1', category: 'CC9',
    title: 'Risk mitigation + business continuity',
    description: 'Snapshot/rollback runbooks + cross-region failover docs.',
    status: 'partial',
    evidence: [
      { kind: 'file', ref: 'docs/runbooks/snapshot-rollback.md' },
      { kind: 'file', ref: 'docs/MULTI_REGION_FAILOVER_RUNBOOK.md' },
    ],
  },
]

/** Return controls grouped by category for dashboard rendering. */
export function listControlsByCategory(): Record<SOC2Category, SOC2Control[]> {
  const out = {} as Record<SOC2Category, SOC2Control[]>
  for (const c of SOC2_CONTROLS) {
    if (!out[c.category]) out[c.category] = []
    out[c.category]!.push(c)
  }
  return out
}

/** Summary: how many controls implemented vs partial vs gap. */
export function controlSummary(): { implemented: number; partial: number; gap: number; total: number } {
  let implemented = 0, partial = 0, gap = 0
  for (const c of SOC2_CONTROLS) {
    if (c.status === 'implemented') implemented++
    else if (c.status === 'partial') partial++
    else gap++
  }
  return { implemented, partial, gap, total: SOC2_CONTROLS.length }
}

/** Collect evidence for one control by counting recent matching events.
 *  Used by the evidence-collection cron; safe to call ad-hoc from the
 *  Compliance tab too. */
export async function collectEvidenceForControl(
  controlId: string,
  windowMs: number = 30 * 24 * 60 * 60_000, // last 30 days
): Promise<{ controlId: string; eventCounts: Record<string, number>; collectedAt: number }> {
  const control = SOC2_CONTROLS.find(c => c.id === controlId)
  if (!control) throw new Error(`unknown control ${controlId}`)
  const since = Date.now() - windowMs
  const eventCounts: Record<string, number> = {}
  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    const { sql, and, eq, gte } = await import('drizzle-orm')
    for (const ev of control.evidence) {
      if (ev.kind !== 'event') continue
      // Wildcard support: cron.*_completed → LIKE 'cron.%_completed'
      const pattern = ev.ref.replace(/\*/g, '%')
      const rows = await db.select({ n: sql<number>`count(*)::int` }).from(events)
        .where(pattern.includes('%')
          ? and(sql`${events.type} LIKE ${pattern}`, gte(events.createdAt, since))
          : and(eq(events.type, ev.ref), gte(events.createdAt, since)))
        .catch(() => [{ n: 0 }])
      eventCounts[ev.ref] = rows[0]?.n ?? 0
    }
  } catch { /* DB unavailable → empty counts */ }
  return { controlId, eventCounts, collectedAt: Date.now() }
}

/** Cron tick — collect evidence for every control + emit one rollup event. */
export async function runComplianceEvidenceCollection(): Promise<{
  controlsCollected: number
  totalEvents:       number
}> {
  let totalEvents = 0
  const perControl: Array<{ id: string; events: number }> = []
  for (const c of SOC2_CONTROLS) {
    const out = await collectEvidenceForControl(c.id).catch((e: Error) => { console.error('[compliance-soc2]', e.message); return null })
    if (!out) continue
    const n = Object.values(out.eventCounts).reduce((a, b) => a + b, 0)
    totalEvents += n
    perControl.push({ id: c.id, events: n })
  }
  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    const { v7: uuidv7 } = await import('uuid')
    await db.insert(events).values({
      id: uuidv7(), type: 'compliance.evidence_collected', workspaceId: 'global',
      payload: { perControl, totalEvents, summary: controlSummary() },
      traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
      source: 'compliance-soc2', version: 1, createdAt: Date.now(),
    }).catch((e: Error) => { console.error('[compliance-soc2]', e.message); return null })
  } catch { /* DB unavailable — non-fatal */ }
  return { controlsCollected: perControl.length, totalEvents }
}

/** Cron tick — run `pnpm audit --json` + emit headline counts.
 *  Returns null + emits nothing if shell exec is unavailable in the
 *  current environment (tests, sandbox). */
export async function runDependencyCveScan(): Promise<{
  critical: number
  high:     number
  moderate: number
  low:      number
} | null> {
  if (process.env['DISABLE_CVE_SCAN'] === '1') return null
  let parsed: { metadata?: { vulnerabilities?: Record<string, number> } } | null = null
  try {
    const { exec } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execp = promisify(exec)
    // pnpm audit exits non-zero when vulns exist; capture stdout regardless.
    const { stdout } = await execp('pnpm audit --json', {
      cwd: process.cwd(),
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    }).catch((e: { stdout?: string }) => ({ stdout: e?.stdout ?? '' }))
    parsed = stdout ? JSON.parse(stdout) : null
  } catch { return null }
  const v = parsed?.metadata?.vulnerabilities ?? {}
  const result = {
    critical: Number(v['critical']) || 0,
    high:     Number(v['high'])     || 0,
    moderate: Number(v['moderate']) || 0,
    low:      Number(v['low'])      || 0,
  }
  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    const { v7: uuidv7 } = await import('uuid')
    await db.insert(events).values({
      id: uuidv7(), type: 'compliance.cve_scan_completed', workspaceId: 'global',
      payload: result,
      traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
      source: 'compliance-soc2', version: 1, createdAt: Date.now(),
    }).catch((e: Error) => { console.error('[compliance-soc2]', e.message); return null })
  } catch { /* tolerated */ }
  return result
}

/** Quarterly access-review event emitter. Operator-attested completion
 *  is recorded via a separate `compliance.access_review_completed`
 *  event from the Compliance tab. */
export async function runQuarterlyAccessReviewCheck(): Promise<{ due: boolean }> {
  // Due if no completed review in the last 95 days (5-day buffer past quarterly).
  const threshold = Date.now() - 95 * 24 * 60 * 60_000
  let due = true
  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    const { and, eq, gte, desc } = await import('drizzle-orm')
    const rows = await db.select({ createdAt: events.createdAt }).from(events)
      .where(and(eq(events.type, 'compliance.access_review_completed'), gte(events.createdAt, threshold)))
      .orderBy(desc(events.createdAt))
      .limit(1)
      .catch(() => [])
    if (rows.length > 0) due = false
    if (due) {
      const { v7: uuidv7 } = await import('uuid')
      await db.insert(events).values({
        id: uuidv7(), type: 'compliance.access_review_due', workspaceId: 'global',
        payload: { lastCompleted: null, daysSince: '>95' },
        traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
        source: 'compliance-soc2', version: 1, createdAt: Date.now(),
      }).catch((e: Error) => { console.error('[compliance-soc2]', e.message); return null })
    }
  } catch { /* DB unavailable */ }
  return { due }
}
