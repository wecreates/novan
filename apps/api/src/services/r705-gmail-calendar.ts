/**
 * R705 — Gmail + Calendar tools (use the R705 OAuth token).
 *
 * gmail.search / gmail.read / gmail.send / gmail.labels
 * calendar.upcoming / calendar.create_event / calendar.search
 *
 * All take workspaceId implicitly via the brain dispatcher; they call
 * getAccessToken() which auto-refreshes. Sending email is an
 * explicit-permission action — the agent must be handed gmail.send.
 */
import { getAccessToken } from './r705-google-oauth.js'

async function gapi(workspaceId: string, url: string, init?: RequestInit): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const t = await getAccessToken(workspaceId)
  if (!t.ok || !t.token) return { ok: false, error: t.error ?? 'no token' }
  try {
    const res = await fetch(url, { ...init, headers: { ...(init?.headers ?? {}), 'Authorization': `Bearer ${t.token}` } })
    if (!res.ok) return { ok: false, error: `google ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}` }
    const ct = res.headers.get('content-type') ?? ''
    return { ok: true, data: ct.includes('json') ? await res.json() : await res.text() }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

// ─── Gmail ──────────────────────────────────────────────────────────────

export async function gmailSearch(workspaceId: string, query: string, limit = 10): Promise<{ ok: boolean; messages?: Array<{ id: string; subject: string; from: string; snippet: string; date: string }>; error?: string }> {
  const list = await gapi(workspaceId, `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${Math.min(25, limit)}`)
  if (!list.ok) return { ok: false, error: list.error }
  const ids = ((list.data as { messages?: Array<{ id: string }> })?.messages ?? []).map(m => m.id)
  const messages = await Promise.all(ids.slice(0, limit).map(async (id) => {
    const m = await gapi(workspaceId, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`)
    const d = m.data as { snippet?: string; payload?: { headers?: Array<{ name: string; value: string }> } } | undefined
    const h = (n: string) => d?.payload?.headers?.find(x => x.name === n)?.value ?? ''
    return { id, subject: h('Subject'), from: h('From'), snippet: d?.snippet ?? '', date: h('Date') }
  }))
  return { ok: true, messages }
}

export async function gmailRead(workspaceId: string, messageId: string): Promise<{ ok: boolean; subject?: string; from?: string; date?: string; body?: string; error?: string }> {
  const m = await gapi(workspaceId, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`)
  if (!m.ok) return { ok: false, error: m.error }
  const d = m.data as { snippet?: string; payload?: { headers?: Array<{ name: string; value: string }>; parts?: Array<{ mimeType: string; body?: { data?: string } }>; body?: { data?: string } } }
  const h = (n: string) => d.payload?.headers?.find(x => x.name === n)?.value ?? ''
  // Extract plain-text body
  let body = ''
  const decode = (data?: string) => data ? Buffer.from(data, 'base64url').toString('utf8') : ''
  if (d.payload?.body?.data) body = decode(d.payload.body.data)
  else {
    const txtPart = d.payload?.parts?.find(p => p.mimeType === 'text/plain')
    body = decode(txtPart?.body?.data) || d.snippet || ''
  }
  return { ok: true, subject: h('Subject'), from: h('From'), date: h('Date'), body: body.slice(0, 8000) }
}

export async function gmailSend(workspaceId: string, to: string, subject: string, body: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  const raw = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n')
  const encoded = Buffer.from(raw).toString('base64url')
  const r = await gapi(workspaceId, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ raw: encoded }),
  })
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, id: (r.data as { id?: string })?.id }
}

// ─── Calendar ───────────────────────────────────────────────────────────

export async function calendarUpcoming(workspaceId: string, maxResults = 10): Promise<{ ok: boolean; events?: Array<{ id: string; summary: string; start: string; end: string; location?: string }>; error?: string }> {
  const now = new Date().toISOString()
  const r = await gapi(workspaceId, `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(now)}&maxResults=${Math.min(50, maxResults)}&singleEvents=true&orderBy=startTime`)
  if (!r.ok) return { ok: false, error: r.error }
  const items = (r.data as { items?: Array<Record<string, unknown>> })?.items ?? []
  const events = items.map(e => ({
    id: String(e['id']),
    summary: String(e['summary'] ?? '(no title)'),
    start: String((e['start'] as Record<string, string>)?.['dateTime'] ?? (e['start'] as Record<string, string>)?.['date'] ?? ''),
    end: String((e['end'] as Record<string, string>)?.['dateTime'] ?? (e['end'] as Record<string, string>)?.['date'] ?? ''),
    ...(e['location'] ? { location: String(e['location']) } : {}),
  }))
  return { ok: true, events }
}

export async function calendarCreateEvent(workspaceId: string, input: { summary: string; startISO: string; endISO: string; description?: string; location?: string }): Promise<{ ok: boolean; id?: string; htmlLink?: string; error?: string }> {
  const body: Record<string, unknown> = {
    summary: input.summary,
    start: { dateTime: input.startISO },
    end: { dateTime: input.endISO },
  }
  if (input.description) body['description'] = input.description
  if (input.location) body['location'] = input.location
  const r = await gapi(workspaceId, 'https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) return { ok: false, error: r.error }
  const d = r.data as { id?: string; htmlLink?: string }
  return { ok: true, id: d?.id, htmlLink: d?.htmlLink }
}
