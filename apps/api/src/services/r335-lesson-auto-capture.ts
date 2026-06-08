/**
 * R146.335 — Lesson Auto-Capture (closes memory.lesson_auto_capture 3→7,
 *                                  memory.lesson_propagation 3→6)
 *
 * Every classified failure produces a candidate lesson. The candidate is
 * scored for generalizability and persisted to workspace_memory under
 * scope='lessons' with importance proportional to applicability scope.
 *
 * Pre-flight hook: before any op that matches a lesson's applicability tag
 * runs, the relevant lesson is injected as context. This is how Etsy's
 * dev-app-ban prevents the same mistake on Instagram, Amazon SP-API, etc.,
 * without operator memory.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

export type LessonScope =
  | 'dev_app_registration'         // Etsy ban pattern → applies to Instagram/Amazon/eBay dev portals
  | 'platform_seller_onboarding'   // TikTok Shop already-approved discovery → probe-before-setup
  | 'oauth_provider_quirks'        // Printful redirect_url, Etsy PKCE
  | 'fulfillment_risk_acknowledgment'
  | 'privacy_runtime'              // home address rule
  | 'cost_optimization'            // free-first strategy compiler
  | 'image_gen_provider_failure'   // FAL/Replicate/Gemini all-down pattern
  | 'shop_address_strategy'
  | 'unknown'

export interface LessonCandidate {
  scope:           LessonScope
  source:          string                 // 'r332.etsy_ban', 'r332.printful_install', etc.
  failureSummary:  string
  rootCause:       string
  generalizable:   boolean                 // does this apply beyond the specific failure?
  applicableTo:    string[]                // tags this lesson applies to (platform names, op categories)
  recommendedAction: string
  importance:      number                  // 80-99
}

export interface CapturedLesson extends LessonCandidate {
  id:              string
  key:             string
  capturedAt:      number
}

/**
 * Score a failure's "lesson value":
 *   - high (95+): generalizable + applies to many platforms (e.g., dev-app ban pattern)
 *   - medium (85-94): pattern-specific but reusable (e.g., PKCE for OAuth)
 *   - low (80-84): point-specific (one-off API quirk)
 * Below 80: don't persist as a lesson; it's just a transient.
 */
export function scoreLesson(c: LessonCandidate): number {
  let score = 75
  if (c.generalizable) score += 10
  if (c.applicableTo.length >= 3) score += 5
  if (c.applicableTo.length >= 5) score += 5
  if (c.scope === 'privacy_runtime' || c.scope === 'dev_app_registration') score += 5
  return Math.min(99, Math.max(80, c.importance ?? score))
}

/**
 * Persist a lesson into workspace_memory.
 * Idempotent via key collision (lesson.<scope>.<source>).
 */
export async function captureLesson(workspaceId: string, c: LessonCandidate): Promise<CapturedLesson | null> {
  const importance = scoreLesson(c)
  const key = `lesson.${c.scope}.${c.source.replace(/[^a-z0-9_]/g, '_')}`
  const value = JSON.stringify({
    scope: c.scope, source: c.source,
    failureSummary: c.failureSummary, rootCause: c.rootCause,
    generalizable: c.generalizable, applicableTo: c.applicableTo,
    recommendedAction: c.recommendedAction,
  })
  const now = Date.now()
  try {
    await db.execute(sql`
      INSERT INTO workspace_memory (workspace_id, key, value, scope, importance, updated_at)
      VALUES (${workspaceId}, ${key}, ${value}, 'lessons', ${importance}, ${now})
      ON CONFLICT (workspace_id, key) DO UPDATE SET
        value      = EXCLUDED.value,
        importance = GREATEST(workspace_memory.importance, EXCLUDED.importance),
        updated_at = EXCLUDED.updated_at
    `)
    return { ...c, id: key, key, capturedAt: now, importance }
  } catch (e) {
    console.error('[r335-lesson-capture] persist failed:', (e as Error).message)
    return null
  }
}

/**
 * Pre-flight hook — called by an op before it runs.
 * Returns the list of applicable lessons sorted by importance desc.
 * Op should fold the recommendedAction into its planning.
 */
