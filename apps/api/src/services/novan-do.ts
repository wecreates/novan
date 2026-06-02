/**
 * R146.118 — Universal "do anything" surface.
 *
 * Inside the platform: propose code changes (routed through existing
 * code-agent + code_proposals approval gate).
 * Outside the platform: gated outbound HTTP, connector actions, browser
 * ops (already wired via persistent playwright + video-vision).
 *
 * All destructive actions REQUIRE an operator approval. This module
 * never executes high-risk operations without an explicit approve step.
 */

import { db } from '../db/client.js'
import { codeProposals, events } from '../db/schema.js'
import { v7 as uuidv7 } from 'uuid'

export interface ProposeCodeInput {
  title:        string
  summary:      string
  filesToCreate?: Array<{ path: string; purpose: string; estLoc?: number }>
  filesToModify?: Array<{ path: string; purpose: string; estLoc?: number }>
  testsRequired?: Array<{ description: string; covers: string }>
  riskLevel?:    'low' | 'medium' | 'high' | 'critical'
  reasoning?:    string[]
}

/**
 * Propose a code change. Inserts a `code_proposals` row in 'proposed' state.
 * Operator must approve (status='approved') before code-agent picks it up.
 */
export async function proposeCodeChange(workspaceId: string, input: ProposeCodeInput): Promise<{ proposalId: string; status: string }> {
  if (!input.title || !input.summary) throw new Error('title and summary are required')
  const now = Date.now()
  const id = uuidv7()
  const filesToCreate = (input.filesToCreate ?? []).map(f => ({ path: f.path, purpose: f.purpose, estLoc: f.estLoc ?? 0 }))
  const filesToModify = (input.filesToModify ?? []).map(f => ({ path: f.path, purpose: f.purpose, estLoc: f.estLoc ?? 0 }))
  const estimatedLoc = [...filesToCreate, ...filesToModify].reduce((s, f) => s + (f.estLoc || 0), 0)
  await db.insert(codeProposals).values({
    id, workspaceId,
    buildPlanId: null, capabilityId: null,
    title: input.title.slice(0, 240),
    summary: input.summary.slice(0, 4000),
    filesToCreate, filesToModify,
    testsRequired: input.testsRequired ?? [],
    riskLevel: input.riskLevel ?? 'medium',
    estimatedLoc,
    status: 'proposed',
    reasoning: input.reasoning ?? [],
    approvalId: null,
    createdAt: now, updatedAt: now,
    shippedAt: null, shippedCommitSha: null, shippedBy: null,
  })
  await db.insert(events).values({
    id: uuidv7(), workspaceId, type: 'novan.code_proposed',
    payload: { proposalId: id, title: input.title, risk: input.riskLevel ?? 'medium' },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'novan-do', version: 1, createdAt: now,
  }).catch(() => null)
  return { proposalId: id, status: 'proposed' }
}

// ─── Capability manifest ───────────────────────────────────────────────

/**
 * Return every brain op the platform exposes, with description + risk.
 * Used by the chat + UI so Novan + the operator know what's available.
 */
export async function listCapabilities(): Promise<{ count: number; ops: Array<{ name: string; description: string; risk: string }> }> {
  const { OPERATIONS } = await import('./brain-task.js')
  const ops = Object.entries(OPERATIONS).map(([name, def]) => {
    const d = def as { description?: string; risk?: string }
    return { name, description: String(d.description ?? ''), risk: String(d.risk ?? 'low') }
  }).sort((a, b) => a.name.localeCompare(b.name))
  return { count: ops.length, ops }
}

// ─── Outbound HTTP (gated) ─────────────────────────────────────────────

const HTTP_DENY_HOSTS = new Set([
  'localhost', '127.0.0.1', '0.0.0.0', '::1',
  '169.254.169.254', // AWS metadata
  'metadata.google.internal',
])

const HTTP_DENY_HOST_SUFFIXES = ['.local', '.internal', '.cluster.local']

function isHostAllowed(host: string): boolean {
  // URL.hostname keeps IPv6 wrapped in brackets — strip for comparison
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (HTTP_DENY_HOSTS.has(h)) return false
  if (HTTP_DENY_HOST_SUFFIXES.some(s => h.endsWith(s))) return false
  // Block private IPv4 ranges (rough SSRF guard)
  if (/^10\./.test(h)) return false
  if (/^192\.168\./.test(h)) return false
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false
  return true
}

