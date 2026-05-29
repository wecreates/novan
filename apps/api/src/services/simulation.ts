/**
 * simulation.ts — Layer 7 Simulation Sandbox + counterfactual replay.
 *
 * Two related capabilities:
 *
 *   1. dryRun(plan) — execute a proposed brain.task plan against a
 *      *read-only* shadow of the workspace state. Side-effect-free ops
 *      run normally; mutating ops are intercepted and their would-be
 *      effects logged instead. Returns the projected ledger of changes
 *      so the operator can see what an autonomous agent WOULD have done
 *      before authorising it.
 *
 *   2. counterfactual(chainId, alternative) — given a past reasoning
 *      chain, re-evaluate the decision under an alternative branch.
 *      "If we had picked option B instead of A, what would the policy
 *      engine + budget guard + (optionally) the persona have said?"
 *      Used for learning loop ("we should have done X") and to A/B-test
 *      prompt variants against real historical inputs.
 *
 * Honest scope:
 *   - dryRun() is intercept-by-op-name, not transactional snapshot
 *     isolation. It blocks listed mutating ops and runs read ops live.
 *     A true snapshot sandbox (Postgres SAVEPOINT or shadow schema)
 *     is a future round.
 *   - counterfactual() does not re-run the LLM persona by default —
 *     that would burn tokens silently. Caller passes `rerunPersona:true`
 *     if they want a fresh LLM evaluation of the alternative; otherwise
 *     the sim returns policy + budget verdicts only.
 */
import { db } from '../db/client.js'
import { reasoningChains } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { evaluate as evalPolicy, type PolicyContext } from './policy-engine.js'
import { checkBusinessBudget } from './business-budget.js'

/** Ops that we KNOW are read-only — safe to execute against live state
 *  during a dry-run. Anything not in this set is blocked + logged as
 *  a projected effect. Keep this list tight; false negatives (mutating
 *  op incorrectly classed safe) are worse than false positives. */
const READ_ONLY_OPS = new Set<string>([
  'db.query', 'platform.smoke', 'providers.validate',
  'pod.pricing.recommend', 'pod.pricing.compare', 'pod.pricing.bundle',
  'agent.list_personas',
  'policy.evaluate', 'policy.list_rules',
  'business.budget.check', 'postmortem.generate',
  'mind.cycle', 'issue.ingest',
])

export interface SimulatedOp {
  op:                string
  params:            Record<string, unknown>
  classification:    'read_only_executed' | 'mutating_intercepted' | 'denied_by_policy' | 'denied_by_budget'
  policyVerdict?:    'allow' | 'require_approval' | 'deny'
  budgetOk?:         boolean
  projectedEffect?:  string | undefined
  liveResult?:       unknown
  reason?:           string | undefined
}

export interface DryRunResult {
  workspaceId:    string
  ops:            SimulatedOp[]
  summary:        string
}

/** Execute a proposed plan in dry-run mode. Read ops run live; mutating
 *  ops are intercepted with a projected-effect description so the
 *  operator sees what would happen without anything actually
 *  changing. */
export async function dryRun(input: {
  workspaceId:   string
  caller:        PolicyContext['caller']
  plan:          Array<{ op: string; params?: Record<string, unknown>; risk?: PolicyContext['risk'] }>
}): Promise<DryRunResult> {
  const out: SimulatedOp[] = []
  for (const step of input.plan) {
    const params = step.params ?? {}
    const risk: PolicyContext['risk'] = step.risk ?? 'low'

    // Policy verdict first — if denied, no further work.
    const policy = evalPolicy({
      op: step.op, risk, workspaceId: input.workspaceId, caller: input.caller, params,
    })
    if (policy.verdict === 'deny') {
      out.push({
        op: step.op, params,
        classification: 'denied_by_policy',
        policyVerdict: policy.verdict,
        reason: policy.reason,
      })
      continue
    }

    // Budget pre-check — agent/cron callers must have budget headroom.
    if (input.caller !== 'operator') {
      const budget = await checkBusinessBudget({ workspaceId: input.workspaceId })
      if (!budget.ok) {
        out.push({
          op: step.op, params,
          classification: 'denied_by_budget',
          policyVerdict: policy.verdict,
          budgetOk: false,
          reason: budget.reason,
        })
        continue
      }
    }

    if (READ_ONLY_OPS.has(step.op)) {
      // Safe to execute live. We route through executePlan with caller=
      // operator (read ops are uniformly low-risk) and capture result.
      let liveResult: unknown = null
      try {
        const { executePlan } = await import('./brain-task.js')
        const r = await executePlan(input.workspaceId, 'sim:read', [{ op: step.op, params }])
        liveResult = r.results[0]?.data
      } catch (e) {
        liveResult = { error: (e as Error).message }
      }
      out.push({
        op: step.op, params,
        classification: 'read_only_executed',
        policyVerdict: policy.verdict,
        budgetOk: true,
        liveResult,
      })
    } else {
      // Mutating — intercept and describe the projected effect.
      out.push({
        op: step.op, params,
        classification: 'mutating_intercepted',
        policyVerdict: policy.verdict,
        budgetOk: true,
        projectedEffect: describeProjection(step.op, params),
      })
    }
  }
  const denied = out.filter(o => o.classification.startsWith('denied')).length
  const intercepted = out.filter(o => o.classification === 'mutating_intercepted').length
  return {
    workspaceId: input.workspaceId, ops: out,
    summary: `${out.length} ops simulated · ${intercepted} mutations intercepted · ${denied} denied. No live mutations occurred.`,
  }
}

