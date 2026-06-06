/**
 * R146.327 (#4) — clarify-or-act decision layer.
 *
 * Closes the social.clarify partial from R326. Before acting on an
 * ambiguous instruction, decide whether to ask ONE specific question
 * or proceed.
 *
 * Heuristic (cheap, deterministic):
 *   1. Resolution score — how specific is the task?
 *      - has subject (noun)        +0.3
 *      - has constraint (time/$/qty) +0.2
 *      - has target (where to land)  +0.2
 *      - mentions a known relationship/business +0.2
 *      - asks for opinion/recommendation  +0.3
 *   2. If score < 0.6, ask ONE clarifying question targeting the lowest-
 *      scoring dimension. If score >= 0.6, proceed.
 *
 * Caller decides what to do with the verdict. Persists the question
 * to clarify_events so we can learn from the answer.
 */
import { db } from '../db/client.js'
import { clarifyEvents } from '../db/schema.js'
import { v7 as uuidv7 } from 'uuid'

export interface ClarifyVerdict {
  proceed:    boolean
  score:      number
  missing:    string[]    // dimensions absent
  question?:  string      // present iff proceed=false
  reasoning:  string      // short trace for logs
}

const SUBJECT_RX     = /\b(image|video|email|post|message|report|plan|draft|schedule|design|product|page|article|tweet|reply|order|file|test|fix|patch|invoice|contract)\b/i
const CONSTRAINT_RX  = /\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|by\s+\d|in\s+\d+|\$\d|\d+\s*(usd|dollars?)|\d+\s*(min|hr|hour|day|week)|asap|urgent)\b/i
const TARGET_RX      = /\b(to|for|at|in|on|via)\s+([A-Z][a-zA-Z]+|gmail|slack|tiktok|youtube|instagram|the\s+\w+|my\s+\w+)/i
const RELATIONSHIP_RX= /\b(?:vendor|client|partner|teammate|investor|advisor|customer|user)\s+[A-Z][a-zA-Z]+/i
const RECOMMEND_RX   = /\b(should i|what'?s? best|recommend|suggest|which (?:one|do)|help me decide|thoughts)\b/i

export function shouldClarify(userMessage: string): ClarifyVerdict {
  let score = 0
  const missing: string[] = []
  const reasoning: string[] = []

  if (SUBJECT_RX.test(userMessage))      { score += 0.3; reasoning.push('subject') } else missing.push('subject')
  if (CONSTRAINT_RX.test(userMessage))   { score += 0.2; reasoning.push('constraint') } else missing.push('constraint')
  if (TARGET_RX.test(userMessage))       { score += 0.2; reasoning.push('target') } else missing.push('target')
  if (RELATIONSHIP_RX.test(userMessage)) { score += 0.2; reasoning.push('relationship') }
  if (RECOMMEND_RX.test(userMessage))    { score += 0.3; reasoning.push('opinion-ask') }

  // Very short messages (under 8 chars) almost always need clarification.
  if (userMessage.trim().length < 8) { score = Math.min(score, 0.3); missing.unshift('detail') }

  if (score >= 0.6) {
    return { proceed: true, score, missing, reasoning: reasoning.join('+') }
  }

  // Generate ONE question targeting the lowest-scoring dimension.
  let question = 'Before I start — '
  if (missing.includes('subject')) question += 'what specifically do you want produced (image / email / post / report)?'
  else if (missing.includes('target')) question += 'where should the result land (which platform / who\'s the recipient)?'
  else if (missing.includes('constraint')) question += 'when do you need it by, and any size/budget limits?'
  else if (missing.includes('detail')) question += 'can you give me one more sentence on what you mean?'
  else question += 'what would success look like for this?'

  return { proceed: false, score, missing, question, reasoning: reasoning.join('+') || 'no-signal' }
}

export async function recordClarify(input: {
  workspaceId: string; conversationId?: string; userMessage: string; question: string
}): Promise<{ id: string }> {
  const id = uuidv7()
  const now = Date.now()
  await db.insert(clarifyEvents).values({
    id, workspaceId: input.workspaceId,
    conversationId: input.conversationId ?? null,
    userMessage: input.userMessage.slice(0, 4000),
    question: input.question, resolved: false,
    createdAt: now,
  } as never).catch(() => null)
  return { id }
}

export async function resolveClarify(id: string, answer: string): Promise<void> {
  const now = Date.now()
  await db.update(clarifyEvents)
    .set({ resolved: true, answer: answer.slice(0, 4000), resolvedAt: now } as never)
    .where((await import('drizzle-orm')).eq(clarifyEvents.id, id))
    .catch(() => null)
}
