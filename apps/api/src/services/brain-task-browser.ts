/**
 * brain-task-browser.ts — Session-based browser control via playwright.
 *
 * Operations:
 *   browser.open      → open a URL, return sessionId
 *   browser.click     → click a selector in a session
 *   browser.fill      → fill a form field
 *   browser.text      → extract text by selector (or whole page)
 *   browser.screenshot → png screenshot of page
 *   browser.evaluate  → run JS in page, return result (must be JSON-safe)
 *   browser.list      → list active sessions
 *   browser.close     → close a session
 *
 * All sessions auto-expire after 10 min of inactivity. Max 5 concurrent.
 */

// Loose playwright shape — module is dynamic-imported so we don't pay
// startup cost on API boot.
interface PWBrowser   { newContext(opts: unknown): Promise<PWContext>; close(): Promise<void> }
interface PWContext   { newPage(): Promise<PWPage>; close(): Promise<void> }
interface PWPage {
  goto(url: string, opts?: unknown): Promise<{ status(): number } | null>
  url():    string
  title():  Promise<string>
  content(): Promise<string>
  click(sel: string, opts?: unknown): Promise<void>
  fill(sel: string, value: string, opts?: unknown): Promise<void>
  textContent(sel: string, opts?: unknown): Promise<string | null>
  innerText(sel: string, opts?: unknown): Promise<string>
  screenshot(opts?: unknown): Promise<Buffer>
  evaluate<T>(fn: string | ((arg?: unknown) => T), arg?: unknown): Promise<T>
  waitForSelector(sel: string, opts?: unknown): Promise<unknown>
  waitForLoadState(state: string, opts?: unknown): Promise<void>
}

interface Session {
  id:          string
  workspaceId: string
  context:     PWContext
  page:        PWPage
  lastUsedAt:  number
  createdAt:   number
  url:         string
}

/** R146.47 — SSRF predicate at the Playwright sink. Imports the same
 *  isInternalHost shared by image-storage, push, browser-route. Throws
 *  with a descriptive message so the LLM/operator sees what was blocked.
 *  Synchronous module-level require() because top-level ESM await isn't
 *  available in this file; the import is satisfied at first call. */
