/**
 * embeddings.ts — Vector embedding abstraction (item #6 partial).
 *
 * Drivers (real HTTP, fail-fast if no key):
 *   - ollama    (OLLAMA_URL)              nomic-embed-text, 768-dim
 *   - openai    (OPENAI_API_KEY)          text-embedding-3-small, 1536-dim → truncated to 768 for schema compatibility
 *
 * No fakes: if no driver is configured, returns null and callers degrade
 * to substring matching (the existing fallback in continuity-engine).
 */

export type EmbedProvider = 'ollama' | 'openai'

export function configuredEmbedProvider(): EmbedProvider | null {
  if (process.env['OLLAMA_URL'])     return 'ollama'
  if (process.env['OPENAI_API_KEY']) return 'openai'
  return null
}

async function embedOllama(text: string): Promise<number[]> {
  const url = process.env['OLLAMA_URL']
  if (!url) throw new Error('OLLAMA_URL not configured')
  const res = await fetch(`${url.replace(/\/$/, '')}/api/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', prompt: text.slice(0, 8192) }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`Ollama embeddings ${res.status}`)
  const body = await res.json() as { embedding?: number[] }
  if (!body.embedding) throw new Error('Ollama returned no embedding')
  return body.embedding
}

async function embedOpenAI(text: string): Promise<number[]> {
  const key = process.env['OPENAI_API_KEY']
  if (!key) throw new Error('OPENAI_API_KEY not configured')
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${key}` },
    body: JSON.stringify({
      input: text.slice(0, 8192),
      model: 'text-embedding-3-small',
      dimensions: 768,           // schema is 768-dim — request truncated
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`OpenAI embeddings ${res.status}`)
  const body = await res.json() as { data?: Array<{ embedding?: number[] }> }
  const v = body.data?.[0]?.embedding
  if (!v) throw new Error('OpenAI returned no embedding')
  return v
}

/** Returns 768-dim vector or null if no provider configured. */
export async function embed(text: string): Promise<number[] | null> {
  const provider = configuredEmbedProvider()
  if (!provider) return null
  try {
    const v = provider === 'ollama' ? await embedOllama(text) : await embedOpenAI(text)
    // Schema is 768-dim — pad or truncate defensively
    if (v.length === 768) return v
    if (v.length > 768)   return v.slice(0, 768)
    return [...v, ...new Array(768 - v.length).fill(0)]
  } catch {
    return null
  }
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
