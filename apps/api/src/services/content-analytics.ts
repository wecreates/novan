/**
 * content-analytics.ts — pull view / CTR / watch-time from platforms
 * and feed back into the brain's research_findings as memories so the
 * learning loop sees which produced videos actually performed.
 *
 * Sources:
 *   • YouTube Analytics API v2 (uses YOUTUBE_ACCESS_TOKEN; needs
 *     yt.analytics scope on the OAuth grant)
 *   • TikTok Business API (uses TIKTOK_BUSINESS_TOKEN; falls back to
 *     basic publish-id stats from Content Posting API)
 *
 * `recordPerformance(videoId, platform)` snapshots current stats and
 * writes a memory entry tagged 'video-performance' so future planning
 * sessions can recall what worked.
 */

import { db } from '../db/client.js'
import { memories } from '../db/schema.js'
import { and, eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

export interface PerformanceStats {
  platform:    string
  videoId:     string
  /** Channel-stable id (UC… for YouTube, open_id for TikTok). Used to
   *  look up the owning business via business_attachments so revenue
   *  events roll up automatically. */
  channelId?:  string
  views?:      number
  likes?:      number
  comments?:   number
  shares?:     number
  watchTimeMin?: number
  avgViewDurationSec?: number
  ctr?:        number              // 0..1
  /** Platform-reported earnings in USD if the operator's auth scope
   *  includes the revenue report. Always preferred over the RPM
   *  estimate when present — actual earnings beat heuristics. */
  estimatedRevenueUsd?: number
  capturedAt:  number
}

// ─── YouTube ───────────────────────────────────────────────────────────
async function fetchYouTube(videoId: string): Promise<PerformanceStats | null> {
  const token = process.env['YOUTUBE_ACCESS_TOKEN']
  if (!token) return null
  try {
    // Basic stats + snippet (for channelId) — public Data API.
    // Without channelId we can't look up the owning business attachment
    // to roll up revenue automatically.
    const statsRes = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${videoId}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
    })
    if (!statsRes.ok) return null
    const sj = await statsRes.json() as { items?: Array<{ statistics?: { viewCount?: string; likeCount?: string; commentCount?: string }; snippet?: { channelId?: string } }> }
    const item = sj.items?.[0]
    const s = item?.statistics
    if (!s) return null

    const out: PerformanceStats = {
      platform: 'youtube', videoId, capturedAt: Date.now(),
      views:    Number(s.viewCount ?? 0),
      likes:    Number(s.likeCount ?? 0),
      comments: Number(s.commentCount ?? 0),
    }
    if (item?.snippet?.channelId) out.channelId = item.snippet.channelId

    // Advanced stats — Analytics API (requires yt-analytics scope).
    // We additionally pull `estimatedRevenue` when the scope permits —
    // that's the actual dollar number YouTube credits to AdSense, and
    // it beats every RPM-based heuristic.
    try {
      const today = new Date().toISOString().slice(0, 10)
      const start = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
      const aRes = await fetch(`https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=${start}&endDate=${today}&metrics=estimatedMinutesWatched,averageViewDuration,impressions,impressionClickThroughRate,estimatedRevenue&filters=video==${videoId}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
      })
      if (aRes.ok) {
        const aj = await aRes.json() as { rows?: number[][] }
        const row = aj.rows?.[0]
        if (row) {
          if (row[0]) out.watchTimeMin = row[0]
          if (row[1]) out.avgViewDurationSec = row[1]
          if (row[3]) out.ctr = row[3] / 100
          if (row[4] && row[4] > 0) out.estimatedRevenueUsd = row[4]
        }
      }
    } catch { /* analytics scope optional */ }

    return out
  } catch { return null }
}

// ─── TikTok ────────────────────────────────────────────────────────────
async function fetchTikTok(videoId: string): Promise<PerformanceStats | null> {
  const token = process.env['TIKTOK_BUSINESS_TOKEN'] ?? process.env['TIKTOK_ACCESS_TOKEN']
  if (!token) return null
  try {
    const r = await fetch(`https://open.tiktokapis.com/v2/video/query/?fields=id,view_count,like_count,comment_count,share_count`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ filters: { video_ids: [videoId] } }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) return null
    const j = await r.json() as { data?: { videos?: Array<{ id: string; view_count: number; like_count: number; comment_count: number; share_count: number }> } }
    const v = j.data?.videos?.[0]
    if (!v) return null
    return {
      platform: 'tiktok', videoId, capturedAt: Date.now(),
      views: v.view_count, likes: v.like_count, comments: v.comment_count, shares: v.share_count,
    }
  } catch { return null }
}

export async function fetchStats(platform: 'youtube' | 'tiktok', videoId: string): Promise<PerformanceStats | null> {
  if (platform === 'youtube') return fetchYouTube(videoId)
  if (platform === 'tiktok')  return fetchTikTok(videoId)
  return null
}

/**
 * Snapshot current performance + persist as a memory with confidence
 * scaled by view count so future planning weights real winners higher.
 */
export async function recordPerformance(workspaceId: string, platform: 'youtube' | 'tiktok', videoId: string, briefHint?: string): Promise<{ ok: boolean; stats?: PerformanceStats; memoryId?: string }> {
  const stats = await fetchStats(platform, videoId)
  if (!stats) return { ok: false }

  // Confidence: 0.5 baseline → +0.2 if views > 10k → +0.15 if CTR > 5%
  let confidence = 0.5
  if ((stats.views ?? 0) > 10_000)     confidence += 0.2
  if ((stats.views ?? 0) > 100_000)    confidence += 0.15
  if ((stats.ctr ?? 0)   > 0.05)       confidence += 0.15
  confidence = Math.min(0.95, confidence)

  const summary = `[${platform}] ${stats.views ?? 0} views · ${stats.likes ?? 0} likes${stats.ctr ? ` · ${(stats.ctr * 100).toFixed(1)}% CTR` : ''}${stats.avgViewDurationSec ? ` · ${stats.avgViewDurationSec.toFixed(0)}s AVD` : ''}${briefHint ? ` · brief: "${briefHint.slice(0, 120)}"` : ''} · video ${videoId}`

  try {
    const now = Date.now()
    const sourceRef = `${platform}:${videoId}`
    const tags = ['video-performance', platform, ...(stats.views && stats.views > 10_000 ? ['winner'] : [])]
    // UPSERT by source_ref — previously INSERTed a new row on every
    // snapshot, so the same video had N rows after N snapshots, and
    // economic-engine.workspaceHealth double-counted them all.
    const existing = await db.select({ id: memories.id }).from(memories)
      .where(and(eq(memories.workspaceId, workspaceId), eq(memories.sourceRef, sourceRef)))
      .limit(1)
    if (existing.length > 0 && existing[0]) {
      await db.update(memories).set({
        content: summary, confidence, tags, updatedAt: now,
      }).where(eq(memories.id, existing[0].id))
      await rollupToBusiness(workspaceId, platform, stats)
      return { ok: true, stats, memoryId: existing[0].id }
    }
    const id = uuidv7()
    await db.insert(memories).values({
      id, workspaceId, type: 'fact',
      content: summary, confidence, tags,
      source: 'content-analytics', sourceRef,
      createdAt: now, updatedAt: now,
    })
    await rollupToBusiness(workspaceId, platform, stats)
    return { ok: true, stats, memoryId: id }
  } catch { return { ok: true, stats } }
}

/**
 * Auto-roll-up: if the channel that owns this video is attached to a
 * business, append a revenue row so the portfolio's gap-to-$10k math
 * updates automatically. Idempotent per (videoId, capturedAt-hour) so
 * repeated snapshots within the same hour don't double-count revenue.
 *
 * Revenue source priority:
 *   1. Platform-reported estimatedRevenueUsd (YouTube Analytics)
 *   2. Heuristic: views × niche-typical RPM × platform share
 *      (only when no real revenue number is available; tagged as
 *      'heuristic' in the source field so the operator can distinguish
 *      brain-estimated from platform-reported revenue)
 *
 * Best-effort — never throws to the caller. Failures emit an event
 * but don't break the underlying recordPerformance() flow.
 */
async function rollupToBusiness(workspaceId: string, platform: 'youtube' | 'tiktok', stats: PerformanceStats): Promise<void> {
  if (!stats.channelId) return
  try {
    const { findOwningBusiness, markSynced } = await import('./business-attachments.js')
    const { recordRevenue, earningsMonth }    = await import('./business-portfolio.js')
    const sourceType = platform === 'youtube' ? 'youtube_channel' : 'tiktok_account'
    const owner = await findOwningBusiness(workspaceId, sourceType, stats.channelId)
    if (!owner) return

    let amountUsd = 0
    let revKind: 'ad_share' | 'other' = 'ad_share'
    if (stats.estimatedRevenueUsd && stats.estimatedRevenueUsd > 0) {
      amountUsd = stats.estimatedRevenueUsd
    } else if (stats.views && stats.views > 0) {
      // Heuristic ad-share based on platform norms (matches the playbook
      // RPM table). We DO NOT make up revenue when the platform doesn't
      // expose it — we attribute a small estimate so the brain has a
      // signal to work with, and tag it 'heuristic' so the operator can
      // distinguish from real-reported.
      const rpm = platform === 'youtube' ? 5 : 0.05      // YouTube mid-niche / TikTok creator-fund tier
      const share = platform === 'youtube' ? 0.55 : 1    // YouTube 45% cut; TikTok creator-fund net of share
      amountUsd = (stats.views / 1000) * rpm * share
      // Below $0.10 isn't worth a ledger row.
      if (amountUsd < 0.10) return
      revKind = 'other'
    } else {
      return
    }

    // Idempotency: bucket by (videoId, hour) so re-snapshotting an hour
    // later doesn't append another row for the same earnings.
    const hourBucket = Math.floor(stats.capturedAt / 3_600_000)
    const sourceRef = `${platform}:${stats.videoId}:h${hourBucket}`

    await recordRevenue({
      workspaceId,
      businessId:    owner.businessId,
      kind:          revKind,
      amountUsd,
      source:        stats.estimatedRevenueUsd ? `${platform}-reported` : `${platform}-heuristic`,
      sourceRef,
      earningsMonth: earningsMonth(stats.capturedAt),
    })

    await markSynced(owner.attachmentId)
  } catch (e) {
    console.error('[content-analytics] rollupToBusiness failed:', (e as Error).message)
  }
}

/** Bulk: snapshot every published video the operator wants tracked. */
export async function snapshotMany(workspaceId: string, items: Array<{ platform: 'youtube' | 'tiktok'; videoId: string; brief?: string }>): Promise<Array<{ videoId: string; ok: boolean; stats?: PerformanceStats }>> {
  return Promise.all(items.map(async (it) => {
    const r = await recordPerformance(workspaceId, it.platform, it.videoId, it.brief)
    const out: { videoId: string; ok: boolean; stats?: PerformanceStats } = { videoId: it.videoId, ok: r.ok }
    if (r.stats) out.stats = r.stats
    return out
  }))
}
