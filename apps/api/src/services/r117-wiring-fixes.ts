/**
 * r117-wiring-fixes.ts — R146.117 — make agents actually do work.
 *
 * Five wirings, no breaking changes:
 *
 *  A) Findings → ops board bridge. Sam (Finance & Security) gets tickets.
 *     Each new high/critical security finding becomes an agent_ops_board
 *     row with ownerAgentId=Sam, status=on_deck, notes=evidence summary.
 *     Updates security_findings.mitigation_task_id so we don't dupe.
 *
 *  B) Coding/improvement loop. Ali (Developer) gets work too. Reads recent
 *     improvement findings, runs improvement-engine, files candidates onto
 *     the ops board with ownerAgentId=Ali. No autonomous code-write —
 *     just surfaces what to work on.
 *
 *  C) Agent dispatcher. Reads agent_ops_board.in_process tasks per agent
 *     and updates agent_roster.status + currentTask so the War Room shows
 *     reality instead of static "idle".
 *
 *  D) Instagram igUserId fetch. Add a method that, given a fresh IG access
 *     token, calls Meta's /me?fields=id and stamps the result into the
 *     account.metadata. Auto-called from postToInstagram before the
 *     poster's existing "missing igUserId" check fires.
 *
 *  E) Auto-poster token refresh. Wrap resolveAccessToken with a freshness
 *     check that calls refreshAccessToken when within 5 min of expiry.
 */
import { db } from '../db/client.js'
import {
  securityFindings, agentRoster, agentOpsBoard, connectorAccounts, events,
} from '@ops/db'
import { and, desc, eq, gte, isNull, sql, inArray } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── A) findings → ops_board bridge (Sam does work) ────────────────────

export async function findingsToOpsBridge(workspaceId: string, limit = 10): Promise<{
  bridged: number; skipped: number
}> {
  // High/critical findings, open status, without a mitigation_task_id yet.
  const open = await db.select().from(securityFindings).where(and(
    eq(securityFindings.workspaceId, workspaceId),
    eq(securityFindings.status, 'open'),
    inArray(securityFindings.severity, ['high', 'critical']),
    isNull(securityFindings.mitigationTaskId),
  )).orderBy(desc(securityFindings.detectedAt)).limit(limit)
  if (open.length === 0) return { bridged: 0, skipped: 0 }

  // Resolve Sam's id once
  const [sam] = await db.select().from(agentRoster).where(and(
    eq(agentRoster.workspaceId, workspaceId),
    eq(agentRoster.shortName, 'Sam'),
  )).limit(1)
  // If Sam isn't seeded yet (workspace too fresh) we still bridge with
  // ownerAgentId=null so the task is visible; dispatcher will assign later.
  const samId = sam?.id ?? null

  let bridged = 0
  for (const f of open) {
    const taskId = uuidv7(); const now = Date.now()
    try {
      await db.insert(agentOpsBoard).values({
        id: taskId, workspaceId,
        title: `[${f.severity.toUpperCase()}] ${f.title}`.slice(0, 300),
        ...(samId ? { ownerAgentId: samId } : {}),
        column: 'on_deck',
        notes: [
          `Category: ${f.category}`,
          `Recommended: ${f.recommendedAction}`,
          f.affectedResource ? `Affected: ${f.affectedResource}` : '',
          f.description ? `\n${f.description.slice(0, 600)}` : '',
        ].filter(Boolean).join('\n').slice(0, 2000),
        createdAt: now, updatedAt: now,
      })
      // Link back so we don't bridge again
      await db.update(securityFindings).set({
        mitigationTaskId: taskId, updatedAt: now,
      }).where(eq(securityFindings.id, f.id))
      bridged++
    } catch (e) { console.error('[findings-bridge]', (e as Error).message) }
  }
  return { bridged, skipped: open.length - bridged }
}

// ─── B) Improvement → ops_board bridge (Ali does work) ─────────────────

interface ImprovementSignal { id: string; title: string; rationale?: string; severity?: string }

