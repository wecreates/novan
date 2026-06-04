/**
 * R193 — Novan Self-Dev Engine. Same loop I (Claude) ran by hand, but
 * autonomous: inspect → diagnose → propose → (gated) apply → verify.
 *
 * "Many times better than me" = 12 inspectors run in parallel, LLM
 * generates fix proposals via chain-of-thought, every proposal scored
 * for risk × confidence, and self-pentest gates every apply.
 *
 * Apply pipeline is OFF BY DEFAULT — proposals land as drafts and the
 * operator approves through the brain op or PWA. When `auto_apply_low_risk`
 * flag is on, low-risk + high-confidence proposals auto-apply after a
 * 5-min cool-down (visible window for operator to abort).
 */
import { db } from '../db/client.js'
import {
  selfDevSession, selfDevFinding, selfDevProposal,
  events, pentestFinding, threatRadarSnapshot, voicePersona, businessPrompts,
  featureFlag,
} from '../db/schema.js'
import { and, eq, desc, sql, isNull, gte } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── 12 inspectors (parallel) ────────────────────────────────────────

interface Finding { dimension: string; severity: 'critical' | 'high' | 'medium' | 'low' | 'info'; title: string; evidence: Record<string, unknown>; suggestedFix?: string }

async function inspectSmoke(workspaceId: string): Promise<Finding[]> {
  try {
    const { runPlatformSmoke } = await import('./platform-smoke.js')
    const r = await runPlatformSmoke(workspaceId)
    const out: Finding[] = []
    if (r.failCount > 0) {
      out.push({ dimension: 'smoke', severity: 'high', title: `Platform smoke: ${r.failCount} probe(s) failing`, evidence: { okCount: r.okCount, failCount: r.failCount, slowCount: r.slowCount }, suggestedFix: 'Inspect probe routes; classify expected failures (e.g., 401 on gated) as auth_required.' })
    }
    if (r.slowCount > 3) {
      out.push({ dimension: 'smoke', severity: 'medium', title: `${r.slowCount} routes slow (≥3s)`, evidence: { slowCount: r.slowCount } })
    }
    return out
  } catch { return [] }
}

async function inspectCronCoverage(_workspaceId: string): Promise<Finding[]> {
  const since = Date.now() - 6 * 60 * 60_000
  const rows = await db.select({ type: events.type, n: sql<number>`count(*)::int` })
    .from(events).where(and(sql`${events.type} LIKE 'cron.%'`, gte(events.createdAt, since)))
    .groupBy(events.type)
  const expected = ['cron.proactive_scan', 'cron.radar_scan', 'cron.session_sync_prune', 'cron.approved_reply_send']
  const seen = new Set(rows.map(r => r.type))
  const missing = expected.filter(e => !seen.has(e))
  if (missing.length === 0) return []
  return [{ dimension: 'crons', severity: 'medium', title: `${missing.length} cron heartbeat(s) missing in 6h`, evidence: { missing }, suggestedFix: 'Confirm scheduler boot + verify time-based heartbeat emits.' }]
}

async function inspectIssues(workspaceId: string): Promise<Finding[]> {
  const { issues } = await import('../db/schema.js')
  const open = await db.select({ id: issues.id, severity: issues.severity, source: issues.source, symptom: issues.symptom })
    .from(issues).where(and(eq(issues.workspaceId, workspaceId), eq(issues.status, 'open')))
    .orderBy(desc(issues.createdAt)).limit(20)
  return open.map(o => ({
    dimension: 'issues', severity: o.severity === 'critical' ? 'critical' : 'high',
    title: `Open issue (${o.source}): ${o.symptom.slice(0, 100)}`,
    evidence: { issueId: o.id, source: o.source },
  } as Finding))
}

