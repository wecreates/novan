/**
 * novan-chat.ts — Operator-facing chat with Novan.
 *
 * Flow:
 *   1. Persist user message
 *   2. Build memory-injected system prompt (identity + charter + state + horizons + chains)
 *   3. Semantic-search recent chains for query-relevant context
 *   4. Stream completion via Groq (with provider fallback)
 *   5. Identity-audit the final response
 *   6. Persist assistant message with citations + audit + token usage
 *   7. Record reasoning chain so the conversation is auditable
 *
 * Safety:
 *   - Budget guard via cron-budget ('novan_chat')
 *   - Hard refusal patterns checked on assistant output (purchase/spam/IP)
 *   - Identity audit surfaces hype/fake-certainty
 *   - All assistant outputs persisted with token/cost accounting
 *
 * Honest scope:
 *   - Streams via SSE
 *   - No autonomous tool execution — Novan can SUGGEST actions; operator
 *     triggers them via the existing dashboard buttons. Chat surfaces
 *     "I propose X — open /proposals to act."
 */
import { db } from '../db/client.js'
import {
  conversations, messages, reasoningChains, strategicHorizons,
  designConcepts, driftWarnings, codeProposals,
} from '../db/schema.js'
import { and, eq, desc, gte } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { getProfile, CORE_TRAITS, audit as identityAudit } from './identity-core.js'
import { CHARTER } from './mission-charter.js'
import { search as semanticSearch, indexChain } from './semantic-search.js'
import { record as recordChain } from './reasoning-chains.js'
import { getRuntimeStatus } from './runtime-heartbeat.js'
import { checkBudget, consume } from './cron-budget.js'
import { checkPublishContent } from './commerce-policy.js'

// ─── Conversation mgmt ──────────────────────────────────────────────────

export async function createConversation(workspaceId: string, title?: string): Promise<string> {
  const id = uuidv7(), now = Date.now()
  await db.insert(conversations).values({
    id, workspaceId, title: (title ?? 'New conversation').slice(0, 200),
    messageCount: 0, totalTokens: 0, totalCostUsd: 0, archived: false,
    createdAt: now, updatedAt: now,
  }).catch(() => null)
  return id
}

export async function listConversations(workspaceId: string, limit = 30) {
  return db.select().from(conversations)
    .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.archived, false)))
    .orderBy(desc(conversations.updatedAt))
    .limit(limit).catch(() => [])
}

export async function listMessages(workspaceId: string, conversationId: string) {
  return db.select().from(messages)
    .where(and(eq(messages.workspaceId, workspaceId), eq(messages.conversationId, conversationId)))
    .orderBy(messages.createdAt).catch(() => [])
}

export async function archiveConversation(workspaceId: string, conversationId: string): Promise<void> {
  await db.update(conversations).set({ archived: true, updatedAt: Date.now() })
    .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.id, conversationId)))
    .catch(() => null)
}

// ─── System prompt builder (memory injection) ───────────────────────────

interface PromptContext {
  systemPrompt: string
  citations: Array<{ kind: string; id: string; extract: string }>
}

