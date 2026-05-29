/**
 * video-knowledge.ts — the brain's accumulated video-editing wisdom.
 *
 * Mirror of music-knowledge: the bootstrap seeds 20 video-editing
 * research topics, the research loop ingests findings, this module
 * recalls them on demand and injects into chat context when the user
 * asks anything edit-related (or drops a video link / asks for an edit).
 */

import { db } from '../db/client.js'
import { researchFindings, memories } from '../db/schema.js'
import { and, eq, sql, desc } from 'drizzle-orm'

const VIDEO_RE = /\b(edit|editing|cut|cuts|footage|broll|b[- ]roll|capcut|premiere|davinci|resolve|fcp|final cut|after effects|ae|color grade|grading|lut|exposure|saturation|contrast|sharpen|denoise|stabili[sz]|warp|speed|ramp|slow[- ]?mo|timelapse|keyframe|transition|cross[- ]?fade|whip|zoom|pan|tilt|jump cut|j[- ]cut|l[- ]cut|montage|sequence|timeline|audio mix|sfx|sound effect|foley|adr|voiceover|narration|caption|subtitle|aspect ratio|9:16|16:9|1:1|vertical|landscape|portrait|long[- ]form|short[- ]form|reel|shorts|tiktok|youtube|thumbnail|hook|retention|watch time|ctr|click[- ]through|view|engagement|story|storytelling|narrative|script|b[- ]roll)\b/i

export function isVideoQuery(text: string): boolean {
  if (!text) return false
  return VIDEO_RE.test(text)
}

export interface VideoKnowledgeItem {
  source: 'research' | 'memory'
  summary: string
  confidence: number
  sourceUrl?: string
  sourceTitle?: string
  tags: string[]
  freshAt?: number
}

export async function recallVideoKnowledge(
  workspaceId: string,
  query: string,
  limit = 8,
): Promise<VideoKnowledgeItem[]> {
  const results: VideoKnowledgeItem[] = []
  const q = query.trim().toLowerCase()
  if (!q) return results

  const stop = new Set(['the','and','for','with','how','what','when','why','this','that','into','from'])
  const keywords = Array.from(new Set(q.split(/[^a-z0-9]+/).filter(w => w.length > 2 && !stop.has(w)))).slice(0, 8)
  // OR-of-LIKEs (any keyword matches), not AND via %a%b% which requires order
  const likeClauses = keywords.length > 0
    ? sql.join(keywords.map(k => sql`${researchFindings.summary} ILIKE ${`%${k}%`}`), sql` OR `)
    : sql`${researchFindings.summary} ILIKE '%video%'`

  try {
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
      const item: VideoKnowledgeItem = {
        source: 'research', summary: f.summary,
        confidence: f.confidence ?? 0.5, tags: ['video'],
      }
      if (f.sourceUrl)   item.sourceUrl   = f.sourceUrl
      if (f.sourceTitle) item.sourceTitle = f.sourceTitle
      if (f.freshAt)     item.freshAt     = f.freshAt
      results.push(item)
    }

    if (results.length < limit) {
      const remaining = limit - results.length
      const memLikes = keywords.length > 0
        ? sql.join(keywords.map(k => sql`${memories.content} ILIKE ${`%${k}%`}`), sql` OR `)
        : sql`${memories.content} ILIKE '%video%'`
      const memRows = await db.select({
        content: memories.content, confidence: memories.confidence, tags: memories.tags,
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
          source: 'memory', summary: m.content,
          confidence: m.confidence ?? 0.6,
          tags: Array.isArray(m.tags) ? m.tags as string[] : [],
        })
      }
    }
  } catch { /* */ }

  return results.slice(0, limit)
}

export function renderVideoKnowledgeForChat(items: VideoKnowledgeItem[]): string {
  if (items.length === 0) return ''
  const lines: string[] = ['## Video-editing knowledge (the brain has studied these)']
  for (const it of items) {
    const conf = `[${(it.confidence * 100).toFixed(0)}%]`
    const src  = it.sourceTitle ? ` — ${it.sourceTitle}` : ''
    lines.push(`- ${conf} ${it.summary.slice(0, 400)}${src}`)
  }
  lines.push('\nWhen answering edit questions or making edits, draw from these techniques. Be specific (frame rates, codecs, durations, CapCut shortcuts, retention thresholds). Cite a source when one is shown.')
  return lines.join('\n')
}

export async function videoKnowledgeBlock(workspaceId: string, query: string): Promise<string> {
  const items = await recallVideoKnowledge(workspaceId, query, 8)
  return renderVideoKnowledgeForChat(items)
}
