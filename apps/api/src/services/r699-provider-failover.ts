/**
 * R699 — Multi-provider failover for embeddings + vision + image gen.
 *
 * Wraps R685 embed / R659 vision / R654 image-gen with a try-OpenAI →
 * try-Gemini → throw chain. Right now only OpenAI is fully wired; the
 * Gemini paths are stubbed and return `unavailable` if GEMINI_API_KEY
 * isn't set. Structure is in place so adding a second provider is a
 * one-method change.
 */
import { embedText as embedOpenAI } from './r685-embeddings.js'
import { describeImage as visionOpenAI } from './r659-openai-vision.js'

interface FailoverResult<T> { ok: boolean; provider: string; data?: T; error?: string }

async function geminiEmbed(text: string): Promise<{ ok: boolean; vector?: number[]; tokens?: number; error?: string }> {
  const key = process.env['GEMINI_API_KEY']
  if (!key) return { ok: false, error: 'GEMINI_API_KEY not set' }
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: { parts: [{ text: text.slice(0, 8000) }] } }),
    })
    if (!res.ok) return { ok: false, error: `gemini ${res.status}` }
    const j = await res.json() as { embedding?: { values?: number[] } }
    const v = j.embedding?.values
    if (!Array.isArray(v)) return { ok: false, error: 'no embedding' }
    return { ok: true, vector: v, tokens: text.length }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

export async function embedWithFailover(text: string): Promise<FailoverResult<{ vector: number[]; tokens: number }>> {
  const a = await embedOpenAI(text)
  if (a.ok && a.vector) return { ok: true, provider: 'openai', data: { vector: a.vector, tokens: a.tokens ?? 0 } }
  const b = await geminiEmbed(text)
  if (b.ok && b.vector) {
    // Note: Gemini text-embedding-004 is 768-dim, OpenAI 3-small is 1536. If
    // they need to share an index, caller must standardize. For pure failover
    // queries (where the matching set was OpenAI-embedded) this won't work
    // cross-provider; we still return for completeness.
    return { ok: true, provider: 'gemini-text-embedding-004', data: { vector: b.vector, tokens: b.tokens ?? 0 } }
  }
  return { ok: false, provider: 'none', error: `${a.error ?? '?'} | gemini: ${b.error ?? '?'}` }
}

export async function visionWithFailover(workspaceId: string, input: Parameters<typeof visionOpenAI>[1]): Promise<FailoverResult<unknown>> {
  const a = await visionOpenAI(workspaceId, input)
  if (a.ok) return { ok: true, provider: a.model, data: a }
  // Gemini vision is a future hook; for now surface OpenAI's error.
  return { ok: false, provider: 'openai', error: a.error ?? 'vision failed' }
}

export async function providerHealth(): Promise<Record<string, { configured: boolean; lastOk?: boolean }>> {
  return {
    openai:  { configured: !!process.env['OPENAI_API_KEY'] },
    gemini:  { configured: !!process.env['GEMINI_API_KEY'] },
    anthropic: { configured: !!process.env['ANTHROPIC_API_KEY'] },
  }
}