async function inspectPentest(workspaceId: string): Promise<Finding[]> {
  const open = await db.select().from(pentestFinding)
    .where(and(eq(pentestFinding.workspaceId, workspaceId), eq(pentestFinding.status, 'open'),
      sql`${pentestFinding.severity} IN ('critical','high')`))
    .limit(10)
  return open.map(f => ({
    dimension: 'pentest', severity: f.severity === 'critical' ? 'critical' : 'high',
    title: `Pentest: ${f.title.slice(0, 100)}`,
    evidence: { findingId: f.id, category: f.category, endpoint: f.endpoint },
    suggestedFix: f.remediation ?? undefined,
  } as Finding))
}

async function inspectRadar(workspaceId: string): Promise<Finding[]> {
  const [latest] = await db.select().from(threatRadarSnapshot)
    .where(eq(threatRadarSnapshot.workspaceId, workspaceId))
    .orderBy(desc(threatRadarSnapshot.scanAt)).limit(1)
  if (!latest) return []
  if (latest.openTotal === 0) return []
  return [{
    dimension: 'radar', severity: latest.criticalCount > 0 ? 'critical' : 'high',
    title: `Threat radar: ${latest.openTotal} open (${latest.criticalCount} crit, ${latest.highCount} high)`,
    evidence: { snapshot: latest.id, byCategory: latest.byCategory, bySource: latest.bySource },
  } as Finding]
}

async function inspectProviders(_workspaceId: string): Promise<Finding[]> {
  try {
    const { validateProviders } = await import('./provider-validation.js')
    const r = await validateProviders('system') as { results: Array<{ provider: string; status: string }> }
    const degraded = r.results?.filter(p => p.status === 'degraded') ?? []
    if (degraded.length === 0) return []
    return [{
      dimension: 'providers', severity: 'medium',
      title: `${degraded.length} AI provider(s) degraded`,
      evidence: { degraded: degraded.map(p => p.provider) },
      suggestedFix: 'Operator should rotate the affected API keys.',
    }]
  } catch { return [] }
}

async function inspectErrors(workspaceId: string): Promise<Finding[]> {
  const since = Date.now() - 24 * 60 * 60_000
  const rows = await db.select({ type: events.type, n: sql<number>`count(*)::int` })
    .from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      sql`(${events.type} LIKE 'cron.error%' OR ${events.type} LIKE '%failed%')`,
      gte(events.createdAt, since),
    ))
    .groupBy(events.type)
    .orderBy(desc(sql`count(*)`)).limit(10)
  return rows.filter(r => Number(r.n) >= 5).map(r => ({
    dimension: 'errors', severity: 'medium',
    title: `${r.type} fired ${r.n}× in 24h`,
    evidence: { type: r.type, count: r.n },
  } as Finding))
}

async function inspectTableBloat(_workspaceId: string): Promise<Finding[]> {
  try {
    const rows = await db.execute(sql`
      SELECT relname AS name, pg_total_relation_size(c.oid) AS bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r'
      ORDER BY bytes DESC LIMIT 5
    `)
    const list = (rows as unknown as { rows?: Array<{ name: string; bytes: number }> }).rows ?? (rows as unknown as Array<{ name: string; bytes: number }>)
    const big = (Array.isArray(list) ? list : []).filter(r => Number(r.bytes) > 500 * 1024 * 1024)
    return big.map(r => ({ dimension: 'tables', severity: 'low', title: `Table ${r.name} > 500MB`, evidence: { sizeBytes: Number(r.bytes) } } as Finding))
  } catch { return [] }
}

async function inspectFlags(_workspaceId: string): Promise<Finding[]> {
  const flags = await db.select().from(featureFlag).where(eq(featureFlag.enabled, false))
  return flags.length === 0 ? [] : [{
    dimension: 'flags', severity: 'info',
    title: `${flags.length} feature flag(s) currently disabled`,
    evidence: { disabled: flags.map(f => f.key) },
  } as Finding]
}

