/**
 * governance-engine.ts — constitutional rules + escalation policies.
 *
 * Every action the brain considers passes through governance.check()
 * before execution. Returns:
 *   • allow  — proceed
 *   • approve — requires operator approval first
 *   • escalate — surface to operator as a decision, don't auto-act
 *   • block  — never do this, even with approval
 *
 * Rules are stored per-workspace and seed defaults on first read.
 */

import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

export type Verdict = 'allow' | 'approve' | 'escalate' | 'block'

export interface GovernanceRule {
  id: string
  workspaceId: string
  name: string
  /** Regex matched against op name or description; defaults to op exact-match. */
  matcher: string
  verdict: Verdict
  reason: string
  priority: number          // higher = checked first
  enabled: boolean
}

const DEFAULT_RULES: Array<Omit<GovernanceRule, 'workspaceId'>> = [
  { id: 'no-money',          name: 'No financial actions',     matcher: '^(payment|billing|stripe|payout)', verdict: 'block',    reason: 'Financial actions are hard-blocked by constitution.', priority: 1000, enabled: true },
  { id: 'no-mass-delete',    name: 'No mass deletion',         matcher: 'delete.*all|truncate|drop\\s+table', verdict: 'block', reason: 'Mass deletion is destructive and irreversible.', priority: 990, enabled: true },
  { id: 'auth-approve',      name: 'Approve auth changes',     matcher: '^(auth|permission|role|workspace)', verdict: 'approve', reason: 'Authentication changes require operator approval.', priority: 800, enabled: true },
  { id: 'publish-approve',   name: 'Approve publishing',       matcher: '^(channel|video)\\.publish',         verdict: 'approve', reason: 'Public-facing publishing requires operator approval.', priority: 750, enabled: true },
  { id: 'deploy-escalate',   name: 'Escalate deploys',         matcher: '^(deploy|infra|prod)',               verdict: 'escalate', reason: 'Deployments must be decided by the operator.', priority: 700, enabled: true },
  { id: 'arch-escalate',     name: 'Escalate arch changes',    matcher: 'schema|migration|architecture',      verdict: 'escalate', reason: 'Architectural changes need operator sign-off.', priority: 600, enabled: true },
  { id: 'high-risk-approve', name: 'Approve high-risk ops',    matcher: 'desktop\\.(exec|write_file|kill)',   verdict: 'approve', reason: 'Host-level execution requires operator approval.', priority: 850, enabled: true },
]

