/**
 * voice-skill-memory.ts — capture + summarize operator behavior so
 * Novan can improve future intent routing.
 *
 * Writes are append-only into `voice_skill_observations`. The aggregator
 * functions are pure(-ish): they read a recent window and compute
 * rollups (top phrases, misunderstanding rate, preferred brain nodes,
 * etc.) that the router and analytics page consume.
 *
 * No fake learning: every observation is a real event the operator
 * produced — corrections explicitly tagged via `voice.command` payloads,
 * brain-node usage tagged when `brain.*` intents fire, repeats tagged
 * when the same phrase fires twice in a session within 60 s.
 */
import { db } from '../db/client.js'
import { voiceSkillObservations } from '../db/schema.js'
import { and, eq, gte, desc } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

export type SkillKind = 'misunderstood' | 'corrected' | 'repeated' | 'workflow' | 'brain_node' | 'preferred_action'

export interface SkillObservationInput {
  workspaceId: string
  userId?: string | null
  sessionId?: string | null
  kind: SkillKind
  phrase?: string
  intentKind?: string
  fromIntent?: string
  toIntent?: string
  confidence?: number
  nodeId?: string
  meta?: Record<string, unknown>
}

export async function recordObservation(input: SkillObservationInput): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(voiceSkillObservations).values({
    id,
    workspaceId: input.workspaceId,
    userId:      input.userId ?? null,
    sessionId:   input.sessionId ?? null,
    kind:        input.kind,
    phrase:      input.phrase?.toLowerCase().slice(0, 200) ?? null,
    intentKind:  input.intentKind ?? null,
    fromIntent:  input.fromIntent ?? null,
    toIntent:    input.toIntent ?? null,
    confidence:  input.confidence ?? null,
    nodeId:      input.nodeId ?? null,
    meta:        input.meta ?? null,
    createdAt:   Date.now(),
  }).catch((e: Error) => { console.error('[voice-skill-memory]', e.message); return null })
  return { id }
}

export interface SkillRollup {
  topPhrases:           Array<{ phrase: string; count: number; intentKind: string | null }>
  topIntents:           Array<{ intentKind: string; count: number }>
  topBrainNodes:        Array<{ nodeId: string; count: number }>
  misunderstandings:    Array<{ phrase: string; count: number }>
  correctionPairs:      Array<{ from: string; to: string; count: number }>
  repeatedPhrases:      Array<{ phrase: string; count: number }>
  preferredActions:     Array<{ intentKind: string; count: number }>
  /** Misunderstanding rate over the window (misunderstood / total). */
  correctionRate:       number
  total:                number
  windowMs:             number
}

/**
 * Pure aggregator — used in tests with hand-built fixtures so the rollup
 * math is verifiable.
 */
