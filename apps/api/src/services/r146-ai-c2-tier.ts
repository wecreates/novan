/**
 * R146.146 — C-tier round 2 (features 36-40):
 * Chain-of-density summarization, constitutional AI loop, tree-of-thoughts
 * reasoning, active learning boundary cases, symbolic+LLM hybrid solver.
 */

// ─── #36 — Chain-of-density summarization ────────────────────────────

/**
 * Iteratively dense summary: each pass shortens AND adds missing entities.
 * 5 rounds default. Result is more dense + informative than single-shot.
 */
export async function chainOfDensity(workspaceId: string, opts: {
  source: string
  rounds?: number
}): Promise<{ summaries: string[]; final: string }> {
  const rounds = Math.max(1, Math.min(opts.rounds ?? 5, 8))
  const { streamChat } = await import('./chat-providers.js')
  const summaries: string[] = []
  let current = ''
  for (let i = 0; i < rounds; i++) {
    const sys = i === 0
      ? 'Summarize the source in 80 words. Include only the most important facts/entities.'
      : `Make this denser: same length (80 words) but include MORE missing important entities/facts. Don't repeat what's already covered. Round ${i + 1}/${rounds}.`
    const prompt = i === 0 ? opts.source.slice(0, 16000) : `Source: ${opts.source.slice(0, 8000)}\n\nCurrent summary: ${current}`
    const gen = streamChat(workspaceId, [
      { role: 'system', content: sys },
      { role: 'user',   content: prompt },
    ], { taskType: 'other' } as Parameters<typeof streamChat>[2])
    let acc = ''
    for await (const ch of gen) acc += ch.delta
    current = acc.trim().slice(0, 1500)
    summaries.push(current)
  }
  return { summaries, final: current }
}

// ─── #37 — Constitutional AI loop ────────────────────────────────────

/**
 * LLM drafts → self-critiques against constitution → revises → returns.
 * Two-pass minimum.
 */
const DEFAULT_CONSTITUTION = [
  'Be truthful — never fabricate facts, sources, statistics, or quotes.',
  'Be specific — concrete > vague.',
  'Be honest about uncertainty — say "I don\'t know" when uncertain.',
  'Avoid manipulation — never use dark patterns or psychological tricks.',
  'Match the operator\'s actual interests, not engagement-maxing.',
  'Stay within stated scope — don\'t expand the task.',
]

export async function constitutionalDraft(workspaceId: string, opts: {
  task: string
  constitution?: string[]
  maxRevisions?: number
}): Promise<{ draft: string; critique: string; revised: string }> {
  const constitution = opts.constitution ?? DEFAULT_CONSTITUTION
  const maxRevs = Math.max(1, Math.min(opts.maxRevisions ?? 2, 4))
  const { streamChat } = await import('./chat-providers.js')

  // Pass 1: draft
  let draft = ''
  {
    const gen = streamChat(workspaceId, [
      { role: 'user', content: opts.task },
    ], { taskType: 'other' } as Parameters<typeof streamChat>[2])
    for await (const ch of gen) draft += ch.delta
  }

  // Pass 2: critique
  let critique = ''
  {
    const gen = streamChat(workspaceId, [
      { role: 'system', content: `You critique drafts against this constitution:\n${constitution.map((c, i) => `${i+1}. ${c}`).join('\n')}\n\nList violations + specific lines. If none, output "NONE".` },
      { role: 'user',   content: `Task: ${opts.task}\n\nDraft:\n${draft.slice(0, 8000)}` },
    ], { taskType: 'other', suppressQualityBar: true } as Parameters<typeof streamChat>[2])
    for await (const ch of gen) critique += ch.delta
  }

  let revised = draft
  // Pass 3+: revise
  if (!/^\s*NONE/i.test(critique)) {
    for (let r = 0; r < maxRevs; r++) {
      let next = ''
      const gen = streamChat(workspaceId, [
        { role: 'system', content: `Revise the draft to address the critique. Stay faithful to the original task. Constitution:\n${constitution.map((c, i) => `${i+1}. ${c}`).join('\n')}` },
        { role: 'user',   content: `Task: ${opts.task}\n\nDraft:\n${revised.slice(0, 8000)}\n\nCritique:\n${critique.slice(0, 4000)}` },
      ], { taskType: 'other', suppressQualityBar: true } as Parameters<typeof streamChat>[2])
      for await (const ch of gen) next += ch.delta
      revised = next.trim()
    }
  }
  return { draft, critique, revised }
}

