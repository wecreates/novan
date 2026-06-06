/**
 * R146.329 — items #4, #6, #7, #9, #10, #15.
 *
 *   #4 cost cap enforcement check
 *   #6 clarify auto-resolve from next chat turn
 *   #7 workflow → businessId attribution helpers
 *   #9 export-all
 *   #10 conversation-to-memory promotion (importance detection)
 *   #15 browser approval scope per path
 */
import { db } from '../db/client.js'
import {
  workspaceMemory, clarifyEvents, workflowRuns, businesses, relationshipGraph,
  events, businessPortfolioEarnings, aiUsage, killSwitches,
} from '../db/schema.js'
import { and, eq, gte, desc, sql, isNull } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { createHmac } from 'node:crypto'

// ─── #4 cost cap enforcement check ───────────────────────────────────────
export interface CostCapCheckResult {
  cap_usd:          number
  spent_usd:        number
  remaining_usd:    number
  cap_enforced:     boolean
  kill_switch_present: boolean
  test_scenario:    string
  recommendation:   string
}

export async function costCapEnforcementCheck(workspaceId: string): Promise<CostCapCheckResult> {
  // Read current spend (last 30d)
  const since = Date.now() - 30 * 86400_000
  const rows = await db.select({ cost: aiUsage.costUsd })
    .from(aiUsage)
    .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, since)))
    .catch(() => [])
  const spent = rows.reduce((s, r) => s + Number(r.cost ?? 0), 0)
  const capUsd = Number(process.env['DEFAULT_COST_CAP_USD'] ?? 5)

  // Is the AI-request kill switch present?
  const [ks] = await db.select({ enabled: killSwitches.enabled })
    .from(killSwitches)
    .where(and(eq(killSwitches.workspaceId, workspaceId), eq(killSwitches.switchType, 'ai_request')))
    .limit(1).catch(() => [])
  const kill_switch_present = ks !== undefined

  // The actual halting happens in cost-governor's preflight. We don't
  // simulate billing here (that would require an injection point); instead
  // we report the state and what would happen if we WERE over-cap.
  const cap_enforced = spent < capUsd
  const recommendation = !cap_enforced
    ? 'Over cap — verify cost-governor preflight is wired into novan-chat AND that ai_request kill_switch flips on cap-cross'
    : kill_switch_present
      ? 'Under cap; kill-switch infrastructure present.'
      : 'Under cap; consider provisioning an ai_request kill_switch for hard-stop on emergencies.'

  return {
    cap_usd: capUsd,
    spent_usd: Number(spent.toFixed(4)),
    remaining_usd: Number((capUsd - spent).toFixed(4)),
    cap_enforced,
    kill_switch_present,
    test_scenario: 'state-only inspection — no simulated billing',
    recommendation,
  }
}

// ─── #6 clarify auto-resolve ─────────────────────────────────────────────
/** Look for the most recent unresolved clarify_event for this workspace.
 *  If found, mark it resolved with the operator's current message. Returns
 *  the resolved row id (or null if nothing pending). */
export async function autoResolveClarify(workspaceId: string, conversationId: string | null, userMessage: string): Promise<string | null> {
  // Only resolve if the operator's message is substantive (>3 chars) and
  // arrived within 10 min of the question (otherwise the operator likely
  // moved on).
  if (userMessage.trim().length < 4) return null
  const cutoff = Date.now() - 10 * 60_000
  const [row] = await db.select({ id: clarifyEvents.id, createdAt: clarifyEvents.createdAt })
    .from(clarifyEvents)
    .where(and(
      eq(clarifyEvents.workspaceId, workspaceId),
      eq(clarifyEvents.resolved, false),
      gte(clarifyEvents.createdAt, cutoff),
      conversationId ? eq(clarifyEvents.conversationId, conversationId) : isNull(clarifyEvents.conversationId),
    ))
    .orderBy(desc(clarifyEvents.createdAt))
    .limit(1)
    .catch(() => [])
  if (!row) return null
  await db.update(clarifyEvents)
    .set({ resolved: true, answer: userMessage.slice(0, 4000), resolvedAt: Date.now() } as never)
    .where(eq(clarifyEvents.id, row.id))
    .catch(() => null)
  return row.id
}

// ─── #7 workflow attribution ─────────────────────────────────────────────
export async function attachWorkflowToBusiness(workflowRunId: string, businessId: string): Promise<{ ok: boolean }> {
  const [wf] = await db.select({ metadata: workflowRuns.metadata })
    .from(workflowRuns)
    .where(eq(workflowRuns.id, workflowRunId))
    .limit(1).catch(() => [])
  if (!wf) return { ok: false }
  const meta = { ...(wf.metadata as Record<string, unknown> ?? {}), businessId }
  await db.update(workflowRuns)
    .set({ metadata: meta })
    .where(eq(workflowRuns.id, workflowRunId))
    .catch(() => null)
  return { ok: true }
}

