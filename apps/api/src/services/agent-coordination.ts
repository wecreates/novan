/**
 * agent-coordination.ts — Closes the failure modes the spec calls out
 * as where demo-to-production gap is widest.
 *
 * Implements:
 *   - Shared blackboard with append-only semantics + conflict marking
 *   - Bounded replanning + escalation budgets per agent + structured
 *     escalation to the next tier (specialist → tech lead → PM → human)
 *   - Loop detection (identical-action-twice, progress-check, diverging-
 *     from-baseline)
 *   - Reversible action pattern (begin/commit/cancel phases — the spec
 *     calls this out: "create payment intent" rather than "send money")
 *   - Adversarial review (skeptical-prompt review agent run on different
 *     model family than producer)
 *
 * Built on the round-104 coding-topology contracts so existing flows
 * automatically inherit these protections.
 */
import { db } from '../db/client.js'
import { events, reasoningChains } from '../db/schema.js'
import { eq, and, gte, sql, desc } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ── Shared blackboard ──────────────────────────────────────────────
/** A blackboard entry. Append-only — agents never overwrite an
 *  earlier entry; new entries either ADD information or explicitly
 *  flag a conflict with an earlier one for the manager to reconcile. */
export interface BlackboardEntry {
  id:            string
  workspaceId:   string
  /** Logical board name — typically the task id or workflow run id. */
  boardKey:      string
  agentId:       string
  /** Categorical: claim, finding, decision, conflict, retraction. */
  kind:          'claim' | 'finding' | 'decision' | 'conflict' | 'retraction'
  content:       string
  /** When an entry conflicts with an earlier entry, link it here so
   *  the manager sees both sides. */
  conflictsWith?: string
  /** Confidence the writer attached. */
  confidence:    number
  createdAt:     number
}

export async function blackboardWrite(input: Omit<BlackboardEntry, 'id' | 'createdAt'>): Promise<BlackboardEntry> {
  const id = uuidv7()
  const entry: BlackboardEntry = { id, createdAt: Date.now(), ...input }
  await db.insert(events).values({
    id, type: 'blackboard.write', workspaceId: input.workspaceId,
    payload: { ...entry } as never,
    traceId: uuidv7(), correlationId: input.boardKey, causationId: null,
    source: 'agent-coordination', version: 1, createdAt: entry.createdAt,
  }).catch(() => null)
  return entry
}

export async function blackboardRead(input: { workspaceId: string; boardKey: string; limit?: number }): Promise<BlackboardEntry[]> {
  const rows = await db.select({ payload: events.payload })
    .from(events)
    .where(and(
      eq(events.workspaceId, input.workspaceId),
      eq(events.type, 'blackboard.write'),
      eq(events.correlationId, input.boardKey),
    ))
    .orderBy(desc(events.createdAt))
    .limit(input.limit ?? 200)
    .catch(() => [])
  return rows.map(r => r.payload as unknown as BlackboardEntry)
}

/** Detect hallucination-cascade candidates: pairs of entries on the
 *  same board where one CLAIMS X and another CLAIMS NOT-X with
 *  similar topic but neither has flagged the conflict. The manager
 *  layer should be alerted on every detection. */
export async function blackboardDetectInconsistencies(input: { workspaceId: string; boardKey: string }): Promise<Array<{ pairIds: [string, string]; reason: string }>> {
  const entries = await blackboardRead({ workspaceId: input.workspaceId, boardKey: input.boardKey, limit: 500 })
  const out: Array<{ pairIds: [string, string]; reason: string }> = []
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]!, b = entries[j]!
      if (a.conflictsWith === b.id || b.conflictsWith === a.id) continue   // already flagged
      const aTokens = new Set(a.content.toLowerCase().split(/\s+/).filter(t => t.length > 3))
      const bTokens = new Set(b.content.toLowerCase().split(/\s+/).filter(t => t.length > 3))
      const overlap = [...aTokens].filter(t => bTokens.has(t)).length
      if (overlap < 4) continue
      // Crude negation detection — looks for inversion words on similar topics.
      const aNeg = /\b(not|no|never|cannot|isn't|doesn't|won't|refuse)\b/i.test(a.content)
      const bNeg = /\b(not|no|never|cannot|isn't|doesn't|won't|refuse)\b/i.test(b.content)
      if (aNeg !== bNeg) {
        out.push({ pairIds: [a.id, b.id], reason: `same topic (${overlap} shared tokens) · opposite polarity (one negation, one assertion) · unflagged conflict` })
      }
    }
  }
  return out
}

