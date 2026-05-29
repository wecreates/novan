/**
 * voice-context-store.ts — DB-backed read/write for ConversationContext +
 * voice quality feedback rollups.
 *
 * Stays a thin layer so voice-conversation.ts can remain pure & testable.
 */
import { db } from '../db/client.js'
import { voiceSessionContext, voiceQualityFeedback } from '../db/schema.js'
import { and, eq, desc, gte } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import type { ConversationContext, ExpectedNext } from './voice-conversation.js'
import type { ActionPlan, Risk } from './voice-command-router.js'

const EMPTY_CTX = (sessionId: string, workspaceId: string): ConversationContext => ({
  sessionId, workspaceId,
  currentNode: null, currentTemplate: null, currentLod: null,
  activeMission: null, selectedSystem: null,
  lastPlan: null, pendingPlan: null,
  currentRisk: 'low', currentUiMode: null,
  preferences: {}, turnCount: 0, expectedNext: null,
  mutedUntil: null, voiceLocked: false, pendingDryRunId: null,
})

export async function getContext(sessionId: string, workspaceId: string): Promise<ConversationContext> {
  const row = await db.select().from(voiceSessionContext)
    .where(eq(voiceSessionContext.sessionId, sessionId))
    .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[voice-context-store]', e.message); return null })
  if (!row) return EMPTY_CTX(sessionId, workspaceId)
  return {
    sessionId,
    workspaceId: row.workspaceId,
    currentNode: row.currentNode,
    currentTemplate: row.currentTemplate,
    currentLod: row.currentLod,
    activeMission: row.activeMission,
    selectedSystem: row.selectedSystem,
    lastPlan: row.lastPlan as ActionPlan | null,
    pendingPlan: row.pendingPlan as ActionPlan | null,
    currentRisk: (row.currentRisk as Risk) ?? 'low',
    currentUiMode: row.currentUiMode,
    preferences: (row.preferences as Record<string, unknown>) ?? {},
    turnCount: row.turnCount,
    expectedNext: (row.expectedNext as ExpectedNext | null) ?? null,
    mutedUntil:  row.mutedUntil ?? null,
    voiceLocked: row.voiceLocked ?? false,
    pendingDryRunId: row.pendingDryRunId ?? null,
  }
}

export async function patchContext(sessionId: string, workspaceId: string, patch: Partial<ConversationContext>): Promise<void> {
  const now = Date.now()
  const existing = await db.select().from(voiceSessionContext).where(eq(voiceSessionContext.sessionId, sessionId)).limit(1).then(r => r[0]).catch((e: Error) => { console.error('[voice-context-store]', e.message); return null })
  if (!existing) {
    await db.insert(voiceSessionContext).values({
      sessionId, workspaceId,
      currentNode:     patch.currentNode ?? null,
      currentTemplate: patch.currentTemplate ?? null,
      currentLod:      patch.currentLod ?? null,
      activeMission:   patch.activeMission ?? null,
      selectedSystem:  patch.selectedSystem ?? null,
      lastPlan:        (patch.lastPlan ?? null) as unknown,
      pendingPlan:     (patch.pendingPlan ?? null) as unknown,
      currentRisk:     patch.currentRisk ?? 'low',
      currentUiMode:   patch.currentUiMode ?? null,
      preferences:     patch.preferences ?? {},
      turnCount:       patch.turnCount ?? 0,
      expectedNext:    (patch.expectedNext ?? null) as unknown,
      mutedUntil:      patch.mutedUntil ?? null,
      voiceLocked:     patch.voiceLocked ?? false,
      pendingDryRunId: patch.pendingDryRunId ?? null,
      updatedAt:       now,
    }).catch((e: Error) => { console.error('[voice-context-store]', e.message); return null })
    return
  }
  // Selective set — never null-out fields the caller didn't touch
  const update: Record<string, unknown> = { updatedAt: now }
  if (patch.currentNode     !== undefined) update['currentNode']     = patch.currentNode
  if (patch.currentTemplate !== undefined) update['currentTemplate'] = patch.currentTemplate
  if (patch.currentLod      !== undefined) update['currentLod']      = patch.currentLod
  if (patch.activeMission   !== undefined) update['activeMission']   = patch.activeMission
  if (patch.selectedSystem  !== undefined) update['selectedSystem']  = patch.selectedSystem
  if (patch.lastPlan        !== undefined) update['lastPlan']        = patch.lastPlan
  if (patch.pendingPlan     !== undefined) update['pendingPlan']     = patch.pendingPlan
  if (patch.currentRisk     !== undefined) update['currentRisk']     = patch.currentRisk
  if (patch.currentUiMode   !== undefined) update['currentUiMode']   = patch.currentUiMode
  if (patch.preferences     !== undefined) update['preferences']     = patch.preferences
  if (patch.turnCount       !== undefined) update['turnCount']       = patch.turnCount
  if (patch.expectedNext    !== undefined) update['expectedNext']    = patch.expectedNext
  if (patch.mutedUntil      !== undefined) update['mutedUntil']      = patch.mutedUntil
  if (patch.voiceLocked     !== undefined) update['voiceLocked']     = patch.voiceLocked
  if (patch.pendingDryRunId !== undefined) update['pendingDryRunId'] = patch.pendingDryRunId
  await db.update(voiceSessionContext).set(update)
    .where(eq(voiceSessionContext.sessionId, sessionId)).catch((e: Error) => { console.error('[voice-context-store]', e.message); return null })
}