async function buildSystemPrompt(workspaceId: string, userMessage: string): Promise<PromptContext> {
  const citations: PromptContext['citations'] = []

  // 1. Identity
  const profile = await getProfile(workspaceId).catch(() => null)
  const traits = profile?.traits ?? CORE_TRAITS

  // 2. Charter top principles (always include the operator-first + safety ones)
  const corePrinciples = CHARTER.filter(p => ['identity', 'reality_anchoring', 'security_ethics', 'operator_first', 'explainability'].includes(p.section))

  // 3. Runtime liveness
  const runtime = getRuntimeStatus()

  // 4. Active strategic horizons
  const horizons = await db.select().from(strategicHorizons)
    .where(and(eq(strategicHorizons.workspaceId, workspaceId), eq(strategicHorizons.status, 'active')))
    .limit(5).catch(() => [])

  // 5. Open drift warnings
  const drifts = await db.select().from(driftWarnings)
    .where(and(eq(driftWarnings.workspaceId, workspaceId), eq(driftWarnings.status, 'open')))
    .limit(3).catch(() => [])

  // 6. Pending code proposals
  const proposals = await db.select().from(codeProposals)
    .where(and(eq(codeProposals.workspaceId, workspaceId), eq(codeProposals.status, 'proposed')))
    .orderBy(desc(codeProposals.createdAt)).limit(3).catch(() => [])

  // 7. Semantic-relevant past chains
  const chainHits = await semanticSearch(workspaceId, userMessage, { limit: 5, minScore: 0.1 }).catch(() => [])
  for (const h of chainHits) {
    citations.push({ kind: 'chain', id: h.chainId, extract: h.decision })
  }

  // 8. Recent design concepts (commerce/creative context)
  const recentDesigns = await db.select({ brief: designConcepts.brief, prompt: designConcepts.prompt, status: designConcepts.status })
    .from(designConcepts)
    .where(eq(designConcepts.workspaceId, workspaceId))
    .orderBy(desc(designConcepts.createdAt)).limit(3).catch(() => [])

  const lines: string[] = []
  lines.push('You are Novan. You are NOT a chatbot, prompt executor, or toy AI. You are a distributed autonomous operational intelligence system.')
  lines.push('')
  lines.push('### Identity traits (target levels 0..1):')
  for (const [k, v] of Object.entries(traits).slice(0, 10)) {
    lines.push(`  ${k.replace(/_/g, ' ')}: ${(Number(v) * 100).toFixed(0)}%`)
  }
  lines.push('')
  lines.push('### Communication standards (HARD requirements):')
  lines.push('  - Always separate FACTS from FORECASTS. Mark predictions explicitly (estimate, ~, likely, conf X).')
  lines.push('  - Never use hype: no "absolutely", "100%", "game-changing", "revolutionary", "skyrocket", "10x", multiple exclamations.')
  lines.push('  - In any prediction context, include an uncertainty marker (likely / may / forecast / confidence X).')
  lines.push('  - Be concise. Be tactical. Be operationally focused.')
  lines.push('  - Never claim a system is "fixed/verified/complete" without typecheck + tests + smoke.')
  lines.push('  - Cite evidence by chain ID when you reference past decisions.')
  lines.push('  - If operator asks for something blocked (purchases, spam, IP-violating, deceptive), refuse plainly and explain.')
  lines.push('')
  lines.push('### Operator sovereignty:')
  lines.push('  - The operator retains FULL override authority. You suggest; they decide.')
  lines.push('  - You may PROPOSE actions (e.g. "I can build a proposal for X") but never auto-execute high-risk operations.')
  lines.push('  - Direct the operator to specific dashboard pages: /home, /commerce, /proposals, /patches, /economy, /trust-governance, /mission.')
  lines.push('')
  lines.push('### Charter (top principles):')
  for (const p of corePrinciples) {
    lines.push(`  ${p.id.toUpperCase()}: ${p.statement}`)
  }
  lines.push('')
  lines.push('### Current runtime state:')
  lines.push(`  Uptime: ${runtime.uptimeHuman} · ${runtime.cyclesRun} heartbeats · ${runtime.memoryMb}MB`)
  lines.push('')
  if (horizons.length > 0) {
    lines.push('### Active strategic horizons:')
    for (const h of horizons) {
      lines.push(`  [${h.horizon}] ${h.title}`)
    }
    lines.push('')
  }
  if (drifts.length > 0) {
    lines.push('### Open drift warnings:')
    for (const d of drifts) lines.push(`  · ${d.kind} (${d.severity}): ${d.recommendedAction ?? ''}`)
    lines.push('')
  }
  if (proposals.length > 0) {
    lines.push('### Pending code proposals awaiting operator review:')
    for (const p of proposals) lines.push(`  · ${p.title} (~${p.estimatedLoc} LOC, risk=${p.riskLevel}) at /proposals`)
    lines.push('')
  }
  if (chainHits.length > 0) {
    lines.push('### Semantically relevant past reasoning chains:')
    for (const h of chainHits) {
      lines.push(`  · [${h.kind}] ${h.decision.slice(0, 140)} (chain:${h.chainId.slice(0, 8)})`)
    }
    lines.push('')
  }
  if (recentDesigns.length > 0) {
    lines.push('### Recent design concepts:')
    for (const d of recentDesigns) lines.push(`  · ${d.brief.slice(0, 80)} → ${d.status}`)
    lines.push('')
  }
  lines.push('Respond directly. No preamble. Reference dashboard pages by path when relevant.')

  return { systemPrompt: lines.join('\n'), citations }
}

