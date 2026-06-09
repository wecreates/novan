/**
 * R366 — Selector-improver service.
 *
 * When a local-agent driver crashes because it can't find an element, it
 * posts the failure context here. This service feeds the screenshot + page
 * HTML excerpt + error to an LLM and asks for revised selectors. The
 * response is persisted to platform_selectors and returned to the agent so
 * it can retry.
 *
 * Operator never has to manually iterate on selectors — the agent learns
 * from its own crashes.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { v7 as uuidv7 } from 'uuid'

export interface ImproveSelectorsInput {
  workspaceId:        string
  platform:           string
  step:               string                  // e.g. 'fill_title', 'click_publish', 'await_file_input'
  errorMessage:       string
  pageUrl:            string
  pageHtmlExcerpt:    string                  // first 8 KB of stripped HTML (no scripts/styles)
  screenshotBase64?:  string                  // optional, helps the LLM see what's rendered
  previousSelectors?: string[]                // what we tried that failed
}

export interface SuggestedSelector {
  selector:     string          // CSS selector to try next
  reasoning:    string          // 1-line explanation
  confidence:   number          // 0-1
  selectorType: 'css' | 'text' | 'role'   // playwright locator style
}

export interface ImproveSelectorsResult {
  ok:           boolean
  suggestions:  SuggestedSelector[]
  cachedFrom?:  string                       // selector cache key if hit
  reason?:      string
}

/**
 * Persisted via raw SQL so we don't need to touch the schema package right
 * now. Table is created lazily.
 */
async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS platform_selectors (
      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL,
      platform        TEXT NOT NULL,
      step            TEXT NOT NULL,
      selector        TEXT NOT NULL,
      selector_type   TEXT NOT NULL,
      confidence      NUMERIC NOT NULL DEFAULT 0.5,
      reasoning       TEXT,
      success_count   INTEGER NOT NULL DEFAULT 0,
      failure_count   INTEGER NOT NULL DEFAULT 0,
      created_at      BIGINT NOT NULL,
      last_used_at    BIGINT
    )
  `).catch(() => {/* may already exist */})
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS platform_selectors_ws_plat_step_idx
    ON platform_selectors (workspace_id, platform, step, confidence DESC)
  `).catch(() => {/* may already exist */})
}

/**
 * Returns the top-N stored selectors for a (platform, step) — these are
 * pre-vetted by past success. Agent tries these BEFORE asking the LLM for
 * new suggestions.
 */
export async function getStoredSelectors(workspaceId: string, platform: string, step: string, limit = 3): Promise<SuggestedSelector[]> {
  await ensureTable()
  const rows = await db.execute(sql`
    SELECT selector, selector_type, confidence, reasoning
    FROM platform_selectors
    WHERE workspace_id = ${workspaceId} AND platform = ${platform} AND step = ${step}
    ORDER BY (success_count + 1)::numeric / (success_count + failure_count + 1) DESC,
             confidence DESC
    LIMIT ${limit}
  `)
  return (rows as unknown as Array<Record<string, unknown>>).map(r => ({
    selector:     String(r['selector']),
    selectorType: (r['selector_type'] as 'css' | 'text' | 'role') ?? 'css',
    confidence:   Number(r['confidence']) || 0.5,
    reasoning:    String(r['reasoning'] ?? ''),
  }))
}

export async function recordSelectorOutcome(workspaceId: string, platform: string, step: string, selector: string, success: boolean): Promise<void> {
  await ensureTable()
  if (success) {
    await db.execute(sql`
      UPDATE platform_selectors
      SET success_count = success_count + 1, last_used_at = ${Date.now()}
      WHERE workspace_id = ${workspaceId} AND platform = ${platform} AND step = ${step} AND selector = ${selector}
    `)
  } else {
    await db.execute(sql`
      UPDATE platform_selectors
      SET failure_count = failure_count + 1, last_used_at = ${Date.now()}
      WHERE workspace_id = ${workspaceId} AND platform = ${platform} AND step = ${step} AND selector = ${selector}
    `)
  }
}

/**
 * Ask an LLM for new selectors based on the failure context. Persists
 * suggestions to platform_selectors. Caller (the agent) then tries each
 * suggestion in confidence order and reports back outcomes via
 * recordSelectorOutcome.
 */
// R467 — per-(workspace, platform) circuit breaker: 3 consecutive LLM
// failures opens the breaker for 30 min. Prevents the autonomous loop from
// spamming a degraded provider.
const SELECTOR_CB = new Map<string, { fails: number; openUntil: number }>()

