/**
 * prompt-rewriter.ts — Operator prompt-improvement assistant (item #29).
 *
 * Uses the token-stretcher cache so identical rewrites are free on repeat.
 * Returns suggestions clearly labelled as model output, not ground truth.
 */
import { stretch }                     from './token-stretcher.js'

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'

export interface RewriteSuggestion {
  improved:    string
  rationale:   string[]
  modelProvenance: 'groq:llama-3.1-8b-instant'
  cacheHit:    boolean
}

export async function rewritePrompt(workspaceId: string, original: string, purpose: 'image' | 'research' | 'general' = 'general'): Promise<RewriteSuggestion | { error: string }> {
  const key = process.env['GROQ_API_KEY']
  if (!key) return { error: 'GROQ_API_KEY not configured' }
  if (original.trim().length < 5) return { error: 'prompt too short to improve' }

  const guide = purpose === 'image'
    ? 'Optimize for an image-generation model. Add subject, style, composition, lighting, color palette, medium. No purple unless requested. No fabricated brand names.'
    : purpose === 'research'
    ? 'Optimize for a research query: make the topic specific, add concrete sub-questions, and request citations/facts/dates.'
    : 'Make the prompt clearer, more specific, and easier for a model to follow. Preserve original intent exactly.'

  const instruction = `You are a prompt-improvement assistant. ${guide}

ORIGINAL PROMPT:
${original.slice(0, 2000)}

Return strict JSON:
{
  "improved": "...the improved prompt...",
  "rationale": ["short reason 1", "short reason 2", "short reason 3"]
}

Rules:
- Keep the improved prompt under 500 words.
- Don't fabricate facts the operator didn't provide.
- Don't add disallowed content (CSAM, weapons, real-person sexual content).`

  const result = await stretch({
    workspaceId,
    model:       'llama-3.1-8b-instant',
    taskType:    'prompt-rewrite',
    messages:    [{ role: 'user', content: instruction }],
    maxTokens:   800,
    temperature: 0.3,
    cacheTtlMs:  12 * 60 * 60_000,
    call: async ({ model, messages, maxTokens, temperature }) => {
      const res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${key}` },
        body:   JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
        signal: AbortSignal.timeout(30_000),
      })
      const body = await res.json().catch(() => ({})) as Record<string, unknown>
      if (!res.ok) throw new Error(`Groq ${res.status}`)
      const choices = body['choices'] as Array<{ message?: { content?: string } }> | undefined
      return { content: choices?.[0]?.message?.content ?? '' }
    },
  }).catch((e: Error) => ({ error: e.message } as const))

  if ('error' in result) return result
  const match = result.content.match(/\{[\s\S]*\}/)
  if (!match) {
    return {
      improved:        original,
      rationale:       ['model did not return parseable JSON; returning original'],
      modelProvenance: 'groq:llama-3.1-8b-instant',
      cacheHit:        result.cacheHit,
    }
  }
  try {
    const parsed = JSON.parse(match[0]) as { improved?: string; rationale?: string[] }
    return {
      improved:        String(parsed.improved ?? original).slice(0, 4000),
      rationale:       Array.isArray(parsed.rationale) ? parsed.rationale.slice(0, 6).map(String) : [],
      modelProvenance: 'groq:llama-3.1-8b-instant',
      cacheHit:        result.cacheHit,
    }
  } catch {
    return {
      improved:        original,
      rationale:       ['JSON parse failed'],
      modelProvenance: 'groq:llama-3.1-8b-instant',
      cacheHit:        result.cacheHit,
    }
  }
}
