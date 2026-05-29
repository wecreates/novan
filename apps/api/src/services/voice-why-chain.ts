/**
 * voice-why-chain.ts — produce a "why" chain for a recent voice/action
 * decision (#29 directive primitive).
 *
 * Pulls events adjacent to an anchor (a specific event id or a
 * timestamp) and orders them chronologically, tagging each with the
 * role it played in the decision (intent / safety / budget / approval /
 * execution / context). The platform already has a richer
 * recommendation-explainer in services/explainability.ts; this module
 * is the lightweight, voice-oriented variant for the Strategic Console.
 *
 * Pure helpers exposed for tests; the DB wrapper reads the `events`
 * audit log.
 */
import { db } from '../db/client.js'
import { events } from '../db/schema.js'
import { and, eq, gte, lte, desc } from 'drizzle-orm'

export type WhyRole = 'intent' | 'safety' | 'budget' | 'approval' | 'execution' | 'context'

export interface WhyStep {
  at:       number
  type:     string
  role:     WhyRole
  summary:  string
  payload:  unknown
}

export interface WhyChain {
  rootEventId: string
  anchorAt:    number
  steps:       WhyStep[]
  conclusion:  string
}

/** Pure: classify an event type into the role it played in a decision. */
export function classifyRole(type: string): WhyRole {
  // Dry-run lifecycle: `.executed` is the action firing; everything
  // else in the lifecycle is approval-track.
  if (type === 'voice.dry_run.executed')                   return 'execution'
  if (type.startsWith('voice.dry_run.'))                   return 'approval'
  if (type.includes('safety') || type.includes('block') || type.includes('reject')) return 'safety'
  if (type.includes('budget') || type.includes('cap'))     return 'budget'
  if (type.includes('approval') || type.includes('confirm')) return 'approval'
  if (type.includes('execute') || type.includes('executed') || type.includes('dispatched')) return 'execution'
  if (type.startsWith('voice.'))                           return 'intent'
  return 'context'
}

/** Pure: short, calm summary of a single event. */
export function summarizeEvent(type: string, payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>
  if (type.startsWith('voice.dry_run.')) {
    if (type.endsWith('.created'))         return `Dry-run created · risk ${p['risk'] ?? '?'} · hardBlocked=${p['hardBlocked'] ?? false}`
    if (type.endsWith('.approval'))        return `Approval recorded · source=${p['source'] ?? '?'} · full=${p['fullyApproved'] ?? false}`
    if (type.endsWith('.executed'))        return `Executed via ${p['via'] ?? '?'} · status ${p['status'] ?? '?'}`
    if (type.endsWith('.execute_failed'))  return `Execute FAILED · ${p['error'] ?? p['status'] ?? 'unknown'}`
    if (type.endsWith('.swept_expired'))   return `Swept ${p['count'] ?? 0} expired pending runs`
  }
  if (type.startsWith('voice.')) {
    const intent = (p['intent'] as { kind?: string } | undefined)?.kind ?? type
    const plan   = p['plan'] as { verdict?: string } | undefined
    return `Voice intent ${intent}${plan?.verdict ? ` · ${plan.verdict}` : ''}`
  }
  if (type.includes('image.creative.'))    return `Creative review · ${type.split('.').pop()}`
  if (type.includes('runtime.self_heal.')) return `Self-heal · ${type.split('.').pop()}`
  return `${type}${typeof p['summary'] === 'string' ? ' · ' + p['summary'] : ''}`
}

export interface BuildOpts {
  workspaceId:    string
  rootEventId?:   string
  /** Anchor timestamp — defaults to the root event's createdAt or now. */
  anchorAt?:      number
  /** How far before/after the anchor to look (ms). */
  windowMs?:      number
  /** Max steps to include. */
  limit?:         number
}

export async function buildWhyChain(opts: BuildOpts): Promise<WhyChain | null> {
  const windowMs = opts.windowMs ?? 5 * 60_000
  const limit    = opts.limit    ?? 30

  let anchorAt = opts.anchorAt ?? Date.now()
  let rootType: string | null = null
  let rootPayload: unknown = null

  if (opts.rootEventId) {
    const root = await db.select().from(events)
      .where(and(eq(events.workspaceId, opts.workspaceId), eq(events.id, opts.rootEventId)))
      .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[voice-why-chain]', e.message); return null })
    if (!root) return null
    anchorAt = root.createdAt
    rootType = root.type
    rootPayload = root.payload
  }

  const rows = await db.select().from(events)
    .where(and(
      eq(events.workspaceId, opts.workspaceId),
      gte(events.createdAt, anchorAt - windowMs),
      lte(events.createdAt, anchorAt + windowMs),
    ))
    .orderBy(desc(events.createdAt))
    .limit(limit).catch(() => [])

  const steps: WhyStep[] = rows.map(r => ({
    at:      r.createdAt,
    type:    r.type,
    role:    classifyRole(r.type),
    summary: summarizeEvent(r.type, r.payload),
    payload: r.payload,
  })).reverse()

  const conclusion = rootType
    ? summarizeEvent(rootType, rootPayload)
    : steps[steps.length - 1]?.summary ?? 'No anchor.'

  return { rootEventId: opts.rootEventId ?? '', anchorAt, steps, conclusion }
}