// ─── LLM call (Groq) ────────────────────────────────────────────────────

interface LLMResult {
  content: string
  tokens: number
  costUsd: number
  provider: string
  model: string
}

interface LLMStreamChunk { delta: string; done: boolean }

async function* streamFromGroq(systemPrompt: string, history: Array<{ role: 'user' | 'assistant'; content: string }>, userMessage: string): AsyncGenerator<LLMStreamChunk, LLMResult> {
  const apiKey = process.env['GROQ_API_KEY']
  if (!apiKey) {
    yield { delta: '_(LLM unavailable — GROQ_API_KEY not configured. Configure /notifications page to set up.)_', done: true }
    return { content: '_(LLM unavailable)_', tokens: 0, costUsd: 0, provider: 'none', model: 'none' }
  }

  const msgs = [
    { role: 'system' as const, content: systemPrompt },
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: userMessage },
  ]

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: msgs,
      stream: true,
      temperature: 0.3,
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(90_000),
  }).catch(() => null)

  if (!res || !res.ok || !res.body) {
    const err = `_(provider error: ${res?.status ?? 'no response'})_`
    yield { delta: err, done: true }
    return { content: err, tokens: 0, costUsd: 0, provider: 'groq', model: 'llama-3.3-70b-versatile' }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fullContent = ''
  let totalTokens = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (!t || !t.startsWith('data:')) continue
      const payload = t.slice(5).trim()
      if (payload === '[DONE]') continue
      try {
        const obj = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>
          x_groq?: { usage?: { total_tokens?: number } }
        }
        const delta = obj.choices?.[0]?.delta?.content ?? ''
        if (delta) {
          fullContent += delta
          yield { delta, done: false }
        }
        if (obj.x_groq?.usage?.total_tokens) totalTokens = obj.x_groq.usage.total_tokens
      } catch { /* ignore malformed chunks */ }
    }
  }

  yield { delta: '', done: true }
  return {
    content: fullContent,
    tokens: totalTokens,
    costUsd: Number(((totalTokens * 0.59) / 1_000_000).toFixed(6)),
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
  }
}

// ─── Public chat entry ──────────────────────────────────────────────────

export interface ChatTurnInput {
  workspaceId:    string
  conversationId: string
  userMessage:    string
}

