/**
 * R628 — Discord + Telegram + Slack channel adapters.
 *
 * Adds operator-daily-use notification channels for R613 digest + ad-hoc
 * alerts. All three use webhook patterns — no OAuth dance, no app review.
 *
 *   channel.discord.send  — POST to DISCORD_WEBHOOK_URL
 *   channel.telegram.send — POST to https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage
 *   channel.slack.send    — POST to SLACK_WEBHOOK_URL
 *   channel.fanout        — send same message to all configured channels
 *
 * Configure via env:
 *   DISCORD_WEBHOOK_URL  (single webhook URL)
 *   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
 *   SLACK_WEBHOOK_URL
 */
export type ChannelKind = 'discord' | 'telegram' | 'slack'

export interface SendInput {
  text:       string         // markdown
  title?:     string
  threadId?:  string
  silent?:    boolean        // suppress @mentions
}

export interface SendResult {
  channel:  ChannelKind
  ok:       boolean
  status?:  number
  error?:   string
  latencyMs: number
}

function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text]
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    let end = Math.min(i + max, text.length)
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end)
      if (nl > i + max / 2) end = nl
    }
    out.push(text.slice(i, end))
    i = end
  }
  return out
}

// ─── Discord ────────────────────────────────────────────────────────────────

export async function sendDiscord(input: SendInput): Promise<SendResult> {
  const t0 = Date.now()
  const url = process.env['DISCORD_WEBHOOK_URL']
  if (!url) return { channel: 'discord', ok: false, error: 'DISCORD_WEBHOOK_URL not set', latencyMs: 0 }
  try {
    const body = {
      content: (input.title ? `**${input.title}**\n` : '') + input.text.slice(0, 1900),
      allowed_mentions: input.silent ? { parse: [] } : undefined,
    }
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      return { channel: 'discord', ok: false, status: r.status, error: text.slice(0, 200), latencyMs: Date.now() - t0 }
    }
    return { channel: 'discord', ok: true, status: r.status, latencyMs: Date.now() - t0 }
  } catch (e) {
    return { channel: 'discord', ok: false, error: (e as Error).message, latencyMs: Date.now() - t0 }
  }
}

// ─── Telegram ───────────────────────────────────────────────────────────────

export async function sendTelegram(input: SendInput): Promise<SendResult> {
  const t0 = Date.now()
  const token = process.env['TELEGRAM_BOT_TOKEN']
  const chatId = input.threadId ?? process.env['TELEGRAM_CHAT_ID']
  if (!token)  return { channel: 'telegram', ok: false, error: 'TELEGRAM_BOT_TOKEN not set', latencyMs: 0 }
  if (!chatId) return { channel: 'telegram', ok: false, error: 'TELEGRAM_CHAT_ID not set', latencyMs: 0 }
  try {
    const text = (input.title ? `*${input.title}*\n` : '') + input.text
    // Telegram caps at 4096; chunk to be safe.
    const chunks = chunkText(text, 3900)
    for (const c of chunks) {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: c, parse_mode: 'Markdown', disable_notification: !!input.silent }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!r.ok) {
        const txt = await r.text().catch(() => '')
        return { channel: 'telegram', ok: false, status: r.status, error: txt.slice(0, 200), latencyMs: Date.now() - t0 }
      }
    }
    return { channel: 'telegram', ok: true, latencyMs: Date.now() - t0 }
  } catch (e) {
    return { channel: 'telegram', ok: false, error: (e as Error).message, latencyMs: Date.now() - t0 }
  }
}

// ─── Slack ──────────────────────────────────────────────────────────────────

export async function sendSlack(input: SendInput): Promise<SendResult> {
  const t0 = Date.now()
  const url = process.env['SLACK_WEBHOOK_URL']
  if (!url) return { channel: 'slack', ok: false, error: 'SLACK_WEBHOOK_URL not set', latencyMs: 0 }
  try {
    const body = {
      text: (input.title ? `*${input.title}*\n` : '') + input.text.slice(0, 3500),
    }
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      return { channel: 'slack', ok: false, status: r.status, error: text.slice(0, 200), latencyMs: Date.now() - t0 }
    }
    return { channel: 'slack', ok: true, status: r.status, latencyMs: Date.now() - t0 }
  } catch (e) {
    return { channel: 'slack', ok: false, error: (e as Error).message, latencyMs: Date.now() - t0 }
  }
}

// ─── Fan-out + health ──────────────────────────────────────────────────────

export async function fanout(input: SendInput): Promise<{ sent: number; results: SendResult[] }> {
  const results = await Promise.all([sendDiscord(input), sendTelegram(input), sendSlack(input)])
  return { sent: results.filter(r => r.ok).length, results }
}

export function channelsHealth(): { discord: { configured: boolean }; telegram: { configured: boolean }; slack: { configured: boolean } } {
  return {
    discord:  { configured: !!process.env['DISCORD_WEBHOOK_URL'] },
    telegram: { configured: !!process.env['TELEGRAM_BOT_TOKEN'] && !!process.env['TELEGRAM_CHAT_ID'] },
    slack:    { configured: !!process.env['SLACK_WEBHOOK_URL'] },
  }
}
