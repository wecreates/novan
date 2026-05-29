/**
 * data-governance.ts — operator-facing data control (#32).
 *
 * The directive requires:
 *   - inspect memory
 *   - delete memory
 *   - export data
 *   - control retention
 *
 * This module provides workspace-scoped, audit-logged read / export /
 * delete operations over the data the operator actually owns:
 *
 *   - voice_sessions, voice_events, voice_session_context,
 *     voice_quality_feedback, voice_skill_observations
 *   - operator_voice_prefs, voice_shortcuts, workspace_voice_prefs
 *   - voice_dry_runs
 *   - image_generations, image_quality_reviews
 *
 * No new tables — the existing audit log (`events`) records every
 * inspect/export/delete call so the data trail is replayable.
 *
 * Deletes are scoped + workspace-isolated. The operator can target a
 * specific table or run "erase everything for my workspace" in one call.
 */
import { db } from '../db/client.js'
import {
  events,
  voiceSessions, voiceEvents, voiceSessionContext, voiceQualityFeedback,
  voiceSkillObservations, voiceShortcuts,
  operatorVoicePrefs, workspaceVoicePrefs,
  voiceDryRuns,
  imageGenerations, imageQualityReviews,
} from '../db/schema.js'
import { and, eq, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

export type GovernanceScope =
  | 'voice_sessions' | 'voice_events' | 'voice_context' | 'voice_feedback'
  | 'voice_skill'    | 'voice_shortcuts'
  | 'voice_prefs'    | 'workspace_voice_prefs'
  | 'voice_dry_runs'
  | 'image_generations' | 'image_quality'

export interface InspectSummary {
  scope:   GovernanceScope
  rowCount: number
  oldestAt: number | null
  newestAt: number | null
}

export interface ExportBundle {
  workspaceId:  string
  exportedAt:   number
  rowCounts:    Record<string, number>
  /** Truncated previews — full data is for the operator's own download. */
  data:         Record<string, unknown[]>
  retention:    Record<string, string>
}

/**
 * Inspect — return row counts + oldest/newest timestamps per scope.
 * Pure-DB read; emits a `governance.inspect` audit event.
 */
export async function inspectWorkspace(workspaceId: string): Promise<InspectSummary[]> {
  await audit(workspaceId, 'governance.inspect', { workspaceId })
  const sumFor = async (scope: GovernanceScope, p: Promise<Array<{ n: number; oldest: number | null; newest: number | null }>>) => {
    const r = await p.catch(() => [{ n: 0, oldest: null, newest: null }])
    const row = r[0] ?? { n: 0, oldest: null, newest: null }
    return { scope, rowCount: Number(row.n) || 0, oldestAt: row.oldest, newestAt: row.newest }
  }

  return Promise.all([
    sumFor('voice_sessions', db.select({ n: sql<number>`count(*)::int`, oldest: sql<number | null>`min(${voiceSessions.startedAt})`, newest: sql<number | null>`max(${voiceSessions.startedAt})` })
      .from(voiceSessions).where(eq(voiceSessions.workspaceId, workspaceId))),
    sumFor('voice_events', db.select({ n: sql<number>`count(*)::int`, oldest: sql<number | null>`min(${voiceEvents.createdAt})`, newest: sql<number | null>`max(${voiceEvents.createdAt})` })
      .from(voiceEvents).where(eq(voiceEvents.workspaceId, workspaceId))),
    sumFor('voice_context', db.select({ n: sql<number>`count(*)::int`, oldest: sql<number | null>`min(${voiceSessionContext.updatedAt})`, newest: sql<number | null>`max(${voiceSessionContext.updatedAt})` })
      .from(voiceSessionContext).where(eq(voiceSessionContext.workspaceId, workspaceId))),
    sumFor('voice_feedback', db.select({ n: sql<number>`count(*)::int`, oldest: sql<number | null>`min(${voiceQualityFeedback.createdAt})`, newest: sql<number | null>`max(${voiceQualityFeedback.createdAt})` })
      .from(voiceQualityFeedback).where(eq(voiceQualityFeedback.workspaceId, workspaceId))),
    sumFor('voice_skill', db.select({ n: sql<number>`count(*)::int`, oldest: sql<number | null>`min(${voiceSkillObservations.createdAt})`, newest: sql<number | null>`max(${voiceSkillObservations.createdAt})` })
      .from(voiceSkillObservations).where(eq(voiceSkillObservations.workspaceId, workspaceId))),
    sumFor('voice_shortcuts', db.select({ n: sql<number>`count(*)::int`, oldest: sql<number | null>`min(${voiceShortcuts.createdAt})`, newest: sql<number | null>`max(${voiceShortcuts.createdAt})` })
      .from(voiceShortcuts).where(eq(voiceShortcuts.workspaceId, workspaceId))),
    sumFor('voice_dry_runs', db.select({ n: sql<number>`count(*)::int`, oldest: sql<number | null>`min(${voiceDryRuns.createdAt})`, newest: sql<number | null>`max(${voiceDryRuns.createdAt})` })
      .from(voiceDryRuns).where(eq(voiceDryRuns.workspaceId, workspaceId))),
    sumFor('image_generations', db.select({ n: sql<number>`count(*)::int`, oldest: sql<number | null>`min(${imageGenerations.createdAt})`, newest: sql<number | null>`max(${imageGenerations.createdAt})` })
      .from(imageGenerations).where(eq(imageGenerations.workspaceId, workspaceId))),
    sumFor('image_quality', db.select({ n: sql<number>`count(*)::int`, oldest: sql<number | null>`min(${imageQualityReviews.createdAt})`, newest: sql<number | null>`max(${imageQualityReviews.createdAt})` })
      .from(imageQualityReviews).where(eq(imageQualityReviews.workspaceId, workspaceId))),
  ])
}

/**
 * Export — bundles every workspace-scoped row from the named scopes
 * (or all by default). Emits an audit event including row counts.
 * Capped at 5_000 rows per scope to keep the JSON downloadable.
 */
export async function exportWorkspace(workspaceId: string, scopes?: ReadonlyArray<GovernanceScope>): Promise<ExportBundle> {
  const cap = 5_000
  const data: Record<string, unknown[]> = {}
  const rowCounts: Record<string, number> = {}

  const wants = (s: GovernanceScope) => !scopes || scopes.length === 0 || scopes.includes(s)

  if (wants('voice_sessions'))   data['voice_sessions']   = await db.select().from(voiceSessions).where(eq(voiceSessions.workspaceId, workspaceId)).limit(cap).catch(() => [])
  if (wants('voice_events'))     data['voice_events']     = await db.select().from(voiceEvents).where(eq(voiceEvents.workspaceId, workspaceId)).limit(cap).catch(() => [])
  if (wants('voice_context'))    data['voice_context']    = await db.select().from(voiceSessionContext).where(eq(voiceSessionContext.workspaceId, workspaceId)).limit(cap).catch(() => [])
  if (wants('voice_feedback'))   data['voice_feedback']   = await db.select().from(voiceQualityFeedback).where(eq(voiceQualityFeedback.workspaceId, workspaceId)).limit(cap).catch(() => [])
  if (wants('voice_skill'))      data['voice_skill']      = await db.select().from(voiceSkillObservations).where(eq(voiceSkillObservations.workspaceId, workspaceId)).limit(cap).catch(() => [])
  if (wants('voice_shortcuts'))  data['voice_shortcuts']  = await db.select().from(voiceShortcuts).where(eq(voiceShortcuts.workspaceId, workspaceId)).limit(cap).catch(() => [])
  if (wants('voice_prefs'))      data['voice_prefs']      = await db.select().from(operatorVoicePrefs).where(eq(operatorVoicePrefs.workspaceId, workspaceId)).limit(cap).catch(() => [])
  if (wants('workspace_voice_prefs')) data['workspace_voice_prefs'] = await db.select().from(workspaceVoicePrefs).where(eq(workspaceVoicePrefs.workspaceId, workspaceId)).limit(cap).catch(() => [])
  if (wants('voice_dry_runs'))   data['voice_dry_runs']   = await db.select().from(voiceDryRuns).where(eq(voiceDryRuns.workspaceId, workspaceId)).limit(cap).catch(() => [])
  if (wants('image_generations')) data['image_generations'] = await db.select().from(imageGenerations).where(eq(imageGenerations.workspaceId, workspaceId)).limit(cap).catch(() => [])
  if (wants('image_quality'))    data['image_quality']    = await db.select().from(imageQualityReviews).where(eq(imageQualityReviews.workspaceId, workspaceId)).limit(cap).catch(() => [])

  for (const [k, v] of Object.entries(data)) rowCounts[k] = Array.isArray(v) ? v.length : 0

  await audit(workspaceId, 'governance.export', { workspaceId, scopes: scopes ?? 'all', rowCounts })

  return {
    workspaceId,
    exportedAt: Date.now(),
    rowCounts,
    data,
    retention: {
      voice_events:        '60d (apps/api retention sweep)',
      reasoning_chains:    '90d',
      messages:            '60d',
      status_changes:      '180d',
      communication_audit: '90d',
      governance:          'permanent (excluded from retention)',
    },
  }
}

/**
 * Delete — workspace-scoped erase. Operator MUST pass `confirm: true`
 * AND a reason ≥ 5 chars. Returns row counts deleted per scope.
 * Emits a `governance.delete` audit event BEFORE the delete so the
 * trail survives the operation.
 */
export async function deleteWorkspaceData(input: {
  workspaceId: string
  scopes?:     ReadonlyArray<GovernanceScope>
  confirm:     boolean
  reason:      string
  actor?:      string
}): Promise<{ ok: boolean; deleted: Record<string, number>; reason?: string }> {
  if (!input.confirm)          return { ok: false, deleted: {}, reason: 'confirm=true required' }
  if (!input.reason || input.reason.trim().length < 5)
    return { ok: false, deleted: {}, reason: 'reason ≥5 chars required' }

  await audit(input.workspaceId, 'governance.delete.requested', {
    workspaceId: input.workspaceId, scopes: input.scopes ?? 'all',
    reason: input.reason, actor: input.actor ?? null,
  })

  const wants = (s: GovernanceScope) => !input.scopes || input.scopes.length === 0 || input.scopes.includes(s)
  const deleted: Record<string, number> = {}

  async function del(scope: GovernanceScope, run: () => Promise<unknown>) {
    if (!wants(scope)) return
    const before = await rowCount(scope, input.workspaceId)
    await run().catch(() => null)
    const after = await rowCount(scope, input.workspaceId)
    deleted[scope] = Math.max(0, before - after)
  }

  await del('voice_events',    () => db.delete(voiceEvents).where(eq(voiceEvents.workspaceId, input.workspaceId)))
  await del('voice_context',   () => db.delete(voiceSessionContext).where(eq(voiceSessionContext.workspaceId, input.workspaceId)))
  await del('voice_feedback',  () => db.delete(voiceQualityFeedback).where(eq(voiceQualityFeedback.workspaceId, input.workspaceId)))
  await del('voice_skill',     () => db.delete(voiceSkillObservations).where(eq(voiceSkillObservations.workspaceId, input.workspaceId)))
  await del('voice_shortcuts', () => db.delete(voiceShortcuts).where(eq(voiceShortcuts.workspaceId, input.workspaceId)))
  await del('voice_prefs',     () => db.delete(operatorVoicePrefs).where(eq(operatorVoicePrefs.workspaceId, input.workspaceId)))
  await del('workspace_voice_prefs', () => db.delete(workspaceVoicePrefs).where(eq(workspaceVoicePrefs.workspaceId, input.workspaceId)))
  await del('voice_dry_runs',  () => db.delete(voiceDryRuns).where(eq(voiceDryRuns.workspaceId, input.workspaceId)))
  await del('voice_sessions',  () => db.delete(voiceSessions).where(eq(voiceSessions.workspaceId, input.workspaceId)))
  await del('image_quality',   () => db.delete(imageQualityReviews).where(eq(imageQualityReviews.workspaceId, input.workspaceId)))
  await del('image_generations', () => db.delete(imageGenerations).where(eq(imageGenerations.workspaceId, input.workspaceId)))

  await audit(input.workspaceId, 'governance.delete.completed', {
    workspaceId: input.workspaceId, scopes: input.scopes ?? 'all',
    deleted, actor: input.actor ?? null,
  })
  return { ok: true, deleted }
}

/**
 * Cross-workspace (org-wide) compliance bundle. Pulls a single export
 * per workspace and stitches them under a top-level `workspaces` key so
 * legal/compliance can review the entire tenancy in one download.
 *
 * The caller MUST pass `actor` (admin identity) and a `reason`; both
 * land in the audit trail of every targeted workspace before any reads
 * happen, so erasure of the audit log can't hide an org-wide pull.
 */
export interface OrgExportInput {
  workspaceIds: ReadonlyArray<string>
  scopes?:      ReadonlyArray<GovernanceScope>
  actor:        string
  reason:       string
}
export interface OrgExportBundle {
  exportedAt:    number
  actor:         string
  reason:        string
  workspaceIds:  string[]
  workspaces:    Record<string, ExportBundle>
  aggregate:     { rowCounts: Record<string, number>; workspaceCount: number }
}

export async function exportOrg(input: OrgExportInput): Promise<{ ok: true; bundle: OrgExportBundle } | { ok: false; reason: string }> {
  if (!input.actor || input.actor.trim().length < 1)             return { ok: false, reason: 'actor required' }
  if (!input.reason || input.reason.trim().length < 5)           return { ok: false, reason: 'reason ≥5 chars required' }
  if (!Array.isArray(input.workspaceIds) || input.workspaceIds.length === 0)
                                                                  return { ok: false, reason: 'workspaceIds non-empty array required' }
  if (input.workspaceIds.length > 50)                            return { ok: false, reason: 'max 50 workspaces per org export' }

  // Audit BEFORE reading so the trail survives even if the export is
  // intercepted. One event per targeted workspace.
  for (const ws of input.workspaceIds) {
    await audit(ws, 'governance.org_export.requested', {
      actor: input.actor, reason: input.reason, scopes: input.scopes ?? 'all',
      workspaces: input.workspaceIds,
    })
  }

  const workspaces: Record<string, ExportBundle> = {}
  const aggregate: Record<string, number> = {}
  for (const ws of input.workspaceIds) {
    const b = await exportWorkspace(ws, input.scopes)
    workspaces[ws] = b
    for (const [k, v] of Object.entries(b.rowCounts)) aggregate[k] = (aggregate[k] ?? 0) + v
  }

  for (const ws of input.workspaceIds) {
    await audit(ws, 'governance.org_export.completed', {
      actor: input.actor, scopes: input.scopes ?? 'all', rowCounts: workspaces[ws]?.rowCounts ?? {},
    })
  }

  return {
    ok: true,
    bundle: {
      exportedAt:    Date.now(),
      actor:         input.actor,
      reason:        input.reason,
      workspaceIds:  [...input.workspaceIds],
      workspaces,
      aggregate:     { rowCounts: aggregate, workspaceCount: input.workspaceIds.length },
    },
  }
}

async function rowCount(scope: GovernanceScope, ws: string): Promise<number> {
  const tableMap: Record<GovernanceScope, { workspaceId: { name: string } } & { _: unknown }> = {
    voice_sessions:        voiceSessions as never,
    voice_events:          voiceEvents as never,
    voice_context:         voiceSessionContext as never,
    voice_feedback:        voiceQualityFeedback as never,
    voice_skill:           voiceSkillObservations as never,
    voice_shortcuts:       voiceShortcuts as never,
    voice_prefs:           operatorVoicePrefs as never,
    workspace_voice_prefs: workspaceVoicePrefs as never,
    voice_dry_runs:        voiceDryRuns as never,
    image_generations:     imageGenerations as never,
    image_quality:         imageQualityReviews as never,
  }
  const t = tableMap[scope]
  if (!t) return 0
  const r = await db.select({ n: sql<number>`count(*)::int` }).from(t as never).where(eq((t as never as { workspaceId: never }).workspaceId, ws)).catch(() => [{ n: 0 }])
  return Number(r[0]?.n ?? 0)
}

async function audit(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/data-governance', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}
