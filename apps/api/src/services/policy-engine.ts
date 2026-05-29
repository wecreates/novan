/**
 * policy-engine.ts — Declarative governance rule evaluation.
 *
 * The operator's "constitution" is a list of policy rules expressed
 * as small predicates. Before any high-risk op runs (brain.task,
 * autonomous-mind action, MCP call, scheduled-production publish),
 * the engine evaluates the proposed action against every active rule
 * and returns a verdict: allow | deny | require_approval.
 *
 * This is the layer that lets the operator say things like:
 *   - "Any op that touches money requires OPERATOR_APPROVED."
 *   - "Agent 'community_manager' cannot run between 22:00-06:00 UTC."
 *   - "Daily AI spend > $50 for workspace X → pause autonomous-mind."
 *   - "Op risk='critical' is blocked unless approval_token AND operator
 *      is the calling identity (not a delegated session)."
 *
 * Design choices:
 *   - Rules are JS predicates (not a separate DSL). Operator edits
 *     this file directly; no parser, no eval. Safer than a custom DSL
 *     and easier to typecheck.
 *   - Rules are PURE — they receive a PolicyContext and return a verdict.
 *     No DB access from inside a rule. The caller pre-loads context.
 *   - Rules compose with first-match-wins, with `deny` taking precedence
 *     over `require_approval` taking precedence over `allow`. So a
 *     stricter rule always wins regardless of declaration order.
 *
 * Wiring: brain-task.executePlan() will call evaluate() per-op before
 * dispatch. Returns a verdict + the rule(s) that matched + a structured
 * reason the operator UI can render.
 */

export type Verdict = 'allow' | 'require_approval' | 'deny'

export interface PolicyContext {
  /** Operation name (e.g. 'business.create', 'portfolio.improve'). */
  op:           string
  /** Risk tier declared by the op spec. */
  risk:         'low' | 'medium' | 'high' | 'critical'
  workspaceId:  string
  /** Calling identity — operator | session | agent | cron. */
  caller:       'operator' | 'session' | 'agent' | 'cron' | 'mcp'
  /** Persona name when caller='agent'. */
  agentPersona?: string
  /** Approval token if the caller presented one. */
  approvalToken?: string
  /** Free-form op-specific params (already redacted of secrets). */
  params:        Record<string, unknown>
  /** Telemetry the engine can use without going back to DB:
   *  todaySpendUsd — total ai_usage cost for this workspace today
   *  weekSpendUsd  — week-to-date
   *  recentDenies  — count of policy denies in the last hour */
  telemetry?: {
    todaySpendUsd?:  number
    weekSpendUsd?:   number
    recentDenies?:   number
    nowIso?:         string   // server time, for time-of-day rules
  }
  /** Money-pattern signal from existing brain-task-money-guard, if the
   *  op was pre-scanned. The engine layers ON TOP of money-guard — it
   *  doesn't replace it. */
  moneyPatternDetected?: boolean
}

export interface PolicyDecision {
  verdict:        Verdict
  matchedRules:   Array<{ id: string; description: string; verdict: Verdict }>
  /** First rule's reason — what to show the operator. */
  reason:         string
  /** All matched rules' reasons — for the audit log. */
  allReasons:     string[]
}

interface Rule {
  id:          string
  description: string
  /** Higher = evaluated first. Default 100. Doesn't change precedence
   *  rules — strict-wins still holds — only the order of matched-rules
   *  in the decision payload. */
  priority?:   number
  /** Returns a verdict (or null to abstain). */
  evaluate: (ctx: PolicyContext) => Verdict | null
}

// ─── DEFAULT POLICY SET ──────────────────────────────────────────────────
// These mirror the existing brain-task contract so the engine doesn't
// surprise existing callers. Operator can append workspace-scoped rules
// at runtime via addRule() (not yet persistent — durability is round-106
// work; for now rules survive process restart only as code).