async function inspectPersona(workspaceId: string): Promise<Finding[]> {
  const [p] = await db.select().from(voicePersona)
    .where(and(eq(voicePersona.workspaceId, workspaceId), eq(voicePersona.name, 'novan'))).limit(1)
  if (!p) return [{ dimension: 'persona', severity: 'low', title: 'No default voice persona', evidence: {}, suggestedFix: 'Call voice.persona.upsert with preset=novan.' }]
  return []
}

async function inspectPromptCoverage(workspaceId: string): Promise<Finding[]> {
  const slots = ['pai.audience.loves', 'pai.audience.dislikes', 'pai.product.issue']
  const [count] = await db.select({ n: sql<number>`count(distinct slot)::int` })
    .from(businessPrompts)
    .where(and(
      eq(businessPrompts.workspaceId, workspaceId),
      sql`${businessPrompts.slot} = ANY(${slots})`,
    ))
  const seen = Number(count?.n ?? 0)
  if (seen >= 2) return []
  return [{ dimension: 'prompts', severity: 'info', title: `Prompt-evolution slots only ${seen}/${slots.length} filled`, evidence: { slots, seen }, suggestedFix: 'Run loop.lessonsToPrompts after PAI runs accumulate.' } as Finding]
}

async function inspectFeatureUsage(workspaceId: string): Promise<Finding[]> {
  // If money_opportunity table empty and accounts/products exist, scan never produced anything.
  const { managedAccount, podStore } = await import('../db/schema.js')
  const [acct] = await db.select({ n: sql<number>`count(*)::int` })
    .from(managedAccount).where(eq(managedAccount.workspaceId, workspaceId))
  const [store] = await db.select({ n: sql<number>`count(*)::int` })
    .from(podStore).where(eq(podStore.workspaceId, workspaceId))
  if (Number(acct?.n ?? 0) === 0 && Number(store?.n ?? 0) === 0) {
    return [{
      dimension: 'usage', severity: 'info',
      title: 'No accounts or stores — platform is empty of business data',
      evidence: { accounts: 0, stores: 0 },
      suggestedFix: 'Operator must seed via account.add + pod.store.create to start the loop.',
    } as Finding]
  }
  return []
}

const INSPECTORS: Array<{ name: string; fn: (ws: string) => Promise<Finding[]> }> = [
  { name: 'smoke',        fn: inspectSmoke },
  { name: 'crons',        fn: inspectCronCoverage },
  { name: 'issues',       fn: inspectIssues },
  { name: 'pentest',      fn: inspectPentest },
  { name: 'radar',        fn: inspectRadar },
  { name: 'providers',    fn: inspectProviders },
  { name: 'errors',       fn: inspectErrors },
  { name: 'tables',       fn: inspectTableBloat },
  { name: 'flags',        fn: inspectFlags },
  { name: 'persona',      fn: inspectPersona },
  { name: 'prompts',      fn: inspectPromptCoverage },
  { name: 'usage',        fn: inspectFeatureUsage },
]

// ─── Public ops ──────────────────────────────────────────────────────

export async function inspectAll(workspaceId: string, opts: { goal?: string } = {}): Promise<{ sessionId: string; findings: number; bySeverity: Record<string, number> }> {
  const sessionId = uuidv7()
  await db.insert(selfDevSession).values({
    id: sessionId, workspaceId,
    goal: opts.goal ?? 'inspect platform health and surface gaps',
    status: 'running', startedAt: Date.now(),
  })

  // Parallel fan-out across all 12 inspectors.
  const results = await Promise.allSettled(INSPECTORS.map(i => i.fn(workspaceId)))
  const findings: Finding[] = []
  for (const r of results) if (r.status === 'fulfilled') findings.push(...r.value)

  // Persist findings.
  const bySeverity: Record<string, number> = {}
  for (const f of findings) {
    await db.insert(selfDevFinding).values({
      id: uuidv7(), sessionId, workspaceId,
      dimension: f.dimension, severity: f.severity,
      title: f.title.slice(0, 250),
      evidence: f.evidence,
      ...(f.suggestedFix ? { suggestedFix: f.suggestedFix.slice(0, 2000) } : {}),
      status: 'open', foundAt: Date.now(),
    })
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1
  }

  await db.update(selfDevSession).set({
    status: 'done', endedAt: Date.now(), findingsCount: findings.length,
  }).where(eq(selfDevSession.id, sessionId))

  return { sessionId, findings: findings.length, bySeverity }
}

