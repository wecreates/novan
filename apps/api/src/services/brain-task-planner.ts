/**
 * brain-task-planner.ts — Convert natural-language task → operation plan.
 *
 * Uses the configured chat provider (Groq by default — fast + cheap).
 * Returns a JSON plan that brain-task.executePlan can run directly.
 *
 * The planner has STRICT output format requirements; if the model
 * returns invalid JSON or unknown ops, we fall back to a heuristic
 * planner so the brain still does something useful.
 */
import { listAvailableOperations, type TaskOperation } from './brain-task.js'

const PLANNER_SYSTEM_PROMPT = `You are the planner for an autonomous operations platform.

The operator gives you a task in plain English. You output a JSON plan:
a short ordered list of operations from the allowed set below. Each
operation has a name and a params object.

Output format (STRICT):
{"plan": [{"op": "<name>", "params": {...}}, ...], "reason": "<one line>"}

Do not output prose. Do not output markdown. Only the JSON object above.

Pick the SMALLEST plan that accomplishes the task. Prefer reading + diagnostic
operations before mutations. If you can't accomplish the task with the
allowed operations, return {"plan": [], "reason": "<why>"}.

Allowed operations:
__OPS__`

interface ParsedPlan { plan: TaskOperation[]; reason: string }

export async function planTaskFromText(task: string): Promise<ParsedPlan> {
  const opsList = listAvailableOperations()
    .map(o => `- ${o.op} (risk=${o.risk}): ${o.description}`)
    .join('\n')
  const systemPrompt = PLANNER_SYSTEM_PROMPT.replace('__OPS__', opsList)

  // Try LLM planner first — Groq is fastest + cheapest. Fall back to
  // heuristic if no provider is configured.
  const llmPlan = await llmPlan_(systemPrompt, task)
  if (llmPlan) return llmPlan
  return heuristicPlan(task)
}

