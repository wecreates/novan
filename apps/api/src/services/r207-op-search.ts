/**
 * R146.207 — Deferred op discovery. brain-task.ts has ~900 ops; loading
 * every description into the system prompt costs 50K+ tokens/turn. This
 * lets the model call op.search{query} to find ops on demand. Mirrors
 * the ToolSearch pattern in Anthropic's harness.
 */
import { OPERATIONS } from './brain-task.js'

export interface OpSearchHit {
  op:           string
  description:  string
  risk:         string
  score:        number
}

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2)
}

export function opSearch(query: string, limit = 10): OpSearchHit[] {
  if (!query || query.trim().length === 0) {
    return Object.entries(OPERATIONS).slice(0, limit).map(([op, spec]) => ({
      op, description: spec.description, risk: spec.risk, score: 1,
    }))
  }
  // Tier 1: exact match by name fragment
  const exact = query.toLowerCase()
  const directMatches = Object.keys(OPERATIONS).filter(name => name.toLowerCase().includes(exact))
  if (directMatches.length >= limit) {
    return directMatches.slice(0, limit).map(op => ({
      op, description: OPERATIONS[op]!.description, risk: OPERATIONS[op]!.risk, score: 100,
    }))
  }
  // Tier 2: token overlap on name + description
  const qTokens = new Set(tokens(query))
  const scored: OpSearchHit[] = []
  for (const [op, spec] of Object.entries(OPERATIONS)) {
    const haystack = new Set([...tokens(op), ...tokens(spec.description)])
    let score = 0
    for (const t of qTokens) if (haystack.has(t)) score++
    if (directMatches.includes(op)) score += 50
    if (score > 0) scored.push({ op, description: spec.description, risk: spec.risk, score })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit)
}

/** Used by chat-providers to remind the model that op.search exists. */
export function opSearchHint(): string {
  const n = Object.keys(OPERATIONS).length
  return `Novan has ${n} brain ops. To find one without loading the full registry, call op.search{query:"..."} first — returns top matches with description+risk.`
}