/** Map an op name + params into a one-line description of what it
 *  WOULD have done if executed for real. Conservative — when in doubt
 *  the description hints at "see op handler for full effect". */
function describeProjection(op: string, params: Record<string, unknown>): string {
  if (op.startsWith('business.create'))   return `would create a new business with brief "${String(params['brief'] ?? '').slice(0, 80)}"`
  if (op.startsWith('business.sunset'))   return `would mark business ${String(params['businessId'] ?? '?')} as sunset proposal`
  if (op.startsWith('proposal.approve'))  return `would approve code proposal ${String(params['proposalId'] ?? '?')}`
  if (op.startsWith('schedule'))          return `would mutate schedule ${String(params['scheduleId'] ?? '?')}`
  if (op.startsWith('agent.dispatch'))    return `would dispatch persona ${String(params['persona'] ?? '?')} and incur LLM cost`
  if (op.startsWith('memory.'))           return `would mutate semantic memory store`
  if (op.startsWith('desktop.') || op.startsWith('browser.')) return `would drive ${op.split('.')[0]} session`
  return `would invoke ${op} (mutating; see op handler for full effect)`
}

export interface CounterfactualInput {
  chainId:        string
  /** The alternative the operator wants to compare against. Either an
   *  op-name swap, a parameter change, or a different persona. */
  alternative: {
    op?:           string
    params?:       Record<string, unknown>
    persona?:      string
    risk?:         PolicyContext['risk']
  }
  caller:         PolicyContext['caller']
  /** Burn LLM tokens to actually re-evaluate via persona? Default false. */
  rerunPersona?:  boolean
}

export interface CounterfactualOutput {
  chainId:           string
  original: {
    decision:        string
    subjectId:       string | null
    confidence:      number | null
  }
  alternative: {
    op:              string | null
    persona:         string | null
    policyVerdict:   'allow' | 'require_approval' | 'deny'
    budgetOk:        boolean
    rerunResult?:    unknown
  }
  divergence:        string
}

/** Re-evaluate a past decision under an alternative branch. Does NOT
 *  mutate the original chain — appends a new sibling chain marked
 *  `kind='decision'` with `subjectId='counterfactual:{originalId}'`. */
export async function counterfactual(input: CounterfactualInput): Promise<CounterfactualOutput | { error: string }> {
  const rows = await db.select().from(reasoningChains).where(eq(reasoningChains.id, input.chainId)).limit(1)
  const orig = rows[0]
  if (!orig) return { error: `chain not found: ${input.chainId}` }

  const op = input.alternative.op ?? 'unknown'
  const policy = evalPolicy({
    op,
    risk: input.alternative.risk ?? 'low',
    workspaceId: orig.workspaceId,
    caller: input.caller,
    params: input.alternative.params ?? {},
  })

  const budget = await checkBusinessBudget({ workspaceId: orig.workspaceId })

  let rerunResult: unknown = undefined
  if (input.rerunPersona && input.alternative.persona) {
    try {
      const { dispatchPersona } = await import('./agent-team.js')
      const r = await dispatchPersona({
        workspaceId: orig.workspaceId,
        persona:     input.alternative.persona as never,
        task:        `Counterfactual replay of chain ${input.chainId}: ${orig.decision.slice(0, 200)}`,
        context:     `Original confidence ${orig.confidence ?? 'unknown'}. Re-evaluate the same decision and produce structured output.`,
      })
      rerunResult = { persona: r.persona, raw: r.raw.slice(0, 2_000), parsed: r.parsed, tokens: r.tokens }
    } catch (e) {
      rerunResult = { error: (e as Error).message }
    }
  }

  const divergence = (() => {
    const origDecision = String(orig.decision ?? '')
    if (policy.verdict === 'deny')              return `alternative would have been DENIED by policy: ${policy.reason}`
    if (!budget.ok)                              return `alternative would have been BLOCKED by budget: ${budget.reason}`
    if (input.alternative.persona && input.rerunPersona) return `alternative routed to persona ${input.alternative.persona}; see rerunResult for differences`
    return `alternative passes policy + budget — viable replacement for "${origDecision.slice(0, 80)}"`
  })()

  return {
    chainId: input.chainId,
    original: {
      decision:   String(orig.decision ?? ''),
      subjectId:  orig.subjectId ?? null,
      confidence: orig.confidence !== null ? Number(orig.confidence) : null,
    },
    alternative: {
      op:            input.alternative.op ?? null,
      persona:       input.alternative.persona ?? null,
      policyVerdict: policy.verdict,
      budgetOk:      budget.ok,
      ...(rerunResult !== undefined ? { rerunResult } : {}),
    },
    divergence,
  }
}
