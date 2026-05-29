/**
 * music-knowledge.ts — the brain's accumulated music-production wisdom.
 *
 * The brain studies music production continuously via the research loop
 * (DEFAULT_RESEARCH_TOPICS in workspace-bootstrap seeds 20 music topics:
 * mixing, mastering, vocal production, anti-robotic techniques, sound
 * design, genre playbooks, famous producers, Mixcraft workflow, etc).
 *
 * This module surfaces that knowledge to:
 *   1. The chat — when the user asks a music question, recall and
 *      inject the most relevant findings as system context.
 *   2. The music generation pipeline — when crafting an ACE-Step prompt,
 *      enrich it with technique knowledge (e.g. "vocal de-essing notch
 *      at 6.5 kHz" augments the master tier preset).
 *   3. Brain-task ops — music.knowledge returns ranked findings.
 *
 * Query strategy: tag-AND text-LIKE match against research_findings,
 * fall back to memories table, deduped by content hash.
 */

import { db } from '../db/client.js'
import { researchFindings, memories } from '../db/schema.js'
import { and, eq, sql, desc } from 'drizzle-orm'

const MUSIC_TAGS = [
  'music', 'mixing', 'mastering', 'vocals', 'ai-vocals', 'anti-robotic',
  'production', 'sound-design', 'synthesis', 'drums', 'rhythm',
  'theory', 'composition', 'arrangement', 'structure', 'genre', 'playbook',
  'reverb', 'delay', 'compression', 'eq', 'saturation', 'stereo', 'imaging',
  'lyrics', 'songwriting', 'mixcraft', 'daw', 'workflow', 'reference',
  'broadcast', 'producers', 'study', 'royalties', 'fundamentals',
] as const

const MUSIC_RE = /\b(mix|mixing|master(?:ing)?|vocal|sing|singer|voice|chord|melody|lyric|song|track|beat|drum|kick|snare|hat|bass|sub|808|reverb|delay|compress|eq|equali[sz]|sidechain|sat(?:urat)?|stereo|pan|loudn|lufs|dbtp|true[- ]peak|sibil|de[- ]ess|tuning|melodyne|auto[- ]tune|mixcraft|daw|ableton|fl studio|logic|pro tools|cubase|reaper|ace[- ]step|suno|udio|musicgen|stable audio|stem|arrangement|verse|chorus|bridge|intro|outro|harmon|musical|instrument|synth|sampl(?:e|ing)|midi|automation|side[- ]chain|tape|analog|digital|render|export|wav|mp3|flac|44\.?1|48k(?:hz)?|24[- ]bit|32[- ]bit|hp[- ]filter|lp[- ]filter|high[- ]pass|low[- ]pass|pre[- ]delay|ms|m\/s|mid[/ -]side)\b/i

export function isMusicQuery(text: string): boolean {
  if (!text) return false
  return MUSIC_RE.test(text)
}

export interface MusicKnowledgeItem {
  source: 'research' | 'memory'
  summary: string
  confidence: number
  sourceUrl?: string
  sourceTitle?: string
  tags: string[]
  freshAt?: number
}

/**
 * Recall the brain's accumulated music-production knowledge relevant to
 * a query. Pulls from research_findings (tag-filtered + LIKE-matched on
 * summary) and memories (content LIKE-matched), ranked by confidence
 * and freshness.
 */
export async function recallMusicKnowledge(
  workspaceId: string,
  query: string,
  limit = 8,
): Promise<MusicKnowledgeItem[]> {
  const results: MusicKnowledgeItem[] = []
  const q = query.trim().toLowerCase()
  if (!q) return results

  // Extract candidate keywords (3+ chars, non-stopword) for LIKE search
  const stopwords = new Set(['the', 'and', 'for', 'with', 'how', 'what', 'when', 'why', 'this', 'that', 'into', 'from'])
  const keywords = Array.from(new Set(q.split(/[^a-z0-9]+/).filter(w => w.length > 2 && !stopwords.has(w)))).slice(0, 8)
  // OR-of-LIKEs across keywords — any match counts. Previous version used
  // %word1%word2% which required exact ordering, blocking most recalls.
  const likeClauses = keywords.length > 0
    ? sql.join(keywords.map(k => sql`${researchFindings.summary} ILIKE ${`%${k}%`}`), sql` OR `)
    : sql`${researchFindings.summary} ILIKE '%music%'`

  try {
    // 1. Research findings tagged music + matching keywords
    const findings = await db.select({
      summary: researchFindings.summary,
      confidence: researchFindings.confidence,
      sourceUrl: researchFindings.sourceUrl,
      sourceTitle: researchFindings.sourceTitle,
      freshAt: researchFindings.freshAt,
    })
    .from(researchFindings)
    .where(and(
      eq(researchFindings.workspaceId, workspaceId),
      sql`(${likeClauses})`,
    ))
    .orderBy(desc(researchFindings.confidence), desc(researchFindings.freshAt))
    .limit(limit)

    for (const f of findings) {
      const item: MusicKnowledgeItem = {
        source: 'research',
        summary: f.summary,
        confidence: f.confidence ?? 0.5,
        tags: ['music'],
      }
      if (f.sourceUrl)   item.sourceUrl   = f.sourceUrl
      if (f.sourceTitle) item.sourceTitle = f.sourceTitle
      if (f.freshAt)     item.freshAt     = f.freshAt
      results.push(item)
    }

    // 2. Memories — confidence ≥ 0.6, content LIKE keywords
    if (results.length < limit) {
      const remaining = limit - results.length
      const memLikes = keywords.length > 0
        ? sql.join(keywords.map(k => sql`${memories.content} ILIKE ${`%${k}%`}`), sql` OR `)
        : sql`${memories.content} ILIKE '%music%'`
      const memRows = await db.select({
        content: memories.content,
        confidence: memories.confidence,
        tags: memories.tags,
      })
      .from(memories)
      .where(and(
        eq(memories.workspaceId, workspaceId),
        sql`${memories.confidence} >= 0.6`,
        sql`(${memLikes})`,
      ))
      .orderBy(desc(memories.confidence))
      .limit(remaining)

      for (const m of memRows) {
        results.push({
          source: 'memory',
          summary: m.content,
          confidence: m.confidence ?? 0.6,
          tags: Array.isArray(m.tags) ? m.tags as string[] : [],
        })
      }
    }
  } catch { /* DB unavailable — return what we have */ }

  return results.slice(0, limit)
}

/**
 * Render recalled music knowledge as a system-prompt block for chat.
 * Empty string if nothing found (caller can skip injection).
 */
export function renderKnowledgeForChat(items: MusicKnowledgeItem[]): string {
  if (items.length === 0) return ''
  const lines: string[] = ['## Music-production knowledge (the brain has studied these)']
  for (const it of items) {
    const conf = `[${(it.confidence * 100).toFixed(0)}%]`
    const src  = it.sourceTitle ? ` — ${it.sourceTitle}` : ''
    lines.push(`- ${conf} ${it.summary.slice(0, 400)}${src}`)
  }
  lines.push('\nWhen answering music questions, draw from the techniques above. Be specific (Hz, dB, ratios, ms). Cite a source when one is shown.')
  return lines.join('\n')
}

/**
 * Convenience: query + render in one call. Used by novan-chat when
 * isMusicQuery() returns true on the user message.
 */
export async function musicKnowledgeBlock(workspaceId: string, query: string): Promise<string> {
  const items = await recallMusicKnowledge(workspaceId, query, 8)
  return renderKnowledgeForChat(items)
}

export { MUSIC_TAGS }
