/**
 * R643c — Twilio SMS (H4).
 *
 * Operator-gated on env: TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM.
 * Falls through to graceful error when unconfigured (same pattern as R641-Hedra).
 *
 *   sms.send       — POST a message via Twilio REST API
 *   sms.status     — fetch delivery status of a sent message
 *   sms.health     — env-config probe
 */
import { Buffer } from 'node:buffer'

interface TwilioConfig {
  accountSid: string
  authToken:  string
  from:       string
}

function cfg(): TwilioConfig | null {
  const accountSid = process.env['TWILIO_ACCOUNT_SID']
  const authToken  = process.env['TWILIO_AUTH_TOKEN']
  const from       = process.env['TWILIO_FROM']
  if (!accountSid || !authToken || !from) return null
  return { accountSid, authToken, from }
}

function basicAuth(c: TwilioConfig): string {
  return 'Basic ' + Buffer.from(`${c.accountSid}:${c.authToken}`).toString('base64')
}

export interface SendInput {
  to:           string         // E.164: +14155552671
  body:         string
  mediaUrl?:    string         // for MMS
  statusCallback?: string      // webhook URL Twilio pings on delivery
}

export interface SendResult {
  ok:        boolean
  sid?:      string
  status?:   string             // 'queued' | 'sending' | 'sent' | 'delivered' | 'failed'
  price?:    string
  errorCode?: number
  error?:    string
  durationMs: number
}

const E164 = /^\+[1-9]\d{6,14}$/

export async function send(input: SendInput): Promise<SendResult> {
  const t0 = Date.now()
  const c = cfg()
  if (!c) return { ok: false, durationMs: 0, error: 'TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM not set' }
  if (!E164.test(input.to)) return { ok: false, durationMs: 0, error: 'to must be E.164 (+15551234567)' }
  if (!input.body?.trim()) return { ok: false, durationMs: 0, error: 'body required' }
  if (input.body.length > 1600) return { ok: false, durationMs: 0, error: 'body >1600 chars; split first' }

  const form = new URLSearchParams()
  form.set('From', c.from)
  form.set('To',   input.to)
  form.set('Body', input.body)
  if (input.mediaUrl)       form.set('MediaUrl',       input.mediaUrl)
  if (input.statusCallback) form.set('StatusCallback', input.statusCallback)

  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization:  basicAuth(c),
        'content-type': 'application/x-www-form-urlencoded',
        Accept:         'application/json',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(20_000),
    })
    const j = await r.json().catch(() => ({})) as Record<string, unknown>
    if (!r.ok) {
      const fail: SendResult = {
        ok: false,
        durationMs: Date.now() - t0,
        error: typeof j['message'] === 'string' ? String(j['message']).slice(0, 300) : `twilio ${r.status}`,
      }
      if (typeof j['code'] === 'number') fail.errorCode = j['code'] as number
      return fail
    }
    const okRes: SendResult = { ok: true, durationMs: Date.now() - t0 }
    if (typeof j['sid']    === 'string') okRes.sid    = j['sid']    as string
    if (typeof j['status'] === 'string') okRes.status = j['status'] as string
    if (typeof j['price']  === 'string') okRes.price  = j['price']  as string
    return okRes
  } catch (e) {
    return { ok: false, durationMs: Date.now() - t0, error: (e as Error).message }
  }
}

export interface StatusResult {
  ok:        boolean
  sid:       string
  status?:   string
  to?:       string
  from?:     string
  errorCode?: number
  errorMessage?: string
  price?:    string
  dateSent?: string
  error?:    string
}

export async function status(input: { sid: string }): Promise<StatusResult> {
  const c = cfg()
  if (!c) return { ok: false, sid: input.sid, error: 'TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM not set' }
  if (!input.sid?.startsWith('SM') && !input.sid?.startsWith('MM')) return { ok: false, sid: input.sid, error: 'sid must start with SM or MM' }
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}/Messages/${encodeURIComponent(input.sid)}.json`, {
      headers: { Authorization: basicAuth(c), Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    const j = await r.json().catch(() => ({})) as Record<string, unknown>
    if (!r.ok) return { ok: false, sid: input.sid, error: typeof j['message'] === 'string' ? String(j['message']).slice(0, 300) : `twilio ${r.status}` }
    const out: StatusResult = { ok: true, sid: input.sid }
    if (typeof j['status']        === 'string') out.status       = j['status']        as string
    if (typeof j['to']            === 'string') out.to           = j['to']            as string
    if (typeof j['from']          === 'string') out.from         = j['from']          as string
    if (typeof j['error_code']    === 'number') out.errorCode    = j['error_code']    as number
    if (typeof j['error_message'] === 'string') out.errorMessage = j['error_message'] as string
    if (typeof j['price']         === 'string') out.price        = j['price']         as string
    if (typeof j['date_sent']     === 'string') out.dateSent     = j['date_sent']     as string
    return out
  } catch (e) {
    return { ok: false, sid: input.sid, error: (e as Error).message }
  }
}

export function smsHealth(): { configured: boolean; from: string | null } {
  const c = cfg()
  return { configured: !!c, from: c?.from ?? null }
}