let _ensured = false
async function ensure(): Promise<void> {
  if (_ensured) return
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS governance_rules (
      id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      matcher TEXT NOT NULL,
      verdict TEXT NOT NULL,
      reason TEXT NOT NULL,
      priority INT NOT NULL DEFAULT 500,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      PRIMARY KEY (workspace_id, id)
    )`)
  _ensured = true
}

async function seedDefaultsIfEmpty(workspaceId: string): Promise<void> {
  await ensure()
  const r = await db.execute(sql`SELECT COUNT(*)::int AS n FROM governance_rules WHERE workspace_id = ${workspaceId}`)
  const n = Number(((r as unknown as { rows?: Array<Record<string, unknown>> }).rows?.[0]?.['n']) ?? 0)
  if (n > 0) return
  for (const rule of DEFAULT_RULES) {
    await db.execute(sql`
      INSERT INTO governance_rules (id, workspace_id, name, matcher, verdict, reason, priority, enabled)
      VALUES (${rule.id}, ${workspaceId}, ${rule.name}, ${rule.matcher}, ${rule.verdict}, ${rule.reason}, ${rule.priority}, ${rule.enabled})
      ON CONFLICT (workspace_id, id) DO NOTHING`)
  }
}

export interface GovernanceCheckResult {
  verdict: Verdict
  matchedRules: Array<{ id: string; name: string; reason: string }>
  explanation: string
}

// Per-workspace rules cache — governance.check fires before EVERY brain-task op,
// and the rules barely ever change. 5-min TTL gives 99.9% hit rate while keeping
// edits visible within minutes.
interface CachedRules { rules: Array<{ id: string; name: string; matcher: string; verdict: Verdict; reason: string; priority: number }>; at: number }
const _rulesCache = new Map<string, CachedRules>()
const RULES_TTL_MS = 5 * 60_000
export function invalidateRulesCache(workspaceId?: string): void {
  if (workspaceId) _rulesCache.delete(workspaceId)
  else _rulesCache.clear()
}

export async function check(workspaceId: string, op: string, context = ''): Promise<GovernanceCheckResult> {
  const hit = _rulesCache.get(workspaceId)
  let rules: CachedRules['rules']
  if (hit && Date.now() - hit.at < RULES_TTL_MS) {
    rules = hit.rules
  } else {
    await seedDefaultsIfEmpty(workspaceId)
    const rows = await db.execute(sql`
      SELECT id, name, matcher, verdict, reason, priority FROM governance_rules
      WHERE workspace_id = ${workspaceId} AND enabled = TRUE
      ORDER BY priority DESC`)
    rules = ((rows as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? []).map(r => ({
      id: String(r['id']), name: String(r['name']),
      matcher: String(r['matcher']), verdict: r['verdict'] as Verdict,
      reason: String(r['reason']), priority: Number(r['priority']),
    }))
    _rulesCache.set(workspaceId, { rules, at: Date.now() })
  }
  const haystack = `${op} ${context}`
  const matched: GovernanceCheckResult['matchedRules'] = []
  const brokenRules: string[] = []
  let verdict: Verdict = 'allow'
  const order: Record<Verdict, number> = { allow: 0, approve: 1, escalate: 2, block: 3 }
  for (const r of rules) {
    let re: RegExp
    try { re = new RegExp(r.matcher, 'i') } catch {
      // Track broken rules so they're surfaced — previously silently skipped.
      brokenRules.push(`${r.id}(${r.name})`)
      continue
    }
    if (re.test(haystack)) {
      matched.push({ id: r.id, name: r.name, reason: r.reason })
      // Defense-in-depth: validate verdict shape even though saveRule now checks
      if ((order[r.verdict] ?? -1) > order[verdict]) verdict = r.verdict
    }
  }
  // Emit a one-shot event when broken rules are encountered so the operator
  // sees their misconfigured rules instead of silently disabled governance.
  if (brokenRules.length > 0) {
    void db.execute(sql`
      INSERT INTO events (id, workspace_id, type, payload, created_at, trace_id, correlation_id, causation_id, source, version)
      VALUES (gen_random_uuid(), ${workspaceId}, 'governance.rule_broken',
              ${JSON.stringify({ brokenRules })}::jsonb, ${Date.now()},
              gen_random_uuid()::text, gen_random_uuid()::text, null, 'governance-engine', 1)
    `).catch((e: Error) => { console.error('[governance-engine]', e.message); return null })
  }
  const explanation = matched.length === 0
    ? 'No governance rules matched — default allow.'
    : `${matched.length} rule(s) matched → ${verdict.toUpperCase()}: ${matched.map(m => m.name).join(', ')}`
  return { verdict, matchedRules: matched, explanation }
}

const VALID_VERDICTS = new Set(['allow', 'approve', 'escalate', 'block'])

export async function saveRule(rule: GovernanceRule): Promise<{ ok: boolean }> {
  await ensure()
  // Validate verdict — previously a typo like 'reject' was silently saved
  // and then the `order[undefined] > order[allow]` comparison returned
  // false, silently allowing the matched op. Verify here.
  if (!VALID_VERDICTS.has(rule.verdict)) {
    throw new Error(`saveRule: invalid verdict "${rule.verdict}" — must be one of: allow, approve, escalate, block`)
  }
  if (!rule.id || !rule.workspaceId || !rule.name || !rule.matcher || !rule.reason) {
    throw new Error('saveRule: id, workspaceId, name, matcher, reason all required')
  }
  // Validate matcher compiles as a regex
  try { new RegExp(rule.matcher, 'i') } catch (e) {
    throw new Error(`saveRule: matcher is not a valid regex: ${(e as Error).message}`)
  }
  await db.execute(sql`
    INSERT INTO governance_rules (id, workspace_id, name, matcher, verdict, reason, priority, enabled)
    VALUES (${rule.id}, ${rule.workspaceId}, ${rule.name}, ${rule.matcher}, ${rule.verdict}, ${rule.reason}, ${rule.priority}, ${rule.enabled})
    ON CONFLICT (workspace_id, id) DO UPDATE SET
      name = EXCLUDED.name, matcher = EXCLUDED.matcher, verdict = EXCLUDED.verdict,
      reason = EXCLUDED.reason, priority = EXCLUDED.priority, enabled = EXCLUDED.enabled`)
  invalidateRulesCache(rule.workspaceId)
  return { ok: true }
}

export async function listRules(workspaceId: string): Promise<GovernanceRule[]> {
  await seedDefaultsIfEmpty(workspaceId)
  const rows = await db.execute(sql`
    SELECT * FROM governance_rules WHERE workspace_id = ${workspaceId} ORDER BY priority DESC`)
  return ((rows as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? []).map(r => ({
    id: String(r['id']), workspaceId: String(r['workspace_id']),
    name: String(r['name']), matcher: String(r['matcher']),
    verdict: r['verdict'] as Verdict, reason: String(r['reason']),
    priority: Number(r['priority']), enabled: Boolean(r['enabled']),
  }))
}
