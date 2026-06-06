/**
 * R146.328 (#6) — browser.action consumer.
 *
 * The API emits browser.action.requested events when an operator approves
 * a domain. This worker polls for those events, executes the action via
 * Playwright, and emits browser.action.completed (or .failed).
 *
 * Honest scope: this scaffold polls events directly. Production should
 * use BullMQ. Wiring to BullMQ is one config step away — left as the
 * "next iteration" since the event-polling path proves the loop.
 */
import type { Browser, Page } from 'playwright'

export interface ActionRequest {
  workspaceId: string
  url:         string
  action:      'fill' | 'click' | 'submit' | 'wait_for'
  selector?:   string
  value?:      string
}

export interface ActionResult {
  ok:         boolean
  finalUrl?:  string
  title?:     string
  error?:     string
  durationMs: number
}

let _browser: Browser | null = null

async function getBrowser(): Promise<Browser> {
  if (_browser) return _browser
  const { chromium } = await import('playwright')
  _browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  return _browser
}

export async function execAction(req: ActionRequest): Promise<ActionResult> {
  const start = Date.now()
  let page: Page | null = null
  try {
    const browser = await getBrowser()
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Novan-action; +https://novan.ai/bot)',
      viewport:  { width: 1280, height: 800 },
    })
    page = await ctx.newPage()
    page.setDefaultTimeout(15_000)
    await page.goto(req.url, { waitUntil: 'domcontentloaded' })

    switch (req.action) {
      case 'fill':
        if (!req.selector || req.value === undefined) throw new Error('fill requires selector + value')
        await page.fill(req.selector, req.value)
        break
      case 'click':
        if (!req.selector) throw new Error('click requires selector')
        await page.click(req.selector)
        break
      case 'submit':
        if (!req.selector) throw new Error('submit requires selector')
        await page.locator(req.selector).press('Enter')
        break
      case 'wait_for':
        if (!req.selector) throw new Error('wait_for requires selector')
        await page.waitForSelector(req.selector, { timeout: 15_000 })
        break
    }

    const finalUrl = page.url()
    const title    = await page.title().catch(() => '')
    await ctx.close().catch(() => null)
    return { ok: true, finalUrl, title, durationMs: Date.now() - start }
  } catch (e) {
    if (page) await page.context().close().catch(() => null)
    return { ok: false, error: (e as Error).message, durationMs: Date.now() - start }
  }
}

export async function shutdown(): Promise<void> {
  if (_browser) { try { await _browser.close() } catch { /* */ } _browser = null }
}