// ── Escalation budgets ─────────────────────────────────────────────
export interface EscalationBudget {
  agentId:            string
  /** Hard caps before mandatory escalation. */
  maxWallClockMs:     number
  maxToolCalls:       number
  maxCostUsd:         number
  /** When the agent hits ANY cap, it must escalate with structured context. */
}

export interface EscalationReceipt {
  fromAgent:          string
  toTier:             'specialist' | 'tech_lead' | 'pm' | 'human'
  reason:             'budget_exhausted' | 'novel_situation' | 'dependency_missing' | 'invalid_assumption' | 'high_risk_detected'
  context: {
    triedApproaches:    string[]
    discoveries:        string[]
    remainingOptions:   string[]
    elapsedMs:          number
    toolCallsUsed:      number
    costUsd:            number
  }
  escalatedAt:        number
}

/** Compute whether an agent should escalate given current spend.
 *  Caller invokes this before each step; if shouldEscalate=true, the
 *  agent stops and emits an EscalationReceipt instead of continuing. */
export function shouldEscalate(input: {
  budget:          EscalationBudget
  consumed: {
    wallClockMs:     number
    toolCalls:       number
    costUsd:         number
  }
}): { shouldEscalate: boolean; trigger: string | null } {
  if (input.consumed.wallClockMs >= input.budget.maxWallClockMs) {
    return { shouldEscalate: true, trigger: `wallClock ${input.consumed.wallClockMs}ms >= cap ${input.budget.maxWallClockMs}ms` }
  }
  if (input.consumed.toolCalls >= input.budget.maxToolCalls) {
    return { shouldEscalate: true, trigger: `toolCalls ${input.consumed.toolCalls} >= cap ${input.budget.maxToolCalls}` }
  }
  if (input.consumed.costUsd >= input.budget.maxCostUsd) {
    return { shouldEscalate: true, trigger: `costUsd $${input.consumed.costUsd.toFixed(4)} >= cap $${input.budget.maxCostUsd}` }
  }
  return { shouldEscalate: false, trigger: null }
}

/** Persist an escalation so the receiving tier picks it up. */
export async function emitEscalation(input: {
  workspaceId: string
  receipt:     EscalationReceipt
}): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type: 'agent.escalation', workspaceId: input.workspaceId,
    payload: input.receipt as never,
    traceId: uuidv7(), correlationId: input.receipt.fromAgent, causationId: null,
    source: 'agent-coordination', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

// ── Loop detection ─────────────────────────────────────────────────
/** Track recent actions per agent so we can detect identical-twice
 *  loops, no-progress conditions, and diverging-from-baseline. */
interface ActionRecord {
  agentId:    string
  action:     string
  args:       string
  at:         number
}
const _recentActions: ActionRecord[] = []
const ACTION_RECENCY_MS = 5 * 60_000

export interface LoopCheck {
  inLoop:        boolean
  reason:        string | null
  identicalCount: number
}

/** Call before each tool action. Returns inLoop=true if the same agent
 *  is about to make the same call with the same args repeatedly. */
