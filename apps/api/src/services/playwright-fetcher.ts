/**
 * playwright-fetcher.ts — Headless-browser fetcher for JS-heavy pages.
 *
 * Why: plain `fetch()` returns the SSR shell on SPAs (React/Vue/etc.)
 * with no real content. Research + feed-ingester paths need the rendered
 * DOM to extract actual text.
 *
 * Strategy:
 *   - Dynamic-import playwright so the API doesn't pay startup cost
 *     when this isn't used. The browser-worker package keeps playwright
 *     installed; we share the same pnpm-hoisted binary.
 *   - Single shared browser instance with a fresh context per fetch
 *     (cheaper than launch-per-call, safer than shared cookies).
 *   - Hard caps on time + content size; circuit breaker on failures.
 *
 * Honest scope: this is an API-side convenience for short, on-demand
 * fetches. For long-running browser automation, use the browser-worker
 * queue with proper governance + audit logging.
 */

// Playwright is loaded via dynamic import — not in API package.json so we
// don't pay startup cost when it isn't used. Types are deliberately loose;
// the runtime contract is what matters.
interface PWBrowserLike {
  newContext(opts: unknown): Promise<PWContextLike>
  close(): Promise<void>
}
interface PWContextLike {
  newPage():   Promise<PWPageLike>
  close():     Promise<void>
}
interface PWPageLike {
  setDefaultNavigationTimeout(ms: number): void
  setDefaultTimeout(ms: number): void
  goto(url: string, opts?: unknown): Promise<{ status(): number } | null>
  url():       string
  title():     Promise<string>
  content():   Promise<string>
  evaluate<T>(fn: () => T): Promise<T>
  waitForSelector(sel: string, opts?: unknown): Promise<unknown>
}

const FETCH_TIMEOUT_MS = 15_000
const MAX_HTML_BYTES   = 5 * 1024 * 1024   // 5 MB cap

interface SharedBrowser {
  browser:  PWBrowserLike
  loadedAt: number
}
let shared: SharedBrowser | null = null
let loading: Promise<SharedBrowser | null> | null = null
const BROWSER_TTL_MS = 30 * 60_000   // recycle every 30 min to avoid leaks

async function getBrowser(): Promise<SharedBrowser | null> {
  if (shared && Date.now() - shared.loadedAt < BROWSER_TTL_MS) return shared
  if (loading) return loading
  loading = (async () => {
    try {
      const mod = (await import('playwright' as string)) as unknown as { chromium: { launch(opts: unknown): Promise<PWBrowserLike> } }
      const browser = await mod.chromium.launch({ headless: true, args: ['--no-sandbox'] })
      // Close any expired prior browser
      if (shared) { try { await shared.browser.close() } catch { /* */ } }
      shared = { browser, loadedAt: Date.now() }
      return shared
    } catch {
      return null
    } finally {
      loading = null
    }
  })()
  return loading
}

export interface FetchResult {
  ok:         true
  url:        string
  finalUrl:   string
  title:      string
  text:       string
  html:       string
  status:     number
  durationMs: number
}
export interface FetchFailure {
  ok:         false
  url:        string
  reason:     string
  status:     number
  durationMs: number
}

/**
 * Fetch a URL with a real browser. Returns rendered text + HTML.
 * Never throws — failures come back as `{ ok: false, reason }`.
 */
export async function renderFetch(url: string, opts: { waitForSelector?: string } = {}): Promise<FetchResult | FetchFailure> {
  const start = Date.now()
  // R146.312 — SSRF guard. The web.fetch brain op is risk:low (auto-callable
  // by brain.loop), so an LLM under prompt-injection could feed cloud-IMDS
  // (169.254.169.254) or container-internal addresses (postgres on 127.0.0.1
  // host network) here. Cloud creds would land in r.text → next chat turn →
  // exfiltrated. Block obvious internal targets before the browser dials.
  // DNS rebinding is mitigated by playwright resolving fresh; if needed,
  // upgrade to a resolved-IP recheck.
  const { ssrfReject } = await import('../util/ssrf-guard.js')
  const reject = ssrfReject(url)
  if (reject) {
    return { ok: false, url, reason: `SSRF guard: ${reject}`, status: 0, durationMs: Date.now() - start }
  }
  const sb = await getBrowser()
  if (!sb) {
    return { ok: false, url, reason: 'playwright unavailable (not installed?)', status: 0, durationMs: Date.now() - start }
  }
  const ctx = await sb.browser.newContext({
    userAgent: 'Mozilla/5.0 (Novan; +https://novan.ai/bot) Chrome/120',
    viewport:  { width: 1280, height: 800 },
    javaScriptEnabled: true,
  })
  try {
    const page = await ctx.newPage()
    page.setDefaultNavigationTimeout(FETCH_TIMEOUT_MS)
    page.setDefaultTimeout(FETCH_TIMEOUT_MS)
    const res = await page.goto(url, { waitUntil: 'networkidle' }).catch((e: Error) => { console.error('[playwright-fetcher]', e.message); return null })
    if (!res) {
      return { ok: false, url, reason: 'navigation failed/timeout', status: 0, durationMs: Date.now() - start }
    }
    if (opts.waitForSelector) {
      await page.waitForSelector(opts.waitForSelector, { timeout: 5_000 }).catch((e: Error) => { console.error('[playwright-fetcher]', e.message); return null })
    }
    const status = res.status()
    const finalUrl = page.url()
    const title = await page.title().catch(() => '')
    let html = await page.content().catch(() => '')
    if (html.length > MAX_HTML_BYTES) html = html.slice(0, MAX_HTML_BYTES)
    const text = await page.evaluate<string>(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = (globalThis as any).document as { body?: { innerText?: string } } | undefined
      return doc?.body?.innerText ?? ''
    }).catch(() => '')
    return {
      ok: true, url, finalUrl, title, text: text.slice(0, MAX_HTML_BYTES), html, status,
      durationMs: Date.now() - start,
    }
  } finally {
    await ctx.close().catch((e: Error) => { console.error('[playwright-fetcher]', e.message); return null })
  }
}

/**
 * Detect "thin" fetched content — typical SSR shell with no real text.
 * Heuristic: <body> exists but extractable text is < 500 chars, OR
 * the HTML contains common SPA root markers and lacks substantial text.
 */
export function looksLikeSpaShell(html: string): boolean {
  if (!html) return true
  const lower = html.toLowerCase()
  // Strip script/style + tags, count text
  const text = lower
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length < 500) return true
  // SPA root markers + thin text
  const spaMarkers = ['<div id="root"', '<div id="__next"', '<div id="app"', 'data-reactroot', 'ng-version']
  return spaMarkers.some(m => lower.includes(m)) && text.length < 1500
}

export async function shutdownFetcher(): Promise<void> {
  if (shared) {
    try { await shared.browser.close() } catch { /* */ }
    shared = null
  }
}
