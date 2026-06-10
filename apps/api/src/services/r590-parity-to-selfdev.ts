/**
 * R590 — Wire R584 high-confidence parity entries into R195 self-dev applier.
 *
 * Closes the "6 months ahead of competitors" loop END-TO-END:
 *   R579 captures competitor releases →
 *   R584 LLM scores them →
 *   R590 high-confidence entries (score ≥ 90) auto-file as self_dev_proposal
 *       with status='draft' (operator reviews + approves) →
 *   Existing R195 applier picks up status='approved' proposals + ships code
 *
 * Lower-confidence entries (70 ≤ score < 90) still emit competitor.parity_gap
 * events (R584 already does this) so they surface in R385 next-actions for
 * operator-driven evaluation.
 *
 * Safety: NEVER auto-applies. Every entry creates a DRAFT proposal that
 * operator MUST explicitly approve before R195 picks it up.
 */
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'

export interface FileSelfDevResult {
  attempted:    number
  filed:        number
  alreadyFiled: number
  details:      Array<{ entryId: string; title: string; score: number; status: 'filed' | 'already_filed' | 'error'; proposalId?: string; reason?: string }>
}

export async function fileHighConfidenceAsSelfDev(workspaceId = 'default', minScore = 90, max = 10): Promise<FileSelfDevResult> {
  const result: FileSelfDevResult = { attempted: 0, filed: 0, alreadyFiled: 0, details: [] }
  let entries: Array<{ id: string; title: string; url: string; parity_score: number; capability_delta: string | null }> = []
  try {
    const r = await db.execute(sql`
      SELECT id, title, url, parity_score, capability_delta
      FROM competitor_feed_entries
      WHERE parity_score IS NOT NULL AND parity_score >= ${minScore}
      ORDER BY parity_score DESC, published_at DESC
      LIMIT ${max}
    `)
    entries = r as unknown as typeof entries
  } catch { return result }

  for (const e of entries) {
    result.attempted++
    // Check dedup — has this entry already been filed?
    const findingId = `r584:${e.id}`
    try {
      const existing = await db.execute(sql`
        SELECT id FROM self_dev_proposal WHERE finding_id = ${findingId} LIMIT 1
      `)
      const a = existing as unknown as Array<unknown>
      if (Array.isArray(a) && a.length > 0) {
        result.alreadyFiled++
        result.details.push({ entryId: e.id, title: e.title, score: Number(e.parity_score), status: 'already_filed' })
        continue
      }
    } catch { /* tolerated, try insert anyway */ }

    const proposalId = uuidv7()
    const title = `Parity: ${e.title.slice(0, 200)}`
    const rationale = `R584 scored this competitor feature at ${e.parity_score}/100 for parity priority.\n\nCapability delta: ${e.capability_delta ?? '(none)'}\n\nSource: ${e.url}\n\nRECOMMENDED: review the linked release notes, scope a Novan-side R-numbered feature, draft the migration + service files + brain ops, then approve this proposal for the R195 applier to ship.`
    try {
      await db.execute(sql`
        INSERT INTO self_dev_proposal (id, finding_id, workspace_id, title, rationale, files, risk_level, confidence, status, created_at)
        VALUES (${proposalId}, ${findingId}, ${workspaceId}, ${title}, ${rationale},
                '[]'::jsonb, 'medium', ${Number(e.parity_score) / 100}, 'draft', ${Date.now()})
      `)
      result.filed++
      result.details.push({ entryId: e.id, title: e.title, score: Number(e.parity_score), status: 'filed', proposalId })

      // Audit event
      try {
        await db.execute(sql`
          INSERT INTO events (id, type, workspace_id, payload, trace_id, correlation_id, source, version, created_at)
          VALUES (${uuidv7()}, 'parity.self_dev_filed', ${workspaceId},
            ${JSON.stringify({ entryId: e.id, proposalId, title: e.title, score: e.parity_score, url: e.url })}::jsonb,
            ${uuidv7()}, ${uuidv7()}, 'r590-parity-to-selfdev', 1, ${Date.now()})
        `).catch(() => {/* tolerated */})
      } catch { /* tolerated */ }
    } catch (err) {
      result.details.push({ entryId: e.id, title: e.title, score: Number(e.parity_score), status: 'error', reason: (err as Error).message.slice(0, 100) })
    }
  }
  return result
}

/** Inspect what would be filed without actually inserting. */
export async function previewHighConfidence(minScore = 90, max = 10): Promise<Array<{ title: string; url: string; score: number; capabilityDelta: string | null; alreadyFiled: boolean }>> {
  try {
    const r = await db.execute(sql`
      SELECT cfe.id, cfe.title, cfe.url, cfe.parity_score, cfe.capability_delta,
             EXISTS(SELECT 1 FROM self_dev_proposal sdp WHERE sdp.finding_id = 'r584:' || cfe.id) AS already_filed
      FROM competitor_feed_entries cfe
      WHERE cfe.parity_score IS NOT NULL AND cfe.parity_score >= ${minScore}
      ORDER BY cfe.parity_score DESC, cfe.published_at DESC LIMIT ${max}
    `)
    return (r as unknown as Array<{ id: string; title: string; url: string; parity_score: number; capability_delta: string | null; already_filed: boolean }>).map(x => ({
      title: x.title, url: x.url, score: Number(x.parity_score),
      capabilityDelta: x.capability_delta,
      alreadyFiled: Boolean(x.already_filed),
    }))
  } catch { return [] }
}