export function detectIdenticalLoop(input: {
  agentId:  string
  action:   string
  args:     Record<string, unknown>
}): LoopCheck {
  const now = Date.now()
  // Garbage-collect older entries.
  while (_recentActions.length > 0 && _recentActions[0]!.at < now - ACTION_RECENCY_MS) _recentActions.shift()

  const argsKey = JSON.stringify(input.args)
  const identical = _recentActions.filter(r =>
    r.agentId === input.agentId && r.action === input.action && r.args === argsKey,
  )
  _recentActions.push({ agentId: input.agentId, action: input.action, args: argsKey, at: now })

  if (identical.length >= 2) {
    return {
      inLoop:        true,
      reason:        `agent ${input.agentId} made identical ${input.action} call ${identical.length + 1} times in last 5 min — probable loop, escalate`,
      identicalCount: identical.length + 1,
    }
  }
  return { inLoop: false, reason: null, identicalCount: identical.length + 1 }
}

/** Progress check: caller supplies the original spec + current state;
 *  we measure whether the work is converging toward the spec or
 *  diverging. Naive but useful heuristic: Levenshtein-like token-set
 *  similarity. Real prod uses LLM-based "is this closer to the goal
 *  than 10 minutes ago" judgment. */
export function detectStalledProgress(input: {
  originalSpec:   string
  prevState:      string
  currentState:   string
}): { stalled: boolean; reason: string } {
  if (input.prevState === input.currentState) {
    return { stalled: true, reason: 'state identical to previous checkpoint — no progress' }
  }
  const tokens = (s: string): Set<string> => new Set(s.toLowerCase().split(/\s+/).filter(t => t.length > 3))
  const spec = tokens(input.originalSpec)
  const prev = tokens(input.prevState)
  const curr = tokens(input.currentState)
  const prevOverlap = [...prev].filter(t => spec.has(t)).length
  const currOverlap = [...curr].filter(t => spec.has(t)).length
  if (currOverlap < prevOverlap - 1) {
    return {
      stalled: true,
      reason: `current state shares fewer concepts with spec (${currOverlap} vs prev ${prevOverlap}) — diverging from baseline`,
    }
  }
  return { stalled: false, reason: 'progress detected' }
}

// ── Reversible actions ─────────────────────────────────────────────
/** A reversible action exposes three phases:
 *    begin()   — make the intent durable (e.g. PaymentIntent w/ confirm=false)
 *    commit()  — finalise the action
 *    cancel()  — undo the intent before commit
 *
 *  Agents that take side effects should ALWAYS go through this pattern
 *  so a coordination failure doesn't double-execute. */
export interface ReversibleAction<Intent, Outcome> {
  name:        string
  begin:       (input: Intent) => Promise<{ intentId: string }>
  commit:      (intentId: string) => Promise<Outcome>
  cancel:      (intentId: string) => Promise<void>
}

/** Tracks pending intents so we can detect leaks (intents that were
 *  never committed or cancelled). Caller sweeps these on shutdown. */
const _pendingIntents = new Map<string, { actionName: string; intentId: string; openedAt: number }>()

export async function execReversible<I, O>(input: {
  workspaceId:  string
  agent:        ReversibleAction<I, O>
  intent:       I
  approvalToken?: string
}): Promise<{ ok: true; outcome: O; intentId: string } | { ok: false; error: string; intentId?: string }> {
  // Get the intent first — this is the "create payment intent" step.
  let intentId: string
  try {
    const r = await input.agent.begin(input.intent)
    intentId = r.intentId
    _pendingIntents.set(intentId, { actionName: input.agent.name, intentId, openedAt: Date.now() })
  } catch (e) {
    return { ok: false, error: `begin failed: ${(e as Error).message}` }
  }

  // Approval gate — irreversible actions require OPERATOR_APPROVED.
  if (input.approvalToken !== 'OPERATOR_APPROVED') {
    await input.agent.cancel(intentId).catch(() => null)
    _pendingIntents.delete(intentId)
    return { ok: false, error: `commit refused: missing OPERATOR_APPROVED token; intent cancelled`, intentId }
  }

  try {
    const outcome = await input.agent.commit(intentId)
    _pendingIntents.delete(intentId)
    await db.insert(events).values({
      id: uuidv7(), type: 'reversible.committed', workspaceId: input.workspaceId,
      payload: { action: input.agent.name, intentId } as never,
      traceId: uuidv7(), correlationId: intentId, causationId: null,
      source: 'agent-coordination', version: 1, createdAt: Date.now(),
    }).catch(() => null)
    return { ok: true, outcome, intentId }
  } catch (e) {
    await input.agent.cancel(intentId).catch(() => null)
    _pendingIntents.delete(intentId)
    return { ok: false, error: `commit failed; intent cancelled: ${(e as Error).message}`, intentId }
  }
}

