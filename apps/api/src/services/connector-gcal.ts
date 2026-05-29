/**
 * connector-gcal.ts — real Google Calendar handlers via REST v3.
 *
 * Auth: OAuth access token. Stored in vault; expired tokens surface
 * a 401 the operator handles by reconnecting (the OAuth substrate
 * supports refresh tokens but the periodic refresh cron is deferred).
 *
 * Wired:
 *   - gcal.list_events   (read)
 *   - gcal.read_event    (read)
 *   - gcal.create_event  (draft → approval required)
 *   - gcal.update_event  (draft → approval required)
 *
 * Calendar selection: `params.calendarId` defaults to 'primary'.
 */
import type { ConnectorHandler, DryRunFn } from './connectors.js'
import { fetchWithRetry } from './provider-retry.js'

const BASE = 'https://www.googleapis.com/calendar/v3'

async function call<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'authorization': `Bearer ${token}`,
    ...(init.body ? { 'content-type': 'application/json' } : {}),
    ...(init.headers as Record<string, string> | undefined),
  }
  const out = await fetchWithRetry('gcal', `${BASE}${path}`, {
    ...init, headers,
    signal: init.signal ?? AbortSignal.timeout(30_000),
  })
  if (!out.ok) throw new Error(`GCal ${out.status}: ${out.statusText}`)
  if (out.response.status === 204) return null as T
  return out.response.json() as Promise<T>
}

interface GCalEvent {
  id: string; summary?: string; description?: string;
  status: string; start: { dateTime?: string; date?: string };
  end:   { dateTime?: string; date?: string };
  htmlLink: string; created: string; updated: string;
  attendees?: Array<{ email: string; responseStatus?: string }>;
}

function calendarId(params: Record<string, unknown>): string {
  return typeof params['calendarId'] === 'string' && params['calendarId'].length > 0
    ? params['calendarId'] : 'primary'
}

export const listEvents: ConnectorHandler = async (ctx, params) => {
  const token = await ctx.getSecret()
  const cal = encodeURIComponent(calendarId(params))
  const timeMin = typeof params['timeMin'] === 'string' ? params['timeMin'] : new Date().toISOString()
  const timeMax = typeof params['timeMax'] === 'string' ? params['timeMax'] : undefined
  const maxResults = Math.min(Number(params['maxResults'] ?? 25), 250)
  const q = new URLSearchParams({
    timeMin, maxResults: String(maxResults), singleEvents: 'true', orderBy: 'startTime',
    ...(timeMax ? { timeMax } : {}),
  })
  const data = await call<{ items: GCalEvent[] }>(token, `/calendars/${cal}/events?${q}`)
  return (data.items ?? []).map(e => ({
    id: e.id, summary: e.summary ?? '(no title)',
    start: e.start.dateTime ?? e.start.date,
    end:   e.end.dateTime   ?? e.end.date,
    status: e.status, url: e.htmlLink,
    attendees: (e.attendees ?? []).map(a => ({ email: a.email, status: a.responseStatus ?? 'needsAction' })),
  }))
}

export const readEvent: ConnectorHandler = async (ctx, params) => {
  const token = await ctx.getSecret()
  const cal = encodeURIComponent(calendarId(params))
  const id = String(params['eventId'] ?? params['id'] ?? '').trim()
  if (!id) throw new Error('params.eventId required')
  const e = await call<GCalEvent>(token, `/calendars/${cal}/events/${encodeURIComponent(id)}`)
  return {
    id: e.id, summary: e.summary ?? '(no title)', description: e.description ?? '',
    start: e.start.dateTime ?? e.start.date,
    end:   e.end.dateTime   ?? e.end.date,
    status: e.status, url: e.htmlLink,
    attendees: (e.attendees ?? []).map(a => ({ email: a.email, status: a.responseStatus ?? 'needsAction' })),
  }
}

export const createEvent: ConnectorHandler = async (ctx, params) => {
  const token = await ctx.getSecret()
  const cal = encodeURIComponent(calendarId(params))
  const summary = String(params['summary'] ?? params['title'] ?? '').trim()
  if (!summary) throw new Error('params.summary required')
  // Caller passes ISO 8601; we don't second-guess the timezone.
  const start = params['start']      // { dateTime: '2025-…' } or { date: '2025-…' }
  const end   = params['end']
  if (!start || !end) throw new Error('params.start and params.end required (gcal event time blocks)')

  const description = typeof params['description'] === 'string' ? params['description'] : undefined
  const attendees = Array.isArray(params['attendees'])
    ? (params['attendees'] as Array<string | { email: string }>).map(a =>
        typeof a === 'string' ? { email: a } : a)
    : undefined

  const body: Record<string, unknown> = {
    summary, start, end,
    ...(description ? { description } : {}),
    ...(attendees   ? { attendees }   : {}),
  }
  const e = await call<GCalEvent>(token, `/calendars/${cal}/events`, {
    method: 'POST', body: JSON.stringify(body),
  })
  return { id: e.id, url: e.htmlLink, summary: e.summary ?? summary, status: e.status }
}

export const updateEvent: ConnectorHandler = async (ctx, params) => {
  const token = await ctx.getSecret()
  const cal = encodeURIComponent(calendarId(params))
  const id = String(params['eventId'] ?? params['id'] ?? '').trim()
  if (!id) throw new Error('params.eventId required')
  const patch: Record<string, unknown> = {}
  if (typeof params['summary']     === 'string') patch['summary']     = params['summary']
  if (typeof params['description'] === 'string') patch['description'] = params['description']
  if (params['start']) patch['start'] = params['start']
  if (params['end'])   patch['end']   = params['end']
  if (Object.keys(patch).length === 0) throw new Error('no fields to update')
  const e = await call<GCalEvent>(token, `/calendars/${cal}/events/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify(patch),
  })
  return { id: e.id, url: e.htmlLink, summary: e.summary ?? '', status: e.status }
}

export const createEventDryRun: DryRunFn = async (_ctx, params) => {
  const summary = String(params['summary'] ?? params['title'] ?? '(no summary)')
  const cal = calendarId(params)
  return {
    summary: `would create event "${summary}" on calendar ${cal}`,
    affected: { calendar: cal, summary, start: params['start'], end: params['end'] },
  }
}

export const updateEventDryRun: DryRunFn = async (_ctx, params) => {
  const id = String(params['eventId'] ?? params['id'] ?? '?')
  const fields = ['summary','description','start','end'].filter(f => params[f] !== undefined)
  return {
    summary: `would update event ${id} (fields: ${fields.join(', ') || 'none'})`,
    affected: { eventId: id, fields },
  }
}