// ─── #9 export all ───────────────────────────────────────────────────────
export interface ExportBundle {
  workspaceId:  string
  generatedAt:  number
  workspaceMemory: unknown[]
  relationships:   unknown[]
  businesses:      unknown[]
  earnings:        unknown[]
  setupProgress:   unknown
  clarifyEvents:   unknown[]
  recentEvents:    unknown[]
}

export async function exportAll(workspaceId: string): Promise<ExportBundle> {
  const since = Date.now() - 30 * 86400_000
  const [mem, rels, biz, earn, clar, evts] = await Promise.all([
    db.select().from(workspaceMemory).where(eq(workspaceMemory.workspaceId, workspaceId)).catch(() => []),
    db.select().from(relationshipGraph).where(eq(relationshipGraph.workspaceId, workspaceId)).catch(() => []),
    db.select().from(businesses).where(eq(businesses.workspaceId, workspaceId)).catch(() => []),
    db.select().from(businessPortfolioEarnings).where(eq(businessPortfolioEarnings.workspaceId, workspaceId)).catch(() => []),
    db.select().from(clarifyEvents).where(eq(clarifyEvents.workspaceId, workspaceId)).catch(() => []),
    db.select().from(events).where(and(
      eq(events.workspaceId, workspaceId),
      gte(events.createdAt, since),
    )).orderBy(desc(events.createdAt)).limit(2000).catch(() => []),
  ])
  let setupProgress: unknown = null
  try {
    const { getSetupState } = await import('./r327-onboarding.js')
    setupProgress = await getSetupState(workspaceId)
  } catch { /* */ }
  return {
    workspaceId, generatedAt: Date.now(),
    workspaceMemory: mem, relationships: rels, businesses: biz, earnings: earn,
    setupProgress, clarifyEvents: clar, recentEvents: evts,
  }
}

// ─── #10 conversation-to-memory promotion ────────────────────────────────
const COMMITMENT_RX = /\b(due|deadline|by\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d|next))|\b(remember|please remember|don'?t forget|note that|use the|always|never use)\b/i
const FACT_RX       = /\b(my (?:name|email|address|phone|company|business) is|i (?:prefer|hate|use|don'?t use)|the (?:logo|brand|color|tone) is)\b/i

export async function promoteIfImportant(workspaceId: string, userMessage: string): Promise<{ promoted: boolean; key?: string }> {
  if (!COMMITMENT_RX.test(userMessage) && !FACT_RX.test(userMessage)) return { promoted: false }
  const key = `_chatPromoted.${uuidv7().slice(0, 12)}`
  const now = Date.now()
  await db.insert(workspaceMemory).values({
    workspaceId, key,
    value: userMessage.slice(0, 1000),
    scope: 'operator', importance: 80,  // high — auto-promoted from chat
    updatedAt: now,
  } as never).onConflictDoNothing().catch(() => null)
  return { promoted: true, key }
}

// ─── #15 browser approval scope per path ─────────────────────────────────
/** Build an approval key bound to (domain, path-prefix) so approving
 *  google.com/search doesn't authorize google.com/admin. */
export function browserApprovalKey(url: string, depth = 1): string {
  try {
    const u = new URL(url)
    const segs = u.pathname.split('/').filter(Boolean).slice(0, depth)
    const prefix = segs.length > 0 ? '/' + segs.join('/') : '/'
    return `APPROVE:${u.hostname}${prefix}`
  } catch {
    return `APPROVE:invalid`
  }
}

/** Sign the approval key with AUTH_SECRET so it can't be forged. */
export function signBrowserApproval(key: string): string {
  const secret = process.env['AUTH_SECRET'] ?? ''
  return key + ':' + createHmac('sha256', secret).update(key).digest('hex').slice(0, 16)
}

/** Verify a token against a URL — returns the approval scope or null. */
export function verifyBrowserApproval(token: string, url: string): string | null {
  const parts = token.split(':')
  if (parts.length < 3) return null
  const sig = parts.pop()!
  const key = parts.join(':')
  const expected = signBrowserApproval(key).split(':').pop()
  if (sig !== expected) return null
  // Match url against key
  try {
    const u = new URL(url)
    const keyParts = key.split(':')
    if (keyParts[0] !== 'APPROVE') return null
    const scope = keyParts[1] ?? ''
    const [host, ...pathSegs] = scope.split('/')
    if (u.hostname !== host) return null
    const requiredPath = '/' + pathSegs.join('/')
    if (!u.pathname.startsWith(requiredPath)) return null
    return scope
  } catch { return null }
}

void sql  // anchor
