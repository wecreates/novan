/**
 * research-to-action.ts — Convert research findings into roadmap tasks.
 *
 * Heuristic mapping (no LLM round-trip needed for the simple case):
 *   - factType = 'fact'    AND confidence >= 0.7 → roadmap backlog candidate
 *   - keywords match ('vulnerab','cve','exploit','injection') → priority bump
 *   - keywords match ('performance','latency','slow') → optimization category
 *   - keywords match ('competitor','pricing','launch') → growth category
 *   - everything else      → 'backlog' / category 'insight'
 *
 * Workspace-scoped. Idempotent — uses content-hash to dedup against
 * existing roadmap_tasks entries.
 */
import crypto                          from 'node:crypto'
import { db }                          from '../db/client.js'
import { researchFindings, roadmapTasks, events } from '../db/schema.js'
import { and, eq, gte, isNotNull, sql } from 'drizzle-orm'
import { v7 as uuidv7 }                from 'uuid'

export interface ConversionResult {
  scanned:   number
  created:   number
  skipped:   number
  reasons:   Record<string, number>
}

interface Categorization {
  category:    'security' | 'performance' | 'growth' | 'reliability' | 'insight'
  phase:       'immediate' | 'near_term' | 'backlog'
  impact:      number   // 1..5
  risk:        number   // 1..5
  requiresApproval: boolean
}

function categorize(text: string, confidence: number): Categorization {
  const t = text.toLowerCase()
  const hasSec  = /\b(vulnerab|cve-|exploit|injection|xss|csrf|auth\s*bypass|rce)\b/.test(t)
  const hasPerf = /\b(latency|slow|bottleneck|p9[59]|memory leak|performance)\b/.test(t)
  const hasGrowth = /\b(competitor|pricing|launch|market|adoption|growth)\b/.test(t)
  const hasReli = /\b(outage|incident|reliability|sla|crash|deadlock)\b/.test(t)

  if (hasSec) return { category: 'security',    phase: 'immediate', impact: 5, risk: 2, requiresApproval: true }
  if (hasReli) return { category: 'reliability', phase: 'near_term', impact: 4, risk: 2, requiresApproval: true }
  if (hasPerf) return { category: 'performance', phase: 'near_term', impact: 3, risk: 2, requiresApproval: false }
  if (hasGrowth) return { category: 'growth',    phase: 'backlog',   impact: 3, risk: 1, requiresApproval: false }
  return {
    category: 'insight', phase: 'backlog',
    impact: confidence >= 0.8 ? 2 : 1,
    risk:   1,
    requiresApproval: false,
  }
}

function priorityScore(c: Categorization, confidence: number): number {
  return Math.round((c.impact * 20 - c.risk * 5 + confidence * 30) * 10) / 10
}

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'research-to-action', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[research-to-action]', e.message); return null })
}

export async function convertFindings(workspaceId: string, opts?: { sinceMs?: number; maxFindings?: number }): Promise<ConversionResult> {
  const since = Date.now() - (opts?.sinceMs ?? 7 * 24 * 60 * 60_000)
  const max = opts?.maxFindings ?? 20

  // Pull recent findings with confidence >= 0.5 (skip low-confidence guesses)
  const findings = await db.select({
    id:         researchFindings.id,
    summary:    researchFindings.summary,
    factType:   researchFindings.factType,
    confidence: researchFindings.confidence,
    sourceUrl:  researchFindings.sourceUrl,
    sourceTitle: researchFindings.sourceTitle,
    contentHash: researchFindings.contentHash,
  }).from(researchFindings)
    .where(and(
      eq(researchFindings.workspaceId, workspaceId),
      gte(researchFindings.createdAt, since),
      isNotNull(researchFindings.summary),
    ))
    .limit(max).catch(() => [])

  const reasons: Record<string, number> = {}
  let created = 0, skipped = 0

  for (const f of findings) {
    if (Number(f.confidence) < 0.5) { skipped++; reasons['low_confidence'] = (reasons['low_confidence'] ?? 0) + 1; continue }
    if (f.factType === 'guess')     { skipped++; reasons['factType_guess'] = (reasons['factType_guess'] ?? 0) + 1; continue }

    // Dedup: skip if a roadmap task already references this content hash
    const recoId = `research:${f.contentHash}`
    const existing = await db.select({ id: roadmapTasks.id }).from(roadmapTasks)
      .where(and(eq(roadmapTasks.workspaceId, workspaceId), eq(roadmapTasks.recommendationId, recoId)))
      .limit(1).then(r => r[0])
    if (existing) { skipped++; reasons['duplicate'] = (reasons['duplicate'] ?? 0) + 1; continue }

    const text = `${f.sourceTitle ?? ''} ${f.summary ?? ''}`
    const cat = categorize(text, Number(f.confidence))
    const score = priorityScore(cat, Number(f.confidence))

    const now = Date.now()
    await db.insert(roadmapTasks).values({
      id:              uuidv7(),
      workspaceId,
      recommendationId: recoId,
      phase:           cat.phase,
      title:           `[research] ${(f.sourceTitle ?? f.sourceUrl).slice(0, 200)}`,
      description:     `${f.summary}\n\nSource: ${f.sourceUrl}\nConfidence: ${f.confidence}`,
      category:        cat.category,
      impact:          cat.impact,
      risk:            cat.risk,
      priorityScore:   score,
      assignedAgent:   null,
      requiresApproval: cat.requiresApproval,
      status:          'pending',
      createdAt:       now,
      updatedAt:       now,
    }).onConflictDoNothing().catch((e: Error) => { console.error('[research-to-action]', e.message); return null })
    created++
  }

  if (created > 0) await emit(workspaceId, 'research_to_action.completed', { created, scanned: findings.length })
  return { scanned: findings.length, created, skipped, reasons }
}

export async function recentRoadmapFromResearch(workspaceId: string, limit = 25) {
  return db.select().from(roadmapTasks)
    .where(and(eq(roadmapTasks.workspaceId, workspaceId), sql`${roadmapTasks.recommendationId} like 'research:%'`))
    .orderBy(sql`${roadmapTasks.priorityScore} desc`)
    .limit(limit)
}