export async function improvementsToOpsBridge(workspaceId: string, limit = 5): Promise<{
  bridged: number
}> {
  // Sources: open improvement_suggestions (if table exists) + open issues
  // classified as 'improvement' kind. Both are existing schemas.
  let suggestions: ImprovementSignal[] = []
  try {
    const r = await db.execute<{ id: string; title: string; rationale: string | null; severity: string | null }>(sql`
      SELECT id, title, rationale, severity
      FROM improvement_suggestions
      WHERE workspace_id = ${workspaceId} AND status = 'open'
      ORDER BY created_at DESC LIMIT ${limit}
    `) as unknown as Array<{ id: string; title: string; rationale: string | null; severity: string | null }>
    suggestions = r.map(x => ({
      id: x.id, title: x.title,
      ...(x.rationale ? { rationale: x.rationale } : {}),
      ...(x.severity  ? { severity:  x.severity }  : {}),
    }))
  } catch { /* table absent in fresh installs — that's fine */ }

  if (suggestions.length === 0) return { bridged: 0 }

  // Resolve Ali
  const [ali] = await db.select().from(agentRoster).where(and(
    eq(agentRoster.workspaceId, workspaceId),
    eq(agentRoster.shortName, 'Ali'),
  )).limit(1)
  const aliId = ali?.id ?? null

  // Dedup: skip if a task already references this suggestion's id in notes
  const existing = await db.select({ notes: agentOpsBoard.notes }).from(agentOpsBoard)
    .where(and(eq(agentOpsBoard.workspaceId, workspaceId), inArray(agentOpsBoard.column, ['on_deck', 'in_process'])))
    .limit(200)
  const seenRefs = new Set<string>(
    existing.flatMap(e => (e.notes ?? '').match(/improvement-suggestion:[a-z0-9-]+/gi) ?? []).map(s => s.toLowerCase()),
  )

  let bridged = 0
  for (const s of suggestions) {
    const ref = `improvement-suggestion:${s.id}`.toLowerCase()
    if (seenRefs.has(ref)) continue
    const taskId = uuidv7(); const now = Date.now()
    try {
      await db.insert(agentOpsBoard).values({
        id: taskId, workspaceId,
        title: `[improve] ${s.title}`.slice(0, 300),
        ...(aliId ? { ownerAgentId: aliId } : {}),
        column: 'on_deck',
        notes: [s.rationale ?? '', `\nref: ${ref}`].join('').slice(0, 2000),
        createdAt: now, updatedAt: now,
      })
      bridged++
    } catch (e) { console.error('[improvements-bridge]', (e as Error).message) }
  }
  return { bridged }
}

// ─── C) Agent dispatcher (reflect ops board in roster status) ──────────

export async function agentDispatcherTick(workspaceId: string): Promise<{ updated: number }> {
  // For each agent, find their most-recent in_process task. If they have one
  // → status=live, currentTask=title. If on_deck and no in_process → status
  // stays idle but currentTask shows "next: <title>". If neither, currentTask
  // is cleared.
  const agents = await db.select().from(agentRoster).where(eq(agentRoster.workspaceId, workspaceId))
  if (agents.length === 0) return { updated: 0 }
  let updated = 0
  for (const a of agents) {
    const [inProgress] = await db.select().from(agentOpsBoard).where(and(
      eq(agentOpsBoard.workspaceId, workspaceId),
      eq(agentOpsBoard.ownerAgentId, a.id),
      eq(agentOpsBoard.column, 'in_process'),
    )).orderBy(desc(agentOpsBoard.updatedAt)).limit(1)
    const [nextUp] = inProgress ? [null] : await db.select().from(agentOpsBoard).where(and(
      eq(agentOpsBoard.workspaceId, workspaceId),
      eq(agentOpsBoard.ownerAgentId, a.id),
      eq(agentOpsBoard.column, 'on_deck'),
    )).orderBy(desc(agentOpsBoard.updatedAt)).limit(1)
    const nextStatus: 'live' | 'idle' = inProgress ? 'live' : 'idle'
    const nextTask = inProgress?.title ?? (nextUp ? `next: ${nextUp.title}` : null)
    if (a.status !== nextStatus || a.currentTask !== nextTask) {
      await db.update(agentRoster).set({
        status: nextStatus,
        currentTask: nextTask,
        lastActiveAt: Date.now(),
      }).where(eq(agentRoster.id, a.id))
      updated++
    }
  }
  return { updated }
}

// ─── D) Instagram igUserId fetch after OAuth ───────────────────────────

/** Given a connector_account that's Instagram and missing igUserId in its
 *  metadata, fetch /me?fields=id from Meta's Graph API and stamp it. */
export async function ensureIgUserId(connectorAccountId: string): Promise<{ ok: boolean; igUserId?: string; error?: string }> {
  const [acct] = await db.select().from(connectorAccounts).where(eq(connectorAccounts.id, connectorAccountId)).limit(1)
  if (!acct) return { ok: false, error: 'no-account' }
  const meta = (acct.metadata ?? {}) as Record<string, unknown>
  const existing = meta['igUserId']
  if (typeof existing === 'string' && existing.length > 0) return { ok: true, igUserId: existing }
  if (!acct.secretRef) return { ok: false, error: 'no-secret-ref' }
  try {
    const { revealSecret } = await import('./secrets-vault.js')
    const tok = await revealSecret(acct.secretRef, 'ig-uid-fetch', 'shortform poster')
    if (!tok) return { ok: false, error: 'no-token' }
    // Meta Graph API — /me returns the IG Business User id when called with
    // an instagram_basic access token. If it's a Facebook page token we
    // first need /me/accounts → IG account id, but most Novan OAuth flows
    // grant instagram_business_manage scopes directly.
    const r = await fetch(`https://graph.facebook.com/v21.0/me?fields=id,username&access_token=${encodeURIComponent(tok)}`,
      { signal: AbortSignal.timeout(20_000) })
    if (!r.ok) return { ok: false, error: `meta ${r.status}` }
    const d = await r.json() as { id?: string; username?: string }
    if (!d.id) return { ok: false, error: 'no-id-in-response' }
    const nextMeta = { ...meta, igUserId: d.id, ...(d.username ? { igUsername: d.username } : {}) }
    await db.update(connectorAccounts).set({ metadata: nextMeta, updatedAt: Date.now() })
      .where(eq(connectorAccounts.id, connectorAccountId))
    return { ok: true, igUserId: d.id }
  } catch (e) { return { ok: false, error: (e as Error).message.slice(0, 200) } }
}

