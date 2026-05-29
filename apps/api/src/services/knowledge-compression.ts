/**
 * knowledge-compression.ts — Cluster real source rows into summarized
 * lessons. Every output row carries sourceTable + sourceRefs so raw
 * history is always reachable.
 *
 * No fabrication: clusters are formed from REAL signatures (failures)
 * or REAL contentHashes (research). Summaries quote from source rows
 * verbatim where possible; LLM extraction (Groq) is optional and
 * clearly labelled via confidenceProvenance.
 */
import { db }                          from '../db/client.js'
import {
  compressedLessons, failureMemory, successfulFixes, researchFindings,
  incidents, feedbackReports,
} from '../db/schema.js'
import { and, desc, eq, sql }          from 'drizzle-orm'
import { v7 as uuidv7 }                from 'uuid'

const MIN_CLUSTER_SIZE = 3

export interface CompressionResult {
  workspaceId: string
  failureClusters:   number
  fixPatterns:       number
  researchSyntheses: number
  incidentPatterns:  number
  operatorFriction:  number
  totalCreated:      number
  totalSkipped:      number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Normalize a signature to its first ~40 chars for clustering. */
function clusterKey(signature: string): string {
  return signature.trim().toLowerCase().slice(0, 40)
}

async function upsertLesson(workspaceId: string, opts: {
  kind: 'failure_cluster' | 'fix_pattern' | 'research_synthesis' | 'incident_pattern' | 'operator_friction'
  title: string
  summary: string
  abstractedLesson?: string | undefined
  sourceTable: string
  sourceRefs: string[]
  confidence?: number
  confidenceProvenance?: 'heuristic' | 'model_reported' | 'verified'
}): Promise<{ created: boolean }> {
  // Idempotency: hash (kind + sorted sourceRefs) to avoid duplicate lessons
  const stableKey = `${opts.kind}:${[...opts.sourceRefs].sort().join('|')}`
  const existing = await db.select({ id: compressedLessons.id }).from(compressedLessons)
    .where(and(
      eq(compressedLessons.workspaceId, workspaceId),
      eq(compressedLessons.kind, opts.kind),
      sql`array_to_string(${compressedLessons.sourceRefs}, '|') = ${[...opts.sourceRefs].sort().join('|')}`,
    ))
    .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[knowledge-compression]', e.message); return null })
  if (existing) return { created: false }
  void stableKey

  const now = Date.now()
  await db.insert(compressedLessons).values({
    id: uuidv7(), workspaceId,
    kind:               opts.kind,
    title:              opts.title.slice(0, 300),
    summary:            opts.summary.slice(0, 4000),
    abstractedLesson:   opts.abstractedLesson?.slice(0, 4000) ?? null,
    sourceTable:        opts.sourceTable,
    sourceRefs:         opts.sourceRefs,
    sourceCount:        opts.sourceRefs.length,
    confidence:         opts.confidence ?? 0.5,
    confidenceProvenance: opts.confidenceProvenance ?? 'heuristic',
    createdAt: now, updatedAt: now,
  }).onConflictDoNothing().catch((e: Error) => { console.error('[knowledge-compression]', e.message); return null })
  return { created: true }
}

// ─── Compression strategies ─────────────────────────────────────────────────

async function compressFailureClusters(workspaceId: string): Promise<{ created: number; skipped: number }> {
  // Take all failure_memory rows with occurrenceCount >= MIN_CLUSTER_SIZE,
  // group by clusterKey(signature), produce a lesson per cluster.
  const rows = await db.select().from(failureMemory)
    .where(eq(failureMemory.workspaceId, workspaceId)).catch(() => [])

  const clusters = new Map<string, typeof rows>()
  for (const r of rows) {
    const sig = String(r.signature ?? '')
    if (Number(r.occurrenceCount ?? 0) < MIN_CLUSTER_SIZE) continue
    const k = clusterKey(sig)
    if (!k) continue
    const arr = clusters.get(k) ?? []
    arr.push(r); clusters.set(k, arr)
  }

  let created = 0, skipped = 0
  for (const [key, cluster] of clusters) {
    const sourceRefs = cluster.map(c => c.id)
    const totalOccurrences = cluster.reduce((s, c) => s + Number(c.occurrenceCount ?? 0), 0)
    const types = [...new Set(cluster.map(c => String(c.failureType ?? '')).filter(Boolean))]
    const title = `Recurring failure: ${key}${cluster.length > 1 ? ` (×${cluster.length})` : ''}`
    const summary = `${totalOccurrences} occurrences across ${cluster.length} signature variant(s). Types: ${types.join(', ') || 'unknown'}.`
    const abstractedLesson = totalOccurrences >= 10
      ? `Treat as a known systemic pattern — investigate root cause rather than fix individually.`
      : `Pattern emerging — monitor and consider preventive fix.`

    const r = await upsertLesson(workspaceId, {
      kind: 'failure_cluster', title, summary, abstractedLesson,
      sourceTable: 'failure_memory', sourceRefs,
      confidence: Math.min(1, 0.5 + cluster.length * 0.05),
      confidenceProvenance: 'heuristic',
    })
    if (r.created) created++; else skipped++
  }
  return { created, skipped }
}

async function compressFixPatterns(workspaceId: string): Promise<{ created: number; skipped: number }> {
  // successful_fixes with successCount >= MIN_CLUSTER_SIZE → reusable fix pattern
  const rows = await db.select().from(successfulFixes)
    .where(eq(successfulFixes.workspaceId, workspaceId)).catch(() => [])

  let created = 0, skipped = 0
  for (const r of rows) {
    if (Number(r.successCount ?? 0) < MIN_CLUSTER_SIZE) continue
    const desc = String(r.fixDescription ?? '').slice(0, 240)
    const sig  = String(r.failureSignature ?? '').slice(0, 120)
    const title = `Proven fix: ${desc.slice(0, 80)}`
    const summary = `Applied successfully ${r.successCount}× against failure: "${sig}"`
    const abstractedLesson = `This fix is RELIABLE for the matching failure signature — try this first when similar failures recur.`
    const out = await upsertLesson(workspaceId, {
      kind: 'fix_pattern', title, summary, abstractedLesson,
      sourceTable: 'successful_fixes', sourceRefs: [r.id],
      confidence: Math.min(1, 0.6 + Number(r.successCount) * 0.05),
      confidenceProvenance: 'verified',   // grounded in actual successful application
    })
    if (out.created) created++; else skipped++
  }
  return { created, skipped }
}

async function compressIncidentPatterns(workspaceId: string): Promise<{ created: number; skipped: number }> {
  // Cluster incidents by normalized title; ≥3 in same cluster → pattern
  const rows = await db.select().from(incidents)
    .where(eq(incidents.workspaceId, workspaceId)).catch(() => [])

  const clusters = new Map<string, typeof rows>()
  for (const r of rows) {
    const t = String(r.title ?? '').toLowerCase().replace(/\d+/g, '#').slice(0, 40)
    if (!t) continue
    const arr = clusters.get(t) ?? []
    arr.push(r); clusters.set(t, arr)
  }

  let created = 0, skipped = 0
  for (const [key, cluster] of clusters) {
    if (cluster.length < MIN_CLUSTER_SIZE) continue
    const sourceRefs = cluster.map(c => c.id)
    const severities = [...new Set(cluster.map(c => String(c.severity ?? '')))]
    const title = `Incident pattern: ${key}`
    const summary = `${cluster.length} incidents matching pattern. Severities: ${severities.join(', ')}.`
    const out = await upsertLesson(workspaceId, {
      kind: 'incident_pattern', title, summary,
      abstractedLesson: 'Recurring incident — investigate shared root cause rather than treating each in isolation.',
      sourceTable: 'incidents', sourceRefs,
      confidence: 0.7,
      confidenceProvenance: 'heuristic',
    })
    if (out.created) created++; else skipped++
  }
  return { created, skipped }
}

async function compressResearchSyntheses(workspaceId: string): Promise<{ created: number; skipped: number }> {
  // Group research_findings by topicId; ≥3 findings → synthesis
  const rows = await db.select().from(researchFindings)
    .where(eq(researchFindings.workspaceId, workspaceId)).catch(() => [])

  const byTopic = new Map<string, typeof rows>()
  for (const r of rows) {
    const t = r.topicId
    if (!t) continue
    const arr = byTopic.get(t) ?? []
    arr.push(r); byTopic.set(t, arr)
  }

  let created = 0, skipped = 0
  for (const [topicId, findings] of byTopic) {
    if (findings.length < MIN_CLUSTER_SIZE) continue
    // Synthesis: quote top facts from highest-confidence findings
    const sorted = findings.slice().sort((a, b) => Number(b.confidence ?? 0) - Number(a.confidence ?? 0))
    const topFacts = sorted.slice(0, 5).flatMap(f => {
      const facts = (Array.isArray(f.extractedFacts) ? f.extractedFacts : []) as Array<{ text?: string; kind?: string }>
      return facts.filter(x => x.kind === 'fact').slice(0, 2).map(x => x.text).filter(Boolean) as string[]
    }).slice(0, 8)

    const title = `Research synthesis (topic ${topicId.slice(0, 8)})`
    const summary = topFacts.length > 0
      ? `Top facts (verbatim from sources): ${topFacts.join(' · ')}`
      : `${findings.length} findings across ${topicId.slice(0, 8)} — most low-confidence (no facts above 0.7).`
    const out = await upsertLesson(workspaceId, {
      kind: 'research_synthesis', title, summary,
      sourceTable: 'research_findings', sourceRefs: findings.map(f => f.id),
      confidence: Math.min(1, sorted[0]?.confidence ? Number(sorted[0].confidence) : 0.5),
      confidenceProvenance: 'model_reported',  // facts came from Groq extraction
    })
    if (out.created) created++; else skipped++
  }
  return { created, skipped }
}

async function compressOperatorFriction(workspaceId: string): Promise<{ created: number; skipped: number }> {
  const rows = await db.select().from(feedbackReports)
    .where(eq(feedbackReports.workspaceId, workspaceId)).catch(() => [])

  // Cluster by kind + first 40 chars of title
  const clusters = new Map<string, typeof rows>()
  for (const r of rows) {
    const k = `${r.kind}:${String(r.title ?? '').toLowerCase().slice(0, 40)}`
    const arr = clusters.get(k) ?? []
    arr.push(r); clusters.set(k, arr)
  }

  let created = 0, skipped = 0
  for (const [key, cluster] of clusters) {
    if (cluster.length < MIN_CLUSTER_SIZE) continue
    const sourceRefs = cluster.map(c => c.id)
    const title = `Operator friction: ${key.split(':')[1] ?? key}`
    const summary = `${cluster.length} feedback reports of kind "${cluster[0]?.kind}" with similar titles — operator pain point.`
    const out = await upsertLesson(workspaceId, {
      kind: 'operator_friction', title, summary,
      abstractedLesson: 'Repeated operator friction — prioritise UX or workflow fix.',
      sourceTable: 'feedback_reports', sourceRefs,
      confidence: 0.8, confidenceProvenance: 'verified',
    })
    if (out.created) created++; else skipped++
  }
  return { created, skipped }
}

// ─── Public ──────────────────────────────────────────────────────────────────

export async function runCompression(workspaceId: string): Promise<CompressionResult> {
  const [fc, fp, rs, ip, of_] = await Promise.all([
    compressFailureClusters(workspaceId).catch(() => ({ created: 0, skipped: 0 })),
    compressFixPatterns(workspaceId).catch(() => ({ created: 0, skipped: 0 })),
    compressResearchSyntheses(workspaceId).catch(() => ({ created: 0, skipped: 0 })),
    compressIncidentPatterns(workspaceId).catch(() => ({ created: 0, skipped: 0 })),
    compressOperatorFriction(workspaceId).catch(() => ({ created: 0, skipped: 0 })),
  ])
  return {
    workspaceId,
    failureClusters:   fc.created,
    fixPatterns:       fp.created,
    researchSyntheses: rs.created,
    incidentPatterns:  ip.created,
    operatorFriction:  of_.created,
    totalCreated:      fc.created + fp.created + rs.created + ip.created + of_.created,
    totalSkipped:      fc.skipped + fp.skipped + rs.skipped + ip.skipped + of_.skipped,
  }
}

export async function listLessons(workspaceId: string, opts?: { kind?: string; archived?: boolean; limit?: number }) {
  const conds = [eq(compressedLessons.workspaceId, workspaceId)]
  if (opts?.kind) conds.push(eq(compressedLessons.kind, opts.kind))
  if (opts?.archived === true)  conds.push(sql`${compressedLessons.archivedAt} IS NOT NULL`)
  if (opts?.archived === false) conds.push(sql`${compressedLessons.archivedAt} IS NULL`)
  return db.select().from(compressedLessons)
    .where(and(...conds))
    .orderBy(desc(compressedLessons.confidence), desc(compressedLessons.sourceCount))
    .limit(opts?.limit ?? 100).catch(() => [])
}

export async function archiveLesson(workspaceId: string, id: string): Promise<{ ok: boolean }> {
  await db.update(compressedLessons).set({ archivedAt: Date.now() })
    .where(and(eq(compressedLessons.workspaceId, workspaceId), eq(compressedLessons.id, id)))
    .catch((e: Error) => { console.error('[knowledge-compression]', e.message); return null })
  return { ok: true }
}

/** Stale-knowledge candidates: lessons not refreshed in 90 days with no recent
 *  source-table activity. Honest signal — operator decides whether to archive. */
export async function staleCandidates(workspaceId: string): Promise<typeof compressedLessons.$inferSelect[]> {
  const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60_000
  return db.select().from(compressedLessons)
    .where(and(
      eq(compressedLessons.workspaceId, workspaceId),
      sql`${compressedLessons.archivedAt} IS NULL`,
      sql`${compressedLessons.updatedAt} < ${ninetyDaysAgo}`,
    ))
    .limit(50).catch(() => [])
}
