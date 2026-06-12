/**
 * R678 — Incoming webhook receiver.
 *
 * Operator registers a webhook with (slug, goal_template, tools_allowed).
 * External services POST JSON to /webhooks/incoming/<slug>?token=<secret>.
 * The payload is JSON-injected into goal_template via {{payload.xxx}}
 * placeholders, and the resulting goal fires novan.agent in the background.
 *
 * Use cases: Stripe payment event → agent runs "summarize this charge and
 * record to ledger". GitHub PR opened → "review the diff". Slack message
 * → "draft a reply".
 */
import crypto from 'crypto'
import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

let ddlOk = false
async function ensureDdl(): Promise<void> {
  if (ddlOk) return
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS r678_webhooks (
        slug          TEXT PRIMARY KEY,
        workspace_id  TEXT NOT NULL,
        secret        TEXT NOT NULL,
        goal_template TEXT NOT NULL,
        tools_allowed JSONB,
        enabled       BOOLEAN NOT NULL DEFAULT true,
        fire_count    INT NOT NULL DEFAULT 0,
        last_fired_at TIMESTAMPTZ,
        last_run_id   TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch(() => {})
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS r678_webhook_events (
        id           TEXT PRIMARY KEY,
        slug         TEXT NOT NULL,
        payload      JSONB,
        goal         TEXT,
        run_id       TEXT,
        status       TEXT,
        received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch(() => {})
    ddlOk = true
  } catch { /* tolerated */ }
}

export interface WebhookCreateInput {
  slug:           string
  goalTemplate:   string
  toolsAllowed?:  string[]
}

export interface WebhookCreateResult {
  slug:    string
  secret:  string
  url:     string
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{2,40}$/

export async function createWebhook(workspaceId: string, input: WebhookCreateInput): Promise<WebhookCreateResult> {
  await ensureDdl()
  if (!SLUG_RE.test(input.slug)) throw new Error('slug must match [a-z0-9][a-z0-9_-]{2,40}')
  if (!input.goalTemplate?.trim()) throw new Error('goalTemplate required')
  const secret = crypto.randomBytes(16).toString('hex')
  try {
    await db.execute(sql`
      INSERT INTO r678_webhooks (slug, workspace_id, secret, goal_template, tools_allowed)
      VALUES (${input.slug}, ${workspaceId}, ${secret}, ${input.goalTemplate},
              ${input.toolsAllowed ? JSON.stringify(input.toolsAllowed) : null}::jsonb)
    `)
  } catch (e) {
    if ((e as Error).message?.includes('duplicate')) throw new Error(`webhook ${input.slug} already exists`)
    throw e
  }
  return { slug: input.slug, secret, url: `/webhooks/incoming/${input.slug}?token=${secret}` }
}

export async function listWebhooks(workspaceId: string, limit = 50): Promise<Array<Record<string, unknown>>> {
  await ensureDdl()
  try {
    const rows = await db.execute(sql`
      SELECT slug, goal_template, tools_allowed, enabled, fire_count, last_fired_at, last_run_id, created_at
      FROM r678_webhooks WHERE workspace_id = ${workspaceId}
      ORDER BY created_at DESC LIMIT ${limit}
    `)
    return (rows.rows ?? rows) as Array<Record<string, unknown>>
  } catch { return [] }
}

export async function deleteWebhook(workspaceId: string, slug: string): Promise<{ ok: boolean }> {
  await ensureDdl()
  try {
    await db.execute(sql`DELETE FROM r678_webhooks WHERE slug = ${slug} AND workspace_id = ${workspaceId}`)
    return { ok: true }
  } catch { return { ok: false } }
}

/** Resolve {{payload.path.to.value}} placeholders. */
function renderTemplate(tmpl: string, payload: unknown): string {
  return tmpl.replace(/\{\{\s*payload\.([\w.]+)\s*\}\}/g, (_, path: string) => {
    const parts = path.split('.')
    let cur: unknown = payload
    for (const p of parts) {
      if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[p]
      } else { return '' }
    }
    return cur == null ? '' : String(cur).slice(0, 500)
  })
}

export async function fireWebhook(slug: string, providedSecret: string, payload: unknown): Promise<{ ok: boolean; runId?: string; error?: string }> {
  await ensureDdl()
  let row: Record<string, unknown> | undefined
  try {
    const rows = await db.execute(sql`
      SELECT workspace_id, secret, goal_template, tools_allowed, enabled
      FROM r678_webhooks WHERE slug = ${slug} LIMIT 1
    `)
    row = ((rows.rows ?? rows) as Array<Record<string, unknown>>)[0]
  } catch { /* tolerated */ }
  if (!row) return { ok: false, error: 'webhook not found' }

  // Constant-time secret compare
  const expected = String(row['secret'] ?? '')
  const a = Buffer.from(expected), b = Buffer.from(providedSecret)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: 'invalid token' }
  }
  if (row['enabled'] !== true) return { ok: false, error: 'webhook disabled' }

  const workspaceId = String(row['workspace_id'])
  const tmpl = String(row['goal_template'])
  const tools = row['tools_allowed'] as string[] | null
  const goal = renderTemplate(tmpl, payload)
  const eventId = `wbh_${crypto.randomBytes(8).toString('hex')}`

  try {
    await db.execute(sql`
      INSERT INTO r678_webhook_events (id, slug, payload, goal, status)
      VALUES (${eventId}, ${slug}, ${JSON.stringify(payload)}::jsonb, ${goal}, 'received')
    `)
  } catch { /* tolerated */ }

  // Fire the agent (background — return immediately so caller doesn't block)
  void (async () => {
    try {
      const { runAgent } = await import('./r649-agent.js')
      const result = await runAgent(workspaceId, {
        goal,
        ...(tools && Array.isArray(tools) && tools.length > 0 ? { toolsAllowed: tools } : {}),
      })
      try {
        await db.execute(sql`
          UPDATE r678_webhook_events SET run_id = ${result.runId}, status = ${result.done ? 'done' : 'capped'}
          WHERE id = ${eventId}
        `)
        await db.execute(sql`
          UPDATE r678_webhooks
          SET fire_count = fire_count + 1, last_fired_at = now(), last_run_id = ${result.runId}
          WHERE slug = ${slug}
        `)
      } catch { /* tolerated */ }
    } catch (e) {
      try {
        await db.execute(sql`UPDATE r678_webhook_events SET status = ${'error: ' + ((e as Error).message ?? '').slice(0, 200)} WHERE id = ${eventId}`)
      } catch { /* tolerated */ }
    }
  })()

  return { ok: true, runId: eventId }
}

export async function listWebhookEvents(slug: string, limit = 50): Promise<Array<Record<string, unknown>>> {
  await ensureDdl()
  try {
    const rows = await db.execute(sql`
      SELECT id, payload, goal, run_id, status, received_at
      FROM r678_webhook_events WHERE slug = ${slug}
      ORDER BY received_at DESC LIMIT ${limit}
    `)
    return (rows.rows ?? rows) as Array<Record<string, unknown>>
  } catch { return [] }
}
