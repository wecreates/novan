/**
 * R146.328 (#20) — calendar awareness.
 *
 * Reads operator's Google Calendar via the OAuth credential, returns
 * upcoming events. Used by:
 *   - chat layer: prefix system prompt with "you have X in 30min"
 *   - daily routine: include in morning briefing
 *
 * Scaffold: API path + response shape complete. Live read requires the
 * Google Calendar OAuth to be wired (R328 #5 connector flow does this).
 */
import { db } from '../db/client.js'
import { connectorCredentials } from '../db/schema.js'
import { and, eq } from 'drizzle-orm'

export interface CalendarEvent {
  id:        string
  title:     string
  startAt:   number
  endAt:     number
  location?: string
  description?: string
  minutesUntil: number
}

export interface CalendarResult {
  ok:           boolean
  reason?:      string
  upcoming:     CalendarEvent[]
  nextSoonest?: CalendarEvent | null
}

async function getCalendarToken(workspaceId: string): Promise<string | null> {
  const [cred] = await db.select({ vaultKey: connectorCredentials.vaultKey })
    .from(connectorCredentials)
    .where(and(
      eq(connectorCredentials.workspaceId, workspaceId),
      eq(connectorCredentials.connectorId, 'calendar'),
      eq(connectorCredentials.status, 'active'),
    ))
    .limit(1).catch(() => [])
  if (!cred) return null
  try {
    const { readSecret } = await import('./secrets-vault.js') as { readSecret: (ws: string, key: string) => Promise<string | null> }
    return await readSecret(workspaceId, cred.vaultKey)
  } catch { return null }
}

export async function upcomingEvents(workspaceId: string, windowHours = 24): Promise<CalendarResult> {
  const token = await getCalendarToken(workspaceId)
  if (!token) {
    return {
      ok: false,
      reason: 'No active calendar credential — connect via /api/v1/oauth/calendar/start',
      upcoming: [],
    }
  }
  const now = Date.now()
  const until = now + windowHours * 3600_000
  try {
    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events')
    url.searchParams.set('timeMin', new Date(now).toISOString())
    url.searchParams.set('timeMax', new Date(until).toISOString())
    url.searchParams.set('singleEvents', 'true')
    url.searchParams.set('orderBy', 'startTime')
    url.searchParams.set('maxResults', '20')
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal:  AbortSignal.timeout(8_000),
    })
    if (!res.ok) return { ok: false, reason: `calendar API ${res.status}`, upcoming: [] }
    const j = await res.json() as { items?: Array<{ id: string; summary?: string; description?: string; location?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }> }
    const upcoming: CalendarEvent[] = (j.items ?? [])
      .map(it => {
        const startISO = it.start?.dateTime ?? it.start?.date
        const endISO   = it.end?.dateTime   ?? it.end?.date
        if (!startISO || !endISO) return null
        const startAt = new Date(startISO).getTime()
        const endAt   = new Date(endISO).getTime()
        return {
          id: it.id, title: it.summary ?? '(untitled)',
          startAt, endAt,
          ...(it.location ? { location: it.location } : {}),
          ...(it.description ? { description: it.description.slice(0, 500) } : {}),
          minutesUntil: Math.round((startAt - now) / 60_000),
        } as CalendarEvent
      })
      .filter((e): e is CalendarEvent => e !== null)
    return { ok: true, upcoming, nextSoonest: upcoming[0] ?? null }
  } catch (e) {
    return { ok: false, reason: `calendar fetch failed: ${(e as Error).message}`, upcoming: [] }
  }
}

/** Build a one-line prefix for chat system prompt. Returns '' if nothing soon. */
export async function calendarPrefix(workspaceId: string, soonMinutes = 60): Promise<string> {
  const r = await upcomingEvents(workspaceId, 4).catch(() => null)
  if (!r?.ok || !r.nextSoonest) return ''
  const ev = r.nextSoonest
  if (ev.minutesUntil < 0 || ev.minutesUntil > soonMinutes) return ''
  return `Operator context: "${ev.title}" in ${ev.minutesUntil} min.\n`
}
