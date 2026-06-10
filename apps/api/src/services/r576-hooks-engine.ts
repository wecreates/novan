/**
 * R576 — Operator-defined hooks on brain ops.
 *
 * Claude Code lets users intercept tool calls via settings.json hooks
 * (pre/post). Novan equivalent: operator can register `pre` or `post` hooks
 * against op-name patterns. A pre-hook can BLOCK execution (operator says
 * "never run R401 between 10pm-7am"); a post-hook can ALERT (operator wants
 * Slack ping every time R443 kill_switch is flipped).
 *
 * Schema:
 *   operator_hooks(id, workspace_id, op_pattern, when (pre|post),
 *                  action (block|log|alert|require_approval),
 *                  match_condition (jsonb), config (jsonb), enabled, created_at)
 *
 * Pattern matching: simple glob — 'R401.*' or 'finance.*' or '*' for all.
 *
 * Eval flow (caller wires in via runHooks() around handler):
 *   1. Brain-task starts op X
 *   2. runHooks(workspaceId, 'pre', opName, params) → if blocked, throw
 *   3. Handler runs
 *   4. runHooks(workspaceId, 'post', opName, { result, durationMs })
 *
 * Built-in hook actions:
 *   - block:               throws CronSkip-like exception
 *   - require_approval:    throws unless params.approvalToken='OPERATOR_APPROVED'
 *   - log:                 emits an event so operator can replay
 *   - alert:               emits + broadcastPush + (future) Slack webhook
 */
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS operator_hooks (
      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL,
      op_pattern      TEXT NOT NULL,
      when_kind       TEXT NOT NULL,                  -- 'pre' | 'post'
      action          TEXT NOT NULL,                  -- 'block'|'log'|'alert'|'require_approval'
      match_condition JSONB DEFAULT '{}'::jsonb,      -- e.g. { time_window: '22:00-07:00', tz: 'America/Chicago' }
      config          JSONB DEFAULT '{}'::jsonb,      -- alert config (push title, slack url, etc)
      enabled         BOOLEAN NOT NULL DEFAULT true,
      created_at      BIGINT NOT NULL,
      updated_at      BIGINT NOT NULL,
      hits            INT NOT NULL DEFAULT 0
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS operator_hooks_ws_when_idx ON operator_hooks (workspace_id, when_kind, enabled)`).catch(() => {})
}

export interface OperatorHook {
  id:              string
  workspaceId:     string
  opPattern:       string
  whenKind:        'pre' | 'post'
  action:          'block' | 'log' | 'alert' | 'require_approval'
  matchCondition:  Record<string, unknown>
  config:          Record<string, unknown>
  enabled:         boolean
  createdAt:       number
  updatedAt:       number
  hits:            number
}

function patternMatches(pattern: string, opName: string): boolean {
  if (pattern === '*' || pattern === opName) return true
  if (!pattern.includes('*')) return false
  // Convert glob to regex
  const re = '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
  return new RegExp(re).test(opName)
}

function withinTimeWindow(_window: string, _tz: string): boolean {
  // Format: 'HH:MM-HH:MM' (wraps midnight if start > end)
  try {
    const [start, end] = _window.split('-')
    if (!start || !end) return true
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: _tz, hour: 'numeric', hour12: false }).format(new Date()))
    const minute = Number(new Intl.DateTimeFormat('en-US', { timeZone: _tz, minute: 'numeric' }).format(new Date()))
    const now = hour * 60 + minute
    const [sh, sm] = start.split(':').map(Number); const sMin = (sh ?? 0) * 60 + (sm ?? 0)
    const [eh, em] = end.split(':').map(Number);   const eMin = (eh ?? 0) * 60 + (em ?? 0)
    if (sMin <= eMin) return now >= sMin && now <= eMin
    return now >= sMin || now <= eMin   // wraps midnight
  } catch { return false }
}

export class HookBlockedError extends Error {
  constructor(public hookId: string, public reason: string) { super(`hook ${hookId} blocked op: ${reason}`); this.name = 'HookBlockedError' }
}

export interface HookContext {
  workspaceId:    string
  opName:         string
  params?:        Record<string, unknown>
  result?:        unknown
  durationMs?:    number
  approvalToken?: string
}

/** Run matching hooks. Throws HookBlockedError if any blocks. */
export async function runHooks(whenKind: 'pre' | 'post', ctx: HookContext): Promise<void> {
  await ensureTable()
  let hooks: OperatorHook[] = []
  try {
    const r = await db.execute(sql`
      SELECT id, workspace_id, op_pattern, when_kind, action,
             match_condition, config, enabled, created_at, updated_at, hits
      FROM operator_hooks
      WHERE workspace_id = ${ctx.workspaceId} AND when_kind = ${whenKind} AND enabled = true
    `)
    hooks = (r as unknown as Array<{
      id: string; workspace_id: string; op_pattern: string; when_kind: 'pre' | 'post';
      action: 'block' | 'log' | 'alert' | 'require_approval';
      match_condition: Record<string, unknown>; config: Record<string, unknown>;
      enabled: boolean; created_at: number; updated_at: number; hits: number;
    }>).map(x => ({
      id: x.id, workspaceId: x.workspace_id, opPattern: x.op_pattern, whenKind: x.when_kind,
      action: x.action, matchCondition: x.match_condition ?? {}, config: x.config ?? {},
      enabled: x.enabled, createdAt: Number(x.created_at), updatedAt: Number(x.updated_at), hits: Number(x.hits),
    }))
  } catch { return }
  for (const h of hooks) {
    if (!patternMatches(h.opPattern, ctx.opName)) continue
    // Time-window match condition
    const mc = h.matchCondition
    if (mc['time_window'] && mc['tz']) {
      if (!withinTimeWindow(String(mc['time_window']), String(mc['tz']))) continue
    }
    // Hit! Apply action
    try { await db.execute(sql`UPDATE operator_hooks SET hits = hits + 1 WHERE id = ${h.id}`).catch(() => {/* tolerated */}) } catch { /* tolerated */ }
    if (h.action === 'block') {
      throw new HookBlockedError(h.id, `pre-hook on ${h.opPattern} blocked ${ctx.opName}`)
    }
    if (h.action === 'require_approval' && ctx.approvalToken !== 'OPERATOR_APPROVED') {
      throw new HookBlockedError(h.id, `pre-hook on ${h.opPattern} requires approvalToken='OPERATOR_APPROVED' for ${ctx.opName}`)
    }
    if (h.action === 'log' || h.action === 'alert') {
      try {
        await db.execute(sql`
          INSERT INTO events (id, type, workspace_id, payload, trace_id, correlation_id, source, version, created_at)
          VALUES (${uuidv7()}, 'hook.fired', ${ctx.workspaceId},
            ${JSON.stringify({ hookId: h.id, opName: ctx.opName, whenKind, action: h.action, pattern: h.opPattern, durationMs: ctx.durationMs })}::jsonb,
            ${uuidv7()}, ${uuidv7()}, 'r576-hooks-engine', 1, ${Date.now()})
        `).catch(() => {/* tolerated */})
      } catch { /* tolerated */ }
      if (h.action === 'alert') {
        try {
          const { broadcastPush } = await import('./web-push.js')
          const title = String(h.config['title'] ?? `Hook fired: ${ctx.opName}`)
          const body  = String(h.config['body']  ?? `Hook ${h.id} matched ${ctx.opName}`)
          void broadcastPush(ctx.workspaceId, { title, body, url: '/ops/dashboard', tag: `hook-${h.id}` } as Parameters<typeof broadcastPush>[1])
        } catch { /* tolerated */ }
      }
    }
  }
}

export async function createHook(workspaceId: string, input: { opPattern: string; whenKind: 'pre' | 'post'; action: OperatorHook['action']; matchCondition?: Record<string, unknown>; config?: Record<string, unknown> }): Promise<OperatorHook | null> {
  await ensureTable()
  const id = uuidv7()
  const now = Date.now()
  try {
    await db.execute(sql`
      INSERT INTO operator_hooks (id, workspace_id, op_pattern, when_kind, action, match_condition, config, enabled, created_at, updated_at)
      VALUES (${id}, ${workspaceId}, ${input.opPattern}, ${input.whenKind}, ${input.action},
              ${JSON.stringify(input.matchCondition ?? {})}::jsonb,
              ${JSON.stringify(input.config ?? {})}::jsonb,
              true, ${now}, ${now})
    `)
    return {
      id, workspaceId, opPattern: input.opPattern, whenKind: input.whenKind, action: input.action,
      matchCondition: input.matchCondition ?? {}, config: input.config ?? {},
      enabled: true, createdAt: now, updatedAt: now, hits: 0,
    }
  } catch { return null }
}

export async function listHooks(workspaceId: string): Promise<OperatorHook[]> {
  await ensureTable()
  try {
    const r = await db.execute(sql`
      SELECT id, workspace_id, op_pattern, when_kind, action, match_condition, config, enabled, created_at, updated_at, hits
      FROM operator_hooks WHERE workspace_id = ${workspaceId}
      ORDER BY created_at DESC
    `)
    return (r as unknown as Array<{
      id: string; workspace_id: string; op_pattern: string; when_kind: 'pre' | 'post';
      action: 'block' | 'log' | 'alert' | 'require_approval';
      match_condition: Record<string, unknown>; config: Record<string, unknown>;
      enabled: boolean; created_at: number; updated_at: number; hits: number;
    }>).map(x => ({
      id: x.id, workspaceId: x.workspace_id, opPattern: x.op_pattern, whenKind: x.when_kind,
      action: x.action, matchCondition: x.match_condition ?? {}, config: x.config ?? {},
      enabled: x.enabled, createdAt: Number(x.created_at), updatedAt: Number(x.updated_at), hits: Number(x.hits),
    }))
  } catch { return [] }
}

export async function setHookEnabled(workspaceId: string, hookId: string, enabled: boolean): Promise<{ ok: boolean }> {
  await ensureTable()
  try {
    await db.execute(sql`UPDATE operator_hooks SET enabled = ${enabled}, updated_at = ${Date.now()} WHERE id = ${hookId} AND workspace_id = ${workspaceId}`)
    return { ok: true }
  } catch { return { ok: false } }
}

export async function deleteHook(workspaceId: string, hookId: string): Promise<{ ok: boolean }> {
  await ensureTable()
  try {
    await db.execute(sql`DELETE FROM operator_hooks WHERE id = ${hookId} AND workspace_id = ${workspaceId}`)
    return { ok: true }
  } catch { return { ok: false } }
}
