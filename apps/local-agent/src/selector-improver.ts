/**
 * R366 — Self-improving driver helper.
 *
 * When a Playwright locator fails, the driver calls this module to get
 * better selectors from the droplet's selector.improve op. The op asks an
 * LLM with the page HTML + screenshot + error, returns ranked suggestions,
 * and persists them so future drivers try the proven ones first.
 *
 * Drivers don't need to implement perfect selectors up front — they
 * iterate to perfection automatically.
 */
import type { Locator, Page } from 'playwright'
import type { AgentConfig } from './config.js'

export interface ResilientLocateInput {
  cfg:        AgentConfig
  page:       Page
  platform:   string
  step:       string                    // e.g. 'fill_title', 'find_file_input'
  fallback:   string                    // first selector to try (the driver's best guess)
  visible?:   boolean                   // require :visible
  timeoutMs?: number                    // per-attempt timeout
}

interface SelectorRow {
  selector:     string
  selectorType: 'css' | 'text' | 'role'
  confidence:   number
  reasoning:    string
}

async function brainTask<T>(cfg: AgentConfig, op: string, params: Record<string, unknown>): Promise<T | null> {
  try {
    const res = await fetch(`${cfg.apiBase}/api/v1/brain/task`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${cfg.opsToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ workspace_id: cfg.workspaceId, plan: [{ op, params }] }),
    })
    if (!res.ok) return null
    const j = await res.json() as { data?: { results?: Array<{ ok: boolean; data: T }> } }
    return j.data?.results?.[0]?.data ?? null
  } catch { return null }
}

function buildLocator(page: Page, s: SelectorRow): Locator {
  if (s.selectorType === 'text') return page.locator(`:has-text("${s.selector.replace(/"/g, '\\"')}")`)
  if (s.selectorType === 'role') {
    // crude parse: "button[name='Publish']" → role=button, name=Publish
    const m = s.selector.match(/^(\w+)(?:\[name=['"]([^'"]+)['"]\])?/)
    if (m) return page.getByRole(m[1]! as 'button', m[2] ? { name: m[2] } : {})
  }
  return page.locator(s.selector)
}

/**
 * Try the fallback selector first; on failure, fetch stored selectors;
 * on still-failure, ask the LLM via selector.improve. Returns the first
 * locator that becomes visible/attached, or null after all attempts.
 *
 * Reports outcomes back so the success-ratio sort improves over time.
 */
export async function resilientLocate(input: ResilientLocateInput): Promise<Locator | null> {
  const { cfg, page, platform, step, fallback, timeoutMs = 6_000 } = input
  const triedSelectors: string[] = []

  async function tryOne(sel: SelectorRow): Promise<Locator | null> {
    triedSelectors.push(sel.selector)
    try {
      const loc = buildLocator(page, sel)
      const target = input.visible ? loc.first() : loc.first()
      await target.waitFor({ state: input.visible ? 'visible' : 'attached', timeout: timeoutMs })
      // report success best-effort
      void brainTask(cfg, 'selector.outcome', { platform, step, selector: sel.selector, success: true })
      return target
    } catch {
      void brainTask(cfg, 'selector.outcome', { platform, step, selector: sel.selector, success: false })
      return null
    }
  }

  // 1. Driver's hand-written guess
  const hit1 = await tryOne({ selector: fallback, selectorType: 'css', confidence: 0.5, reasoning: 'driver default' })
  if (hit1) return hit1

  // 2. Stored selectors from past runs
  const stored = await brainTask<SelectorRow[]>(cfg, 'selector.stored', { platform, step, limit: 5 }) ?? []
  for (const s of stored) {
    if (triedSelectors.includes(s.selector)) continue
    const hit = await tryOne(s)
    if (hit) return hit
  }

  // 3. Ask the LLM. Capture page HTML + screenshot.
  let html = ''
  try { html = await page.content() } catch { /* ignore */ }
  // strip <script>, <style>, base64 data: blobs to fit token budget
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/data:[^"']{200,}/g, 'data:...truncated')
    .slice(0, 8000)
  let screenshotBase64: string | undefined
  try {
    const buf = await page.screenshot({ fullPage: false, timeout: 5_000 })
    screenshotBase64 = buf.toString('base64')
  } catch { /* ignore */ }

  const improved = await brainTask<{ ok: boolean; suggestions: SelectorRow[] }>(cfg, 'selector.improve', {
    platform, step,
    errorMessage:      `locator wait timeout for "${fallback}" on ${step}`,
    pageUrl:           page.url(),
    pageHtmlExcerpt:   html,
    previousSelectors: triedSelectors,
    ...(screenshotBase64 ? { screenshotBase64 } : {}),
  })

  for (const s of improved?.suggestions ?? []) {
    if (triedSelectors.includes(s.selector)) continue
    const hit = await tryOne(s)
    if (hit) return hit
  }

  return null
}
