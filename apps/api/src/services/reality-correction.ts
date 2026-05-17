/**
 * reality-correction.ts — Apply safe corrections in response to drift warnings.
 *
 * Honest scope: corrections are CONSERVATIVE and OBSERVABLE.
 *   - reduce confidence on the affected reasoning chains
 *   - mark assumption status for re-verification
 *   - emit governance.reality_correction events
 *
 * Does NOT:
 *   - rewrite priority weights (autonomy boundary)
 *   - silently re-run anything risky
 *   - pause agents without operator review (already governed)
 */
import { db }                          from '../db/client.js'
import {
  driftWarnings, reasoningChains, assumptions, events, killSwitches,
} from '../db/schema.js'
import { and, eq, gte, sql }           from 'drizzle-orm'
import { v7 as uuidv7 }                from 'uuid'

export interface CorrectionResult {
  workspaceId:        string
  warningsHandled:    number
  confidenceReductions: number
  assumptionsMarkedForRevalidation: number
  killSwitchEngagements: number
  details:            Array<{ warningId: string; kind: string; action: string }>
}

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'reality-correction', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

async function reduceChainConfidence(workspaceId: string, kind: string, factor = 0.85): Promise<number> {
  // Reduce confidence on RECENT unmatched chains of this kind. Capped at 0.1
  const since = Date.now() - 14 * 24 * 60 * 60_000
  const rows = await db.select().from(reasoningChains)
    .where(and(
      eq(reasoningChains.workspaceId, workspaceId),
      eq(reasoningChains.kind, kind),
      gte(reasoningChains.createdAt, since),
    ))
    .catch(() => [])
  let n = 0
  for (const r of rows) {
    if (typeof r.confidence !== 'number') continue
    const next = Math.max(0.1, Number(r.confidence) * factor)
    if (Math.abs(next - Number(r.confidence)) < 0.01) continue
    await db.update(reasoningChains).set({ confidence: Number(next.toFixed(3)) })
      .where(eq(reasoningChains.id, r.id))
      .catch(() => null)
    n++
  }
  return n
}

async function markAssumptionForRevalidation(workspaceId: string, assumptionId: string): Promise<void> {
  await db.update(assumptions).set({
    status: 'verifying', updatedAt: Date.now(),
  }).where(and(eq(assumptions.workspaceId, workspaceId), eq(assumptions.id, assumptionId)))
    .catch(() => null)
}

async function engageKillSwitchIfCritical(workspaceId: string, reason: string): Promise<boolean> {
  // For research only — high-bar autonomy throttle. Image stays on
  // unless operator explicitly engages.
  const existing = await db.select().from(killSwitches)
    .where(and(eq(killSwitches.workspaceId, workspaceId), eq(killSwitches.switchType, 'research')))
    .limit(1).then(r => r[0]).catch(() => null)
  if (existing?.enabled) return false
  const now = Date.now()
  if (existing) {
    await db.update(killSwitches).set({
      enabled: true, reason, enabledBy: 'reality-correction', enabledAt: now, updatedAt: now,
    }).where(eq(killSwitches.id, existing.id)).catch(() => null)
  } else {
    await db.insert(killSwitches).values({
      id: uuidv7(), workspaceId, switchType: 'research', enabled: true,
      reason, enabledBy: 'reality-correction', enabledAt: now,
      createdAt: now, updatedAt: now,
    }).onConflictDoNothing().catch(() => null)
  }
  return true
}

export async function applyCorrections(workspaceId: string): Promise<CorrectionResult> {
  const open = await db.select().from(driftWarnings)
    .where(and(eq(driftWarnings.workspaceId, workspaceId), eq(driftWarnings.status, 'open')))
    .catch(() => [])

  const result: CorrectionResult = {
    workspaceId,
    warningsHandled: 0,
    confidenceReductions: 0,
    assumptionsMarkedForRevalidation: 0,
    killSwitchEngagements: 0,
    details: [],
  }

  for (const w of open) {
    let action = 'noop'
    if (w.kind === 'repeated_wrong_prediction' && w.subjectId) {
      const n = await reduceChainConfidence(workspaceId, w.subjectId)
      result.confidenceReductions += n
      action = `reduced confidence on ${n} chains of kind=${w.subjectId}`
    } else if (w.kind === 'stale_belief' && w.subjectId) {
      await markAssumptionForRevalidation(workspaceId, w.subjectId)
      result.assumptionsMarkedForRevalidation++
      action = `assumption ${w.subjectId} marked for re-verification`
    } else if (w.kind === 'failed_recommendations' && w.subjectId) {
      // Reduce confidence on the failing rec subject specifically (kind always = recommendation)
      const rows = await db.select().from(reasoningChains)
        .where(and(eq(reasoningChains.workspaceId, workspaceId), eq(reasoningChains.subjectId, w.subjectId)))
        .catch(() => [])
      for (const r of rows) {
        if (typeof r.confidence !== 'number') continue
        await db.update(reasoningChains).set({ confidence: Math.max(0.1, Number(r.confidence) * 0.7) })
          .where(eq(reasoningChains.id, r.id)).catch(() => null)
        result.confidenceReductions++
      }
      action = `reduced confidence on failing subject ${w.subjectId}`
    } else if (w.kind === 'low_confidence_loop') {
      // Critical: low confidence + loop → throttle autonomous research
      const engaged = await engageKillSwitchIfCritical(workspaceId, `drift: low_confidence_loop on ${w.subjectId ?? '?'}`)
      if (engaged) result.killSwitchEngagements++
      action = engaged ? 'research kill_switch ENGAGED' : 'kill_switch already engaged or skipped'
    } else if (w.kind === 'unsupported_conclusion' && w.subjectId) {
      await db.update(assumptions).set({ status: 'unverified', updatedAt: Date.now() })
        .where(and(eq(assumptions.workspaceId, workspaceId), eq(assumptions.id, w.subjectId)))
        .catch(() => null)
      result.assumptionsMarkedForRevalidation++
      action = `assumption ${w.subjectId} downgraded to unverified (no evidence)`
    }

    // Mark warning as resolved with applied action
    await db.update(driftWarnings).set({
      status: 'resolved', appliedAction: action, resolvedAt: Date.now(),
    }).where(eq(driftWarnings.id, w.id)).catch(() => null)

    result.warningsHandled++
    result.details.push({ warningId: w.id, kind: w.kind, action })
    await emit(workspaceId, 'governance.reality_correction', { warningId: w.id, kind: w.kind, action })
  }

  return result
}