function assertExternalUrl(url: string, op: string): void {
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Error(`${op}: invalid url`) }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${op}: url scheme must be http(s)`)
  }
  if (!parsed.hostname) throw new Error(`${op}: url missing hostname`)
  // Dynamic ESM import; deferred so this module stays cheap to require.
  // The first browser.open call pays a one-time module-load cost.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isInternalHost = (globalThis as any).__novan_isInternalHost as ((h: string) => boolean) | undefined
  if (isInternalHost && isInternalHost(parsed.hostname)) {
    throw new Error(`${op}: internal host blocked: ${parsed.hostname}`)
  }
  // Belt-and-suspenders inline check: even if the cache miss above
  // returns undefined (first call before hydration), still reject the
  // common literals.
  const h = parsed.hostname.toLowerCase()
  if (h === 'localhost' || h.startsWith('novan-') || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h === '169.254.169.254') {
    throw new Error(`${op}: internal host blocked: ${h}`)
  }
}

// Hydrate the shared predicate once at module load (best-effort; the
// inline literal-list above covers any window where this is still null).
;(async () => {
  try {
    const m = await import('./image-storage.js')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).__novan_isInternalHost = m.isInternalHost
  } catch { /* tolerated — falls back to inline check */ }
})()

/** Global cap on concurrent browser sessions across all workspaces. */
const MAX_SESSIONS         = 5
/** Per-workspace cap. Without this, a single workspace can claim every
 *  slot and starve other workspaces sharing the API process. */
const MAX_SESSIONS_PER_WS  = 3
const SESSION_TTL_MS  = 10 * 60_000
const sessions = new Map<string, Session>()

let sharedBrowser: PWBrowser | null = null
let loading: Promise<PWBrowser | null> | null = null
let lastBrowserLoadError: string | null = null

async function getBrowser(): Promise<PWBrowser | null> {
  if (sharedBrowser) return sharedBrowser
  if (loading) return loading
  loading = (async () => {
    try {
      const mod = (await import('playwright')) as unknown as { chromium: { launch(opts: unknown): Promise<PWBrowser> } }
      sharedBrowser = await mod.chromium.launch({ headless: true, args: ['--no-sandbox'] })
      return sharedBrowser
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[brain-task-browser] playwright load failed:', (e as Error).message)
      lastBrowserLoadError = (e as Error).message
      return null
    } finally {
      loading = null
    }
  })()
  return loading
}

export async function reapExpired(): Promise<void> {
  const now = Date.now()
  for (const [id, s] of sessions) {
    if (now - s.lastUsedAt > SESSION_TTL_MS) {
      try { await s.context.close() }
      catch (e) { console.error('[brain-task-browser] reap close failed for', id, (e as Error).message) }
      sessions.delete(id)
    }
  }
}

// Background reaper — without this, sessions that timeout BETWEEN
// browserOpen calls are never collected and Chromium contexts leak.
// .unref() so the timer doesn't keep the event loop alive at shutdown.
// The existing shutdownAllBrowserSessions() below clears this interval.
const REAP_INTERVAL_MS = 5 * 60_000
const _reapTimer = setInterval(() => { void reapExpired() }, REAP_INTERVAL_MS)
_reapTimer.unref()

function getSession(id: string): Session {
  const s = sessions.get(id)
  if (!s) throw new Error(`browser session not found: ${id}`)
  s.lastUsedAt = Date.now()
  return s
}

// ─── Operations ────────────────────────────────────────────────────────

export async function browserOpen(workspaceId: string, params: Record<string, unknown>): Promise<unknown> {
  await reapExpired()
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error(`max ${MAX_SESSIONS} concurrent browser sessions globally — close one first`)
  }
  let wsCount = 0
  for (const s of sessions.values()) if (s.workspaceId === workspaceId) wsCount++
  if (wsCount >= MAX_SESSIONS_PER_WS) {
    throw new Error(`max ${MAX_SESSIONS_PER_WS} concurrent browser sessions per workspace — close one first`)
  }
  const url = String(params['url'] ?? '').trim()
  if (!url) throw new Error('browser.open: url required')
  // R146.47 — SSRF guard at the actual Playwright sink. R146.45 fixed
  // the queued-job route, but brain-task-browser is the LLM-callable
  // path that bypasses the route entirely. Same predicate.
  assertExternalUrl(url, 'browser.open')

  const br = await getBrowser()
  if (!br) throw new Error(`playwright not available${lastBrowserLoadError ? `: ${lastBrowserLoadError}` : ''}`)

  const context = await br.newContext({
    userAgent: 'Mozilla/5.0 (Novan-Brain; +https://novan.ai/bot)',
    viewport:  { width: 1280, height: 800 },
    javaScriptEnabled: true,
  })
  const page = await context.newPage()
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch((e: Error) => { console.error('[brain-task-browser]', e.message); return null })
  if (!res) {
    await context.close().catch((e: Error) => { console.error('[brain-task-browser]', e.message); return null })
    throw new Error(`browser.open: navigation failed/timeout for ${url}`)
  }

  const id = `bs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const now = Date.now()
  sessions.set(id, { id, workspaceId, context, page, lastUsedAt: now, createdAt: now, url: page.url() })
  return {
    sessionId: id, url: page.url(), title: await page.title().catch(() => ''),
    status: res.status(), activeSessions: sessions.size,
  }
}

export async function browserClick(_ws: string, params: Record<string, unknown>): Promise<unknown> {
  const s = getSession(String(params['sessionId'] ?? ''))
  const selector = String(params['selector'] ?? '').trim()
  if (!selector) throw new Error('browser.click: selector required')
  await s.page.click(selector, { timeout: 5_000 })
  return { sessionId: s.id, url: s.page.url(), clicked: selector }
}

export async function browserFill(_ws: string, params: Record<string, unknown>): Promise<unknown> {
  const s = getSession(String(params['sessionId'] ?? ''))
  const selector = String(params['selector'] ?? '').trim()
  const value    = String(params['value'] ?? '')
  if (!selector) throw new Error('browser.fill: selector required')
  await s.page.fill(selector, value, { timeout: 5_000 })
  return { sessionId: s.id, filled: selector, length: value.length }
}

