/**
 * R686 — Outbound notifications on agent completion.
 *
 * When a scheduled agent (R656) finishes, fire any registered handlers:
 *   - generic webhook URL (POST {goal, answer, runId, status, costUsd})
 *   - Slack/Discord (reuses R624 channel.* ops if available)
 *   - R129 VAPID push notification to subscribed devices
 *
 * Per-workspace settings stored in r686_notify_targets. Multiple targets
 * per workspace OK. Each fire is logged in r686_notify_log.
 */
import crypto from 'crypto'
import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

let ddlOk = false
async function ensureDdl(): Promise<void> {
  if (ddlOk) return
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS r686_notify_targets (
        id            TEXT PRIMARY KEY,
        workspace_id  TEXT NOT NULL,
        kind          TEXT NOT NULL,
        target        TEXT NOT NULL,
        only_on       TEXT,
        enabled       BOOLEAN NOT NULL DEFAULT true,
        fire_count    INT NOT NULL DEFAULT 0,
        last_fired_at TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch(() => {})
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS r686_notify_log (
        id           TEXT PRIMARY KEY,
        target_id    TEXT NOT NULL,
        run_id       TEXT,
        status       TEXT,
        error        TEXT,
        fired_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch(() => {})
    ddlOk = true
  } catch { /* tolerated */ }
}

export interface NotifyTargetInput {
  /** webhook | slack | discord | push */
  kind:    'webhook' | 'slack' | 'discord' | 'push'
  /** for webhook: URL. for slack/discord: webhook URL. for push: subscription id (or '*' for all) */
  target:  string
  /** Optional filter — fire only when status matches 'done' | 'capped' | 'error' (default = all) */
  onlyOn?: string
}

export async function addNotifyTarget(workspaceId: string, input: NotifyTargetInput): Promise<{ id: string }> {
  await ensureDdl()
  if (!['webhook', 'slack', 'discord', 'push'].includes(input.kind)) throw new Error('kind must be webhook|slack|discord|push')
  if (!input.target) throw new Error('target required')
  const id = `nt_${crypto.randomBytes(8).toString('hex')}`
  await db.execute(sql`
    INSERT INTO r686_notify_targets (id, workspace_id, kind, target, only_on)
    VALUES (${id}, ${workspaceId}, ${input.kind}, ${input.target}, ${input.onlyOn ?? null})
  `).catch(() => {})
  return { id }
}

export async function listNotifyTargets(workspaceId: string): Promise<Array<Record<string, unknown>>> {
  await ensureDdl()
  try {
    const rows = await db.execute(sql`
      SELECT id, kind, target, only_on, enabled, fire_count, last_fired_at, created_at
      FROM r686_notify_targets WHERE workspace_id = ${workspaceId}
      ORDER BY created_at DESC
    `)
    return (rows.rows ?? rows) as Array<Record<string, unknown>>
  } catch { return [] }
}

export async function removeNotifyTarget(workspaceId: string, id: string): Promise<{ ok: boolean }> {
  await ensureDdl()
  try {
    await db.execute(sql`DELETE FROM r686_notify_targets WHERE id = ${id} AND workspace_id = ${workspaceId}`)
    return { ok: true }
  } catch { return { ok: false } }
}

export interface NotifyContext {
  workspaceId: string
  runId:       string
  goal:        string
  answer:      string
  status:      'done' | 'capped' | 'error'
  costUsd:     number
  tokens:      number
  scheduleId?: string
}

/** Fire all matching targets for this workspace. Fire-and-forget per target. */
export async function notifyAgentCompletion(ctx: NotifyContext): Promise<{ fired: number; errors: number }> {
  await ensureDdl()
  let targets: Array<Record<string, unknown>> = []
  try {
    const rows = await db.execute(sql`
      SELECT id, kind, target, only_on
      FROM r686_notify_targets
      WHERE workspace_id = ${ctx.workspaceId} AND enabled = true
    `)
    targets = (rows.rows ?? rows) as Array<Record<string, unknown>>
  } catch { return { fired: 0, errors: 0 } }

  let fired = 0, errors = 0
  await Promise.all(targets.map(async (t) => {
    const id   = String(t['id'])
    const kind = String(t['kind'])
    const url  = String(t['target'])
    const onlyOn = t['only_on'] ? String(t['only_on']) : null
    if (onlyOn && onlyOn !== ctx.status) return
    const logId = `nl_${crypto.randomBytes(8).toString('hex')}`
    try {
      await dispatchOne(kind, url, ctx)
      fired++
      try {
        await db.execute(sql`INSERT INTO r686_notify_log (id, target_id, run_id, status) VALUES (${logId}, ${id}, ${ctx.runId}, ${'sent'})`)
        await db.execute(sql`UPDATE r686_notify_targets SET fire_count = fire_count + 1, last_fired_at = now() WHERE id = ${id}`)
      } catch { /* tolerated */ }
    } catch (e) {
      errors++
      try {
        await db.execute(sql`INSERT INTO r686_notify_log (id, target_id, run_id, status, error) VALUES (${logId}, ${id}, ${ctx.runId}, ${'error'}, ${(e as Error).message?.slice(0, 200) ?? ''})`)
      } catch { /* tolerated */ }
    }
  }))
  return { fired, errors }
}

async function dispatchOne(kind: string, target: string, ctx: NotifyContext): Promise<void> {
  if (kind === 'webhook') {
    const body = {
      runId:    ctx.runId,
      goal:     ctx.goal,
      answer:   ctx.answer,
      status:   ctx.status,
      costUsd:  ctx.costUsd,
      tokens:   ctx.tokens,
      scheduleId: ctx.scheduleId ?? null,
      workspaceId: ctx.workspaceId,
    }
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'User-Agent': 'Novan-R686' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`webhook ${res.status}`)
    return
  }
  if (kind === 'slack' || kind === 'discord') {
    // Slack-formatted text works on both Slack and Discord (Discord ignores extras)
    const emoji = ctx.status === 'done' ? '✅' : ctx.status === 'capped' ? '⚠️' : '❌'
    const text = `${emoji} *Novan agent ${ctx.status}*\n*Goal:* ${ctx.goal.slice(0, 200)}\n*Answer:* ${ctx.answer.slice(0, 800)}\n_${ctx.tokens} tokens · $${ctx.costUsd.toFixed(4)}_`
    const body = kind === 'slack' ? { text } : { content: text.slice(0, 1900) }
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`${kind} ${res.status}`)
    return
  }
  if (kind === 'push') {
    // Reuse R129 web-push infra if present.
    try {
      const mod = await import('./r129-web-push.js') as unknown as { sendPushToWorkspace?: (ws: string, payload: Record<string, unknown>) => Promise<unknown> }
      if (mod.sendPushToWorkspace) {
        await mod.sendPushToWorkspace(ctx.workspaceId, {
          title: `Novan ${ctx.status}`,
          body: ctx.answer.slice(0, 180) || ctx.goal.slice(0, 180),
          data: { runId: ctx.runId, url: '/ops/agents' },
        })
        return
      }
    } catch { /* fall through */ }
    throw new Error('R129 web-push not wired')
  }
  throw new Error(`unknown notify kind: ${kind}`)
}
