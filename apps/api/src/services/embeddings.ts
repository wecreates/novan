/**
 * embeddings.ts — Vector embedding abstraction.
 *
 * Drivers (real HTTP, fail-fast if no key):
 *   - ollama    (OLLAMA_URL)              nomic-embed-text, 768-dim
 *   - openai    (OPENAI_API_KEY)          text-embedding-3-small, 1536-dim → truncated to 768 for schema compatibility
 *   - gemini    (GEMINI_API_KEY)          text-embedding-004, 768-dim native (free tier covers personal use)
 *
 * Provider precedence: Ollama → OpenAI → Gemini. Falls through to the
 * next when the preferred one fails OR isn't configured. Returns null
 * when none are available; callers degrade to substring matching.
 *
 * All providers route through `fetchWithRetry` for transient-failure
 * resilience (Ollama restart, OpenAI 429, Gemini quota spike).
 */
import { fetchWithRetry } from './provider-retry.js'

export type EmbedProvider = 'ollama' | 'openai' | 'gemini' | 'huggingface' | 'cohere'

export function configuredEmbedProvider(): EmbedProvider | null {
  if (process.env['OLLAMA_URL'])      return 'ollama'
  if (process.env['OPENAI_API_KEY'])  return 'openai'
  if (process.env['COHERE_API_KEY'])  return 'cohere'              // R343 — free tier 5000/mo
  if (process.env['HF_TOKEN'])        return 'huggingface'         // R343 — free tier via Inference API
  if (process.env['GEMINI_API_KEY']) return 'gemini'
  return null
}

// R343 — log-flood guard. Without this, when Gemini is over cap every
// retry inside fetchWithRetry triggers a console.error AND the calling
// code may itself retry. Each gemini embed failure was logging dozens
// of "circuit-breaker-open" lines per minute. Throttle to 1/min/provider.
const LAST_ERROR_LOG = new Map<string, number>()
function maybeLogErr(provider: string, msg: string): void {
  const now = Date.now()
  const last = LAST_ERROR_LOG.get(provider) ?? 0
  if (now - last < 60_000) return
  LAST_ERROR_LOG.set(provider, now)
  console.error(`[embeddings] ${provider} embed failed:`, msg)
}