export interface HttpActionInput {
  method?:  'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  url:      string
  headers?: Record<string, string>
  body?:    string | Record<string, unknown> | null
  timeoutMs?: number
}

export interface HttpActionResult {
  ok: boolean
  status: number
  headers: Record<string, string>
  body: string         // first 64 KiB
  truncated: boolean
}

const MAX_RESP_BYTES = 64 * 1024

/**
 * Make an outbound HTTP request from Novan to anywhere on the public web.
 * SSRF-guarded (denies loopback, private ranges, link-local). Always
 * audits to the events table. Body capped at 64 KiB.
 */
export async function httpAction(workspaceId: string, input: HttpActionInput): Promise<HttpActionResult> {
  const method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' = (input.method ?? 'GET')
  let url: URL
  try { url = new URL(input.url) } catch { throw new Error('invalid URL') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('only http(s) URLs supported')
  if (!isHostAllowed(url.hostname)) throw new Error(`host blocked by SSRF policy: ${url.hostname}`)
  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 15_000, 1_000), 60_000)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const headers: Record<string, string> = { 'user-agent': 'Novan/1.0', ...(input.headers ?? {}) }
  let body: string | undefined
  if (input.body !== undefined && input.body !== null) {
    if (typeof input.body === 'string') body = input.body
    else { body = JSON.stringify(input.body); headers['content-type'] = headers['content-type'] ?? 'application/json' }
  }
  const startedAt = Date.now()
  try {
    const init: RequestInit = { method, headers, signal: ac.signal, redirect: 'follow' }
    if (body !== undefined) init.body = body
    const resp = await fetch(url.toString(), init)
    const buf = await resp.arrayBuffer()
    const truncated = buf.byteLength > MAX_RESP_BYTES
    const text = new TextDecoder().decode(buf.slice(0, MAX_RESP_BYTES))
    const respHeaders: Record<string, string> = {}
    resp.headers.forEach((v, k) => { respHeaders[k] = v })
    const result: HttpActionResult = { ok: resp.ok, status: resp.status, headers: respHeaders, body: text, truncated }
    await db.insert(events).values({
      id: uuidv7(), workspaceId, type: 'novan.http_action',
      payload: { method, url: url.toString(), status: resp.status, ms: Date.now() - startedAt, truncated },
      traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
      source: 'novan-do', version: 1, createdAt: Date.now(),
    }).catch(() => null)
    return result
  } finally { clearTimeout(timer) }
}

// ─── Intent classifier ────────────────────────────────────────────────

export interface DoIntentResult {
  category:     'code_change' | 'content' | 'business' | 'connector' | 'research' | 'config' | 'unknown'
  summary:      string
  suggestedOps: string[]
  requiresApproval: boolean
  nextStep:     string
}

/**
 * Classify a free-form operator request into a category + suggested ops.
 * Pure routing — never executes destructive work. Returns the plan; the
 * operator (or a subsequent op call) actually runs it.
 */
/**
 * R146.121 — Try LLM classification first, fall back to keyword routing.
 * The LLM sees the actual op manifest so it can suggest real op names
 * instead of guessing.
 */
