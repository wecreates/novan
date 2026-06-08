/**
 * R146.338 — Platform State Prober (closes platform.plot_twist_detector
 *                                   from R333 mirror; closes onboarding gaps)
 *
 * Before running any platform-onboarding workflow, probe the current state
 * of that platform via cached evidence. If the workflow's goal is already
 * achieved (e.g., TikTok Shop already approved), skip to next step. This is
 * the R332 lesson codified: we spent 20 min preparing a TikTok signup
 * walkthrough then discovered the account was already approved.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

export type PlatformState =
  | 'unknown'
  | 'not_started'
  | 'in_progress'
  | 'pending_approval'
  | 'approved_live'
  | 'banned_or_rejected'
  | 'paused'

export interface PlatformProbe {
  platform:       string
  state:          PlatformState
  evidence:       string
  shouldSkipSetup: boolean
  nextStep:       string
  observedAt:     number
}

/**
 * For each platform, infer state from connector_credentials + workspace_memory.
 * No live API calls — just memory of what we've already learned.
 */
export async function probePlatform(workspaceId: string, platform: string): Promise<PlatformProbe> {
  // Source 1: do we have an active credential?
  let hasActiveCred = false
  try {
    const rows = await db.execute(sql`
      SELECT status, last_used_at FROM connector_credentials
      WHERE workspace_id = ${workspaceId} AND connector_id = ${platform}
        AND status = 'active'
      LIMIT 1
    `) as unknown as Array<{ status: string; last_used_at: number | null }>
    hasActiveCred = rows.length > 0
  } catch { /* ignore */ }

  // Source 2: memory says it's approved + live?
  let memoryState: string | null = null
  try {
    const rows = await db.execute(sql`
      SELECT value FROM workspace_memory
      WHERE workspace_id = ${workspaceId}
        AND key = ${`channel.${platform}.status`}
      LIMIT 1
    `) as unknown as Array<{ value: string }>
    memoryState = rows[0]?.value ?? null
  } catch { /* ignore */ }

  // Source 3: memory says it's banned?
  let banned = false
  try {
    const rows = await db.execute(sql`
      SELECT value FROM workspace_memory
      WHERE workspace_id = ${workspaceId}
        AND scope = 'lessons'
        AND value ILIKE ${'%' + platform + '%banned%'}
      LIMIT 1
    `) as unknown as Array<{ value: string }>
    banned = rows.length > 0
  } catch { /* ignore */ }

  // Classify
  let state: PlatformState = 'unknown'
  let evidence = ''
  let shouldSkip = false
  let nextStep = `Run platform.${platform}.onboard workflow`

  if (banned) {
    state = 'banned_or_rejected'
    evidence = 'Memory shows a lesson entry indicating this platform banned a registration'
    nextStep = `DO NOT retry onboarding. Apply lesson: age account 7+ days, sandbox scope first. Consider alternate platform.`
    shouldSkip = true
  } else if (memoryState && /approved.{0,20}live/i.test(memoryState)) {
    state = 'approved_live'
    evidence = `workspace_memory.channel.${platform}.status indicates approved + live`
    nextStep = `Skip onboarding. Proceed to product publish / sync.`
    shouldSkip = true
  } else if (hasActiveCred) {
    state = 'approved_live'
    evidence = `connector_credentials has active row for ${platform}`
    nextStep = `Skip OAuth. Proceed to next workflow step (sync / publish).`
    shouldSkip = true
  } else if (memoryState && /pending.{0,20}review/i.test(memoryState)) {
    state = 'pending_approval'
    evidence = `workspace_memory indicates ${platform} is in pending review`
    nextStep = `Wait for approval. Set up monitoring for state transition.`
    shouldSkip = true
  } else {
    state = 'not_started'
    evidence = 'No active credential, no memory record'
  }

  return {
    platform,
    state,
    evidence,
    shouldSkipSetup: shouldSkip,
    nextStep,
    observedAt: Date.now(),
  }
}

/** Probe a batch of platforms in parallel. */
export async function probeAll(workspaceId: string, platforms: string[]): Promise<PlatformProbe[]> {
  return Promise.all(platforms.map(p => probePlatform(workspaceId, p)))
}

/**
 * Wrap any onboarding workflow with state-probing. Returns either:
 *   {action: 'skip', probe} — onboarding already done, advance to next step
 *   {action: 'proceed', probe} — proceed with onboarding
 *   {action: 'halt', probe} — banned/rejected, do not retry
 */
export async function gateOnboarding(workspaceId: string, platform: string): Promise<{
  action:  'skip' | 'proceed' | 'halt'
  probe:   PlatformProbe
}> {
  const probe = await probePlatform(workspaceId, platform)
  if (probe.state === 'banned_or_rejected') return { action: 'halt', probe }
  if (probe.shouldSkipSetup) return { action: 'skip', probe }
  return { action: 'proceed', probe }
}
