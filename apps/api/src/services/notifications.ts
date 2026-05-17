/**
 * notifications.ts — Outbound notification dispatcher.
 *
 * Drivers (real HTTP calls, fail-fast when keys missing):
 *   - webhook   any URL, generic JSON body              (NOTIFY_WEBHOOK_URL)
 *   - pushover  https://pushover.net                    (PUSHOVER_TOKEN + PUSHOVER_USER)
 *   - slack     incoming webhook                        (SLACK_WEBHOOK_URL)
 *   - discord   incoming webhook                        (DISCORD_WEBHOOK_URL)
 *
 * Dispatch policy:
 *   - severity 'critical' → all configured drivers
 *   - severity 'high'     → all configured drivers
 *   - severity 'normal'   → webhook only (least noisy)
 *
 * In-process rate limit: same (workspace, type, signature) collapsed
 * within 5 min so kill_switches don't spam phones.
 * No keys configured → returns sent: [] (observable, not fake).
 */
import { db }                          from '../db/client.js'
import { events }                      from '../db/schema.js'
import { v7 as uuidv7 }                from 'uuid'

export type NotifySeverity = 'normal' | 'high' | 'critical'

export interface NotifyInput {
  workspaceId: string
  type:        string             // e.g. 'governance.auto_throttle_engaged'
  title:       string
  body:        string
  severity:    NotifySeverity
  signature?:  string             // for rate-limit dedup; defaults to title
  link?:       string             // optional deep-link
}

export interface NotifyResult {
  sent:    string[]               // drivers that succeeded
  skipped: string[]               // drivers that fired but had no key
  failed:  Array<{ driver: string; error: string }>
  rateLimited: boolean
}

const RATE_LIMIT_WINDOW_MS = 5 * 60_000
const RATE_LIMIT_MAP = new Map<string, number>()

function checkRateLimit(workspaceId: string, type: string, signature: string): boolean {
  const key = `${workspaceId}|${type}|${signature}`
  const last = RATE_LIMIT_MAP.get(key)
  if (last && Date.now() - last < RATE_LIMIT_WINDOW_MS) return true
  RATE_LIMIT_MAP.set(key, Date.now())
  return false
}

// ─── Drivers ─────────────────────────────────────────────────────────────────

async function sendWebhook(input: NotifyInput): Promise<void> {
  const url = process.env['NOTIFY_WEBHOOK_URL']
  if (!url) throw new Error('NOTIFY_WEBHOOK_URL not set')
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workspace_id: input.workspaceId,
      type:         input.type,
      severity:     input.severity,
      title:        input.title,
      body:         input.body,
      link:         input.link ?? null,
      sent_at:      new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Webhook ${res.status}`)
}

async function sendPushover(input: NotifyInput): Promise<void> {
  const token = process.env['PUSHOVER_TOKEN']
  const user  = process.env['PUSHOVER_USER']
  if (!token || !user) throw new Error('PUSHOVER_TOKEN / PUSHOVER_USER not set')
  const priority = input.severity === 'critical' ? 1 : input.severity === 'high' ? 0 : -1
  const form = new URLSearchParams({
    token, user, title: input.title.slice(0, 250),
    message: input.body.slice(0, 1024),
    priority: String(priority),
    ...(input.link ? { url: input.link } : {}),
  })
  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Pushover ${res.status}`)
}

async function sendSlack(input: NotifyInput): Promise<void> {
  const url = process.env['SLACK_WEBHOOK_URL']
  if (!url) throw new Error('SLACK_WEBHOOK_URL not set')
  const icon = input.severity === 'critical' ? ':rotating_light:' :
               input.severity === 'high'     ? ':warning:' : ':information_source:'
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: `${icon} *${input.title}*\n${input.body}${input.link ? `\n<${input.link}|Open>` : ''}`,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Slack ${res.status}`)
}

async function sendDiscord(input: NotifyInput): Promise<void> {
  const url = process.env['DISCORD_WEBHOOK_URL']
  if (!url) throw new Error('DISCORD_WEBHOOK_URL not set')
  const color = input.severity === 'critical' ? 15158332 :  // red
                input.severity === 'high'     ? 16753920 :  // orange
                                                3447003     // blue
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: input.title.slice(0, 256),
        description: input.body.slice(0, 4000),
        color,
        ...(input.link ? { url: input.link } : {}),
        timestamp: new Date().toISOString(),
      }],
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Discord ${res.status}`)
}

// ─── Public dispatcher ───────────────────────────────────────────────────────

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'notifications', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

export async function notify(input: NotifyInput): Promise<NotifyResult> {
  const sig = input.signature ?? input.title
  if (checkRateLimit(input.workspaceId, input.type, sig)) {
    return { sent: [], skipped: [], failed: [], rateLimited: true }
  }

  type Driver = { name: string; fn: () => Promise<void>; gateSeverity: NotifySeverity }
  const drivers: Driver[] = [
    { name: 'webhook',  fn: () => sendWebhook(input),  gateSeverity: 'normal'   },
    { name: 'pushover', fn: () => sendPushover(input), gateSeverity: 'high'     },
    { name: 'slack',    fn: () => sendSlack(input),    gateSeverity: 'high'     },
    { name: 'discord',  fn: () => sendDiscord(input),  gateSeverity: 'high'     },
  ]

  const order = ['normal', 'high', 'critical'] as const
  const minIdx = order.indexOf(input.severity)

  const sent: string[] = []
  const skipped: string[] = []
  const failed: Array<{ driver: string; error: string }> = []

  for (const d of drivers) {
    if (order.indexOf(d.gateSeverity) > minIdx) continue   // severity too low for this driver
    try {
      await d.fn()
      sent.push(d.name)
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('not set')) skipped.push(d.name)
      else failed.push({ driver: d.name, error: msg })
    }
  }

  await emit(input.workspaceId, 'notification.dispatched', {
    type: input.type, severity: input.severity, sent, skipped, failed: failed.length,
  })

  return { sent, skipped, failed, rateLimited: false }
}

/** Quick check: which drivers are configured? */
export function configuredDrivers(): string[] {
  const out: string[] = []
  if (process.env['NOTIFY_WEBHOOK_URL'])  out.push('webhook')
  if (process.env['PUSHOVER_TOKEN'] && process.env['PUSHOVER_USER']) out.push('pushover')
  if (process.env['SLACK_WEBHOOK_URL'])   out.push('slack')
  if (process.env['DISCORD_WEBHOOK_URL']) out.push('discord')
  return out
}