export async function applicableLessonsFor(
  workspaceId: string,
  opName: string,
  tags: string[] = [],
): Promise<CapturedLesson[]> {
  try {
    const rows = await db.execute(sql`
      SELECT key, value, importance, updated_at
      FROM workspace_memory
      WHERE workspace_id = ${workspaceId}
        AND scope = 'lessons'
        AND importance >= 80
      ORDER BY importance DESC
    `) as unknown as Array<{ key: string; value: string; importance: number; updated_at: string | number }>
    const out: CapturedLesson[] = []
    for (const row of rows) {
      let parsed: Partial<LessonCandidate> = {}
      try { parsed = JSON.parse(row.value) as Partial<LessonCandidate> } catch { continue }
      const applies = (parsed.applicableTo ?? []).some(t =>
        tags.includes(t) || opName.toLowerCase().includes(t.toLowerCase()),
      )
      if (!applies) continue
      out.push({
        scope:             (parsed.scope ?? 'unknown') as LessonScope,
        source:            parsed.source ?? 'unknown',
        failureSummary:    parsed.failureSummary ?? '',
        rootCause:         parsed.rootCause ?? '',
        generalizable:     parsed.generalizable ?? false,
        applicableTo:      parsed.applicableTo ?? [],
        recommendedAction: parsed.recommendedAction ?? '',
        importance:        row.importance,
        id:                row.key,
        key:               row.key,
        capturedAt:        Number(row.updated_at) || 0,
      })
    }
    return out
  } catch {
    return []
  }
}

/**
 * Auto-classify a failure into a lesson candidate. Conservative — only
 * generates a candidate when the failure shape is clearly a recurring
 * pattern, not a one-off transient.
 */
export function classifyFailure(input: {
  op:           string
  errorMessage: string
  context?:     Record<string, unknown>
}): LessonCandidate | null {
  const msg = input.errorMessage.toLowerCase()

  // Pattern: dev-app banned (Etsy 2026-06-07 R332)
  if (msg.includes('banned') && (input.op.includes('oauth') || input.op.includes('register'))) {
    return {
      scope:             'dev_app_registration',
      source:            `auto.${input.op}.banned`,
      failureSummary:    `${input.op} returned "banned" — platform fraud system rejected new dev app on first attempt`,
      rootCause:         'New dev account + new app + immediate production scope triggers automated fraud detection',
      generalizable:     true,
      applicableTo:      ['etsy', 'shopify', 'tiktok', 'amazon', 'ebay', 'instagram', 'oauth', 'dev_registration'],
      recommendedAction: 'Age dev account 7+ days, start in sandbox scope, never re-register banned app from same IP',
      importance:        95,
    }
  }

  // Pattern: payment required (Replicate)
  if (msg.includes('402') || msg.includes('payment required') || msg.includes('insufficient credit')) {
    return {
      scope:             'image_gen_provider_failure',
      source:            `auto.${input.op}.billing`,
      failureSummary:    `${input.op} returned 402 — provider account out of credit`,
      rootCause:         'Pay-as-you-go provider hit balance floor; needs top-up before next gen',
      generalizable:     true,
      applicableTo:      ['replicate', 'fal', 'openai', 'image_generation', 'llm_inference'],
      recommendedAction: 'Auto-fallback to next-cheapest healthy provider; if all dead, surface blocker with cost estimate to operator',
      importance:        88,
    }
  }

  // Pattern: spend cap (Gemini)
  if (msg.includes('spending cap') || msg.includes('resource_exhausted')) {
    return {
      scope:             'image_gen_provider_failure',
      source:            `auto.${input.op}.spend_cap`,
      failureSummary:    `${input.op} hit project spending cap`,
      rootCause:         'Project-level spending cap enforced at provider; not transient',
      generalizable:     true,
      applicableTo:      ['gemini', 'google_ai', 'image_generation', 'llm_inference'],
      recommendedAction: 'Raise cap at provider console OR fall back to alternate provider OR use public-domain content router',
      importance:        85,
    }
  }

  // Pattern: hard-block (SSN/banking)
  if (msg.includes('hard-block') || msg.includes('refuse to')) {
    return {
      scope:             'privacy_runtime',
      source:            `auto.${input.op}.hard_block`,
      failureSummary:    `${input.op} blocked by hard-block policy (SSN/bank/govID/W9)`,
      rootCause:         'Anthropic-policy hard block; never bypassable',
      generalizable:     true,
      applicableTo:      ['form_submit', 'oauth_callback', 'identity_verification', 'banking', 'tax_form'],
      recommendedAction: 'Surface clear handoff to operator with field list; pre-stage every non-blocked field',
      importance:        95,
    }
  }

  return null
}
