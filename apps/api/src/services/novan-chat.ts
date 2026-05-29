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
  conversations, messages, strategicHorizons,
  designConcepts, driftWarnings, codeProposals, chatActions,
  memories, issues,
} from '../db/schema.js'
import { and, eq, desc, gte, inArray, ilike, or } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { getProfile, CORE_TRAITS, audit as identityAudit } from './identity-core.js'
import { CHARTER } from './mission-charter.js'
import { search as semanticSearch, indexChain } from './semantic-search.js'
import { record as recordChain } from './reasoning-chains.js'
import { getRuntimeStatus } from './runtime-heartbeat.js'
import { checkBudget, consume } from './cron-budget.js'
import { checkPublishContent } from './commerce-policy.js'
import { streamChat as multiStreamChat, type ChatMsg } from './chat-providers.js'
import { detectIntents } from './chat-intent.js'
import { validateAttachments, type ChatAttachment } from './chat-attachments.js'

// Per-workspace cache of recent risk-alert scans so we don't slam the DB
// on every chat turn. 10-min TTL is enough to surface critical alerts
// promptly while keeping costs bounded.
const riskAlertCache = new Map<string, { at: number; critical: Array<{ category: string; evidence: string[]; recommendation: string; severity: string }> }>()

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

/** Default cap on messages returned per conversation. Without this, a
 *  long conversation forces a full scan + ships hundreds of KB to the
 *  client on every load. Callers needing more can pass an explicit limit. */
const MESSAGES_LIST_DEFAULT_LIMIT = 200
const MESSAGES_LIST_MAX_LIMIT     = 1000

export async function listMessages(
  workspaceId:    string,
  conversationId: string,
  limit:          number = MESSAGES_LIST_DEFAULT_LIMIT,
) {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), MESSAGES_LIST_MAX_LIMIT)
  // Take the most recent `safeLimit` rows then re-sort ascending so the
  // caller still gets chronological order. Without the LIMIT, a 10k-message
  // conversation streamed back per chat turn was the dominant DB cost.
  const recent = await db.select().from(messages)
    .where(and(eq(messages.workspaceId, workspaceId), eq(messages.conversationId, conversationId)))
    .orderBy(desc(messages.createdAt))
    .limit(safeLimit)
    .catch(() => [])
  return recent.reverse()
}

export async function archiveConversation(workspaceId: string, conversationId: string): Promise<void> {
  await db.update(conversations).set({ archived: true, updatedAt: Date.now() })
    .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.id, conversationId)))
    .catch(() => null)
}

/**
 * Find the user turn that produced `assistantMessageId` and return the
 * inputs the client needs to call /stream with `regenerate_from` set.
 *
 * Returns:
 *   { ok: true,  conversationId, userMessage, regenerateFrom }   on success
 *   { ok: false, reason }                                         when the
 *     message is unknown, isn't an assistant message, or has no preceding
 *     user turn (corrupt history).
 */
/**
 * Full-text search across the operator's chat messages. ILIKE on
 * content + title; returns hits with their conversation context.
 */