export function aggregateObservations(rows: ReadonlyArray<{
  kind: string; phrase: string | null; intentKind: string | null;
  fromIntent: string | null; toIntent: string | null; nodeId: string | null;
}>, windowMs: number): SkillRollup {
  const phraseCounts        = new Map<string, { count: number; intentKind: string | null }>()
  const intentCounts        = new Map<string, number>()
  const nodeCounts          = new Map<string, number>()
  const misunderstoodCounts = new Map<string, number>()
  const correctionCounts    = new Map<string, { from: string; to: string; count: number }>()
  const repeatedCounts      = new Map<string, number>()
  const actionCounts        = new Map<string, number>()
  let misunderstood = 0

  for (const r of rows) {
    if (r.phrase) {
      const e = phraseCounts.get(r.phrase) ?? { count: 0, intentKind: r.intentKind }
      e.count++
      phraseCounts.set(r.phrase, e)
    }
    if (r.intentKind) intentCounts.set(r.intentKind, (intentCounts.get(r.intentKind) ?? 0) + 1)
    if (r.nodeId)     nodeCounts.set(r.nodeId, (nodeCounts.get(r.nodeId) ?? 0) + 1)

    if (r.kind === 'misunderstood' && r.phrase) {
      misunderstoodCounts.set(r.phrase, (misunderstoodCounts.get(r.phrase) ?? 0) + 1)
      misunderstood++
    }
    if (r.kind === 'corrected' && r.fromIntent && r.toIntent) {
      const k = `${r.fromIntent}→${r.toIntent}`
      const e = correctionCounts.get(k) ?? { from: r.fromIntent, to: r.toIntent, count: 0 }
      e.count++
      correctionCounts.set(k, e)
    }
    if (r.kind === 'repeated' && r.phrase) {
      repeatedCounts.set(r.phrase, (repeatedCounts.get(r.phrase) ?? 0) + 1)
    }
    if (r.kind === 'preferred_action' && r.intentKind) {
      actionCounts.set(r.intentKind, (actionCounts.get(r.intentKind) ?? 0) + 1)
    }
  }

  const total = rows.length
  return {
    topPhrases:    [...phraseCounts.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 10)
                    .map(([phrase, v]) => ({ phrase, count: v.count, intentKind: v.intentKind })),
    topIntents:    [...intentCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
                    .map(([intentKind, count]) => ({ intentKind, count })),
    topBrainNodes: [...nodeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
                    .map(([nodeId, count]) => ({ nodeId, count })),
    misunderstandings: [...misunderstoodCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
                    .map(([phrase, count]) => ({ phrase, count })),
    correctionPairs:   [...correctionCounts.values()].sort((a, b) => b.count - a.count).slice(0, 10),
    repeatedPhrases:   [...repeatedCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
                    .map(([phrase, count]) => ({ phrase, count })),
    preferredActions:  [...actionCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
                    .map(([intentKind, count]) => ({ intentKind, count })),
    correctionRate:    total === 0 ? 0 : Number((misunderstood / total).toFixed(3)),
    total,
    windowMs,
  }
}

export async function rollupSkillMemory(workspaceId: string, opts: { userId?: string; windowMs?: number } = {}): Promise<SkillRollup> {
  const windowMs = opts.windowMs ?? 30 * 86_400_000
  const since = Date.now() - windowMs
  const cond = opts.userId
    ? and(eq(voiceSkillObservations.workspaceId, workspaceId), eq(voiceSkillObservations.userId, opts.userId), gte(voiceSkillObservations.createdAt, since))
    : and(eq(voiceSkillObservations.workspaceId, workspaceId), gte(voiceSkillObservations.createdAt, since))
  const rows = await db.select().from(voiceSkillObservations).where(cond).limit(5000).catch(() => [])
  return aggregateObservations(rows, windowMs)
}

/** Operator-deletable, scoped to workspace + optional user. */
export async function eraseSkillMemory(workspaceId: string, userId?: string): Promise<void> {
  if (userId) {
    await db.delete(voiceSkillObservations)
      .where(and(eq(voiceSkillObservations.workspaceId, workspaceId), eq(voiceSkillObservations.userId, userId))).catch((e: Error) => { console.error('[voice-skill-memory]', e.message); return null })
  } else {
    await db.delete(voiceSkillObservations)
      .where(eq(voiceSkillObservations.workspaceId, workspaceId)).catch((e: Error) => { console.error('[voice-skill-memory]', e.message); return null })
  }
}

/**
 * Recent misunderstood phrases for the misfire-recovery flow — when the
 * parser sees a low-confidence transcript that nearly matches a phrase
 * we've previously had to correct, we suggest the corrected intent.
 */
export async function recentMisunderstandings(workspaceId: string, limit = 20) {
  return db.select().from(voiceSkillObservations)
    .where(and(eq(voiceSkillObservations.workspaceId, workspaceId), eq(voiceSkillObservations.kind, 'misunderstood')))
    .orderBy(desc(voiceSkillObservations.createdAt))
    .limit(limit).catch(() => [])
}