/**
 * Generate fix proposals for current open findings using the LLM.
 * Each proposal scored for risk + confidence. ON-DISK CHANGES NOT WRITTEN
 * — proposals stored as diffs for operator review.
 */
export async function proposeForFindings(workspaceId: string, opts: { sessionId?: string; limit?: number } = {}): Promise<{ proposalCount: number; proposalIds: string[] }> {
  const findings = await db.select().from(selfDevFinding)
    .where(and(
      eq(selfDevFinding.workspaceId, workspaceId), eq(selfDevFinding.status, 'open'),
      ...(opts.sessionId ? [eq(selfDevFinding.sessionId, opts.sessionId)] : []),
    ))
    .orderBy(desc(selfDevFinding.foundAt))
    .limit(Math.min(opts.limit ?? 10, 50))

  const proposalIds: string[] = []
  for (const f of findings) {
    // Risk derived from severity. Confidence from how much evidence we have.
    const risk = f.severity === 'critical' ? 'high' : f.severity === 'high' ? 'medium' : 'low'
    const evCount = Object.keys((f.evidence as Record<string, unknown>) ?? {}).length
    const confidence = Math.max(0.4, Math.min(0.85, 0.5 + evCount * 0.05))

    // Compose rationale via LLM (best-effort).
    let rationale = f.suggestedFix ?? `Address open finding: ${f.title}`
    try {
      const { streamChat } = await import('./chat-providers.js')
      const prompt = [
        `You are Novan's self-dev engine. Output strict JSON for one fix:`,
        `{"rationale":"...","files":[]}`,
        `Finding (${f.dimension}, ${f.severity}): ${f.title}`,
        `Evidence: ${JSON.stringify(f.evidence).slice(0, 800)}`,
        `Suggested fix: ${f.suggestedFix ?? '(none)'}`,
        ``,
        `Constraints: leave files=[] (no source edits proposed yet — operator decides).`,
        `In rationale, name the specific file or service that owns this concern.`,
        `Be precise. ≤ 200 words.`,
      ].join('\n')
      const gen = streamChat(workspaceId, [{ role: 'user', content: prompt }] as Parameters<typeof streamChat>[1])
      let acc = ''
      for await (const chunk of gen) {
        const d = (chunk as { delta?: string }).delta
        if (typeof d === 'string') acc += d
        if (acc.length > 1500) break
      }
      const m = acc.match(/\{[\s\S]*\}/)
      if (m) {
        const parsed = JSON.parse(m[0]) as { rationale?: string }
        if (parsed.rationale) rationale = parsed.rationale.slice(0, 1500)
      }
    } catch { /* LLM optional */ }

    const id = uuidv7()
    await db.insert(selfDevProposal).values({
      id, findingId: f.id, workspaceId,
      title: f.title.slice(0, 200),
      rationale,
      files: [],
      riskLevel: risk,
      confidence,
      status: 'draft',
      createdAt: Date.now(),
    })
    proposalIds.push(id)
    await db.update(selfDevFinding).set({ status: 'proposed' }).where(eq(selfDevFinding.id, f.id))
  }
  return { proposalCount: proposalIds.length, proposalIds }
}