// ─── #38 — Tree-of-thoughts reasoning ────────────────────────────────

/**
 * Branch N candidate reasoning paths, score each, pick best leaf.
 *
 * Skeleton: single-step branching (not full tree). For each branch, runs
 * the LLM with a different "approach" prompt; then a judge picks the
 * best. Real tree-of-thoughts with multi-depth backtracking is heavier.
 */
export async function treeOfThoughts(workspaceId: string, opts: {
  problem: string
  branches?: number
}): Promise<{ branches: Array<{ approach: string; thought: string; score: number }>; winner: string }> {
  const branchCount = Math.max(2, Math.min(opts.branches ?? 3, 5))
  const APPROACHES = ['First-principles decomposition', 'Analogical: similar past problem', 'Reverse: work backward from goal', 'Constraint-relaxation: which constraint to drop', 'Adversarial: how could this fail']
  const approaches = APPROACHES.slice(0, branchCount)
  const { streamChat } = await import('./chat-providers.js')
  const results: Array<{ approach: string; thought: string; score: number }> = []
  for (const approach of approaches) {
    let thought = ''
    try {
      const gen = streamChat(workspaceId, [
        { role: 'system', content: `Use this approach: "${approach}". Output a 100-word reasoning trace toward an answer.` },
        { role: 'user',   content: opts.problem },
      ], { taskType: 'other' } as Parameters<typeof streamChat>[2])
      for await (const ch of gen) thought += ch.delta
    } catch { thought = '(failed)' }
    // Self-score
    let score = 0.5
    try {
      const gen = streamChat(workspaceId, [
        { role: 'system', content: 'Score this reasoning trace 0..1 on (clarity + correctness + completeness). Return STRICT JSON: {"score":0..1}.' },
        { role: 'user',   content: `Problem: ${opts.problem}\nReasoning:\n${thought.slice(0, 3000)}` },
      ], { taskType: 'other', suppressQualityBar: true } as Parameters<typeof streamChat>[2])
      let acc = ''
      for await (const ch of gen) acc += ch.delta
      const m = acc.match(/\{[\s\S]*\}/)
      if (m) {
        const parsed = JSON.parse(m[0]) as { score?: number }
        if (typeof parsed.score === 'number') score = Math.max(0, Math.min(parsed.score, 1))
      }
    } catch { /* leave default */ }
    results.push({ approach, thought: thought.trim().slice(0, 2000), score })
  }
  results.sort((a, b) => b.score - a.score)
  const winner = results[0]?.thought ?? ''
  return { branches: results, winner }
}

// ─── #39 — Active learning boundary surface ──────────────────────────

/**
 * Find eval cases whose pass rate is closest to 50% — those are the
 * boundary cases that, if labeled, would best improve the prompt.
 *
 * Returns top-N ambiguous cases.
 */
export async function activeLearningSurface(workspaceId: string, opts: {
  promptKey: string
  topN?: number
}): Promise<{ boundary: Array<{ caseId: string; passRate: number; runs: number }> }> {
  const { db } = await import('../db/client.js')
  const { promptEvalRuns } = await import('../db/schema.js')
  const { and, eq, desc } = await import('drizzle-orm')
  const runs = await db.select().from(promptEvalRuns)
    .where(and(eq(promptEvalRuns.workspaceId, workspaceId), eq(promptEvalRuns.promptKey, opts.promptKey)))
    .orderBy(desc(promptEvalRuns.ranAt)).limit(20)
  // Compute per-case pass rates across runs
  const stats = new Map<string, { pass: number; total: number }>()
  for (const run of runs) {
    for (const d of run.details ?? []) {
      const cur = stats.get(d.caseId) ?? { pass: 0, total: 0 }
      cur.total++
      if (d.passed) cur.pass++
      stats.set(d.caseId, cur)
    }
  }
  // Boundary = closest to 50%
  const ranked = [...stats.entries()]
    .map(([caseId, s]) => ({ caseId, passRate: s.pass / Math.max(1, s.total), runs: s.total }))
    .filter(c => c.runs >= 2)
    .sort((a, b) => Math.abs(a.passRate - 0.5) - Math.abs(b.passRate - 0.5))
    .slice(0, Math.max(1, Math.min(opts.topN ?? 10, 50)))
  return { boundary: ranked }
}

