/**
 * Embedder — generates vector embeddings via Ollama (nomic-embed-text, 768-dim)
 * or OpenAI (text-embedding-3-small, 1536-dim) with automatic fallback.
 *
 * Returns 1536-dim vectors padded to match pgvector schema.
 */

const OLLAMA_URL   = process.env['OLLAMA_URL']   ?? 'http://localhost:11434'
const OPENAI_KEY   = process.env['OPENAI_API_KEY']
const EMBED_DIM    = 1536  // canonical dimension in schema

/** Pad or truncate a float array to exactly `dim` length. */
function normalizeDim(vec: number[], dim: number): number[] {
  if (vec.length === dim) return vec
  if (vec.length > dim)  return vec.slice(0, dim)
  return [...vec, ...new Array(dim - vec.length).fill(0)]
}

/** Ollama nomic-embed-text (768-dim → padded to 1536). */
async function embedOllama(texts: string[]): Promise<number[][]> {
  const results: number[][] = []
  // Ollama processes one at a time
  for (const text of texts) {
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
    })
    if (!res.ok) throw new Error(`Ollama embeddings failed: ${res.status}`)
    const json = await res.json() as { embedding: number[] }
    results.push(normalizeDim(json.embedding, EMBED_DIM))
  }
  return results
}

/** OpenAI text-embedding-3-small (1536-dim). */
async function embedOpenAI(texts: string[]): Promise<number[][]> {
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY not set')
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: texts,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`OpenAI embeddings failed: ${res.status} ${body}`)
  }
  const json = await res.json() as { data: { embedding: number[] }[] }
  return json.data.map((d) => normalizeDim(d.embedding, EMBED_DIM))
}

/**
 * Generate embeddings for a batch of texts.
 * Tries Ollama first (local, free), falls back to OpenAI.
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []

  try {
    return await embedOllama(texts)
  } catch (ollamaErr) {
    console.warn('[embedder] Ollama failed, falling back to OpenAI:', (ollamaErr as Error).message)
    try {
      return await embedOpenAI(texts)
    } catch (openaiErr) {
      throw new Error(
        `All embedding providers failed.\n  Ollama: ${(ollamaErr as Error).message}\n  OpenAI: ${(openaiErr as Error).message}`,
      )
    }
  }
}

/** Convenience: embed a single text. */
export async function embedText(text: string): Promise<number[]> {
  const [vec] = await generateEmbeddings([text])
  if (!vec) throw new Error('No embedding returned')
  return vec
}