export async function resetContext(sessionId: string): Promise<void> {
  await db.delete(voiceSessionContext).where(eq(voiceSessionContext.sessionId, sessionId)).catch((e: Error) => { console.error('[voice-context-store]', e.message); return null })
}

// ─── Voice quality feedback ─────────────────────────────────────────────

export interface QualityRatings {
  naturalness?: number; speed?: number; clarity?: number; tone?: number; usefulness?: number
}

export async function recordQualityFeedback(input: {
  sessionId: string; workspaceId: string; provider?: string;
  ratings: QualityRatings; comment?: string;
}): Promise<{ id: string }> {
  const id = uuidv7()
  const sanitize = (n?: number) => n === undefined ? null : Math.max(1, Math.min(5, Math.round(n)))
  await db.insert(voiceQualityFeedback).values({
    id,
    sessionId:   input.sessionId,
    workspaceId: input.workspaceId,
    provider:    input.provider ?? null,
    naturalness: sanitize(input.ratings.naturalness),
    speed:       sanitize(input.ratings.speed),
    clarity:     sanitize(input.ratings.clarity),
    tone:        sanitize(input.ratings.tone),
    usefulness:  sanitize(input.ratings.usefulness),
    comment:     input.comment ?? null,
    createdAt:   Date.now(),
  }).catch((e: Error) => { console.error('[voice-context-store]', e.message); return null })
  return { id }
}

/**
 * Aggregate provider quality scores across recent feedback. Used by the
 * speech-router to bias provider selection toward providers operators
 * consistently rate well.
 */
export async function providerQualityRollup(workspaceId: string, sinceMs: number = 30 * 86_400_000): Promise<Array<{
  provider: string; count: number; avgNaturalness: number; avgClarity: number; avgUsefulness: number; composite: number;
}>> {
  const cutoff = Date.now() - sinceMs
  const rows = await db.select().from(voiceQualityFeedback)
    .where(and(eq(voiceQualityFeedback.workspaceId, workspaceId), gte(voiceQualityFeedback.createdAt, cutoff)))
    .limit(2000).catch(() => [])
  const byProvider = new Map<string, { count: number; nat: number; cla: number; use: number; spd: number; tone: number }>()
  for (const r of rows) {
    if (!r.provider) continue
    const e = byProvider.get(r.provider) ?? { count: 0, nat: 0, cla: 0, use: 0, spd: 0, tone: 0 }
    e.count++
    if (r.naturalness) e.nat += r.naturalness
    if (r.clarity)     e.cla += r.clarity
    if (r.usefulness)  e.use += r.usefulness
    if (r.speed)       e.spd += r.speed
    if (r.tone)        e.tone += r.tone
    byProvider.set(r.provider, e)
  }
  return [...byProvider.entries()].map(([provider, e]) => ({
    provider,
    count: e.count,
    avgNaturalness: Number((e.nat / e.count).toFixed(2)),
    avgClarity:     Number((e.cla / e.count).toFixed(2)),
    avgUsefulness:  Number((e.use / e.count).toFixed(2)),
    composite: Number(((0.4 * e.nat + 0.3 * e.use + 0.2 * e.cla + 0.1 * e.tone) / e.count / 5).toFixed(3)),
  })).sort((a, b) => b.composite - a.composite)
}

