/**
 * R146.328 (#7) — LLM-backed entity extraction.
 *
 * Drop-in replacement for the regex extractor in r327-relationship-graph.
 * Sends one cheap LLM call per chat turn (Haiku/Flash class), aggressively
 * caches by message-hash so re-prompts don't double-bill.
 *
 * Output structured JSON: [{kind, name, attrs?}]. We feed this straight
 * into relationshipUpsert.
 */
import { createHash } from 'node:crypto'
import { TtlCache } from '../util/ttl-cache.js'

export interface ExtractedEntity {
  kind:  'person' | 'business' | 'vendor' | 'partner' | 'team' | 'other'
  name:  string
  attrs?: Record<string, unknown>
}

const _cache = new TtlCache<ExtractedEntity[]>(60 * 60_000, 5000)  // 1h cache

const SYSTEM = (
  'Extract named entities from the user message. Return JSON only — an array of ' +
  '{kind, name, attrs?}. Kinds: person, business, vendor, partner, team, other. ' +
  'Only include real entities the operator mentioned by name (capitalized). ' +
  'Skip pronouns, common nouns, the operator themselves. If none, return [].'
)

function hashKey(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16)
}

export async function extractEntities(userMessage: string): Promise<ExtractedEntity[]> {
  const trimmed = userMessage.trim()
  if (trimmed.length < 8) return []
  const cached = _cache.get(hashKey(trimmed))
  if (cached !== undefined) return cached

  // Cheapest available provider — Haiku or Flash
  const url = process.env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com/v1/messages'
  const key = process.env['ANTHROPIC_API_KEY']
  if (!key) {
    _cache.set(hashKey(trimmed), [])
    return []
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 400, temperature: 0,
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: trimmed.slice(0, 2000) }],
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) { _cache.set(hashKey(trimmed), []); return [] }
    const j = await res.json() as { content?: Array<{ text?: string }> }
    const text = j.content?.[0]?.text?.trim() ?? '[]'
    let parsed: ExtractedEntity[] = []
    try { parsed = JSON.parse(text) as ExtractedEntity[] }
    catch {
      // LLM sometimes wraps with prose — try to recover the first JSON array
      const m = text.match(/\[[\s\S]*\]/)
      if (m) { try { parsed = JSON.parse(m[0]) as ExtractedEntity[] } catch { parsed = [] } }
    }
    const valid = (Array.isArray(parsed) ? parsed : []).filter(e =>
      e && typeof e.name === 'string' && e.name.length > 0 && e.name.length < 100 &&
      ['person','business','vendor','partner','team','other'].includes(e.kind)
    ).slice(0, 8)
    _cache.set(hashKey(trimmed), valid)
    return valid
  } catch {
    _cache.set(hashKey(trimmed), [])
    return []
  }
}