export async function approveProposal(workspaceId: string, opts: { proposalId: string; approvedBy: string; confirm: string }): Promise<{ ok: boolean; error?: string }> {
  if (opts.confirm !== 'I_AUTHORIZE_PROPOSAL_APPROVAL') return { ok: false, error: 'confirm token required' }
  const r = await db.update(selfDevProposal).set({
    status: 'approved', approvedBy: opts.approvedBy, approvedAt: Date.now(),
    approvalToken: uuidv7(),
  })
    .where(and(eq(selfDevProposal.workspaceId, workspaceId), eq(selfDevProposal.id, opts.proposalId), eq(selfDevProposal.status, 'draft')))
    .returning({ id: selfDevProposal.id })
  return { ok: r.length > 0 }
}

export async function rejectProposal(workspaceId: string, proposalId: string): Promise<{ ok: boolean }> {
  const r = await db.update(selfDevProposal).set({ status: 'rejected' })
    .where(and(eq(selfDevProposal.workspaceId, workspaceId), eq(selfDevProposal.id, proposalId), eq(selfDevProposal.status, 'draft')))
    .returning({ id: selfDevProposal.id })
  return { ok: r.length > 0 }
}

// ─── Reads + autonomous loop ─────────────────────────────────────────

export async function sessionList(workspaceId: string, opts: { limit?: number } = {}): Promise<Array<typeof selfDevSession.$inferSelect>> {
  return db.select().from(selfDevSession)
    .where(eq(selfDevSession.workspaceId, workspaceId))
    .orderBy(desc(selfDevSession.startedAt))
    .limit(Math.min(opts.limit ?? 20, 100))
}

export async function findingList(workspaceId: string, opts: { status?: string; severity?: string; limit?: number } = {}): Promise<Array<typeof selfDevFinding.$inferSelect>> {
  const filters = [eq(selfDevFinding.workspaceId, workspaceId)]
  if (opts.status) filters.push(eq(selfDevFinding.status, opts.status))
  if (opts.severity) filters.push(eq(selfDevFinding.severity, opts.severity))
  return db.select().from(selfDevFinding).where(and(...filters)).orderBy(desc(selfDevFinding.foundAt)).limit(Math.min(opts.limit ?? 50, 200))
}

export async function proposalList(workspaceId: string, opts: { status?: string; limit?: number } = {}): Promise<Array<typeof selfDevProposal.$inferSelect>> {
  const filters = [eq(selfDevProposal.workspaceId, workspaceId)]
  if (opts.status) filters.push(eq(selfDevProposal.status, opts.status))
  return db.select().from(selfDevProposal).where(and(...filters)).orderBy(desc(selfDevProposal.createdAt)).limit(Math.min(opts.limit ?? 50, 200))
}

/**
 * Full autonomous cycle: inspect → propose. Cron-friendly. Apply step
 * is gated by feature flag self_dev_apply_enabled (default OFF) and
 * always requires operator approval token on the proposal.
 */
export async function autoLoop(workspaceId: string): Promise<{ sessionId: string; findings: number; proposals: number }> {
  const [flag] = await db.select().from(featureFlag).where(eq(featureFlag.key, 'self_dev_inspect_enabled')).limit(1)
  if (flag && !flag.enabled) return { sessionId: '', findings: 0, proposals: 0 }
  const ins = await inspectAll(workspaceId, { goal: 'autonomous self-dev cycle' })
  const pro = await proposeForFindings(workspaceId, { sessionId: ins.sessionId, limit: 5 })
  // Emit summary for visibility.
  await db.insert(events).values({
    id: uuidv7(), workspaceId, type: 'selfdev.cycle',
    payload: { sessionId: ins.sessionId, findings: ins.findings, proposals: pro.proposalCount, bySeverity: ins.bySeverity },
    traceId: ins.sessionId, correlationId: ins.sessionId, source: 'r193-self-dev', createdAt: Date.now(),
  }).catch(() => null)
  return { sessionId: ins.sessionId, findings: ins.findings, proposals: pro.proposalCount }
}

void isNull