export async function recentFeedback(workspaceId: string, limit = 50) {
  return db.select().from(voiceQualityFeedback)
    .where(eq(voiceQualityFeedback.workspaceId, workspaceId))
    .orderBy(desc(voiceQualityFeedback.createdAt)).limit(limit).catch(() => [])
}

// ─── Session summary ────────────────────────────────────────────────────

export interface SessionSummary {
  sessionId:        string
  turns:            number
  accepted:         number    // executed / navigated / confirmed
  rejected:         number    // blocked + rejected
  corrected:        number    // turns flagged as correction-meta
  clarified:        number    // clarification turns
  failovers:        number
  topIntents:       Array<{ kind: string; count: number }>
  providersUsed:    string[]
  avgLatencyMs:     number | null
  blockedCommands:  number
  durationMs:       number | null
  transcriptHead:   string                                  // first user turn
  transcriptTail:   string                                  // last assistant turn
}

/**
 * Aggregate a single session's events into a structured summary.
 * Pure-ish (one DB read). Used by /sessions/:id/summary for the war room.
 */
export async function summarizeSession(sessionId: string, workspaceId: string): Promise<SessionSummary | null> {
  const { voiceEvents, voiceSessions } = await import('../db/schema.js')
  const [session, evts] = await Promise.all([
    db.select().from(voiceSessions).where(eq(voiceSessions.id, sessionId)).limit(1).then(r => r[0]).catch((e: Error) => { console.error('[voice-context-store]', e.message); return null }),
    db.select().from(voiceEvents)
      .where(and(eq(voiceEvents.sessionId, sessionId), eq(voiceEvents.workspaceId, workspaceId)))
      .orderBy(voiceEvents.createdAt).limit(2000).catch(() => []),
  ])
  if (!session && evts.length === 0) return null

  const intentCounts = new Map<string, number>()
  const providers    = new Set<string>()
  let accepted = 0, rejected = 0, corrected = 0, clarified = 0
  let firstUser = '', lastAssistant = ''

  for (const e of evts) {
    if (e.provider) providers.add(e.provider)
    const meta = (e.meta as { intent?: string; conversationMeta?: string } | null) ?? null
    if (meta?.intent) intentCounts.set(meta.intent, (intentCounts.get(meta.intent) ?? 0) + 1)
    if (meta?.conversationMeta === 'correction') corrected++
    if (e.kind === 'clarify')                    clarified++
    if (e.kind === 'block')                      rejected++
    if (e.kind === 'command' || e.kind === 'confirm') accepted++
    if (e.role === 'user' && !firstUser && e.text)    firstUser     = e.text
    if (e.role === 'assistant' && e.text)             lastAssistant = e.text
  }

  const topIntents = [...intentCounts.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([kind, count]) => ({ kind, count }))

  return {
    sessionId,
    turns:            evts.filter(e => e.role === 'user').length,
    accepted, rejected, corrected, clarified,
    failovers:        session?.failoverCount ?? 0,
    topIntents,
    providersUsed:    [...providers],
    avgLatencyMs:     session?.avgLatencyMs ?? null,
    blockedCommands:  session?.blockedCommands ?? 0,
    durationMs:       session?.endedAt && session?.startedAt ? session.endedAt - session.startedAt : null,
    transcriptHead:   firstUser.slice(0, 200),
    transcriptTail:   lastAssistant.slice(0, 200),
  }
}