/** Sweep stale intents — call from a cron at shutdown. Cancels any
 *  intent older than maxAgeMs that didn't get committed. */
export async function sweepStaleIntents(input: { maxAgeMs?: number; actions: Record<string, ReversibleAction<unknown, unknown>> }): Promise<{ cancelled: number }> {
  const max = input.maxAgeMs ?? 30 * 60_000
  const now = Date.now()
  let cancelled = 0
  for (const [id, pending] of _pendingIntents) {
    if (now - pending.openedAt < max) continue
    const action = input.actions[pending.actionName]
    if (!action) continue
    await action.cancel(id).catch(() => null)
    _pendingIntents.delete(id)
    cancelled++
  }
  return { cancelled }
}

// ── Adversarial review ────────────────────────────────────────────
/** Run an adversarial review on a producer's output. Spec: "review
 *  agent is run on a different model family than the producer to
 *  reduce correlated errors." The review prompt is biased toward
 *  skepticism — its job is to find ways the output is wrong, not to
 *  agree with it. */
export async function adversarialReview(input: {
  workspaceId:     string
  producerOutput:  string
  originalSpec:    string
  /** Provider to force for the review — should be different from the
   *  family that produced the output. */
  reviewerProvider?: string
  /** Categories of checks to bias the review toward. */
  checkCategories?: Array<'fact_check' | 'spec_drift' | 'hallucination' | 'incomplete' | 'security' | 'over_claim'>
}): Promise<{
  passed:        boolean
  findings:      Array<{ category: string; severity: 'low' | 'medium' | 'high' | 'critical'; description: string; evidence: string }>
  recommendation: 'merge' | 'revise' | 'reject'
  reviewerProvider: string
}> {
  const { streamChat } = await import('./chat-providers.js')
  const categories = input.checkCategories ?? ['fact_check', 'spec_drift', 'hallucination', 'over_claim']

  const sys = `You are ADVERSARIAL REVIEWER. Your role is skepticism.

Your job is to find ways this output is wrong, drifts from the spec, contains hallucinations, or over-claims. You are NOT here to be agreeable. Be specific. Cite evidence.

Categories to check (you may flag any): ${categories.join(', ')}.

Return STRICT JSON:
{
  "findings": [
    { "category": one-of-categories, "severity": "low"|"medium"|"high"|"critical", "description": string, "evidence": string }
  ],
  "recommendation": "merge" | "revise" | "reject"
}

Decision rules:
- ANY critical finding → recommendation must be "reject"
- ANY high finding → recommendation must be "revise" or "reject"
- Only "merge" when findings are all low or empty
- Bias toward "revise" when uncertain; specific concrete revisions are better than generic concerns

If the output looks fine to you, DOUBLE-CHECK by looking at one specific claim and verifying it against the spec. Default mode is skeptical, not approving.`

  const msgs = [
    { role: 'system' as const, content: sys },
    { role: 'user' as const, content: `SPEC:\n${input.originalSpec.slice(0, 4_000)}\n\n===\n\nPRODUCER OUTPUT (to be reviewed):\n${input.producerOutput.slice(0, 8_000)}` },
  ]

  const opts: { preferProvider?: string } = {}
  if (input.reviewerProvider) opts.preferProvider = input.reviewerProvider

  let full = ''
  let provider = 'unknown'
  const stream = streamChat(input.workspaceId, msgs, opts)
  let r = await stream.next()
  while (!r.done) { full += (r.value.delta ?? ''); r = await stream.next() }
  if (r.value) provider = r.value.provider

  let parsed: { findings?: Array<{ category: string; severity: string; description: string; evidence: string }>; recommendation?: string } | null = null
  try { parsed = JSON.parse(full.trim()) } catch {
    const m = full.match(/\{[\s\S]*\}/)
    if (m) { try { parsed = JSON.parse(m[0]) } catch { /* */ } }
  }

  const findings = (parsed?.findings ?? []).map(f => ({
    category: String(f.category ?? 'unknown'),
    severity: (['low', 'medium', 'high', 'critical'].includes(f.severity) ? f.severity : 'low') as 'low' | 'medium' | 'high' | 'critical',
    description: String(f.description ?? ''),
    evidence:    String(f.evidence ?? ''),
  }))
  const hasCritical = findings.some(f => f.severity === 'critical')
  const hasHigh     = findings.some(f => f.severity === 'high')
  const recommendation: 'merge' | 'revise' | 'reject' =
    hasCritical ? 'reject'
    : hasHigh     ? 'revise'
    : findings.length === 0 ? 'merge'
    : findings.some(f => f.severity === 'medium') ? 'revise'
    : 'merge'

  return {
    passed: recommendation === 'merge',
    findings,
    recommendation,
    reviewerProvider: provider,
  }
}

