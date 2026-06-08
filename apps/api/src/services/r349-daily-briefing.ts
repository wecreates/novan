/**
 * R146.349 — Daily Operator Briefing
 *
 * Synthesizes one morning report:
 *   "Today upload these N to FAA, these N to Gumroad, ..."
 *
 * Within safe daily velocity per platform. Each item has paste-ready
 * title/description/tags/image-URL so operator can run the morning queue
 * in 20-40 min.
 */
import { statsByPlatform, nextForPlatform, SAFE_DAILY_VELOCITY, type QueueItem } from './r349-upload-queue.js'
import type { Platform } from './r349-listing-content-rotator.js'

export interface DailyBriefingPlatformSlice {
  platform:        Platform
  dailyCap:        number
  alreadyToday:    number
  remainingToday:  number
  items:           QueueItem[]
}

export interface DailyBriefing {
  generatedAt:     number
  totalQueuedToday: number
  totalQueueBacklog: number
  byPlatform:      DailyBriefingPlatformSlice[]
  recommendations: string[]
}

export async function dailyBriefing(opts: {
  workspaceId: string
  platforms?:  Platform[]                  // restrict to subset (e.g. primary 3)
}): Promise<DailyBriefing> {
  const stats = await statsByPlatform(opts.workspaceId)
  const filtered = opts.platforms?.length
    ? stats.filter(s => opts.platforms!.includes(s.platform))
    : stats

  const byPlatform: DailyBriefingPlatformSlice[] = []
  let totalToday = 0
  let totalBacklog = 0
  for (const s of filtered) {
    const want = s.remainingToday
    const items = want > 0
      ? await nextForPlatform({ workspaceId: opts.workspaceId, platform: s.platform, limit: want })
      : []
    byPlatform.push({
      platform:       s.platform,
      dailyCap:       s.dailyCap,
      alreadyToday:   s.uploadedToday,
      remainingToday: want,
      items,
    })
    totalToday   += items.length
    totalBacklog += s.queued
  }

  const recommendations: string[] = []
  if (totalToday === 0) recommendations.push('Queue is empty - run design.generate_batch to produce more designs.')
  if (totalBacklog > 500) recommendations.push(`Backlog is ${totalBacklog} - consider increasing daily upload cadence on lowest-priority platforms.`)
  for (const slice of byPlatform) {
    if (slice.remainingToday > 0 && slice.items.length === 0) {
      recommendations.push(`${slice.platform}: ${slice.remainingToday} upload slots remaining today but no designs queued - run upload_queue.add for this platform.`)
    }
  }
  if (recommendations.length === 0) {
    recommendations.push(`Ship the ${totalToday} items below. Mark each upload with upload_queue.mark_uploaded once done.`)
  }

  return {
    generatedAt:       Date.now(),
    totalQueuedToday:  totalToday,
    totalQueueBacklog: totalBacklog,
    byPlatform,
    recommendations,
  }
}

/** Get just the velocity caps + remaining slots without item content. */
export async function velocityStatus(workspaceId: string): Promise<{
  platforms: Array<{ platform: Platform; cap: number; usedToday: number; remaining: number; queued: number }>
}> {
  const stats = await statsByPlatform(workspaceId)
  return {
    platforms: stats.map(s => ({
      platform: s.platform,
      cap:      s.dailyCap,
      usedToday: s.uploadedToday,
      remaining: s.remainingToday,
      queued:   s.queued,
    })),
  }
}

export { SAFE_DAILY_VELOCITY }