// R146.325 (#21) — recursive-descent arithmetic evaluator. Strictly: + - * /
// () decimals. Returns null on any parse failure or division-by-zero.
function evalArith(s: string): number | null {
  let i = 0
  const src = s
  const peek = () => src[i]
  const eat = (c: string) => { while (peek() === ' ') i++; if (peek() === c) { i++; return true } return false }
  function parseExpr(): number | null {
    let v = parseTerm(); if (v === null) return null
    while (true) {
      if (eat('+')) { const r = parseTerm(); if (r === null) return null; v += r }
      else if (eat('-')) { const r = parseTerm(); if (r === null) return null; v -= r }
      else break
    }
    return v
  }
  function parseTerm(): number | null {
    let v = parseFactor(); if (v === null) return null
    while (true) {
      if (eat('*')) { const r = parseFactor(); if (r === null) return null; v *= r }
      else if (eat('/')) { const r = parseFactor(); if (r === null || r === 0) return null; v /= r }
      else break
    }
    return v
  }
  function parseFactor(): number | null {
    while (peek() === ' ') i++
    if (eat('-')) { const v = parseFactor(); return v === null ? null : -v }
    if (eat('+')) return parseFactor()
    if (eat('(')) { const v = parseExpr(); if (!eat(')')) return null; return v }
    let n = ''
    while (/[0-9.]/.test(peek() ?? '')) { n += peek(); i++ }
    if (n === '' || n === '.') return null
    const v = Number(n)
    return Number.isFinite(v) ? v : null
  }
  const result = parseExpr()
  while (peek() === ' ') i++
  return i === src.length ? result : null
}

// ─── #40 — Symbolic + LLM hybrid solver ──────────────────────────────

/**
 * For math/logic queries, try a symbolic-style approach first (regex +
 * eval for arithmetic), fall back to LLM. True symbolic engine (sympy/z3)
 * would require a sidecar; this is the pure-TS subset.
 */
export async function hybridSolve(workspaceId: string, opts: { question: string }): Promise<{ answer: string; engine: 'symbolic' | 'llm'; confidence: number }> {
  const q = opts.question.trim()

  // R146.325 (#21) — pure-TS arithmetic evaluator. Previously used
  // `new Function(...)` with a regex whitelist; safe in practice but
  // still a code-execution primitive that lints flag and that future
  // extenders could relax. Replaced with a recursive-descent parser
  // that only knows about + - * / () and decimals.
  const arithRe = /^[\d\s+\-*/().,]+$/
  if (arithRe.test(q.replace(/^\s*calculate\s+/i, '').replace(/\s*$/, ''))) {
    const expr = q.replace(/^\s*calculate\s+/i, '').replace(/,/g, '')
    const result = evalArith(expr)
    if (result !== null && Number.isFinite(result)) {
      return { answer: String(result), engine: 'symbolic', confidence: 1.0 }
    }
  }

  // Date arithmetic: "days between A and B"
  const daysBetween = q.match(/days\s+between\s+(\d{4}-\d{2}-\d{2})\s+and\s+(\d{4}-\d{2}-\d{2})/i)
  if (daysBetween && daysBetween[1] && daysBetween[2]) {
    const a = new Date(daysBetween[1]).getTime()
    const b = new Date(daysBetween[2]).getTime()
    if (!isNaN(a) && !isNaN(b)) {
      const days = Math.round(Math.abs(b - a) / (24 * 60 * 60_000))
      return { answer: `${days} days`, engine: 'symbolic', confidence: 1.0 }
    }
  }

  // Fall back to LLM
  const { streamChat } = await import('./chat-providers.js')
  let answer = ''
  const gen = streamChat(workspaceId, [
    { role: 'system', content: 'Answer the question concisely. Show work for math/logic problems.' },
    { role: 'user',   content: q },
  ], { taskType: 'other' } as Parameters<typeof streamChat>[2])
  for await (const ch of gen) answer += ch.delta
  return { answer: answer.trim(), engine: 'llm', confidence: 0.7 }
}
