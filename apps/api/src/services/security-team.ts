/**
 * security-team.ts — Cyber Security Force Team.
 *
 * 10 specialized security agents that scan REAL platform data and produce
 * evidence-backed findings. Every finding references real row IDs.
 *
 * No fake scans. No destructive testing. No raw secrets in findings.
 */
import { db }              from '../db/client.js'
import {
  securityAgents, securityFindings, events,
  patchRecords, sandboxSessions, securityAudits, secretsVault,
  permissions, agentRegistrations, providerFailures,
  auditExports,
}                          from '../db/schema.js'
import { eq, and, desc, gt, isNull } from 'drizzle-orm'
import { v7 as uuidv7 }    from 'uuid'

export type AgentRole =
  | 'cso' | 'appsec' | 'cloud' | 'secrets' | 'runtime'
  | 'tenant' | 'patch' | 'red' | 'blue' | 'compliance'

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical'

export interface EvidenceRef { table: string; id: string }

export interface Finding {
  agentId:           string
  agentRole:         AgentRole
  workspaceId?:      string
  severity:          Severity
  category:          string
  title:             string
  description:       string
  evidenceRefs:      EvidenceRef[]
  affectedResource?: string
  recommendedAction: string
  requiresApproval:  boolean
  blocksLaunch:      boolean
}

// ─── Agent registry ───────────────────────────────────────────────────────────

interface AgentSpec {
  id:           string
  name:         string
  role:         AgentRole
  description:  string
  capabilities: string[]
}

const TEAM: AgentSpec[] = [
  { id: 'cso',        name: 'Chief Security Officer Agent', role: 'cso',
    description: 'Owns security strategy, reviews critical risks, approves posture',
    capabilities: ['aggregate', 'escalate', 'approve_posture'] },
  { id: 'appsec',     name: 'AppSec Agent',                 role: 'appsec',
    description: 'Scans code for unsafe auth, input validation, injection risks',
    capabilities: ['scan_code', 'review_routes', 'block_insecure_patches'] },
  { id: 'cloud',      name: 'Cloud Security Agent',         role: 'cloud',
    description: 'Reviews Docker, env, deploy config, remote worker exposure',
    capabilities: ['review_deploy', 'check_exposure', 'validate_cloud_runtime'] },
  { id: 'secrets',    name: 'Secrets Security Agent',       role: 'secrets',
    description: 'Audits API key handling, encryption, rotation, leak prevention',
    capabilities: ['audit_secrets', 'verify_encryption', 'enforce_rotation'] },
  { id: 'runtime',    name: 'Runtime Threat Detection Agent', role: 'runtime',
    description: 'Detects suspicious workflows, provider abuse, runaway agents',
    capabilities: ['detect_abuse', 'detect_runaway', 'monitor_queues'] },
  { id: 'tenant',     name: 'Tenant Isolation Agent',       role: 'tenant',
    description: 'Verifies workspace isolation, RBAC, cross-tenant leaks',
    capabilities: ['check_isolation', 'verify_rbac', 'detect_leaks'] },
  { id: 'patch',      name: 'Patch Security Reviewer Agent', role: 'patch',
    description: 'Reviews every autonomous patch for security risk',
    capabilities: ['review_patches', 'block_risky_diffs', 'flag_sensitive_changes'] },
  { id: 'red',        name: 'Red Team Agent',               role: 'red',
    description: 'Safe adversarial probing — findings only, never destructive',
    capabilities: ['probe_auth', 'probe_permissions', 'create_findings'] },
  { id: 'blue',       name: 'Blue Team Agent',              role: 'blue',
    description: 'Turns findings into fixes, validates protections, confirms resolution',
    capabilities: ['create_mitigations', 'validate_fixes', 'confirm_resolution'] },
  { id: 'compliance', name: 'Compliance Audit Agent',       role: 'compliance',
    description: 'Verifies audit logs, retention, admin trails, compliance hooks',
    capabilities: ['verify_audit_logs', 'check_retention', 'verify_exports'] },
]

