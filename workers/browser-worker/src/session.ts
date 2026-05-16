/**
 * Browser session manager — isolated Playwright contexts per job.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { mkdir }             from 'node:fs/promises'
import { join }              from 'node:path'
import { v7 as uuidv7 }     from 'uuid'

const SCREENSHOT_DIR     = process.env['SCREENSHOT_DIR'] ?? '/tmp/browser-worker/screenshots'
const SESSION_TIMEOUT_MS = Number(process.env['SESSION_TIMEOUT_MS'] ?? '120000')

let browser: Browser | null = null

export async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      '--disable-web-security', '--disable-features=VizDisplayCompositor',
    ],
  })
  return browser
}

export async function closeBrowser(): Promise<void> {
  if (browser) { await browser.close(); browser = null }
}

// ─── Session ──────────────────────────────────────────────────────────────────

export interface SessionOptions {
  jobId:       string
  workspaceId: string
  viewport?:   { width: number; height: number }
  userAgent?:  string
  locale?:     string
  timezone?:   string
  proxy?:      { server: string; username?: string; password?: string }
}

export interface BrowserSession {
  context:           BrowserContext
  page:              Page
  sessionId:         string
  captureScreenshot: (label?: string) => Promise<string>
  close:             () => Promise<void>
}

export async function createSession(opts: SessionOptions): Promise<BrowserSession> {
  const b         = await getBrowser()
  const sessionId = uuidv7()
  const dir       = join(SCREENSHOT_DIR, opts.workspaceId, opts.jobId)

  await mkdir(dir, { recursive: true })

  const context = await b.newContext({
    viewport:    opts.viewport ?? { width: 1280, height: 900 },
    locale:      opts.locale ?? 'en-US',
    // Conditionally include optional fields to satisfy exactOptionalPropertyTypes
    ...(opts.userAgent    ? { userAgent:   opts.userAgent }    : {}),
    ...(opts.timezone     ? { timezoneId:  opts.timezone }     : {}),
    ...(opts.proxy        ? { proxy:       opts.proxy }        : {}),
  })

  const page = await context.newPage()

  const timeoutHandle = setTimeout(() => {
    void context.close().catch(() => undefined)
  }, SESSION_TIMEOUT_MS)

  async function captureScreenshot(label = 'screenshot'): Promise<string> {
    const filename = `${Date.now()}-${label}.png`
    const path     = join(dir, filename)
    await page.screenshot({ path, fullPage: false })
    return path
  }

  async function close(): Promise<void> {
    clearTimeout(timeoutHandle)
    await page.close().catch(() => undefined)
    await context.close().catch(() => undefined)
  }

  return { context, page, sessionId, captureScreenshot, close }
}

// ─── Action executor ─────────────────────────────────────────────────────────

export interface BrowserAction {
  type:      'navigate' | 'click' | 'fill' | 'select' | 'wait' | 'screenshot' | 'extract' | 'scroll'
  selector?: string
  value?:    string
  url?:      string
  timeout?:  number
  label?:    string
}

export interface ActionResult {
  action:          BrowserAction
  success:         boolean
  output?:         unknown
  error?:          string
  screenshotPath?: string
}

export async function executeAction(
  session: BrowserSession,
  action:  BrowserAction,
): Promise<ActionResult> {
  const { page, captureScreenshot } = session
  const timeout = action.timeout ?? 10_000

  try {
    switch (action.type) {
      case 'navigate': {
await page.goto(action.url!, { timeout, waitUntil: 'domcontentloaded' })
        return { action, success: true, output: { url: page.url() } }
      }
      case 'click': {
await page.locator(action.selector!).click({ timeout })
        return { action, success: true }
      }
      case 'fill': {
await page.locator(action.selector!).fill(action.value ?? '', { timeout })
        return { action, success: true }
      }
      case 'select': {
await page.locator(action.selector!).selectOption(action.value ?? '', { timeout })
        return { action, success: true }
      }
      case 'wait': {
        await page.waitForTimeout(Number(action.value ?? 1000))
        return { action, success: true }
      }
      case 'screenshot': {
        const screenshotPath = await captureScreenshot(action.label)
        return { action, success: true, screenshotPath }
      }
      case 'extract': {
const text = await page.locator(action.selector!).innerText({ timeout })
        return { action, success: true, output: { text } }
      }
      case 'scroll': {
        await page.evaluate(() => { window.scrollBy(0, 500) })
        return { action, success: true }
      }
      default: {
        const t = (action as { type: string }).type
        return { action, success: false, error: `Unknown action type: ${t}` }
      }
    }
  } catch (err) {
    const error          = (err as Error).message
    const screenshotPath = await captureScreenshot(`error-${action.type}`).catch(() => '')
    return { action, success: false, error, screenshotPath }
  }
}
