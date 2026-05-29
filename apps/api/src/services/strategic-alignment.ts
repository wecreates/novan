/**
 * strategic-alignment.ts — Hard gate that autonomous actions align with
 * an active mission.
 *
 * Honest: this only enforces ALIGNMENT, not WORTH. An action that aligns
 * with a mission tag may still be wrong; this gate just prevents
 * autonomous work that's tangential to declared priorities.
 *
 * Default policy: 'permissive' — pass unless operator opts into 'strict'
 * via operator_preferences.metadata.strictAlignment=true.
 */
import { db }                          from '../db/client.js'
import { strategicGoals, events }      from '../db/schema.js'
import { and, eq, sql }                from 'drizzle-orm'
import { v7 as uuidv7 }                from 'uuid'
import { getPreferences }              from './operator-preferences.js'

export interface AlignmentDecision {
  aligned:        boolean
  policy:         'permissive' | 'strict'
  matchedTags:    string[]
  activeTags:     string[]
  reason:         string
  shouldBlock:    boolean
}

/** Strict mode requires at least one tag match. Permissive always allows. */
export async function checkAlignment(workspaceId: string, actionTags: string[]): Promise<AlignmentDecision> {
  const prefs = await getPreferences(workspaceId).catch((e: Error) => { console.error('[strategic-alignment]', e.message); return null })
  const strict = !!(prefs?.metadata && typeof prefs.metadata === 'object'
    && (prefs.metadata as Record<string, unknown>)['strictAlignment'] === true)
  const policy: AlignmentDecision['policy'] = strict ? 'strict' : 'permissive'

  // Pull all active-mission tags
  const goals = await db.select({ tags: strategicGoals.tags }).from(strategicGoals)
    .where(and(eq(strategicGoals.workspaceId, workspaceId), eq(strategicGoals.status, 'active')))
    .catch(() => [])
  const activeTags = new Set<string>()
  for (const g of goals) {
    for (const t of (Array.isArray(g.tags) ? g.tags : []) as string[]) activeTags.add(t.toLowerCase())
  }
  const activeArr = [...activeTags]
  const matched = actionTags.map(t => t.toLowerCase()).filter(t => activeTags.has(t))

  if (policy === 'permissive') {
    return {
      aligned: true, policy, matchedTags: matched, activeTags: activeArr,
      reason: 'permissive mode — alignment not enforced',
      shouldBlock: false,
    }
  }
  // Strict: require at least one match (or if no missions exist at all, allow)
  if (activeArr.length === 0) {
    return {
      aligned: true, policy, matchedTags: [], activeTags: [],
      reason: 'no active missions to align against — strict mode degrades to permissive',
      shouldBlock: false,
    }
  }
  if (matched.length === 0) {
    return {
      aligned: false, policy, matchedTags: [], activeTags: activeArr,
      reason: `strict mode: action tags [${actionTags.join(',')}] do not match any active mission tag`,
      shouldBlock: true,
    }
  }
  return {
    aligned: true, policy, matchedTags: matched, activeTags: activeArr,
    reason: `aligns with ${matched.length} active mission tag(s)`,
    shouldBlock: false,
  }
}

/** Emit an alignment event so blocks are auditable. */
export async function emitAlignmentDecision(workspaceId: string, intent: string, decision: AlignmentDecision): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(),
    type: decision.aligned ? 'strategic_alignment.passed' : 'strategic_alignment.blocked',
    workspaceId,
    payload: { intent, policy: decision.policy, aligned: decision.aligned, matchedTags: decision.matchedTags, reason: decision.reason },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'strategic-alignment', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[strategic-alignment]', e.message); return null })
}