async function llmPlan_(systemPrompt: string, task: string): Promise<ParsedPlan | null> {
  // Prefer Groq for speed. Fall through to OpenAI, Anthropic, Gemini.
  const candidates: Array<{ env: string; url: string; family: 'openai' | 'anthropic' | 'gemini'; model: string }> = [
    { env: 'GROQ_API_KEY',      url: 'https://api.groq.com/openai/v1/chat/completions',           family: 'openai',    model: 'llama-3.3-70b-versatile' },
    { env: 'OPENAI_API_KEY',    url: 'https://api.openai.com/v1/chat/completions',                 family: 'openai',    model: 'gpt-4o-mini' },
    { env: 'ANTHROPIC_API_KEY', url: 'https://api.anthropic.com/v1/messages',                      family: 'anthropic', model: 'claude-haiku-4-5' },
    { env: 'GEMINI_API_KEY',    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent', family: 'gemini', model: 'gemini-2.0-flash' },
  ]
  for (const c of candidates) {
    const key = process.env[c.env]
    if (!key) continue
    try {
      const text = await callProvider(c, key, systemPrompt, task)
      const parsed = parsePlanJson(text)
      if (parsed) return parsed
    } catch { /* try next provider */ }
  }
  return null
}

async function callProvider(
  c: { env: string; url: string; family: 'openai' | 'anthropic' | 'gemini'; model: string },
  key: string,
  systemPrompt: string,
  task: string,
): Promise<string> {
  if (c.family === 'openai') {
    const res = await fetch(c.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: c.model, temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: task },
        ],
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`${c.env} ${res.status}`)
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
    return data.choices?.[0]?.message?.content ?? ''
  }
  if (c.family === 'anthropic') {
    const res = await fetch(c.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: c.model, max_tokens: 1500, temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: task }],
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`${c.env} ${res.status}`)
    const data = await res.json() as { content?: Array<{ text?: string }> }
    return data.content?.[0]?.text ?? ''
  }
  // gemini
  const url = `${c.url}?key=${key}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: task }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 1500, responseMimeType: 'application/json' },
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`${c.env} ${res.status}`)
  const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
}

function parsePlanJson(text: string): ParsedPlan | null {
  // Try direct parse first
  const tryParse = (s: string): unknown => { try { return JSON.parse(s) } catch { return null } }
  let obj = tryParse(text) as { plan?: TaskOperation[]; reason?: string } | null
  if (!obj) {
    // Strip code fences / extract first JSON object
    const match = text.match(/\{[\s\S]*\}/)
    if (match) obj = tryParse(match[0]) as { plan?: TaskOperation[]; reason?: string } | null
  }
  if (!obj || !Array.isArray(obj.plan)) return null
  const allowed = new Set(listAvailableOperations().map(o => o.op))
  // R146.73 — tag every LLM-planner-emitted step as provenance='planner'.
  // The planner consumed operator text, but its output is not operator-
  // typed; the executor's provenance gate uses this to require approval
  // for ops outside the page-derived allowlist, closing the path where
  // an attacker who got text into the planner's input could provoke
  // high-blast-radius ops by phrasing the task plausibly.
  const plan = obj.plan.filter(s => s && typeof s.op === 'string' && allowed.has(s.op)).map(s => ({
    op: s.op,
    params: (s.params ?? {}) as Record<string, unknown>,
    provenance: 'planner' as const,
  }))
  return { plan, reason: obj.reason ?? '' }
}

// ─── Heuristic fallback ────────────────────────────────────────────────
// Pattern-match on common phrasings so the brain still acts when no
// provider key is configured.

interface HeuristicRule { match: RegExp; build: (m: RegExpMatchArray) => TaskOperation[]; reason: string }

const HEURISTICS: HeuristicRule[] = [
  { match: /\bfix\s+(?:all\s+)?(?:the\s+)?(?:bugs?|errors?|issues?)\b/i,
    reason: 'Run issue ingest + full auto-loop to detect and patch problems',
    build: () => [{ op: 'issue.ingest', params: {} }, { op: 'issue.auto_loop', params: {} }] },
  { match: /\b(?:health\s*check|smoke\s*test|are.*(routes|endpoints)\s*(ok|working))\b/i,
    reason: 'Run platform smoke test',
    build: () => [{ op: 'platform.smoke', params: {} }] },
  { match: /\b(?:validate|test|check)\s+(?:all\s+)?providers?\b/i,
    reason: 'Probe all configured AI providers',
    build: () => [{ op: 'providers.validate', params: {} }] },
  { match: /\b(?:find|look for|search for)\s+(?:capability\s+)?gaps?\b|\bmind\s*cycle\b/i,
    reason: 'Run capability-gap detection',
    build: () => [{ op: 'mind.cycle', params: {} }] },
  { match: /\b(?:show|list)\s+(?:recent\s+)?(?:errors?|failures?|incidents?)\b/i,
    reason: 'Read recent incidents from db',
    build: () => [{ op: 'db.query', params: { table: 'incidents', minutes: 60, limit: 50 } }] },
  { match: /\b(?:show|list)\s+(?:recent\s+)?(?:proposals?|patches?)\b/i,
    reason: 'Read recent code proposals',
    build: () => [{ op: 'db.query', params: { table: 'code_proposals', minutes: 1440, limit: 50 } }] },
  { match: /\b(?:show|list)\s+(?:recent\s+)?(?:issues?)\b/i,
    reason: 'Read recent issues',
    build: () => [{ op: 'db.query', params: { table: 'issues', minutes: 1440, limit: 50 } }] },
  { match: /\bsafety\b.*\b(flags?|gates?|mode)\b/i,
    reason: 'Read current safety flags',
    build: () => [{ op: 'safety.flags', params: {} }] },
  { match: /\bsearch\s+(?:the\s+)?code(?:base)?\s+for\s+(.+)/i,
    reason: 'Grep the codebase',
    build: (m) => [{ op: 'code.search', params: { pattern: m[1]!.trim().replace(/[?.!]+$/, '') } }] },
  { match: /\bfetch\s+(https?:\/\/\S+)/i,
    reason: 'Render-fetch URL with playwright',
    build: (m) => [{ op: 'web.fetch', params: { url: m[1] } }] },
]

function heuristicPlan(task: string): ParsedPlan {
  for (const r of HEURISTICS) {
    const m = task.match(r.match)
    // R146.73 — heuristic-derived plans share the planner-derived
    // trust posture; the operator's text fed them, but the op list
    // is produced by code, not operator-typed.
    if (m) return { plan: r.build(m).map(s => ({ ...s, provenance: 'planner' as const })), reason: r.reason }
  }
  return { plan: [], reason: `No matching heuristic for: "${task.slice(0, 100)}". Configure GROQ_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY for LLM planning.` }
}
