/**
 * R146.336 — Clarify Orchestrator (closes conversation.clarification 5→8)
 *
 * Scores ambiguity in operator requests; surfaces clarify-or-act decisions
 * with concrete option chips so the operator can answer in one tap instead
 * of writing a sentence. Learns from past answers to reduce future asks.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { v7 as uuidv7 } from 'uuid'

export interface AmbiguityScore {
  score:        number       // 0-1 (0 = unambiguous, 1 = totally ambiguous)
  reasons:      string[]
  needsClarify: boolean      // score > 0.4
}

export interface ClarifyChip {
  id:    string
  label: string
  inferredAnswer: string
}

export interface ClarifyDecision {
  id:          string
  question:    string
  rationale:   string
  chips:       ClarifyChip[]
  fallback:    string         // 'Other...' freetext path
  confidence:  number          // confidence of best-guess inference 0-1
  createdAt:   number
}

const AMBIGUOUS_PATTERNS: Array<{ pattern: RegExp; reason: string; weight: number }> = [
  { pattern: /\bsomething\b/i,        reason: 'unspecified noun ("something")',      weight: 0.25 },
  { pattern: /\bit\b/i,               reason: 'unbound pronoun ("it")',              weight: 0.10 },
  { pattern: /\bthat\b\s*(thing|one)/i, reason: 'demonstrative ("that thing/one")',  weight: 0.20 },
  { pattern: /\b(can|could|would) you\b.*\?$/i, reason: 'open-ended question',       weight: 0.10 },
  { pattern: /\?\s*$/,                reason: 'ends with question mark',             weight: 0.05 },
  { pattern: /\bbetter\b|\bbest\b/i,  reason: 'requires preference resolution',      weight: 0.15 },
  { pattern: /\bmake (it )?(more|less)\b/i, reason: 'comparative without baseline',   weight: 0.15 },
  { pattern: /^(do|run|fix|update|change)\b\s+\w+\s*$/i, reason: 'very short verb-noun command', weight: 0.20 },
]

export function scoreAmbiguity(text: string): AmbiguityScore {
  const reasons: string[] = []
  let score = 0
  for (const p of AMBIGUOUS_PATTERNS) {
    if (p.pattern.test(text)) {
      score += p.weight
      reasons.push(p.reason)
    }
  }
  // Length signal: very short messages are often ambiguous
  if (text.trim().split(/\s+/).length <= 3) {
    score += 0.20
    reasons.push('very short message (<= 3 words)')
  }
  return {
    score:        Math.min(1, score),
    reasons,
    needsClarify: score > 0.4,
  }
}

/**
 * For a known-ambiguous request, build a chip-style clarify decision.
 * Pre-canned for common revenue-ops requests; falls back to operator freetext.
 */
export function buildClarifyDecision(request: string): ClarifyDecision {
  const lower = request.toLowerCase()
  const id = uuidv7()
  const createdAt = Date.now()

  if (/post|publish|list/.test(lower)) {
    return {
      id, createdAt,
      question:  'Which channel should I publish to?',
      rationale: 'Request mentioned post/publish/list but no channel.',
      chips: [
        { id: 'tiktok_shop', label: 'TikTok Shop',  inferredAnswer: 'tiktok_shop' },
        { id: 'printful',    label: 'Printful only', inferredAnswer: 'printful' },
        { id: 'inprnt',      label: 'INPRNT',       inferredAnswer: 'inprnt' },
        { id: 'all_connected', label: 'All connected', inferredAnswer: 'all_connected' },
      ],
      fallback:   'Other channel (you type)',
      confidence: 0.6,
    }
  }
  if (/design|art|image/.test(lower)) {
    return {
      id, createdAt,
      question:  'Where should designs come from?',
      rationale: 'Request mentioned design/art/image without a source.',
      chips: [
        { id: 'public_domain', label: 'Public domain (Met/LoC)', inferredAnswer: 'public_domain' },
        { id: 'ai_gen', label: 'AI-generated (when providers healthy)', inferredAnswer: 'ai_gen' },
        { id: 'upload', label: 'Operator-uploaded', inferredAnswer: 'upload' },
      ],
      fallback:   'Other source',
      confidence: 0.65,
    }
  }
  if (/price|cost|charge/.test(lower)) {
    return {
      id, createdAt,
      question:  'Which pricing tier?',
      rationale: 'Request mentioned price/cost without a tier.',
      chips: [
        { id: 'value', label: 'Value (lowest margin, mass appeal)', inferredAnswer: 'value' },
        { id: 'mid',   label: 'Mid (balanced)',                       inferredAnswer: 'mid' },
        { id: 'premium', label: 'Premium (highest margin)',          inferredAnswer: 'premium' },
      ],
      fallback:   'Other tier',
      confidence: 0.55,
    }
  }
  // Generic fallback
  return {
    id, createdAt,
    question:  `I need more detail to act on "${request.slice(0, 80)}".`,
    rationale: 'Request scored above ambiguity threshold but no specific clarify chip matched.',
    chips: [
      { id: 'act_with_defaults', label: 'Act with current defaults', inferredAnswer: 'act_with_defaults' },
      { id: 'list_options',      label: 'List options for me first', inferredAnswer: 'list_options' },
    ],
    fallback:   'Type the detail',
    confidence: 0.3,
  }
}

/** Persist the answer so future similar requests can skip clarify entirely. */
export async function recordAnswer(workspaceId: string, decisionId: string, chipId: string): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO workspace_memory (workspace_id, key, value, scope, importance, updated_at)
      VALUES (
        ${workspaceId},
        ${`clarify_answer.${decisionId}`},
        ${JSON.stringify({ decisionId, chipId, answeredAt: Date.now() })},
        'clarify',
        65,
        ${Date.now()}
      )
      ON CONFLICT (workspace_id, key) DO NOTHING
    `)
  } catch { /* ignore */ }
}
