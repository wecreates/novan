/**
 * ceo-orchestrator.ts — the brain acting as CEO.
 *
 * Receives a task, picks the best agent definition from the catalog,
 * runs the agent's system prompt against the chosen LLM provider, and
 * persists the delegation. Every step is auditable via
 * `reasoning_chains` so the operator can replay any decision later.
 *
 * Honest scope:
 *   - This is single-shot delegation. No multi-step crew / agent-to-
 *     agent collaboration yet. That's a separate feature.
 *   - If `pickAgent` can't find a confident match the CEO refuses
 *     rather than guessing — better than running the wrong agent.
 */
import { v7 as uuidv7 } from 'uuid'
import { and, eq, desc } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agentDefinitions, agentDelegations } from '../db/schema.js'
import { streamChat, type ChatMsg } from './chat-providers.js'
import { record as recordChain } from './reasoning-chains.js'
import { pickAgent, type PickerResult } from './agency-catalog.js'

export interface DelegateInput {
  workspaceId: string
  task:        string
  /** Optional operator hint — a department slug ('engineering') or
   *  an exact agent slug ('engineering-ai-engineer'). */
  hint?:       string
  /** Optional structured context the brain wants the agent to see
   *  (recent chain ids, file paths, metric snapshots). */
  context?:    Record<string, unknown>
  requestedBy?: string
}

export interface DelegateResult {
  ok:              true
  delegationId:    string
  definitionId:    string
  slug:            string
  department:      string
  result:          string
  tokens:          number
  costUsd:         number
  provider:        string
  model:           string
  reasoningChainId?: string
}

export interface DelegateRefusal {
  ok:     false
  reason: string
}

/**
 * Brain → CEO → agent flow.
 *
 * 1. Load the catalog for this workspace
 * 2. Pick the best agent (refuse if no confident match)
 * 3. Insert a `pending` delegation row
 * 4. Stream the agent's response through the existing chat-providers
 * 5. Persist result + audit chain
 */