export async function browserText(_ws: string, params: Record<string, unknown>): Promise<unknown> {
  const s = getSession(String(params['sessionId'] ?? ''))
  const selector = String(params['selector'] ?? '').trim()
  // R146.72 — wrap page text in <untrusted_content> tags. When the
  // brain's LLM later sees this in its context window, the trust-tag
  // convention introduced in novan-chat's system prompt tells the
  // model to treat the contents as data, not instructions. The page
  // could contain "ignore previous instructions" or any other injection
  // attempt; tagging it at the source means every downstream LLM that
  // consumes the brain-task output gets the marker.
  const wrap = (raw: string): string => `<untrusted_content origin="page:${s.url}">${raw}</untrusted_content>`
  if (selector) {
    const t = await s.page.textContent(selector, { timeout: 5_000 }).catch((e: Error) => { console.error('[brain-task-browser]', e.message); return null })
    return { sessionId: s.id, selector, text: wrap((t ?? '').slice(0, 5000)) }
  }
  // Whole-page text fallback
  const t = await s.page.evaluate<string>('document.body && document.body.innerText || ""').catch(() => '')
  return { sessionId: s.id, text: wrap(t.slice(0, 5000)) }
}

export async function browserScreenshot(_ws: string, params: Record<string, unknown>): Promise<unknown> {
  const s = getSession(String(params['sessionId'] ?? ''))
  const fullPage = Boolean(params['fullPage'] ?? false)
  const buf = await s.page.screenshot({ fullPage, type: 'png' })
  return { sessionId: s.id, url: s.page.url(), pngBase64: buf.toString('base64'), bytes: buf.length }
}

export async function browserEvaluate(_ws: string, params: Record<string, unknown>): Promise<unknown> {
  const s = getSession(String(params['sessionId'] ?? ''))
  const expr = String(params['expression'] ?? '').trim()
  if (!expr) throw new Error('browser.evaluate: expression required')
  // playwright's page.evaluate accepts a string and runs it in the page.
  // Result MUST be JSON-serializable.
  const result = await s.page.evaluate<unknown>(expr).catch((e: Error) => ({ __error: e.message }))
  return { sessionId: s.id, result }
}

export async function browserWaitFor(_ws: string, params: Record<string, unknown>): Promise<unknown> {
  const s = getSession(String(params['sessionId'] ?? ''))
  const selector = params['selector'] ? String(params['selector']) : null
  const state    = String(params['state'] ?? 'load')   // load | domcontentloaded | networkidle
  const timeout  = Math.min(Number(params['timeoutMs'] ?? 10_000), 30_000)
  if (selector) {
    await s.page.waitForSelector(selector, { timeout })
    return { sessionId: s.id, waitedFor: selector }
  }
  await s.page.waitForLoadState(state, { timeout })
  return { sessionId: s.id, waitedFor: state }
}

export async function browserNavigate(_ws: string, params: Record<string, unknown>): Promise<unknown> {
  const s = getSession(String(params['sessionId'] ?? ''))
  const url = String(params['url'] ?? '').trim()
  if (!url) throw new Error('browser.navigate: url required')
  assertExternalUrl(url, 'browser.navigate')   // R146.47 — same SSRF guard
  const res = await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  s.url = s.page.url()
  return { sessionId: s.id, url: s.page.url(), status: res?.status() ?? 0 }
}

export function browserList(workspaceId: string, _params: Record<string, unknown>): Promise<unknown> {
  return Promise.resolve(
    [...sessions.values()]
      .filter(s => s.workspaceId === workspaceId)
      .map(s => ({ sessionId: s.id, url: s.url, ageSec: Math.round((Date.now() - s.createdAt) / 1000), idleSec: Math.round((Date.now() - s.lastUsedAt) / 1000) })),
  )
}

export async function browserClose(_ws: string, params: Record<string, unknown>): Promise<unknown> {
  const id = String(params['sessionId'] ?? '')
  const s = sessions.get(id)
  if (!s) return { sessionId: id, closed: false, reason: 'not found' }
  try { await s.context.close() } catch { /* */ }
  sessions.delete(id)
  return { sessionId: id, closed: true, remaining: sessions.size }
}

export async function shutdownAllBrowserSessions(): Promise<void> {
  clearInterval(_reapTimer)
  for (const [id, s] of sessions) {
    try { await s.context.close() } catch { /* */ }
    sessions.delete(id)
  }
  if (sharedBrowser) {
    try { await sharedBrowser.close() } catch { /* */ }
    sharedBrowser = null
  }
}