const RULES: Rule[] = [
  {
    id: 'critical_requires_approval',
    description: 'Any critical-risk op must carry OPERATOR_APPROVED token.',
    priority: 1000,
    evaluate: (ctx) => {
      if (ctx.risk !== 'critical') return null
      if (ctx.approvalToken === 'OPERATOR_APPROVED') return 'allow'
      return 'deny'
    },
  },
  {
    id: 'high_requires_approval',
    description: 'High-risk ops require explicit operator approval.',
    priority: 900,
    evaluate: (ctx) => {
      if (ctx.risk !== 'high') return null
      if (ctx.approvalToken === 'OPERATOR_APPROVED') return 'allow'
      return 'require_approval'
    },
  },
  {
    id: 'money_pattern_hard_block',
    description: 'Money-pattern ops (charge / refund / transfer) hard-blocked unless explicitly approved by the human operator in chat.',
    priority: 1100,
    evaluate: (ctx) => {
      if (!ctx.moneyPatternDetected) return null
      // Money is the highest-stakes domain — approval token alone is not
      // enough; we require caller='operator' explicitly. An agent or cron
      // cannot self-approve a money-pattern op.
      if (ctx.caller === 'operator' && ctx.approvalToken === 'OPERATOR_APPROVED') return 'allow'
      return 'deny'
    },
  },
  {
    id: 'daily_spend_cap',
    description: 'Pause autonomous spend when daily AI cost exceeds $50/workspace.',
    priority: 500,
    evaluate: (ctx) => {
      const spend = ctx.telemetry?.todaySpendUsd ?? 0
      if (spend <= 50) return null
      // Operator-initiated calls still pass — the cap is on agents/cron.
      if (ctx.caller === 'operator') return null
      return 'deny'
    },
  },
  {
    id: 'weekly_spend_cap',
    description: 'Pause autonomous spend when weekly AI cost exceeds $200/workspace.',
    priority: 510,
    evaluate: (ctx) => {
      const spend = ctx.telemetry?.weekSpendUsd ?? 0
      if (spend <= 200) return null
      if (ctx.caller === 'operator') return null
      return 'deny'
    },
  },
  {
    id: 'agent_quiet_hours',
    description: 'Community-manager agent cannot post outside business hours (22:00-06:00 UTC blocked).',
    priority: 400,
    evaluate: (ctx) => {
      if (ctx.caller !== 'agent') return null
      if (ctx.agentPersona !== 'community_manager') return null
      const iso = ctx.telemetry?.nowIso ?? new Date().toISOString()
      // ISO is YYYY-MM-DDTHH:mm:ss — UTC hours at positions 11-13
      const hour = Number(iso.slice(11, 13))
      if (!Number.isFinite(hour)) return null
      if (hour >= 22 || hour < 6) return 'require_approval'
      return null
    },
  },
  {
    id: 'mcp_high_risk_requires_approval',
    description: 'MCP-invoked ops at risk>=medium always require approval — the calling agent must route through operator confirmation.',
    priority: 600,
    evaluate: (ctx) => {
      if (ctx.caller !== 'mcp') return null
      if (ctx.risk === 'low') return null
      if (ctx.approvalToken === 'OPERATOR_APPROVED') return 'allow'
      return 'require_approval'
    },
  },
  {
    id: 'cron_destructive_block',
    description: 'Cron-initiated calls cannot execute destructive ops without explicit kill-switch override.',
    priority: 700,
    evaluate: (ctx) => {
      if (ctx.caller !== 'cron') return null
      // Destructive risk shapes: high+ OR op name suggests deletion/sunset.
      const destructiveOp = /\.(delete|sunset|destroy|wipe|drop)$/.test(ctx.op)
      if (!destructiveOp && ctx.risk !== 'high' && ctx.risk !== 'critical') return null
      return 'deny'
    },
  },
  {
    id: 'repeated_denies_circuit_break',
    description: 'After 10 policy denies in the last hour, refuse further autonomous calls — surface to operator.',
    priority: 800,
    evaluate: (ctx) => {
      const recent = ctx.telemetry?.recentDenies ?? 0
      if (recent < 10) return null
      if (ctx.caller === 'operator') return null
      return 'deny'
    },
  },
]

/** Strict-wins precedence: deny > require_approval > allow. */
function combine(a: Verdict, b: Verdict): Verdict {
  if (a === 'deny' || b === 'deny') return 'deny'
  if (a === 'require_approval' || b === 'require_approval') return 'require_approval'
  return 'allow'
}

/** Compile an operator-defined rule row (from policy_rules table) into
 *  a runtime Rule object. Caller invokes this per workspace + caches.
 *  Supported kinds match the migration 0049 docs. */
export function compileOperatorRule(row: {
  id:           string
  kind:         string
  description:  string
  params:       Record<string, unknown>
  priority:     number
}): Rule | null {
  const p = row.params
  const baseProps = { id: row.id, description: row.description, priority: row.priority }
  switch (row.kind) {
    case 'spend_cap': {
      const window     = String(p['window']     ?? 'day')
      const ceilingUsd = Number(p['ceilingUsd'] ?? 0)
      const callerScope = String(p['callerScope'] ?? 'any_non_operator')
      return {
        ...baseProps,
        evaluate: (ctx) => {
          if (callerScope === 'agent' && ctx.caller !== 'agent') return null
          if (callerScope === 'cron'  && ctx.caller !== 'cron')  return null
          if (callerScope === 'any_non_operator' && ctx.caller === 'operator') return null
          const t = ctx.telemetry
          const spend = window === 'week'  ? (t?.weekSpendUsd  ?? 0)
                      : window === 'month' ? ((t as { monthSpendUsd?: number })?.monthSpendUsd ?? 0)
                      :                       (t?.todaySpendUsd ?? 0)
          return spend > ceilingUsd ? 'deny' : null
        },
      }
    }
    case 'quiet_hours': {
      const persona   = String(p['persona']   ?? '')
      const startHour = Number(p['startHour'] ?? 22)
      const endHour   = Number(p['endHour']   ?? 6)
      return {
        ...baseProps,
        evaluate: (ctx) => {
          if (ctx.caller !== 'agent') return null
          if (ctx.agentPersona !== persona) return null
          const iso = ctx.telemetry?.nowIso ?? new Date().toISOString()
          const hour = Number(iso.slice(11, 13))
          if (!Number.isFinite(hour)) return null
          // Range may wrap midnight (start > end).
          const inQuiet = startHour <= endHour
            ? (hour >= startHour && hour < endHour)
            : (hour >= startHour || hour < endHour)
          return inQuiet ? 'require_approval' : null
        },
      }
    }
    case 'op_block': {
      const op = String(p['op'] ?? '')
      return {
        ...baseProps,
        evaluate: (ctx) => ctx.op === op ? 'deny' : null,
      }
    }
    case 'op_require_approval': {
      const op = String(p['op'] ?? '')
      return {
        ...baseProps,
        evaluate: (ctx) => {
          if (ctx.op !== op) return null
          return ctx.approvalToken === 'OPERATOR_APPROVED' ? 'allow' : 'require_approval'
        },
      }
    }
    case 'pattern_block': {
      const patternStr = String(p['pattern'] ?? '')
      let re: RegExp
      try { re = new RegExp(patternStr) } catch { return null }
      return {
        ...baseProps,
        evaluate: (ctx) => re.test(ctx.op) ? 'deny' : null,
      }
    }
    default:
      return null
  }
}