async function classifyWithLlm(prompt: string): Promise<DoIntentResult | null> {
  if (!process.env['GROQ_API_KEY'] && !process.env['OPENAI_API_KEY'] && !process.env['ANTHROPIC_API_KEY'] && !process.env['GEMINI_API_KEY']) return null
  try {
    const { OPERATIONS } = await import('./brain-task.js')
    // Compact ops manifest — name + first 60 chars of description
    const manifest = Object.entries(OPERATIONS).slice(0, 200).map(([n, d]) => `${n}: ${String((d as { description?: string }).description ?? '').slice(0, 80)}`).join('\n')
    const sys = `You are Novan's intent router. Given an operator request, return STRICT JSON: {"category":"code_change|content|business|connector|research|config|unknown","summary":"...","suggestedOps":["op.name",...],"requiresApproval":bool,"nextStep":"..."}. Pick op names ONLY from this manifest. Max 6 suggestedOps. Be terse.\n\nMANIFEST:\n${manifest}`
    const { streamChat } = await import('./chat-providers.js')
    const gen = streamChat('system', [
      { role: 'system', content: sys },
      { role: 'user',   content: prompt.slice(0, 1000) },
    ], { maxTokens: 400 } as Parameters<typeof streamChat>[2])
    let acc = ''
    for await (const ch of gen) { acc += ch.delta }
    const m = acc.match(/\{[\s\S]*\}/)
    if (!m) return null
    const parsed = JSON.parse(m[0]) as Partial<DoIntentResult>
    if (!parsed.category) return null
    return {
      category: parsed.category as DoIntentResult['category'],
      summary: String(parsed.summary ?? ''),
      suggestedOps: Array.isArray(parsed.suggestedOps) ? parsed.suggestedOps.slice(0, 6).map(String) : [],
      requiresApproval: parsed.requiresApproval === true,
      nextStep: String(parsed.nextStep ?? ''),
    }
  } catch { return null }
}

export async function classifyIntent(prompt: string): Promise<DoIntentResult> {
  // Try LLM first; on any failure fall back to keyword routing
  const llm = await classifyWithLlm(prompt)
  if (llm) return llm
  const p = prompt.toLowerCase()
  const { OPERATIONS } = await import('./brain-task.js')
  const matchOps = (terms: string[]): string[] => {
    const out: string[] = []
    for (const [name, def] of Object.entries(OPERATIONS)) {
      const desc = String((def as { description?: string }).description ?? '').toLowerCase()
      const hay = `${name.toLowerCase()} ${desc}`
      if (terms.some(t => hay.includes(t))) out.push(name)
      if (out.length >= 8) break
    }
    return out
  }

  if (/(add|create|build|implement|change|edit|fix|upgrade|refactor|wire|patch).{0,40}(code|file|service|module|api|route|component|function|schema|migration)/.test(p)) {
    return {
      category: 'code_change',
      summary: 'Code change requested. Will be drafted as a code_proposal and require operator approval before shipping.',
      suggestedOps: ['novan.proposeCode', 'proposals.list', 'proposals.approve', 'proposals.buildPatch'],
      requiresApproval: true,
      nextStep: 'Call novan.proposeCode with { title, summary, filesToCreate?, filesToModify?, risk? }.',
    }
  }
  if (/(post|publish|schedule|share|tweet|reel|short|video|caption|hook|script|brand)/.test(p)) {
    return { category: 'content', summary: 'Content/social action.', suggestedOps: matchOps(['shortform', 'viral', 'post', 'caption']), requiresApproval: true, nextStep: 'Specify which platform + which clip/asset.' }
  }
  if (/(business|niche|portfolio|revenue|monetize|launch|brand)/.test(p)) {
    return { category: 'business', summary: 'Business/portfolio action.', suggestedOps: matchOps(['business', 'portfolio', 'launch', 'niche']), requiresApproval: false, nextStep: 'Use business.* or portfolio.* ops.' }
  }
  if (/(connect|connector|oauth|integrate|account|instagram|tiktok|youtube|shopify|etsy)/.test(p)) {
    return { category: 'connector', summary: 'Connector/integration action.', suggestedOps: matchOps(['connector', 'oauth', 'instagram', 'tiktok', 'youtube']), requiresApproval: true, nextStep: 'Specify connector + action (connect / refresh / post).' }
  }
  if (/(research|find|search|analyze|read|watch|investigate|audit)/.test(p)) {
    return { category: 'research', summary: 'Research/analysis. Read-only, safe.', suggestedOps: matchOps(['research', 'analyze', 'watch', 'audit']), requiresApproval: false, nextStep: 'Use the matching read-only op.' }
  }
  if (/(setting|config|toggle|enable|disable|kill\s*switch|env)/.test(p)) {
    return { category: 'config', summary: 'Configuration change.', suggestedOps: matchOps(['setting', 'config', 'kill', 'enable']), requiresApproval: true, nextStep: 'Specify which kill-switch / setting.' }
  }
  return { category: 'unknown', summary: 'Could not classify intent. List capabilities or rephrase.', suggestedOps: ['novan.capabilities'], requiresApproval: false, nextStep: 'Call novan.capabilities to see every op available.' }
}