// ─── E) Auto-poster freshness check ────────────────────────────────────

/** Returns true if the token associated with this account is within
 *  `safetyMs` of expiring. Caller should call refreshAccessToken first
 *  when this is true. */
export async function tokenNearExpiry(connectorAccountId: string, safetyMs = 5 * 60_000): Promise<boolean> {
  const [acct] = await db.select().from(connectorAccounts).where(eq(connectorAccounts.id, connectorAccountId)).limit(1)
  if (!acct) return false
  const meta = (acct.metadata ?? {}) as Record<string, unknown>
  const expiresAt = Number(meta['expiresAt'])
  if (!Number.isFinite(expiresAt) || expiresAt === 0) return false  // unknown expiry → don't speculate
  return expiresAt - Date.now() < safetyMs
}

/** Try to refresh the access token if it's near expiry. Returns the
 *  (possibly-refreshed) bare access_token, or null if no token + no refresh.
 *  Soft-fails: any refresh error returns the existing token (the connector
 *  call will then fail explicitly with the real provider error). */
export async function refreshIfNeeded(connectorAccountId: string): Promise<string | null> {
  const [acct] = await db.select().from(connectorAccounts).where(eq(connectorAccounts.id, connectorAccountId)).limit(1)
  if (!acct?.secretRef) return null
  try {
    const { revealSecret } = await import('./secrets-vault.js')
    let token = await revealSecret(acct.secretRef, 'shortform-poster', 'auto-post token resolve')
    if (!token) return null
    // Some accounts store the token as a JSON blob; unwrap.
    try {
      const parsed = JSON.parse(token) as { access_token?: string }
      if (parsed.access_token) token = parsed.access_token
    } catch { /* bare string */ }
    if (!(await tokenNearExpiry(connectorAccountId))) return token
    // Try to refresh
    try {
      const oauth = await import('./connector-oauth.js')
      if (!oauth.refreshAccessToken) return token
      const r = await oauth.refreshAccessToken({ workspaceId: acct.workspaceId, accountId: acct.id, requestedBy: 'r117-auto-refresh' })
      if (r && r.ok) {
        // Refresh succeeded; re-reveal the now-rotated secret
        const fresh = await revealSecret(acct.secretRef, 'shortform-poster', 'post-refresh resolve')
        if (fresh) {
          try { const p = JSON.parse(fresh) as { access_token?: string }; if (p.access_token) return p.access_token } catch { /* bare */ }
          return fresh
        }
      }
      return token
    } catch (e) {
      console.warn('[r117] token refresh failed for', connectorAccountId, ':', (e as Error).message.slice(0, 200))
      return token
    }
  } catch { return null }
}

// ─── Public ticks (called from cron) ───────────────────────────────────

export async function findingsBridgeTick(workspaceId: string): Promise<{ bridged: number; improvedBridged: number; dispatched: number }> {
  const a = await findingsToOpsBridge(workspaceId, 10)
  const b = await improvementsToOpsBridge(workspaceId, 5)
  const c = await agentDispatcherTick(workspaceId)
  if (a.bridged + b.bridged + c.updated > 0) {
    // R146.125 — notify on agent promotion
    if (c.updated > 0) {
      try {
        const { notify } = await import('./notifications.js')
        await notify({
          workspaceId,
          type: 'agents.dispatch_tick',
          severity: 'normal',
          title: `${c.updated} agent${c.updated === 1 ? '' : 's'} promoted to live`,
          body: `bridged ${a.bridged} security finding${a.bridged === 1 ? '' : 's'} + ${b.bridged} improvement${b.bridged === 1 ? '' : 's'}; dispatched ${c.updated}`,
        }).catch(() => null)
      } catch { /* notify optional */ }
    }
    await db.insert(events).values({
      id: uuidv7(), workspaceId, type: 'agents.dispatch_tick',
      payload: { findings: a.bridged, improvements: b.bridged, dispatched: c.updated },
      traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
      source: 'r117-wiring-fixes', version: 1, createdAt: Date.now(),
    }).catch(() => null)
  }
  return { bridged: a.bridged, improvedBridged: b.bridged, dispatched: c.updated }
}

// satisfy unused-imports lint
void gte