/** Per-workspace cache of compiled operator rules. */
const _operatorRuleCache = new Map<string, { rules: Rule[]; loadedAt: number }>()
const OPERATOR_RULE_TTL_MS = 30_000

async function loadOperatorRules(workspaceId: string): Promise<Rule[]> {
  const cached = _operatorRuleCache.get(workspaceId)
  if (cached && Date.now() - cached.loadedAt < OPERATOR_RULE_TTL_MS) return cached.rules
  try {
    const { db } = await import('../db/client.js')
    const { policyRules } = await import('../db/schema.js')
    const { eq, and } = await import('drizzle-orm')
    const rows = await db.select().from(policyRules)
      .where(and(eq(policyRules.workspaceId, workspaceId), eq(policyRules.enabled, true)))
      .limit(200)
    const compiled = rows
      .map(r => compileOperatorRule({
        id: r.id, kind: r.kind, description: r.description,
        params: r.params as Record<string, unknown>, priority: r.priority,
      }))
      .filter((r): r is Rule => r !== null)
    _operatorRuleCache.set(workspaceId, { rules: compiled, loadedAt: Date.now() })
    return compiled
  } catch {
    return []
  }
}

/** Invalidate the operator-rule cache for a workspace. Called by the
 *  policy-rule CRUD handlers after mutations. */
export function invalidateOperatorRules(workspaceId: string): void {
  _operatorRuleCache.delete(workspaceId)
}

/** Async version of evaluate() that pulls in operator-defined rules
 *  from the DB on top of the built-in defaults. The hardcoded rules
 *  always run; operator rules layer on top, can OVERRIDE a default
 *  rule by re-using its id. Use this from any production call path
 *  (brain-task, mcp.call, autonomous-mind). */
export async function evaluateAsync(ctx: PolicyContext): Promise<PolicyDecision> {
  const operatorRules = await loadOperatorRules(ctx.workspaceId)
  return _evaluate(ctx, operatorRules)
}

/** Evaluate context against all rules. If no rule matches, default
 *  allow (callers should still respect op risk tier, but the engine
 *  itself is non-restrictive in the absence of a matching rule). */
export function evaluate(ctx: PolicyContext): PolicyDecision {
  return _evaluate(ctx, [])
}

function _evaluate(ctx: PolicyContext, operatorRules: Rule[]): PolicyDecision {
  const matched: Array<{ id: string; description: string; verdict: Verdict }> = []
  let net: Verdict = 'allow'
  // Merge default + operator rules; operator rules with same id REPLACE
  // the default (operator override pattern). Then sort by priority desc.
  const merged = [...RULES]
  for (const opr of operatorRules) {
    const i = merged.findIndex(r => r.id === opr.id)
    if (i >= 0) merged[i] = opr
    else        merged.push(opr)
  }
  const sorted = merged.sort((a, b) => (b.priority ?? 100) - (a.priority ?? 100))
  for (const rule of sorted) {
    const v = rule.evaluate(ctx)
    if (v === null) continue
    matched.push({ id: rule.id, description: rule.description, verdict: v })
    net = combine(net, v)
  }
  const first = matched[0]
  return {
    verdict:      net,
    matchedRules: matched,
    reason:       first ? `${first.id}: ${first.description}` : 'no policy rule matched — default allow',
    allReasons:   matched.map(m => `${m.id}: ${m.description}`),
  }
}

/** Test-only helper: append a rule for the duration of one test. The
 *  returned cleanup removes it. */
export function _addRuleForTest(rule: Rule): () => void {
  RULES.push(rule)
  return () => {
    const i = RULES.findIndex(r => r === rule)
    if (i >= 0) RULES.splice(i, 1)
  }
}

/** Listing all rules — used by the /api/v1/governance route + the UI. */
export function listRules(): Array<Pick<Rule, 'id' | 'description' | 'priority'>> {
  return RULES
    .map(r => ({ id: r.id, description: r.description, priority: r.priority ?? 100 }))
    .sort((a, b) => (b.priority ?? 100) - (a.priority ?? 100))
}