export async function searchChatMessages(workspaceId: string, q: string, limit = 30) {
  const like = `%${q.replace(/[%_]/g, m => `\\${m}`)}%`
  const msgHits = await db.select({
      id: messages.id, conversationId: messages.conversationId,
      role: messages.role, content: messages.content, createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(eq(messages.workspaceId, workspaceId), ilike(messages.content, like)))
    .orderBy(desc(messages.createdAt)).limit(limit).catch(() => [])

  const convoIds = [...new Set(msgHits.map(m => m.conversationId))]
  const convos = convoIds.length > 0
    ? await db.select({ id: conversations.id, title: conversations.title })
        .from(conversations)
        .where(and(eq(conversations.workspaceId, workspaceId), inArray(conversations.id, convoIds)))
        .catch(() => [])
    : []
  const titleByConvo = new Map(convos.map(c => [c.id, c.title]))

  return msgHits.map(m => ({
    messageId:     m.id,
    conversationId: m.conversationId,
    conversationTitle: titleByConvo.get(m.conversationId) ?? '(untitled)',
    role:          m.role,
    excerpt:       (() => {
      const idx = m.content.toLowerCase().indexOf(q.toLowerCase())
      const start = Math.max(0, idx - 80)
      const end   = Math.min(m.content.length, idx + 80 + q.length)
      return (start > 0 ? '…' : '') + m.content.slice(start, end) + (end < m.content.length ? '…' : '')
    })(),
    createdAt: m.createdAt,
  }))
}

export async function regenerateMessage(workspaceId: string, assistantMessageId: string): Promise<
  | { ok: true; conversationId: string; userMessage: string; regenerateFrom: string }
  | { ok: false; reason: string }
> {
  const target = await db.select().from(messages)
    .where(and(eq(messages.workspaceId, workspaceId), eq(messages.id, assistantMessageId)))
    .limit(1).then(r => r[0]).catch(() => null)
  if (!target)                       return { ok: false, reason: 'message not found' }
  if (target.role !== 'assistant')   return { ok: false, reason: 'can only regenerate assistant messages' }
  if (target.supersededAt)           return { ok: false, reason: 'message is already superseded' }
  // Refuse to regenerate from a cancelled/partial message — the source
  // text the operator sees is truncated and replay against it could
  // produce a coherent-looking response that doesn't reflect what the
  // operator was actually doing. Operator must explicitly start a fresh
  // turn instead. Cast via `as` because cancelled+streamComplete are
  // optional fields not all schema callers materialize.
  const tt = target as typeof target & { cancelled?: boolean; streamComplete?: boolean }
  if (tt.cancelled === true)         return { ok: false, reason: 'cannot regenerate from a cancelled response — start a fresh turn' }

  // Find the user message immediately preceding this assistant message
  const conv = await db.select().from(messages)
    .where(and(eq(messages.workspaceId, workspaceId), eq(messages.conversationId, target.conversationId)))
    .orderBy(messages.createdAt).catch(() => [])
  const idx = conv.findIndex(m => m.id === assistantMessageId)
  if (idx <= 0) return { ok: false, reason: 'no preceding user turn' }
  // Walk back to the nearest non-superseded user message
  let userMsg: typeof conv[number] | null = null
  for (let i = idx - 1; i >= 0; i--) {
    const m = conv[i]!
    if (m.role === 'user') { userMsg = m; break }
  }
  if (!userMsg) return { ok: false, reason: 'no preceding user turn' }
  return {
    ok: true,
    conversationId: target.conversationId,
    userMessage:    userMsg.content,
    regenerateFrom: assistantMessageId,
  }
}

// ─── brain-task fenced-block parser ─────────────────────────────────────
//
// The model is told to emit tool dispatches as fenced ```brain-task
// ```JSON code-blocks. We pull each block, parse it, and validate the
// shape minimally. Anything off-spec is dropped silently — better than
// running garbage. The full safety stack runs again inside executePlan.

interface BrainTaskBlock { op: string; params: Record<string, unknown> }

function extractBrainTaskBlocks(text: string): BrainTaskBlock[] {
  const out: BrainTaskBlock[] = []
  const re = /```brain-task\s*\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const body = (m[1] ?? '').trim()
    if (!body) continue
    try {
      const parsed = JSON.parse(body) as unknown
      // Support both single object and array of blocks
      const arr = Array.isArray(parsed) ? parsed : [parsed]
      for (const item of arr) {
        if (item && typeof item === 'object' && typeof (item as { op?: unknown }).op === 'string') {
          out.push({
            op:     (item as { op: string }).op,
            params: ((item as { params?: Record<string, unknown> }).params ?? {}),
          })
        }
      }
    } catch { /* malformed — skip */ }
  }
  return out
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

  // 9. High-confidence long-term memories (operator preferences, learned facts,
  //    durable context the memory-worker has scored). Ordered by recency × confidence.
  const recentMemories = await db.select({
      type: memories.type, summary: memories.summary, content: memories.content,
      tags: memories.tags, confidence: memories.confidence,
    })
    .from(memories)
    .where(and(
      eq(memories.workspaceId, workspaceId),
      gte(memories.confidence, 0.6),
    ))
    .orderBy(desc(memories.confidence), desc(memories.updatedAt))
    .limit(8).catch(() => [])

  // 10. Open / diagnosed issues — operator might be asking "what's broken"
  const openIssues = await db.select({
      symptom: issues.symptom, rootCause: issues.rootCause, severity: issues.severity,
      status: issues.status, proposedFix: issues.proposedFix,
    })
    .from(issues)
    .where(and(
      eq(issues.workspaceId, workspaceId),
      inArray(issues.status, ['open', 'triaged', 'diagnosed']),
    ))
    .orderBy(desc(issues.detectedAt))
    .limit(5).catch(() => [])

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
  lines.push('  - For specialist work (marketing copy, design review, backend architecture, sales outreach, finance forecasts, etc.) suggest delegating via /agency. The brain acts as CEO and routes the task to the best matching agent from the 200+ catalog. Phrase: "I can delegate this to <department> — say ‘delegate to <department>’ to confirm."')
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
  if (recentMemories.length > 0) {
    lines.push('### Long-term memories (operator preferences + learned facts):')
    for (const m of recentMemories) {
      const tagStr = (m.tags && m.tags.length > 0) ? ` [${m.tags.slice(0, 3).join(',')}]` : ''
      lines.push(`  · [${m.type}${tagStr} conf=${m.confidence.toFixed(2)}] ${(m.summary ?? m.content).slice(0, 140)}`)
    }
    lines.push('')
  }
  if (openIssues.length > 0) {
    lines.push('### Open issues right now (use these if operator asks "what is broken"):')
    for (const i of openIssues) {
      lines.push(`  · [${i.severity} · ${i.status}] ${i.symptom.slice(0, 100)}`)
      if (i.rootCause)   lines.push(`      cause: ${i.rootCause.slice(0, 120)}`)
      if (i.proposedFix) lines.push(`      fix:   ${i.proposedFix.slice(0, 120)}`)
    }
    lines.push('')
  }
  lines.push('### Available tools (brain-task operations):')
  lines.push('  - Browser: open/click/fill/text/screenshot/evaluate/wait_for/close')
  lines.push('  - Desktop: exec/read_file/write_file/list_dir/open_app/screenshot/processes')
  lines.push('  - Platform: db.query/platform.smoke/providers.validate/mind.cycle/issue.ingest/issue.auto_loop/web.fetch/code.search')
  lines.push('  - To DISPATCH a tool, end your reply with a JSON code-block like:')
  lines.push('      ```brain-task')
  lines.push('      {"op":"<name>","params":{...}}')
  lines.push('      ```')
  lines.push('  - The operator confirms, then the platform runs it. NEVER fabricate the result — wait for the actual run.')
  lines.push('  - Financial actions are HARD-BLOCKED. Do not propose money operations.')
  lines.push('')
  lines.push('Respond directly. No preamble. Reference dashboard pages by path when relevant.')

  return { systemPrompt: lines.join('\n'), citations }
}

// ─── Public chat entry ──────────────────────────────────────────────────

export interface ChatTurnInput {
  workspaceId:    string
  conversationId: string
  userMessage:    string
  /** When set, the new assistant message is marked as a regeneration of
   *  this prior assistant message id, and the prior is marked superseded. */
  regenerateFrom?: string
  /** Polled between events; true means the client disconnected and the
   *  generator should stop and persist what it has so far. */
  isCancelled?:   () => boolean
  /** Optional multimodal inputs (images / docs) for the user message. */
  attachments?:   ChatAttachment[]
  /** When set, route this turn through the named provider if it's enabled. */
  preferProvider?: string
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

  // 0a. Validate attachments (oversize / unknown mimes → refuse early)
  const validated = validateAttachments(i.attachments ?? [])
  if (!validated.ok) {
    yield { event: 'error', data: { reason: `attachments_invalid: ${validated.reason}` } }
    return
  }
  const attachments = validated.attachments ?? []

  // 1. Persist user message
  const userMsgId = uuidv7()
  await db.insert(messages).values({
    id: userMsgId, conversationId: i.conversationId, workspaceId: i.workspaceId,
    role: 'user', content: i.userMessage.slice(0, 20_000),
    citations: [], tokens: 0, costUsd: 0,
    streamComplete: true, createdAt: now,
    attachments,
  }).catch(() => null)
  yield { event: 'user_message', data: { id: userMsgId, attachments: attachments.length } }

  // ─── Operator DNA observation — was wired as an op but never called
  //     automatically. Now every turn refines the brain's understanding
  //     of the operator's preferences without an explicit call.
  try {
    const { observeTurn } = await import('./civilization-core.js')
    const signals: Parameters<typeof observeTurn>[1] = {
      messageLength: i.userMessage.length,
      hourOfDay: new Date().getHours(),
    }
    if (/\b(don'?t|stop|pause|too\s+risky|hold\s+on)\b/i.test(i.userMessage)) signals.userClarifiedRisk = true
    if (/\b(no|don'?t)\s+(auto|automate|automatically)/i.test(i.userMessage))  signals.rejectedAutomation = true
    // Fire-and-forget but with a catch handler — without it, an
    // unhandled rejection from civilization-core kills the process-
    // level safety net's `unhandledRejection` budget.
    void observeTurn(i.workspaceId, signals).catch((e: unknown) => {
      console.error('[novan-chat] observeTurn failed:', (e as Error).message)
    })
  } catch (e) { console.error('[novan-chat] DNA signal assembly failed:', (e as Error).message) }

  // ─── 4 session-start context blocks fetched in parallel ──────────────
  //     Risk alerts (cached) + recap memory + DNA + kill-switch state.
  const [riskAlertBlk, recapBlk, dnaBlk, killSwitchBlk] = await Promise.all([
    // Risk alerts (10-min cache per workspace)
    (async (): Promise<string> => {
      try {
        const cached = riskAlertCache.get(i.workspaceId)
        let critical: Array<{ category: string; evidence: string[]; recommendation: string; severity: string }> = []
        if (cached && Date.now() - cached.at < 10 * 60_000) {
          critical = cached.critical
        } else {
          const { scanAll } = await import('./failure-detector.js')
          const { alerts } = await scanAll(i.workspaceId)
          critical = alerts.filter(a => a.severity === 'critical').slice(0, 3)
          riskAlertCache.set(i.workspaceId, { at: Date.now(), critical })
        }
        if (critical.length === 0) return ''
        return `\n\n## Open critical risk alerts (surface these to the operator if relevant)\n${critical.map(a => `- [${a.category}] ${a.evidence[0]} → ${a.recommendation}`).join('\n')}`
      } catch { return '' }
    })(),
    // Executive recap
    (async (): Promise<string> => {
      try {
        const { db } = await import('../db/client.js')
        const { memories } = await import('../db/schema.js')
        const { and, eq, sql: _sql, desc } = await import('drizzle-orm')
        const recapRows = await db.select({ content: memories.content, createdAt: memories.createdAt })
          .from(memories)
          .where(and(
            eq(memories.workspaceId, i.workspaceId),
            _sql`${memories.tags} @> ARRAY['executive-recap']`,
          ))
          .orderBy(desc(memories.createdAt))
          .limit(1)
        if (recapRows[0] && Date.now() - Number(recapRows[0].createdAt) < 36 * 3_600_000) {
          return `\n\n## Most recent executive recap (last 24-36h)\n${recapRows[0].content}\n\nReference this when the operator asks "what happened" or "what's new".`
        }
      } catch { /* */ }
      return ''
    })(),
    // Operator DNA
    (async (): Promise<string> => {
      try {
        const { getOperatorDna } = await import('./civilization-core.js')
        const dna = await getOperatorDna(i.workspaceId)
        if (dna.observedFromTurns < 5) return ''
        const styleHint = dna.communicationStyle === 'brief'    ? 'Keep responses tight — 1-3 sentences when possible. Match the operator\'s short-message style.'
                        : dna.communicationStyle === 'detailed' ? 'Operator prefers thorough responses — explain reasoning + cite evidence.'
                        : ''
        const riskHint  = dna.riskTolerance === 'low'  ? 'Operator is risk-averse — surface trade-offs explicitly; never auto-act on irreversible changes.'
                        : dna.riskTolerance === 'high' ? 'Operator is action-oriented — present plans concisely; ask fewer clarifying questions.'
                        : ''
        const cadenceHint = dna.workCadence === 'sprint' ? 'Operator is in sprint mode — prioritize what unblocks the next ship.'
                        :   dna.workCadence === 'paced'  ? 'Operator works in measured pace — avoid urgency framing.'
                        : ''
        const parts = [styleHint, riskHint, cadenceHint].filter(Boolean)
        if (parts.length === 0) return ''
        return `\n\n## Operator preferences (learned from ${dna.observedFromTurns} prior turns)\n- ${parts.join('\n- ')}`
      } catch { return '' }
    })(),
    // Kill-switch state — surface when autonomy is gated so the brain can
    // honestly explain why a fix didn't apply (instead of silently stopping).
    (async (): Promise<string> => {
      try {
        const { db } = await import('../db/client.js')
        const { sql: _sql } = await import('drizzle-orm')
        const rows = await db.execute(_sql`
          SELECT switch_type, enabled FROM kill_switches
          WHERE workspace_id = ${i.workspaceId} AND enabled = false`)
        const disabled = ((rows as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [])
          .map(r => String(r['switch_type']))
        if (disabled.length === 0) return ''
        const friendly: Record<string, string> = {
          autonomous_writes:      'auto-patching disabled — diagnosed issues stop at "approved" instead of shipping',
          autonomous_deploys:     'auto-deploys disabled — shipped patches won\'t deploy without operator approval',
          destructive_migrations: 'destructive migrations disabled — schema drops/renames require operator approval',
          external_communications: 'outbound email/Slack disabled',
        }
        const labels = disabled.map(k => friendly[k] ?? k).filter(Boolean)
        return `\n\n## Kill switches disabled (autonomy gates)\n- ${labels.join('\n- ')}\n\nIf the operator asks "why isn't this fixed yet" or "why didn't you ship that", reference the relevant kill switch. To enable: brain-task with op="kill_switch.enable" + the switch_type.`
      } catch { return '' }
    })(),
  ])
  // Emit risk-alerts event if we got any (preserved from previous sequential code)
  if (riskAlertBlk) {
    const count = (riskAlertBlk.match(/^- \[/gm) ?? []).length
    if (count > 0) yield { event: 'risk_alerts', data: { count, critical: count } }
  }

  // 1b. VIDEO DETECTION — if the user dropped a video URL, watch it
  //     before the LLM responds and inject the analysis as context.
  //     This is what makes "drop a video link + ask a question" work.
  const { extractVideoUrls, analyzeVideo, renderAnalysisForChat } = await import('./video-analyzer.js')
  const videoUrls = extractVideoUrls(i.userMessage)
  const videoBlocks: string[] = []
  if (videoUrls.length > 0) {
    yield { event: 'video_analysis_started', data: { count: videoUrls.length, urls: videoUrls } }
    for (const vurl of videoUrls) {
      try {
        const analysis = await analyzeVideo(vurl, i.userMessage, i.workspaceId)
        if (analysis.ok) {
          videoBlocks.push(renderAnalysisForChat(analysis))
          yield { event: 'video_analyzed', data: {
            url: analysis.url, ok: true,
            ...(analysis.title ? { title: analysis.title } : {}),
            ...(analysis.summary ? { summary: analysis.summary.slice(0, 200) } : {}),
            ...(analysis.framesAnalyzed ? { framesAnalyzed: analysis.framesAnalyzed } : {}),
            ...(analysis.visualHighlights?.length ? { visualCount: analysis.visualHighlights.length } : {}),
          } }
        } else {
          videoBlocks.push(`🎬 Video URL detected: ${vurl} — analysis failed: ${analysis.error ?? 'unknown'}`)
          yield { event: 'video_analyzed', data: { url: vurl, ok: false, error: analysis.error } }
        }
      } catch (e) {
        yield { event: 'video_analyzed', data: { url: vurl, ok: false, error: (e as Error).message } }
      }
    }
  }

  // 1c. SONG / IMAGE / AUDIO URL DETECTION — three multimodal paths to
  //     music generation. Song URL → replicate; image URL → mood-based
  //     song from visuals; audio URL → cover/continue/remix of clip.
  const { extractSongUrls, replicateSong, renderJobForChat } = await import('./music-studio.js')
  const { extractImageUrls, extractAudioUrls, fromImage: musicFromImage, fromAudio: musicFromAudio } = await import('./music-multimodal.js')
  const songUrls  = extractSongUrls(i.userMessage)
  const imageUrls = extractImageUrls(i.userMessage)
  // Audio URLs that aren't already covered by song-host detection
  const rawAudioUrls = extractAudioUrls(i.userMessage)
  const audioUrls = rawAudioUrls.filter(u => !songUrls.includes(u))
  const musicBlocks: string[] = []
  // Image → music (auto-trigger when user attaches an image URL and the
  // message intent is musical: contains "song", "music", "soundtrack",
  // "vibe", "make me a", etc. — otherwise images are usually not for
  // music generation)
  const wantsMusicFromVisual = /\b(song|music|soundtrack|theme|score|track|tune|vibe|jingle|loop)\b/i.test(i.userMessage)
  if (wantsMusicFromVisual && imageUrls.length > 0) {
    yield { event: 'music_from_image_started', data: { count: imageUrls.length, urls: imageUrls } }
    for (const url of imageUrls) {
      try {
        const job = await musicFromImage({ url, instructions: i.userMessage, workspaceId: i.workspaceId })
        musicBlocks.push(renderJobForChat(job))
        yield { event: 'music_from_image', data: {
          url, ok: job.ok, ...(job.audioUrl ? { audioUrl: job.audioUrl } : {}),
          ...(job.error ? { error: job.error } : {}),
        } }
      } catch (e) { yield { event: 'music_from_image', data: { url, ok: false, error: (e as Error).message } } }
    }
  }
  if (audioUrls.length > 0) {
    yield { event: 'music_from_audio_started', data: { count: audioUrls.length, urls: audioUrls } }
    for (const url of audioUrls) {
      try {
        const job = await musicFromAudio({ url, instructions: i.userMessage, workspaceId: i.workspaceId })
        musicBlocks.push(renderJobForChat(job))
        yield { event: 'music_from_audio', data: {
          url, ok: job.ok, ...(job.audioUrl ? { audioUrl: job.audioUrl } : {}),
          ...(job.error ? { error: job.error } : {}),
        } }
      } catch (e) { yield { event: 'music_from_audio', data: { url, ok: false, error: (e as Error).message } } }
    }
  }
  if (songUrls.length > 0) {
    yield { event: 'music_replication_started', data: { count: songUrls.length, urls: songUrls } }
    for (const surl of songUrls) {
      try {
        const job = await replicateSong({ url: surl, instructions: i.userMessage, workspaceId: i.workspaceId })
        musicBlocks.push(renderJobForChat(job))
        yield { event: 'music_replicated', data: {
          url: surl, ok: job.ok,
          ...(job.audioUrl ? { audioUrl: job.audioUrl } : {}),
          ...(job.source?.title ? { title: job.source.title } : {}),
          ...(job.source?.artist ? { artist: job.source.artist } : {}),
          ...(job.bpm ? { bpm: job.bpm } : {}),
          ...(job.key ? { key: job.key } : {}),
          ...(job.error ? { error: job.error } : {}),
        } }
      } catch (e) {
        yield { event: 'music_replicated', data: { url: surl, ok: false, error: (e as Error).message } }
      }
    }
  }

  // 1d-2. Parallelize ALL session-start blocks. These are 6 independent
  //        DB reads that previously ran sequentially (~300ms wall time).
  //        Promise.all collapses them to the slowest single read (~50ms).
  const [
    musicKnowledgeBlk,
    videoKnowledgeBlk,
    ctx,
    historyMessages,
  ] = await Promise.all([
    // Music knowledge
    (async (): Promise<string> => {
      try {
        const { isMusicQuery, musicKnowledgeBlock } = await import('./music-knowledge.js')
        if (isMusicQuery(i.userMessage) || songUrls.length > 0) {
          return await musicKnowledgeBlock(i.workspaceId, i.userMessage)
        }
      } catch { /* */ }
      return ''
    })(),
    // Video knowledge
    (async (): Promise<string> => {
      try {
        const { isVideoQuery, videoKnowledgeBlock } = await import('./video-knowledge.js')
        if (isVideoQuery(i.userMessage) || videoUrls.length > 0) {
          return await videoKnowledgeBlock(i.workspaceId, i.userMessage)
        }
      } catch { /* */ }
      return ''
    })(),
    // System prompt (already complex internally; runs in parallel with rest)
    buildSystemPrompt(i.workspaceId, i.userMessage),
    // Chat history
    listMessages(i.workspaceId, i.conversationId).catch(() => []),
  ])
  yield { event: 'context_ready', data: { citations: ctx.citations.length } }

  const history = historyMessages
    .filter(m => m.id !== userMsgId)
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-20)
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))

  // 3. Create assistant message row (will fill as stream completes).
  //    If this is a regeneration, mark the prior assistant message as
  //    superseded so the UI can hide / collapse it.
  const asstMsgId = uuidv7()
  if (i.regenerateFrom) {
    await db.update(messages)
      .set({ supersededAt: Date.now(), supersededBy: asstMsgId })
      .where(and(eq(messages.id, i.regenerateFrom), eq(messages.workspaceId, i.workspaceId)))
      .catch(() => null)
  }
  await db.insert(messages).values({
    id: asstMsgId, conversationId: i.conversationId, workspaceId: i.workspaceId,
    role: 'assistant', content: '',
    citations: ctx.citations,
    streamComplete: false, createdAt: Date.now(),
    regeneratedFrom: i.regenerateFrom ?? null,
  }).catch(() => null)
  yield { event: 'assistant_start', data: { id: asstMsgId, regeneratedFrom: i.regenerateFrom ?? null } }

  // 4. Stream LLM (multi-provider with fallback)
  // If video URLs were analyzed, prepend the analysis as a system block
  // BEFORE the user turn so the LLM has the video context.
  const videoSystemBlock = videoBlocks.length > 0
    ? `\n\n## Video context (the operator dropped these video URLs — you have already watched / read transcripts)\n\n${videoBlocks.join('\n\n---\n\n')}\n\nWhen the operator asks about "the video", "this video", "what they showed", etc., draw from the analysis above. Cite key moments by timestamp when relevant. Do not fabricate visual details the analysis did not include.`
    : ''
  const musicSystemBlock = musicBlocks.length > 0
    ? `\n\n## Music studio (the operator dropped these song URLs — you replicated them via ACE-Step studio preset)\n\n${musicBlocks.join('\n\n---\n\n')}\n\nThe replicated tracks are studio-quality, near-identical structure with rewritten lyrics + cover-noise variation for legal safety. When the operator asks for tweaks ("more upbeat", "female vocal", "shorter intro"), call music.generate or music.replicate again with the relevant params. Do not claim copyright ownership of the source.`
    : ''
  const musicKnowledgePromptBlock = musicKnowledgeBlk ? `\n\n${musicKnowledgeBlk}` : ''
  const videoKnowledgePromptBlock = videoKnowledgeBlk ? `\n\n${videoKnowledgeBlk}` : ''
  // Always inject the risk-awareness self-check so the brain refuses
  // hallucination / false completion / silent action / fake operational
  // claims at every turn.
  let riskAwarenessBlock = ''
  try {
    const { renderForChat } = await import('./risk-taxonomy.js')
    riskAwarenessBlock = `\n\n${renderForChat()}`
  } catch { /* */ }
  // Playbook auto-injection — when the operator's message mentions a
  // topic covered by a curated playbook (YouTube, social, POD, multi-
  // channel ops), splice the matching playbook section into the system
  // prompt so the LLM grounds its reply in real operating knowledge
  // instead of generic training-data fluff. Capped at ~1800 tokens so
  // it can't blow the system-prompt budget.
  let playbookBlock = ''
  try {
    const { composeReferenceBlock } = await import('./playbook-knowledge.js')
    playbookBlock = await composeReferenceBlock(i.userMessage, { maxTokens: 1800, maxSections: 2 })
  } catch { /* tolerated — playbook is advisory */ }

  // R123 — prepend the workspace's applied-business-template bias block
  // when one exists. Tiny (≤ 800 tokens) so it never crowds the playbook.
  let templateBlock = ''
  try {
    const { templateInjectionBlock } = await import('./template-injection.js')
    templateBlock = await templateInjectionBlock(i.workspaceId)
  } catch { /* tolerated — template bias is advisory */ }
  if (templateBlock) playbookBlock = `${templateBlock}\n\n${playbookBlock}`

  // Clamp the assembled system prompt at ~24k chars (~6k tokens). Without
  // this, the safety-critical tail blocks (riskAlertBlk, killSwitchBlk)
  // can get silently truncated by the provider when too many strategic
  // horizons / DNA observations / open issues pile up. Order matters:
  // safety-critical blocks go LAST so the head (videoSystem, etc.) is
  // what gets dropped if anything is over budget. Playbook block sits
  // mid-prompt so it's protected from head truncation but still trims
  // before the safety tail.
  const SYSTEM_PROMPT_MAX_CHARS = 24_000
  const tail = riskAwarenessBlock + riskAlertBlk + recapBlk + dnaBlk + killSwitchBlk
  const midProtected = playbookBlock
  const headBudget = Math.max(0, SYSTEM_PROMPT_MAX_CHARS - tail.length - midProtected.length)
  const rawHead = ctx.systemPrompt + videoSystemBlock + musicSystemBlock + musicKnowledgePromptBlock + videoKnowledgePromptBlock
  const head = rawHead.length > headBudget
    ? rawHead.slice(0, headBudget) + '\n\n[…system prompt truncated to keep safety blocks intact…]'
    : rawHead
  const msgs: ChatMsg[] = [
    { role: 'system', content: head + midProtected + tail },
    ...history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: i.userMessage, ...(attachments.length ? { attachments } : {}) },
  ]
  // Convert the isCancelled-callback into a real AbortController so
  // chat-providers.ts can break out of its reader loop and call
  // reader.cancel() — without this, an aborted browser tab still bills
  // tokens until the LLM completes naturally.
  const abortCtl = new AbortController()
  const stream = multiStreamChat(i.workspaceId, msgs, {
    ...(i.preferProvider ? { preferProvider: i.preferProvider } : {}),
    signal: abortCtl.signal,
  })
  let final = { content: '', tokens: 0, costUsd: 0, provider: 'none', model: 'none' }
  let accumulated = ''
  let next: IteratorResult<{ delta: string; done: boolean }, typeof final>
  let userAborted = false
  while (!(next = await stream.next()).done) {
    if (i.isCancelled?.()) {
      userAborted = true
      abortCtl.abort()
      break
    }
    if (next.value.delta) {
      accumulated += next.value.delta
      yield { event: 'delta', data: { content: next.value.delta } }
    }
  }
  if (userAborted) {
    // Persist whatever we have so it's visible in history + replayable
    await db.update(messages).set({
      content: accumulated, cancelled: true, streamComplete: true,
    }).where(eq(messages.id, asstMsgId)).catch(() => null)
    yield { event: 'cancelled', data: { id: asstMsgId, partial: accumulated.length } }
    return
  }
  // next.value here is the generator's return value (the `final` shape)
  final = next.value as typeof final
  yield { event: 'provider', data: { provider: final.provider, model: final.model } }

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

  // 10. Detect action intents in the user's message → persist as chat_actions
  const intents = detectIntents(i.userMessage)
  const suggestedActions: Array<{ id: string; actionType: string; title: string; summary: string; riskLevel: string }> = []
  for (const intent of intents) {
    const aid = uuidv7()
    await db.insert(chatActions).values({
      id: aid, messageId: asstMsgId, conversationId: i.conversationId,
      workspaceId: i.workspaceId,
      actionType: intent.actionType, title: intent.title,
      summary: intent.summary, payload: intent.payload,
      riskLevel: intent.riskLevel, status: 'suggested',
      createdAt: Date.now(),
    }).catch(() => null)
    suggestedActions.push({
      id: aid, actionType: intent.actionType, title: intent.title,
      summary: intent.summary, riskLevel: intent.riskLevel,
    })
  }
  if (suggestedActions.length > 0) {
    yield { event: 'actions_suggested', data: { actions: suggestedActions } }
  }

  // 10b. brain-task bridge — if the model emitted ```brain-task ...``` blocks,
  //      dispatch each via executePlan. Money-guard + risk-gate already apply
  //      inside brain-task.executePlan, so this surface inherits all safety.
  const taskBlocks = extractBrainTaskBlocks(final.content)
  if (taskBlocks.length > 0) {
    yield { event: 'tools_detected', data: { count: taskBlocks.length, ops: taskBlocks.map(t => t.op) } }
    try {
      const { executePlan } = await import('./brain-task.js')
      const taskResult = await executePlan(i.workspaceId, `chat:${i.conversationId}`, taskBlocks, undefined, 'dispatched from chat')
      yield { event: 'tools_completed', data: {
        results: taskResult.results.map(r => ({ op: r.op, ok: r.ok, durationMs: r.durationMs, ...(r.error ? { error: r.error } : {}) })),
        summary: taskResult.summary,
      } }
      // Persist tool results as a follow-up message so future turns can see them.
      const followId = uuidv7()
      const summaryText = taskResult.results.map(r => `${r.ok ? '✓' : '✗'} ${r.op}${r.error ? `: ${r.error}` : (typeof r.data === 'object' ? `: ${JSON.stringify(r.data).slice(0, 200)}` : '')}`).join('\n')
      await db.insert(messages).values({
        id: followId, conversationId: i.conversationId, workspaceId: i.workspaceId,
        role: 'assistant', content: `**Tool results:**\n\`\`\`\n${summaryText}\n\`\`\``,
        citations: [], streamComplete: true, createdAt: Date.now(),
      }).catch(() => null)
    } catch (e) {
      yield { event: 'tools_failed', data: { error: (e as Error).message } }
    }
  }

  // 11. Record reasoning chain + index for future semantic search
  await recordChain({
    workspaceId: i.workspaceId,
    kind: 'decision',
    subjectId: `chat:${i.conversationId}`,
    decision: `Operator chat turn: "${i.userMessage.slice(0, 80)}…" → Novan responded (${final.tokens} tokens, audit ${auditResult.passed ? 'passed' : 'failed'}, ${suggestedActions.length} actions suggested)`,
    evidence: ctx.citations.map(c => ({ type: c.kind, id: c.id, extract: c.extract })),
    confidence: auditResult.passed ? 0.7 : 0.4,
    source: 'novan-chat',
  }).catch(() => null)
  await indexChain(i.workspaceId, asstMsgId, final.content.slice(0, 1000), 'chat').catch(() => null)

  yield { event: 'done', data: {
    messageId: asstMsgId, tokens: final.tokens, costUsd: final.costUsd,
    provider: final.provider, model: final.model,
    auditPassed: auditResult.passed, citations: ctx.citations.length,
    suggestedActions: suggestedActions.length,
  } }
}
