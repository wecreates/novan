/**
 * connector-slack.ts — real Slack handlers via Web API.
 *
 * Auth: Bot token (xoxb-…) stored in vault.
 * Endpoints: https://slack.com/api/{method}
 *
 * Wired:
 *   - slack.list_channels  (read)
 *   - slack.draft_message  (low risk — stored locally, never sent)
 *   - slack.post_message   (medium risk — approval gated)
 *
 * Slack quirk: every response body has { ok: bool, error?: string }
 * even on HTTP 200. We check both.
 */
import type { ConnectorHandler, DryRunFn } from './connectors.js'
import { fetchWithRetry } from './provider-retry.js'

const BASE = 'https://slack.com/api'

interface SlackResp { ok: boolean; error?: string; [k: string]: unknown }

async function call<T extends SlackResp>(token: string, method: string, body?: Record<string, unknown>): Promise<T> {
  const init: RequestInit = {
    method: body ? 'POST' : 'GET',
    headers: {
      'authorization': `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json; charset=utf-8' } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  }
  if (body) init.body = JSON.stringify(body)
  const out = await fetchWithRetry('slack', `${BASE}/${method}`, init)
  if (!out.ok) throw new Error(`Slack ${method}: ${out.status} ${out.statusText}`)
  const j = await out.response.json() as T
  if (!j.ok) {
    // Application-level error (Slack returns 200 even on permission failures).
    throw new Error(`Slack ${method}: ${j.error ?? 'unknown error'}`)
  }
  return j
}

export const listChannels: ConnectorHandler = async (ctx, params) => {
  const token = await ctx.getSecret()
  const limit = Math.min(Number(params['limit'] ?? 100), 200)
  const data = await call<SlackResp & { channels: Array<{
    id: string; name: string; is_private: boolean; is_archived: boolean;
    num_members?: number; topic?: { value: string }; purpose?: { value: string };
  }> }>(token, `conversations.list?limit=${limit}&exclude_archived=true&types=public_channel,private_channel`)
  return data.channels.map(c => ({
    id: c.id, name: c.name, isPrivate: c.is_private, archived: c.is_archived,
    members: c.num_members ?? 0,
    topic: c.topic?.value ?? '', purpose: c.purpose?.value ?? '',
  }))
}

/**
 * draft_message — does NOT call Slack. Returns the would-be payload so
 * the operator can preview without any side effect. The connector
 * action runtime logs it as completed; sending requires the operator
 * to explicitly call slack.post_message after review.
 */
export const draftMessage: ConnectorHandler = async (_ctx, params) => {
  const channel = String(params['channel'] ?? '').trim()
  const text    = String(params['text']    ?? '').trim()
  if (!channel) throw new Error('params.channel required (#name or channel id)')
  if (!text)    throw new Error('params.text required')
  return {
    channel, text, prepared: true,
    note: 'No network call performed. Call slack.post_message to send.',
  }
}

export const postMessage: ConnectorHandler = async (ctx, params) => {
  const token = await ctx.getSecret()
  const channel = String(params['channel'] ?? '').trim()
  const text    = String(params['text']    ?? '').trim()
  if (!channel) throw new Error('params.channel required')
  if (!text)    throw new Error('params.text required')
  const data = await call<SlackResp & { ts: string; channel: string }>(token, 'chat.postMessage', {
    channel, text,
  })
  return { ts: data.ts, channel: data.channel }
}

export const postMessageDryRun: DryRunFn = async (_ctx, params) => {
  const channel = String(params['channel'] ?? '?')
  const text    = String(params['text'] ?? '')
  return {
    summary: `would post to ${channel} (${text.length} chars)`,
    affected: { channel, length: text.length },
  }
}