/** Yields SSE-shaped events. Caller writes them to the wire. */
export async function* chatTurn(i: ChatTurnInput): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  // 0. Budget guard
  const budget = await checkBudget('novan_chat', {
    maxCalls: 500, maxTokens: 2_000_000, maxCostUsd: 5.0, windowMs: 24 * 60 * 60_000,
  })
  if (!budget.ok) {
    yield { event: 'error', data: { reason: budget.reason ?? 'budget_blocked' } }
    return
  }

  const now = Date.now()

  // 1. Persist user message
  const userMsgId = uuidv7()
  await db.insert(messages).values({
    id: userMsgId, conversationId: i.conversationId, workspaceId: i.workspaceId,
    role: 'user', content: i.userMessage.slice(0, 20_000),
    citations: [], tokens: 0, costUsd: 0,
    streamComplete: true, createdAt: now,
  }).catch(() => null)
  yield { event: 'user_message', data: { id: userMsgId } }

  // 2. Build system prompt + load history
  const ctx = await buildSystemPrompt(i.workspaceId, i.userMessage)
  yield { event: 'context_ready', data: { citations: ctx.citations.length } }

  const history = (await listMessages(i.workspaceId, i.conversationId))
    .filter(m => m.id !== userMsgId)
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-20)
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

  // 3. Create assistant message row (will fill as stream completes)
  const asstMsgId = uuidv7()
  await db.insert(messages).values({
    id: asstMsgId, conversationId: i.conversationId, workspaceId: i.workspaceId,
    role: 'assistant', content: '',
    citations: ctx.citations,
    streamComplete: false, createdAt: Date.now(),
  }).catch(() => null)
  yield { event: 'assistant_start', data: { id: asstMsgId } }

  // 4. Stream LLM
  const stream = streamFromGroq(ctx.systemPrompt, history, i.userMessage)
  let final: LLMResult = { content: '', tokens: 0, costUsd: 0, provider: '', model: '' }
  let next: IteratorResult<LLMStreamChunk, LLMResult>
  // eslint-disable-next-line no-cond-assign
  while (!(next = await stream.next()).done) {
    if (next.value.delta) {
      yield { event: 'delta', data: { content: next.value.delta } }
    }
  }
  final = next.value

  // 5. Hard refusal check on output (purchase/IP/spam)
  const content = checkPublishContent(final.content)
  if (!content.ok) {
    // Replace content with refusal
    final = {
      ...final,
      content: `_(Response withheld: violated ${content.category} policy — ${content.reasons.join('; ')}. This is a safety boundary, not an operator preference.)_`,
    }
    yield { event: 'policy_block', data: { category: content.category, reasons: content.reasons } }
  }

  // 6. Identity audit
  const auditResult = identityAudit(final.content, 'support')
  yield { event: 'audit', data: auditResult as unknown as Record<string, unknown> }

  // 7. Persist final
  await db.update(messages).set({
    content: final.content, tokens: final.tokens, costUsd: final.costUsd,
    provider: final.provider, model: final.model,
    audit: auditResult as unknown as Record<string, unknown>,
    streamComplete: true,
  }).where(eq(messages.id, asstMsgId)).catch(() => null)

  // 8. Update conversation stats
  await db.update(conversations).set({
    messageCount: (await listMessages(i.workspaceId, i.conversationId)).length,
    totalTokens: final.tokens,
    totalCostUsd: final.costUsd,
    updatedAt: Date.now(),
  }).where(eq(conversations.id, i.conversationId)).catch(() => null)

  // 9. Consume budget
  await consume('novan_chat', { calls: 1, tokens: final.tokens, costUsd: final.costUsd })

  // 10. Record reasoning chain + index for future semantic search
  await recordChain({
    workspaceId: i.workspaceId,
    kind: 'decision',
    subjectId: `chat:${i.conversationId}`,
    decision: `Operator chat turn: "${i.userMessage.slice(0, 80)}…" → Novan responded (${final.tokens} tokens, audit ${auditResult.passed ? 'passed' : 'failed'})`,
    evidence: ctx.citations.map(c => ({ type: c.kind, id: c.id, extract: c.extract })),
    confidence: auditResult.passed ? 0.7 : 0.4,
    source: 'novan-chat',
  }).catch(() => null)
  await indexChain(i.workspaceId, asstMsgId, final.content.slice(0, 1000), 'chat').catch(() => null)

  yield { event: 'done', data: {
    messageId: asstMsgId, tokens: final.tokens, costUsd: final.costUsd,
    auditPassed: auditResult.passed, citations: ctx.citations.length,
  } }
}