async function embedOllama(text: string): Promise<number[]> {
  const url = process.env['OLLAMA_URL']
  if (!url) throw new Error('OLLAMA_URL not configured')
  const out = await fetchWithRetry('embed:ollama', `${url.replace(/\/$/, '')}/api/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', prompt: text.slice(0, 8192) }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!out.ok) throw new Error(`Ollama embeddings ${out.status}: ${out.statusText}`)
  const body = await out.response.json() as { embedding?: number[] }
  if (!body.embedding) throw new Error('Ollama returned no embedding')
  return body.embedding
}

async function embedOpenAI(text: string): Promise<number[]> {
  const key = process.env['OPENAI_API_KEY']
  if (!key) throw new Error('OPENAI_API_KEY not configured')
  const out = await fetchWithRetry('embed:openai', 'https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${key}` },
    body: JSON.stringify({
      input: text.slice(0, 8192),
      model: 'text-embedding-3-small',
      dimensions: 768,           // schema is 768-dim — request truncated
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!out.ok) throw new Error(`OpenAI embeddings ${out.status}: ${out.statusText}`)
  const body = await out.response.json() as { data?: Array<{ embedding?: number[] }> }
  const v = body.data?.[0]?.embedding
  if (!v) throw new Error('OpenAI returned no embedding')
  return v
}

async function embedGemini(text: string): Promise<number[]> {
  const key = process.env['GEMINI_API_KEY']
  if (!key) throw new Error('GEMINI_API_KEY not configured')
  // R142 — text-embedding-004 was retired by Google and now returns 404.
  // gemini-embedding-001 is the supported successor (768/1536/3072-dim,
  // we truncate to 768 below). Free tier is small; paid tier kicks in
  // automatically. If the key is depleted, the 429 surfaces through
  // embedWithReason's reason='provider-error' branch instead of silently
  // dropping all memories from semantic search.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${encodeURIComponent(key)}`
  const out = await fetchWithRetry('embed:gemini', url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: { parts: [{ text: text.slice(0, 8192) }] },
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!out.ok) throw new Error(`Gemini embeddings ${out.status}: ${out.statusText}`)
  const body = await out.response.json() as { embedding?: { values?: number[] } }
  const v = body.embedding?.values
  if (!v) throw new Error('Gemini returned no embedding')
  return v
}

/** Returns 768-dim vector or null if no provider configured / call failed.
 *  Callers who need to distinguish "not configured" from "transient failure"
 *  should use embedWithReason() instead. */
export async function embed(text: string): Promise<number[] | null> {
  const r = await embedWithReason(text)
  return r.vector
}

/** Detailed embed call. `reason` is set on failure so callers can decide
 *  whether to fall back (e.g. to keyword search) or surface the error to
 *  the operator. Previously the bare embed() returned null for both
 *  "no key configured" and "Ollama is down" — operators couldn't tell
 *  which case they were in. */
export async function embedWithReason(text: string): Promise<{
  vector: number[] | null
  reason: 'ok' | 'no-provider-configured' | 'provider-error'
  errorMessage?: string
}> {
  const provider = configuredEmbedProvider()
  if (!provider) return { vector: null, reason: 'no-provider-configured' }
  try {
    const v = provider === 'ollama'      ? await embedOllama(text)
            : provider === 'openai'      ? await embedOpenAI(text)
            : provider === 'cohere'      ? await embedCohere(text)
            : provider === 'huggingface' ? await embedHuggingFace(text)
            :                              await embedGemini(text)
    let vector: number[]
    if      (v.length === 768) vector = v
    else if (v.length >  768)  vector = v.slice(0, 768)
    else                       vector = [...v, ...new Array(768 - v.length).fill(0)]
    return { vector, reason: 'ok' }
  } catch (e) {
    const errorMessage = (e as Error).message
    maybeLogErr(provider, errorMessage)
    return { vector: null, reason: 'provider-error', errorMessage }
  }
}

// R343 — Cohere free tier (5000 calls/mo, 384-dim — padded to 768)
async function embedCohere(text: string): Promise<number[]> {
  const key = process.env['COHERE_API_KEY']
  if (!key) throw new Error('COHERE_API_KEY missing')
  const out = await fetchWithRetry('embed:cohere', 'https://api.cohere.com/v2/embed', {
    method:  'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:       'embed-english-light-v3.0',
      input_type:  'search_document',
      embedding_types: ['float'],
      texts:       [text.slice(0, 4096)],
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!out.ok) throw new Error(`Cohere embeddings ${out.status}: ${out.statusText}`)
  const body = await out.response.json() as { embeddings?: { float?: number[][] } }
  const v = body.embeddings?.float?.[0]
  if (!v) throw new Error('Cohere returned no embedding')
  return v
}

// R343 — HuggingFace Inference API embeddings via sentence-transformers
//        (e.g. all-MiniLM-L6-v2 → 384-dim, padded to 768 by caller)
async function embedHuggingFace(text: string): Promise<number[]> {
  const key = process.env['HF_TOKEN']
  if (!key) throw new Error('HF_TOKEN missing')
  const model = process.env['HF_EMBED_MODEL'] ?? 'sentence-transformers/all-MiniLM-L6-v2'
  const out = await fetchWithRetry('embed:hf', `https://api-inference.huggingface.co/pipeline/feature-extraction/${model}`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: text.slice(0, 4096), options: { wait_for_model: true } }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!out.ok) throw new Error(`HF embeddings ${out.status}: ${out.statusText}`)
  const body = await out.response.json() as number[] | number[][]
  // HF returns either [v] for single input or [[v]] depending on model
  const v = Array.isArray(body[0]) ? body[0] as number[] : body as number[]
  if (!v || v.length === 0) throw new Error('HF returned empty embedding')
  return v
}

/** Cosine similarity between two equal-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