export async function delegateToAgent(i: DelegateInput): Promise<DelegateResult | DelegateRefusal> {
  if (!i.task || i.task.trim().length === 0) {
    return { ok: false, reason: 'task required' }
  }

  // 1. Load catalog (cheap projection — full prompt fetched only for the winner)
  const catalog = await db.select({
    id:          agentDefinitions.id,
    slug:        agentDefinitions.slug,
    department:  agentDefinitions.department,
    name:        agentDefinitions.name,
    description: agentDefinitions.description,
    tags:        agentDefinitions.tags,
    vibe:        agentDefinitions.vibe,
  }).from(agentDefinitions)
    .where(eq(agentDefinitions.workspaceId, i.workspaceId))
    .catch(() => [])

  if (catalog.length === 0) {
    return { ok: false, reason: 'agent catalog empty — run /api/v1/agency/sync first' }
  }

  // 2. Pick (with optional operator hint)
  const pick = pickAgent({
    task: i.task, ...(i.hint !== undefined ? { hint: i.hint } : {}),
    catalog: catalog.map(c => ({
      slug: c.slug, department: c.department, name: c.name,
      description: c.description, tags: c.tags, vibe: c.vibe,
    })),
  })
  if (!pick) {
    return { ok: false, reason: 'no confident agent match — supply a department/slug hint' }
  }

  // 3. Fetch the full prompt for the winner
  const def = await db.select().from(agentDefinitions)
    .where(and(eq(agentDefinitions.workspaceId, i.workspaceId), eq(agentDefinitions.slug, pick.slug)))
    .limit(1).then(r => r[0] ?? null).catch(() => null)
  if (!def) return { ok: false, reason: `agent definition ${pick.slug} disappeared` }

  // 4. Insert pending delegation
  const delegationId = uuidv7()
  const now = Date.now()
  await db.insert(agentDelegations).values({
    id: delegationId,
    workspaceId: i.workspaceId,
    definitionId: def.id,
    department:   def.department,
    task:         i.task.slice(0, 4_000),
    context:      i.context ?? {},
    status:       'pending',
    requestedBy:  i.requestedBy ?? 'ceo',
    createdAt:    now,
    startedAt:    now,
  }).catch(() => null)

  // 5. Build system + user prompt; stream.
  //
  // Size/sanitization rules (defense in depth):
  //  - Operator-defined agent systemPrompt was previously unclamped; a
  //    rogue 50kB prompt blew past provider context limits silently.
  //  - i.task and i.context flow from operator/integration input directly
  //    into the user message — strip role-injection markers and cap.
  const sanitizeForPrompt = (s: string): string =>
    s
      // Neutralize role-marker injection ("\n\nuser: ignore previous…").
      .replace(/^(system|assistant|user)\s*:/gim, '$1​:')
      // Strip ```system fences which some providers honor.
      .replace(/^\s*```(system|assistant|user)\b/gim, '```$1​')
  const SYSTEM_MAX = 16_000
  const TASK_MAX   = 4_000
  const CONTEXT_MAX = 4_000

  const defSystem = sanitizeForPrompt(def.systemPrompt ?? '').slice(0, SYSTEM_MAX)
  const taskText  = sanitizeForPrompt(i.task).slice(0, TASK_MAX)
  // JSON.stringify uses no indentation now — saves ~30% characters in
  // the same budget. If the stringified context exceeds CONTEXT_MAX,
  // truncate + mark explicitly so the LLM knows the data was cut.
  let ctxJson = ''
  try { ctxJson = JSON.stringify(i.context ?? {}) } catch { ctxJson = '{}' }
  if (ctxJson.length > CONTEXT_MAX) {
    ctxJson = ctxJson.slice(0, CONTEXT_MAX) + '/* …truncated… */}'
  }
  const ctxPreamble = i.context && Object.keys(i.context).length > 0
    ? `\n\n## Context the CEO is passing you\n\`\`\`json\n${ctxJson}\n\`\`\``
    : ''

  const msgs: ChatMsg[] = [
    { role: 'system', content: `${defSystem}\n\n---\nYou are operating under Novan's CEO orchestrator. Respond to the task below directly, concisely, and in the voice your prompt describes. Do NOT include preamble like "As an X agent". Output only what an operator would consume.\n\n## Cross-team collaboration\nIf your work requires another department to take action, end your response with a line like:\n  HANDOFF: <department> — <one-sentence ask>\nValid departments: engineering, marketing, design, product, sales, finance, support, testing, strategy, paid-media, project-management, game-development, spatial-computing, academic, specialized, examples.\nMaximum 2 handoffs. Use HANDOFF only when concrete action is needed; otherwise omit.` },
    { role: 'user',   content: `## Task\n${taskText}${ctxPreamble}` },
  ]

  // Final assembled-prompt size guard. Even after per-field clamps,
  // pathological combinations (large defSystem + 4k task + 4k context)
  // can total >25k chars. Refuse to ship anything above 28k chars
  // (~7k tokens) — provider-side context windows accept much more, but
  // attention quality degrades past ~32k tokens and the operator's
  // latency/cost suffers. Refusal fails fast with a useful error
  // instead of silently truncating.
  const totalPromptChars = (msgs[0]?.content.length ?? 0) + (msgs[1]?.content.length ?? 0)
  if (totalPromptChars > 28_000) {
    return {
      ok: false,
      reason: `assembled prompt is ${totalPromptChars} chars (>28k cap). Trim the agent's systemPrompt, task, or context block.`,
    }
  }

  let final = { content: '', tokens: 0, costUsd: 0, provider: 'none', model: 'none' }
  const t0 = Date.now()
  try {
    const stream = streamChat(i.workspaceId, msgs)
    let next: IteratorResult<{ delta: string; done: boolean }, typeof final>
    while (!(next = await stream.next()).done) { /* drain — we only want the final summary */ }
    final = next.value as typeof final
    // Cost rollup to ai_usage. The delegation row stores per-row token
    // count for audit; ai_usage aggregates for the workspace's budget
    // report — without this, every CEO delegation was invisible to
    // budget-guard.
    const { recordAiUsage } = await import('./ai-cost-tracker.js')
    recordAiUsage({
      workspaceId:  i.workspaceId,
      provider:     final.provider,
      model:        final.model,
      promptTokens: 0,
      outputTokens: final.tokens,
      costUsd:      final.costUsd,
      latencyMs:    Date.now() - t0,
      taskType:     'chat',
    })
  } catch (e) {
    await db.update(agentDelegations).set({
      status: 'failed',
      error:  (e as Error).message.slice(0, 500),
      completedAt: Date.now(),
    }).where(eq(agentDelegations.id, delegationId)).catch(() => null)
    return { ok: false, reason: `agent run failed: ${(e as Error).message}` }
  }

  // 6. Record audit chain
  const chain = await recordChain({
    workspaceId: i.workspaceId,
    kind:        'decision',
    subjectId:   `delegation:${delegationId}`,
    decision:    `CEO delegated "${i.task.slice(0, 80)}…" → ${def.slug} (score ${pick.score})`,
    evidence:    [{ type: 'agent', id: def.id, extract: def.name }],
    confidence:  Math.min(1, pick.score / 8),
    source:      'ceo-orchestrator',
  }).catch(() => null)

  // 7. Persist result
  await db.update(agentDelegations).set({
    result:      final.content.slice(0, 50_000),
    tokens:      final.tokens,
    costUsd:     final.costUsd,
    provider:    final.provider,
    model:       final.model,
    status:      'succeeded',
    reasoningChainId: chain ?? null,
    completedAt: Date.now(),
  }).where(eq(agentDelegations.id, delegationId)).catch(() => null)

  // 8. Cross-team collaboration — if the agent's output names another
  //    department for follow-up, queue that delegation automatically.
  //    Capped at 2 follow-ups per delegation to avoid chain explosions.
  void chainHandoff(i.workspaceId, delegationId, def.slug, def.department, final.content, i.context)

  return {
    ok: true,
    delegationId,
    definitionId: def.id,
    slug:         def.slug,
    department:   def.department,
    result:       final.content,
    tokens:       final.tokens,
    costUsd:      final.costUsd,
    provider:     final.provider,
    model:        final.model,
    ...(chain ? { reasoningChainId: chain } : {}),
  }
}

// ─── Cross-team handoff parser ───────────────────────────────────────
//
// Looks for explicit collaboration cues in agent output:
//   - "delegate to <department>"
//   - "needs <department> input"
//   - "hand off to <department>"
//   - "@<slug>" (direct mention)
// Each match becomes a follow-up delegation. Capped + depth-guarded so
// a chatty agent can't fan out a denial-of-service handoff chain.

const HANDOFF_PATTERNS: RegExp[] = [
  // Explicit syntax we ask agents to use
  /^\s*HANDOFF:\s*([a-z][a-z-]{2,30})\b/gim,
  // Loose natural-language fallbacks
  /\b(?:delegate|hand[\s-]?off|hand it|pass)\s+(?:this\s+)?to\s+(?:the\s+)?([a-z][a-z-]{2,30})\b/gi,
  /\bneed[s]?\s+(?:the\s+)?([a-z][a-z-]{2,30})\s+(?:team|department|to|input|help|involvement)\b/gi,
  /\b(?:the\s+)?([a-z][a-z-]{2,30})\s+(?:team|department)\s+(?:needs|will need|must|should|to)\b/gi,
  /\b@([a-z][a-z0-9-]{2,40})\b/g,
]

const MAX_HANDOFFS_PER_DELEGATION = 2
const MAX_HANDOFF_DEPTH = 3   // a -> b -> c -> stop

async function chainHandoff(
  workspaceId: string,
  parentDelegationId: string,
  parentSlug: string,
  parentDept: string,
  resultText: string,
  parentContext?: Record<string, unknown>,
): Promise<void> {
  if (!resultText || resultText.length < 50) return
  const depth = ((parentContext as { handoffDepth?: number } | undefined)?.handoffDepth ?? 0) + 1
  if (depth > MAX_HANDOFF_DEPTH) return

  // Extract candidate targets
  const targets = new Set<string>()
  for (const re of HANDOFF_PATTERNS) {
    let m: RegExpExecArray | null
    re.lastIndex = 0
    while ((m = re.exec(resultText)) !== null) {
      const cand = m[1]?.toLowerCase()
      if (!cand) continue
      if (cand === parentDept || cand === parentSlug) continue   // don't loop back
      targets.add(cand)
      if (targets.size >= MAX_HANDOFFS_PER_DELEGATION * 3) break  // wide net, filter later
    }
  }
  if (targets.size === 0) return

  // Resolve each candidate against the catalog: prefer department match,
  // fall back to slug fuzzy match
  const catalog = await db.select({
    id: agentDefinitions.id, slug: agentDefinitions.slug, department: agentDefinitions.department,
  }).from(agentDefinitions)
    .where(eq(agentDefinitions.workspaceId, workspaceId))
    .catch(() => [])
  const byDept = new Map<string, typeof catalog[number][]>()
  const bySlug = new Map<string, typeof catalog[number]>()
  for (const c of catalog) {
    if (!byDept.has(c.department)) byDept.set(c.department, [])
    byDept.get(c.department)!.push(c)
    bySlug.set(c.slug, c)
  }

  let queued = 0
  for (const target of targets) {
    if (queued >= MAX_HANDOFFS_PER_DELEGATION) break

    // Direct slug match first
    const exact = bySlug.get(target) ?? bySlug.get(target.replace(/[-_]/g, '-'))
    // Department match second — pick any agent in that dept (CEO will refine via pickAgent later)
    const deptHint = exact ? exact.department : (byDept.has(target) ? target : undefined)
    if (!deptHint) continue

    // Fire the handoff. Use the same delegateToAgent so it picks the
    // best agent within the target department, persists a new
    // delegation row, and inherits handoff depth.
    const handoffTask = `[Handoff from ${parentDept}/${parentSlug}] ${resultText.slice(0, 800)}`
    void delegateToAgent({
      workspaceId,
      task: handoffTask,
      hint: deptHint,
      context: {
        ...(parentContext ?? {}),
        handoffDepth:        depth,
        handoffFromDelegation: parentDelegationId,
        handoffFromSlug:       parentSlug,
        handoffFromDepartment: parentDept,
      },
      requestedBy: `handoff:${parentSlug}`,
    }).then(r => {
      if (r.ok) {
        // Audit the chain so the brain graph + decision-path can render it
        return recordChain({
          workspaceId,
          kind: 'decision',
          subjectId: `handoff:${parentDelegationId}:${r.delegationId}`,
          decision: `Cross-team handoff: ${parentDept}/${parentSlug} → ${r.department}/${r.slug} (depth ${depth})`,
          evidence: [
            { type: 'delegation', id: parentDelegationId,   extract: parentSlug },
            { type: 'delegation', id: r.delegationId,       extract: r.slug },
          ],
          confidence: 0.7,
          source: 'agent-handoff',
        })
      }
      return null
    }).catch(() => null)
    queued++
  }
}

/** List recent delegations for the workspace. */
export async function listDelegations(workspaceId: string, limit = 30) {
  return db.select().from(agentDelegations)
    .where(eq(agentDelegations.workspaceId, workspaceId))
    .orderBy(desc(agentDelegations.createdAt))
    .limit(limit).catch(() => [])
}