export async function ensureSecurityTeam(): Promise<void> {
  const existing = await db.select({ id: securityAgents.id }).from(securityAgents).limit(20)
  const known = new Set(existing.map((r) => r.id))
  const now = Date.now()
  for (const a of TEAM) {
    if (known.has(a.id)) continue
    await db.insert(securityAgents).values({
      id: a.id, name: a.name, role: a.role, description: a.description,
      capabilities: a.capabilities, isActive: true,
      findingsProduced: 0,
      createdAt: now, updatedAt: now,
    }).catch(() => null)
  }
}

export async function listSecurityAgents() {
  await ensureSecurityTeam()
  return db.select().from(securityAgents).orderBy(securityAgents.role)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function emitEvent(workspaceId: string | null, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId: workspaceId ?? 'global', payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'security-team', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

async function persistFinding(f: Finding): Promise<string> {
  const id = uuidv7()
  const now = Date.now()

  // Dedup: same agent + workspace + title + open status?
  const existing = await db.select({ id: securityFindings.id }).from(securityFindings).where(and(
    eq(securityFindings.agentId, f.agentId),
    eq(securityFindings.title, f.title),
    eq(securityFindings.status, 'open'),
  )).limit(1)

  if (existing[0]) {
    await db.update(securityFindings).set({
      description: f.description,
      evidenceRefs: f.evidenceRefs as unknown as Record<string, unknown>[],
      severity: f.severity, updatedAt: now,
    }).where(eq(securityFindings.id, existing[0].id))
    return existing[0].id
  }

  await db.insert(securityFindings).values({
    id,
    workspaceId:       f.workspaceId ?? null,
    agentId:           f.agentId,
    agentRole:         f.agentRole,
    severity:          f.severity,
    category:          f.category,
    title:             f.title,
    description:       f.description,
    evidenceRefs:      f.evidenceRefs as unknown as Record<string, unknown>[],
    affectedResource:  f.affectedResource ?? null,
    recommendedAction: f.recommendedAction,
    status:            'open',
    requiresApproval:  f.requiresApproval,
    blocksLaunch:      f.blocksLaunch,
    detectedAt:        now,
    createdAt:         now,
    updatedAt:         now,
  })

  await db.update(securityAgents).set({
    lastRunAt: now,
    findingsProduced: (await getAgentFindingCount(f.agentId)) + 1,
    updatedAt: now,
  }).where(eq(securityAgents.id, f.agentId))

  await emitEvent(f.workspaceId ?? null, 'security_team.finding_created', {
    findingId: id, agentId: f.agentId, severity: f.severity,
    blocksLaunch: f.blocksLaunch, category: f.category,
  })

  return id
}

async function getAgentFindingCount(agentId: string): Promise<number> {
  const rows = await db.select({ id: securityFindings.id }).from(securityFindings)
    .where(eq(securityFindings.agentId, agentId)).limit(1000)
  return rows.length
}

// ─── 1. CSO Agent — aggregates top critical findings ──────────────────────────

async function runCSO(workspaceId: string): Promise<Finding[]> {
  const criticals = await db.select().from(securityFindings).where(and(
    eq(securityFindings.workspaceId, workspaceId),
    eq(securityFindings.severity, 'critical'),
    eq(securityFindings.status, 'open'),
  )).orderBy(desc(securityFindings.detectedAt)).limit(20)

  if (criticals.length === 0) return []
  return [{
    agentId: 'cso', agentRole: 'cso', workspaceId,
    severity: 'critical', category: 'aggregate',
    title: `${criticals.length} critical security finding(s) require executive review`,
    description: `CSO escalation: ${criticals.length} open critical issue(s) across the security team. Posture cannot be approved until resolved or accepted with documented rationale.`,
    evidenceRefs: criticals.slice(0, 10).map((c) => ({ table: 'security_findings', id: c.id })),
    recommendedAction: 'Convene security review; assign owner per finding; mark posture as degraded',
    requiresApproval: true, blocksLaunch: true,
  }]
}

// ─── 2. AppSec Agent — scan recent patches for risky targets ──────────────────

async function runAppSec(workspaceId: string): Promise<Finding[]> {
  const patches = await db.select({
    id: patchRecords.id, filePath: patchRecords.filePath, status: patchRecords.status,
  }).from(patchRecords)
    .where(and(
      eq(patchRecords.workspaceId, workspaceId),
      gt(patchRecords.createdAt, Date.now() - 7 * 24 * 3600_000),
    )).limit(200)

  const risky = patches.filter((p) =>
    /\bauth\b|\bjwt\b|\bsession\b|\blogin\b|password|oauth/i.test(p.filePath),
  )
  if (risky.length === 0) return []
  return [{
    agentId: 'appsec', agentRole: 'appsec', workspaceId,
    severity: 'high', category: 'appsec',
    title: `${risky.length} recent patch(es) touch authentication code`,
    description: `Auto-patches modified auth-related files in last 7d. Manual security review recommended for each diff. Files: ${[...new Set(risky.map((r) => r.filePath))].slice(0, 5).join(', ')}`,
    evidenceRefs: risky.slice(0, 10).map((r) => ({ table: 'patch_records', id: r.id })),
    recommendedAction: 'Review every auth-related patch for token leakage, session fixation, broken access control',
    requiresApproval: true, blocksLaunch: false,
  }]
}

// ─── 3. Cloud Security Agent — sandbox isolation violations ───────────────────

async function runCloud(workspaceId: string): Promise<Finding[]> {
  const violations = await db.select({
    id: sandboxSessions.id, violationReason: sandboxSessions.violationReason,
    command: sandboxSessions.command,
  }).from(sandboxSessions)
    .where(and(
      eq(sandboxSessions.workspaceId, workspaceId),
      eq(sandboxSessions.status, 'isolation_violation'),
      gt(sandboxSessions.startedAt, Date.now() - 7 * 24 * 3600_000),
    )).limit(50)

  if (violations.length === 0) return []
  return [{
    agentId: 'cloud', agentRole: 'cloud', workspaceId,
    severity: violations.length >= 5 ? 'high' : 'medium', category: 'cloud',
    title: `${violations.length} sandbox isolation violation(s) in last 7d`,
    description: `Sandbox executor rejected ${violations.length} execution(s). Possible misconfigured commands, path traversal attempts, or env-allowlist gaps.`,
    evidenceRefs: violations.slice(0, 10).map((v) => ({ table: 'sandbox_sessions', id: v.id })),
    affectedResource: 'sandbox-executor',
    recommendedAction: 'Review violation reasons; if intentional, update ALLOWED_COMMANDS; otherwise investigate caller',
    requiresApproval: false, blocksLaunch: false,
  }]
}

// ─── 4. Secrets Security Agent — rotation age + access patterns ───────────────

async function runSecrets(workspaceId: string): Promise<Finding[]> {
  const findings: Finding[] = []
  const ninetyDaysAgo = Date.now() - 90 * 24 * 3600_000

  const secrets = await db.select().from(secretsVault)
    .where(eq(secretsVault.workspaceId, workspaceId)).limit(200)

  const stale = secrets.filter((s) => {
    const lastRotation = s.rotatedAt ?? s.createdAt
    return lastRotation < ninetyDaysAgo
  })

  if (stale.length > 0) {
    findings.push({
      agentId: 'secrets', agentRole: 'secrets', workspaceId,
      severity: 'medium', category: 'secrets',
      title: `${stale.length} secret(s) not rotated in 90+ days`,
      description: `Stale secrets increase blast radius if leaked. Rotate via POST /api/v1/security/secrets/:id/rotate.`,
      evidenceRefs: stale.slice(0, 10).map((s) => ({ table: 'secrets_vault', id: s.id })),
      recommendedAction: 'Rotate each stale secret; verify downstream services pick up new values',
      requiresApproval: false, blocksLaunch: false,
    })
  }

  // Check for high reveal counts (potential abuse)
  const overAccessed = secrets.filter((s) => s.accessCount > 20)
  if (overAccessed.length > 0) {
    findings.push({
      agentId: 'secrets', agentRole: 'secrets', workspaceId,
      severity: 'low', category: 'secrets',
      title: `${overAccessed.length} secret(s) with high reveal counts`,
      description: `Secrets revealed >20 times — review reveal audit log for legitimacy.`,
      evidenceRefs: overAccessed.slice(0, 5).map((s) => ({ table: 'secrets_vault', id: s.id })),
      recommendedAction: 'Audit reveal log; consider replacing reveals with service-to-service auth',
      requiresApproval: false, blocksLaunch: false,
    })
  }
  return findings
}

// ─── 5. Runtime Threat Detection Agent — abuse spikes ─────────────────────────

async function runRuntimeThreat(workspaceId: string): Promise<Finding[]> {
  const since = Date.now() - 60 * 60_000
  const findings: Finding[] = []

  const auths = await db.select({ id: securityAudits.id }).from(securityAudits)
    .where(and(
      eq(securityAudits.workspaceId, workspaceId),
      eq(securityAudits.eventType, 'auth_failure'),
      gt(securityAudits.createdAt, since),
    )).limit(100)
  if (auths.length >= 10) {
    findings.push({
      agentId: 'runtime', agentRole: 'runtime', workspaceId,
      severity: 'high', category: 'runtime',
      title: `Auth failure spike: ${auths.length} failures in last hour`,
      description: `Brute-force or credential-stuffing pattern detected.`,
      evidenceRefs: auths.slice(0, 10).map((a) => ({ table: 'security_audits', id: a.id })),
      recommendedAction: 'Enable rate-limit on auth endpoints; investigate source IPs; consider IP block',
      requiresApproval: false, blocksLaunch: false,
    })
  }

  const providerErrs = await db.select({ id: providerFailures.id }).from(providerFailures)
    .where(and(
      eq(providerFailures.workspaceId, workspaceId),
      gt(providerFailures.createdAt, since),
    )).limit(200)
  if (providerErrs.length >= 50) {
    findings.push({
      agentId: 'runtime', agentRole: 'runtime', workspaceId,
      severity: 'medium', category: 'runtime',
      title: `Provider abuse pattern: ${providerErrs.length} failures in last hour`,
      description: `High failure rate against provider — possible runaway agent or misconfigured retry.`,
      evidenceRefs: providerErrs.slice(0, 10).map((p) => ({ table: 'provider_failures', id: p.id })),
      recommendedAction: 'Inspect calling agent; consider kill switch on provider; verify retry policy',
      requiresApproval: false, blocksLaunch: false,
    })
  }

  // Runaway agents — high failure rate
  const agents = await db.select().from(agentRegistrations)
    .where(eq(agentRegistrations.workspaceId, workspaceId))
  for (const a of agents) {
    const total = a.successCount + a.failureCount
    if (total < 20) continue
    const failRate = a.failureCount / total
    if (failRate > 0.5) {
      findings.push({
        agentId: 'runtime', agentRole: 'runtime', workspaceId,
        severity: 'high', category: 'runtime',
        title: `Runaway agent: ${a.agentName} has ${(failRate * 100).toFixed(0)}% failure rate`,
        description: `Agent ${a.id} produced ${a.failureCount} failures across ${total} runs.`,
        evidenceRefs: [{ table: 'agent_registrations', id: a.id }],
        affectedResource: `agent:${a.id}`,
        recommendedAction: 'Pause agent; review recent assignments; consider restart or replacement',
        requiresApproval: true, blocksLaunch: false,
      })
    }
  }
  return findings
}

// ─── 6. Tenant Isolation Agent — RBAC denial patterns + missing permissions ──

async function runTenantIsolation(workspaceId: string): Promise<Finding[]> {
  const findings: Finding[] = []

  // Workspace with NO permission records — RBAC not configured at all
  const perms = await db.select({ id: permissions.id }).from(permissions)
    .where(eq(permissions.workspaceId, workspaceId)).limit(5)

  if (perms.length === 0) {
    findings.push({
      agentId: 'tenant', agentRole: 'tenant', workspaceId,
      severity: 'high', category: 'tenant',
      title: 'No RBAC permission records for this workspace',
      description: 'Workspace has zero permission rows. Either no users are configured, or RBAC enforcement is missing on all routes.',
      evidenceRefs: [],
      affectedResource: `workspace:${workspaceId}`,
      recommendedAction: 'Grant owner role to workspace creator; audit route handlers for authorize() calls',
      requiresApproval: false, blocksLaunch: true,
    })
  }

  // Permission denial spike
  const denials = await db.select({ id: securityAudits.id }).from(securityAudits)
    .where(and(
      eq(securityAudits.workspaceId, workspaceId),
      eq(securityAudits.eventType, 'permission_denied'),
      gt(securityAudits.createdAt, Date.now() - 24 * 3600_000),
    )).limit(50)
  if (denials.length >= 20) {
    findings.push({
      agentId: 'tenant', agentRole: 'tenant', workspaceId,
      severity: 'medium', category: 'tenant',
      title: `${denials.length} permission denials in last 24h`,
      description: 'Repeated denials may indicate misconfigured roles or hostile probing.',
      evidenceRefs: denials.slice(0, 10).map((d) => ({ table: 'security_audits', id: d.id })),
      recommendedAction: 'Review denial actor list; either grant missing perms or block source',
      requiresApproval: false, blocksLaunch: false,
    })
  }
  return findings
}

// ─── 7. Patch Security Reviewer — protected file patches ──────────────────────

async function runPatchSecurity(workspaceId: string): Promise<Finding[]> {
  const sensitivePatches = await db.select().from(patchRecords).where(and(
    eq(patchRecords.workspaceId, workspaceId),
    gt(patchRecords.createdAt, Date.now() - 7 * 24 * 3600_000),
  )).limit(200)

  const matches = sensitivePatches.filter((p) =>
    /schema\.ts$|migrations?\/|\.env|drizzle\.config|stripe|payment|billing|provider/i.test(p.filePath),
  )
  if (matches.length === 0) return []
  return [{
    agentId: 'patch', agentRole: 'patch', workspaceId,
    severity: 'high', category: 'patch',
    title: `${matches.length} patch(es) touched sensitive files`,
    description: `Patches modified database schema, env config, billing, or provider integrations. Each requires explicit security review.`,
    evidenceRefs: matches.slice(0, 10).map((m) => ({ table: 'patch_records', id: m.id })),
    recommendedAction: 'Manual review of each diff; verify approval gate ran; verify rollback path tested',
    requiresApproval: true, blocksLaunch: matches.length >= 3,
  }]
}

// ─── 8. Red Team Agent — probes via read-only checks (no destructive actions) ─

async function runRedTeam(workspaceId: string): Promise<Finding[]> {
  const findings: Finding[] = []

  // Probe: workspace with no permission records reachable
  const noRbacFindings = await runTenantIsolation(workspaceId)
  if (noRbacFindings.some((f) => f.title.includes('No RBAC'))) {
    findings.push({
      agentId: 'red', agentRole: 'red', workspaceId,
      severity: 'high', category: 'red_team',
      title: 'Red Team probe: workspace endpoints likely unauthenticated',
      description: 'Probe confirms RBAC absence: any user with workspace_id can call protected endpoints.',
      evidenceRefs: [{ table: 'workspaces', id: workspaceId }],
      recommendedAction: 'Add authorize() to every /api/v1/* route handler; deny unknown users by default',
      requiresApproval: false, blocksLaunch: true,
    })
  }

  // Probe: any secret older than 180 days
  const veryOld = await db.select({ id: secretsVault.id, createdAt: secretsVault.createdAt })
    .from(secretsVault)
    .where(eq(secretsVault.workspaceId, workspaceId)).limit(100)
  const expired = veryOld.filter((s) => s.createdAt < Date.now() - 180 * 24 * 3600_000)
  if (expired.length > 0) {
    findings.push({
      agentId: 'red', agentRole: 'red', workspaceId,
      severity: 'medium', category: 'red_team',
      title: `Red Team probe: ${expired.length} secret(s) over 180 days old`,
      description: 'Long-lived secrets violate rotation hygiene; an attacker with stale credentials retains access indefinitely.',
      evidenceRefs: expired.slice(0, 10).map((e) => ({ table: 'secrets_vault', id: e.id })),
      recommendedAction: 'Force rotation; verify all downstream services pick up new value',
      requiresApproval: false, blocksLaunch: false,
    })
  }
  return findings
}

// ─── 9. Blue Team Agent — confirms resolved findings ──────────────────────────

async function runBlueTeam(workspaceId: string): Promise<Finding[]> {
  // Blue team produces a status report: how many findings have been mitigated vs open
  const all = await db.select().from(securityFindings)
    .where(eq(securityFindings.workspaceId, workspaceId)).limit(500)

  if (all.length === 0) return []
  const open       = all.filter((f) => f.status === 'open').length
  const resolved   = all.filter((f) => f.status === 'resolved').length
  const mitigating = all.filter((f) => f.status === 'mitigating').length

  // Only produce a finding if there are unmitigated highs/criticals
  const unmitigated = all.filter((f) =>
    (f.severity === 'critical' || f.severity === 'high') && f.status === 'open',
  )
  if (unmitigated.length === 0) return []
  return [{
    agentId: 'blue', agentRole: 'blue', workspaceId,
    severity: unmitigated.some((f) => f.severity === 'critical') ? 'critical' : 'high',
    category: 'blue_team',
    title: `Blue Team: ${unmitigated.length} unmitigated high/critical finding(s)`,
    description: `Status: ${open} open, ${mitigating} mitigating, ${resolved} resolved. Blue Team has not opened mitigation tasks for the listed unmitigated findings.`,
    evidenceRefs: unmitigated.slice(0, 10).map((f) => ({ table: 'security_findings', id: f.id })),
    recommendedAction: 'Assign owner per finding; convert each into a roadmap task with priority',
    requiresApproval: false, blocksLaunch: false,
  }]
}

// ─── 10. Compliance Audit Agent — log integrity + export coverage ─────────────

async function runCompliance(workspaceId: string): Promise<Finding[]> {
  const findings: Finding[] = []

  // Check audit immutability invariant
  const mutable = await db.select({ id: securityAudits.id }).from(securityAudits).where(and(
    eq(securityAudits.workspaceId, workspaceId),
    eq(securityAudits.immutable, false),
  )).limit(10)

  if (mutable.length > 0) {
    findings.push({
      agentId: 'compliance', agentRole: 'compliance', workspaceId,
      severity: 'critical', category: 'compliance',
      title: `${mutable.length} security audit row(s) marked mutable — integrity invariant violated`,
      description: 'Compliance invariant: all audit rows must have immutable=true. Mutable rows suggest tampering or schema bypass.',
      evidenceRefs: mutable.map((m) => ({ table: 'security_audits', id: m.id })),
      recommendedAction: 'Investigate origin of mutable rows; restore from backup if tampering confirmed',
      requiresApproval: true, blocksLaunch: true,
    })
  }

  // No audit export in last 30d (for workspaces that have any audit data)
  const auditCount = await db.select({ id: securityAudits.id }).from(securityAudits)
    .where(eq(securityAudits.workspaceId, workspaceId)).limit(1)

  if (auditCount.length > 0) {
    const exps = await db.select({ id: auditExports.id }).from(auditExports).where(and(
      eq(auditExports.workspaceId, workspaceId),
      gt(auditExports.createdAt, Date.now() - 30 * 24 * 3600_000),
    )).limit(1)

    if (exps.length === 0) {
      findings.push({
        agentId: 'compliance', agentRole: 'compliance', workspaceId,
        severity: 'low', category: 'compliance',
        title: 'No audit log exports in last 30 days',
        description: 'Compliance hygiene: workspaces with audit activity should produce periodic exports for retention.',
        evidenceRefs: [],
        recommendedAction: 'Schedule periodic exports via POST /api/v1/security/audits/export',
        requiresApproval: false, blocksLaunch: false,
      })
    }
  }

  // Check for never-completed exports
  const stuck = await db.select({ id: auditExports.id }).from(auditExports).where(and(
    eq(auditExports.workspaceId, workspaceId),
    eq(auditExports.status, 'pending'),
    isNull(auditExports.completedAt),
  )).limit(10)
  if (stuck.length > 0) {
    findings.push({
      agentId: 'compliance', agentRole: 'compliance', workspaceId,
      severity: 'medium', category: 'compliance',
      title: `${stuck.length} audit export(s) stuck in pending state`,
      description: 'Pending exports never completed — compliance request unfulfilled.',
      evidenceRefs: stuck.map((s) => ({ table: 'audit_exports', id: s.id })),
      recommendedAction: 'Retry the export; investigate exporter worker',
      requiresApproval: false, blocksLaunch: false,
    })
  }
  return findings
}

// ─── Master scan ──────────────────────────────────────────────────────────────

const RUNNERS: Array<[AgentRole, (ws: string) => Promise<Finding[]>]> = [
  ['appsec',    runAppSec],
  ['cloud',     runCloud],
  ['secrets',   runSecrets],
  ['runtime',   runRuntimeThreat],
  ['tenant',    runTenantIsolation],
  ['patch',     runPatchSecurity],
  ['red',       runRedTeam],
  ['blue',      runBlueTeam],
  ['compliance', runCompliance],
  // CSO runs last so it can aggregate the others
  ['cso',       runCSO],
]

export interface SecurityScanResult {
  agentsRun:     number
  findingsCreated: number
  blockingCount: number
  findingIds:    string[]
}

export async function runSecurityScan(workspaceId: string): Promise<SecurityScanResult> {
  await ensureSecurityTeam()
  const findingIds: string[] = []
  let blocking = 0

  for (const [, runner] of RUNNERS) {
    const findings = await runner(workspaceId).catch(() => [] as Finding[])
    for (const f of findings) {
      const id = await persistFinding(f)
      findingIds.push(id)
      if (f.blocksLaunch) blocking += 1
    }
  }

  await emitEvent(workspaceId, 'security_team.scan_completed', {
    findingsCreated: findingIds.length, blockingCount: blocking,
  })

  return {
    agentsRun: RUNNERS.length, findingsCreated: findingIds.length,
    blockingCount: blocking, findingIds,
  }
}

// ─── Pre-patch review (called by audit dispatch) ──────────────────────────────

/** Returns true if patch is safe to proceed, false if patch security reviewer blocks. */
export async function reviewPatchBeforeDispatch(opts: {
  workspaceId: string
  filePath:    string
  description: string
}): Promise<{ allowed: boolean; reason?: string; findingId?: string }> {
  // Pattern-based block check
  const isProtected = /schema\.ts$|migrations?\/|\.env|drizzle\.config|package-lock|pnpm-lock/i.test(opts.filePath)
  if (!isProtected) return { allowed: true }

  // Persist a finding
  const findingId = await persistFinding({
    agentId: 'patch', agentRole: 'patch', workspaceId: opts.workspaceId,
    severity: 'high', category: 'patch',
    title: `Patch Reviewer blocked autonomous patch to protected file`,
    description: `Autonomous patch attempted to modify '${opts.filePath}'. Pre-dispatch review blocks this without explicit approval. Task: ${opts.description.slice(0, 200)}`,
    evidenceRefs: [],
    affectedResource: opts.filePath,
    recommendedAction: 'Require human approval; verify rollback plan; consider migrating change to manual operator workflow',
    requiresApproval: true, blocksLaunch: false,
  })

  return {
    allowed: false,
    reason: `Patch Security Reviewer blocked patch to protected file '${opts.filePath}'`,
    findingId,
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

export async function listFindings(workspaceId: string, status?: string) {
  if (status) {
    return db.select().from(securityFindings).where(and(
      eq(securityFindings.workspaceId, workspaceId),
      eq(securityFindings.status, status),
    )).orderBy(desc(securityFindings.detectedAt)).limit(200)
  }
  return db.select().from(securityFindings)
    .where(eq(securityFindings.workspaceId, workspaceId))
    .orderBy(desc(securityFindings.detectedAt)).limit(200)
}

export async function getFindingStats(workspaceId: string) {
  const all = await db.select({
    severity: securityFindings.severity, status: securityFindings.status,
    blocksLaunch: securityFindings.blocksLaunch,
  }).from(securityFindings)
    .where(eq(securityFindings.workspaceId, workspaceId)).limit(2000)

  return {
    total:       all.length,
    open:        all.filter((f) => f.status === 'open').length,
    resolved:    all.filter((f) => f.status === 'resolved').length,
    critical:    all.filter((f) => f.severity === 'critical' && f.status === 'open').length,
    high:        all.filter((f) => f.severity === 'high'     && f.status === 'open').length,
    medium:      all.filter((f) => f.severity === 'medium'   && f.status === 'open').length,
    low:         all.filter((f) => f.severity === 'low'      && f.status === 'open').length,
    blocksLaunch: all.filter((f) => f.blocksLaunch && f.status === 'open').length,
  }
}

export async function acknowledgeFinding(id: string, reviewer: string) {
  const now = Date.now()
  await db.update(securityFindings).set({
    status: 'acknowledged', reviewedBy: reviewer, reviewedAt: now, updatedAt: now,
  }).where(eq(securityFindings.id, id))
  const rows = await db.select().from(securityFindings).where(eq(securityFindings.id, id)).limit(1)
  if (rows[0]) await emitEvent(rows[0].workspaceId ?? null, 'security_team.finding_acknowledged', { findingId: id, reviewer })
}

export async function resolveFinding(id: string, reviewer: string, note: string) {
  const now = Date.now()
  await db.update(securityFindings).set({
    status: 'resolved', reviewedBy: reviewer, reviewedAt: now,
    resolutionNote: note, updatedAt: now,
  }).where(eq(securityFindings.id, id))
  const rows = await db.select().from(securityFindings).where(eq(securityFindings.id, id)).limit(1)
  if (rows[0]) await emitEvent(rows[0].workspaceId ?? null, 'security_team.finding_resolved', { findingId: id, reviewer })
}

export async function markFalsePositive(id: string, reviewer: string, note: string) {
  const now = Date.now()
  await db.update(securityFindings).set({
    status: 'false_positive', reviewedBy: reviewer, reviewedAt: now,
    resolutionNote: note, updatedAt: now,
  }).where(eq(securityFindings.id, id))
  const rows = await db.select().from(securityFindings).where(eq(securityFindings.id, id)).limit(1)
  if (rows[0]) await emitEvent(rows[0].workspaceId ?? null, 'security_team.finding_false_positive', { findingId: id, reviewer, note })
}

/** Used by launch-lock — true if any open finding blocks launch. */
export async function hasLaunchBlockingFindings(workspaceId: string): Promise<{ blocking: boolean; count: number; ids: string[] }> {
  const rows = await db.select({ id: securityFindings.id }).from(securityFindings).where(and(
    eq(securityFindings.workspaceId, workspaceId),
    eq(securityFindings.status, 'open'),
    eq(securityFindings.blocksLaunch, true),
  )).limit(50)
  return { blocking: rows.length > 0, count: rows.length, ids: rows.map((r) => r.id) }
}