// ── Authority tier resolution ──────────────────────────────────────
/** Given an agent + action context, decide the authority tier required.
 *  Connects to existing trust-reputation scoring + governance policy. */
export async function resolveAuthority(input: {
  workspaceId:     string
  agentId:         string
  actionRisk:      'low' | 'medium' | 'high' | 'critical'
  actionReversible: boolean
  blastRadius:     'isolated' | 'team' | 'business' | 'portfolio' | 'global'
}): Promise<{
  tier:           'autonomous' | 'auto_with_audit' | 'require_review' | 'require_approval' | 'human_only'
  trustScore:     number
  rationale:      string
}> {
  let trustScore = 0.5
  try {
    const { getScore } = await import('./trust-reputation.js')
    const t = await getScore(input.workspaceId, `agent:${input.agentId}`)
    trustScore = t?.score ?? 0.5
  } catch { /* default */ }

  // Strict tier table — irreversible critical-risk actions are NEVER
  // autonomous regardless of trust.
  if (input.actionRisk === 'critical' && !input.actionReversible) {
    return { tier: 'human_only', trustScore, rationale: 'critical-risk + irreversible: humans-only forever' }
  }
  if (input.actionRisk === 'critical') {
    return { tier: 'require_approval', trustScore, rationale: 'critical-risk: approval token required' }
  }
  if (input.actionRisk === 'high') {
    if (trustScore >= 0.85 && input.actionReversible && input.blastRadius === 'isolated') {
      return { tier: 'require_review', trustScore, rationale: 'high-trust + reversible + isolated: post-hoc review acceptable' }
    }
    return { tier: 'require_approval', trustScore, rationale: 'high-risk: approval required pre-execution' }
  }
  if (input.actionRisk === 'medium') {
    if (trustScore >= 0.75) {
      return { tier: 'auto_with_audit', trustScore, rationale: 'medium-risk + trusted agent: autonomous but audited' }
    }
    return { tier: 'require_review', trustScore, rationale: 'medium-risk + low-trust: review required' }
  }
  // low risk
  if (trustScore >= 0.5) return { tier: 'autonomous', trustScore, rationale: 'low-risk: autonomous' }
  return { tier: 'auto_with_audit', trustScore, rationale: 'low-risk + new/untrusted: audited' }
}