export async function improveSelectors(input: ImproveSelectorsInput): Promise<ImproveSelectorsResult> {
  await ensureTable()

  // First check if we have stored selectors that haven't been tried yet
  const stored = await getStoredSelectors(input.workspaceId, input.platform, input.step, 5)
  const previous = new Set(input.previousSelectors ?? [])
  const untried = stored.filter(s => !previous.has(s.selector))
  if (untried.length > 0) {
    return { ok: true, suggestions: untried, cachedFrom: 'platform_selectors' }
  }

  // Ask the LLM. Use Claude via existing provider routing.
  const { routeChat } = await import('./ai-router-service.js').catch(() => ({ routeChat: null as null | ((..._a: unknown[]) => Promise<{ content: string }>) }))
  if (!routeChat) {
    return { ok: false, suggestions: [], reason: 'ai-router not available' }
  }

  const sysPrompt = `You are a web-automation expert. The Playwright agent failed to find an element on a page. Based on the error, page URL, HTML excerpt, and screenshot, suggest up to 5 CSS / text / role selectors that would let the agent complete this step.

Return ONLY a JSON array of suggestions in this exact shape (no markdown):
[
  {"selector": "input[name='title']", "selectorType": "css", "confidence": 0.85, "reasoning": "Standard form input naming convention"},
  ...
]

Confidence: 0-1, your honest estimate the selector matches the intended element. Selector types: "css" (any CSS selector), "text" (Playwright's :has-text), "role" (getByRole syntax like "button[name='Publish']").
Prefer stable selectors (name, data-* attrs, role + accessible name) over fragile ones (class names, nth-child).`

  const userPrompt = `Platform: ${input.platform}
Step: ${input.step}
Error: ${input.errorMessage}
Page URL: ${input.pageUrl}
Previous failed selectors: ${input.previousSelectors?.join(', ') ?? '(none)'}

Page HTML excerpt (truncated):
\`\`\`html
${input.pageHtmlExcerpt.slice(0, 8000)}
\`\`\``

  // R465/R488 — skip the LLM call if total or per-source daily AI spend is capped.
  try {
    const { isBudgetExhausted, isSourceBudgetExhausted, recordSpend } = await import('./r428-ai-spend-tracker.js')
    if (await isBudgetExhausted(input.workspaceId)) {
      return { ok: false, suggestions: [], reason: 'daily AI budget exhausted (R428)' }
    }
    if (await isSourceBudgetExhausted(input.workspaceId, 'selector_improver')) {
      return { ok: false, suggestions: [], reason: 'selector_improver daily cap reached (R488)' }
    }
    await recordSpend(input.workspaceId, 'selector_improver', 1)
  } catch { /* tolerated */ }

  // R467 — circuit breaker. If LLM has thrown N times in a row for this
  // (workspace, platform), back off for 30 min before trying again.
  const cbKey = `${input.workspaceId}|${input.platform}`
  const cb = SELECTOR_CB.get(cbKey) ?? { fails: 0, openUntil: 0 }
  if (Date.now() < cb.openUntil) {
    return { ok: false, suggestions: [], reason: 'circuit open — recent LLM failures, retry in ' + Math.round((cb.openUntil - Date.now())/60000) + 'min' }
  }

  let content: string
  try {
    const resp = await (routeChat as unknown as (req: unknown) => Promise<{ content: string }>) ({
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user',   content: userPrompt },
        // Vision: include the screenshot if present
        ...(input.screenshotBase64 ? [{
          role: 'user',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: input.screenshotBase64 } }],
        }] : []),
      ],
      maxTokens: 800,
      temperature: 0.2,
    })
    content = resp.content
    // Success — reset breaker
    SELECTOR_CB.set(cbKey, { fails: 0, openUntil: 0 })
  } catch (e) {
    // Record breaker failure
    const c = SELECTOR_CB.get(cbKey) ?? { fails: 0, openUntil: 0 }
    c.fails++
    if (c.fails >= 3) { c.openUntil = Date.now() + 30 * 60_000; c.fails = 0 }
    SELECTOR_CB.set(cbKey, c)
    return { ok: false, suggestions: [], reason: 'LLM call failed: ' + (e as Error).message }
  }

  // Parse JSON array
  const m = content.match(/\[\s*\{[\s\S]+?\}\s*\]/)
  if (!m) return { ok: false, suggestions: [], reason: 'LLM response had no JSON array' }
  let parsed: Array<SuggestedSelector & { selectorType: string }>
  try { parsed = JSON.parse(m[0]) } catch { return { ok: false, suggestions: [], reason: 'JSON parse failed' } }

  // Persist + return
  const suggestions: SuggestedSelector[] = []
  for (const s of parsed.slice(0, 5)) {
    if (typeof s?.selector !== 'string') continue
    const type = (s.selectorType === 'text' || s.selectorType === 'role') ? s.selectorType : 'css' as const
    await db.execute(sql`
      INSERT INTO platform_selectors (id, workspace_id, platform, step, selector, selector_type, confidence, reasoning, created_at)
      VALUES (${uuidv7()}, ${input.workspaceId}, ${input.platform}, ${input.step}, ${s.selector}, ${type}, ${Number(s.confidence) || 0.5}, ${s.reasoning ?? ''}, ${Date.now()})
      ON CONFLICT DO NOTHING
    `).catch(() => {/* dupe ok */})
    suggestions.push({ selector: s.selector, selectorType: type, confidence: Number(s.confidence) || 0.5, reasoning: s.reasoning ?? '' })
  }
  return { ok: true, suggestions }
}
