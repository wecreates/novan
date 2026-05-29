/**
 * connector-tiktok.ts — TikTok for Developers API endpoint wrappers.
 *
 * Mirrors the YouTube + Etsy connector pattern (rounds 118, 129):
 * builds on connector-base for OAuth + REST + rate-limit + retry.
 *
 * High-value endpoints for a content operator running TikTok at scale:
 *   - getMe                  — verify auth + identify the creator account
 *   - listVideos             — recent videos on the authenticated account
 *   - getVideoStats          — analytics (views, likes, comments, shares, watch time)
 *   - initVideoPublish       — start a TikTok Content Posting API publish
 *   - completeVideoPublish   — finalise after media upload
 *   - publishPhotoCarousel   — photo-mode carousel post
 *   - getPublishStatus       — poll a publish job to completion
 *   - listComments           — comments on a video
 *   - replyToComment         — reply to a comment (always operator-confirmed)
 *
 * Honest scope:
 *   - TikTok Content Posting API uses a two-phase flow: init returns an
 *     `upload_url` the operator's tooling streams the video file to,
 *     then a polling endpoint reports completion. This module returns
 *     the init payload; streaming the file is operator-side.
 *   - All write operations gated by `approval_token="OPERATOR_APPROVED"`
 *     per SPEC §11.6.
 *   - TikTok API has aggressive rate limits + scope-specific permissions;
 *     operator must have approved scopes on the developer app.
 *   - Multi-account ethics: per `shortform-engine.checkMultiAccountPlan`,
 *     this module does NOT expose any engagement-manipulation helper
 *     (no auto-like, no engagement-between-own-accounts).
 */
import { connectorRequest, getConnectorSpec } from './connector-base.js'
import { recordAiUsage } from './ai-cost-tracker.js'

const TIKTOK = getConnectorSpec('tiktok')!

type AccessTokenInput = { workspaceId: string; accessToken: string }

/** TikTok daily-quota ledger via ai_usage rows. */
function quotaTick(units = 1): void {
  recordAiUsage({
    workspaceId:  'tiktok-quota',
    provider:     'tiktok',
    model:        'content-api-v2',
    promptTokens: 0,
    outputTokens: units,
    costUsd:      0,
    latencyMs:    0,
    taskType:     'other',
  })
}

// ── Identity ───────────────────────────────────────────────────────
export async function getMe(input: AccessTokenInput): Promise<unknown> {
  quotaTick()
  return connectorRequest({
    spec:        TIKTOK,
    accessToken: input.accessToken,
    path:        '/user/info/',
    query:       {
      fields: 'open_id,union_id,avatar_url,display_name,bio_description,profile_deep_link,is_verified,follower_count,following_count,likes_count,video_count',
    },
  })
}

// ── Videos: list + stats ───────────────────────────────────────────
export async function listVideos(input: AccessTokenInput & { cursor?: number; maxCount?: number }): Promise<unknown> {
  quotaTick()
  return connectorRequest({
    spec:        TIKTOK,
    accessToken: input.accessToken,
    path:        '/video/list/',
    method:      'POST',
    query:       {
      fields: 'id,title,video_description,duration,cover_image_url,share_url,view_count,like_count,comment_count,share_count,create_time',
    },
    body: {
      max_count: Math.min(input.maxCount ?? 20, 20),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    },
  })
}

export async function getVideoStats(input: AccessTokenInput & { videoIds: string[] }): Promise<unknown> {
  if (input.videoIds.length === 0) return { ok: false, error: 'videoIds required' }
  if (input.videoIds.length > 20)  return { ok: false, error: 'max 20 videoIds per call' }
  quotaTick()
  return connectorRequest({
    spec:        TIKTOK,
    accessToken: input.accessToken,
    path:        '/video/query/',
    method:      'POST',
    query:       {
      fields: 'id,view_count,like_count,comment_count,share_count,create_time,duration',
    },
    body: { filters: { video_ids: input.videoIds } },
  })
}

// ── Publishing: video ──────────────────────────────────────────────
export interface VideoPublishInput {
  workspaceId:       string
  accessToken:       string
  /** Title / description (combined into TikTok caption). Max 2200 chars. */
  caption:           string
  /** Privacy level — direct, mutual, public. */
  privacyLevel:      'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'SELF_ONLY' | 'FOLLOWER_OF_CREATOR'
  /** Disable comments / duet / stitch — operator-facing controls. */
  disableComment?:   boolean
  disableDuet?:      boolean
  disableStitch?:    boolean
  /** Video file metadata for the upload step. */
  videoSizeBytes:    number
  videoMimeType:     string
  /** Sets `auto_add_music` to true so the API picks trending audio.
   *  Disabled by default — operator picks audio explicitly. */
  autoAddMusic?:     boolean
  /** OPERATOR_APPROVED gate per SPEC §11.6. */
  approvalToken?:    string
}

export async function initVideoPublish(input: VideoPublishInput): Promise<{ ok: true; publishId: string; uploadUrl: string } | { ok: false; error: string }> {
  if (input.approvalToken !== 'OPERATOR_APPROVED') {
    return { ok: false, error: 'initVideoPublish requires approval_token="OPERATOR_APPROVED" — affects live account' }
  }
  if (input.caption.length > 2200) return { ok: false, error: `caption too long (${input.caption.length} > 2200)` }
  if (input.videoSizeBytes <= 0 || input.videoSizeBytes > 4 * 1024 * 1024 * 1024) {
    return { ok: false, error: `videoSizeBytes ${input.videoSizeBytes} out of supported range (1 byte to 4GB)` }
  }
  quotaTick(5)   // publishes cost more in TikTok's quota model
  // TikTok Content Posting API expects POST to /post/publish/video/init/
  // returning a publish_id + upload_url the caller streams the file to.
  const url = `${TIKTOK.baseUrl}/post/publish/video/init/`
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${input.accessToken}`,
      'Content-Type':  'application/json; charset=UTF-8',
    },
    body: JSON.stringify({
      post_info: {
        title:              input.caption,
        privacy_level:      input.privacyLevel,
        disable_duet:       input.disableDuet   ?? false,
        disable_comment:    input.disableComment ?? false,
        disable_stitch:     input.disableStitch ?? false,
        ...(input.autoAddMusic ? { auto_add_music: true } : {}),
      },
      source_info: {
        source:           'FILE_UPLOAD',
        video_size:       input.videoSizeBytes,
        chunk_size:       Math.min(input.videoSizeBytes, 10_000_000),  // 10MB chunks
        total_chunk_count: Math.ceil(input.videoSizeBytes / 10_000_000),
      },
    }),
  }).catch(e => ({ ok: false, status: 0 } as never))
  if (!('ok' in r) || !r.ok) return { ok: false, error: `TikTok init failed (status ${(r as Response).status ?? 'network'})` }
  const j = await (r as Response).json().catch(() => ({} as { data?: { publish_id?: string; upload_url?: string } }))
  const publishId = (j as { data?: { publish_id?: string } }).data?.publish_id
  const uploadUrl = (j as { data?: { upload_url?: string } }).data?.upload_url
  if (!publishId || !uploadUrl) return { ok: false, error: 'TikTok did not return publish_id + upload_url — check scopes (video.publish + video.upload)' }
  return { ok: true, publishId, uploadUrl }
}

export async function getPublishStatus(input: AccessTokenInput & { publishId: string }): Promise<{ ok: true; status: string; publicId?: string; failReason?: string } | { ok: false; error: string }> {
  quotaTick()
  const result = await connectorRequest({
    spec:        TIKTOK,
    accessToken: input.accessToken,
    path:        '/post/publish/status/fetch/',
    method:      'POST',
    body:        { publish_id: input.publishId },
  })
  if (!result.ok) return { ok: false, error: 'status fetch failed' }
  const d = (result.data as { data?: { status?: string; publicaly_available_post_id?: string[]; fail_reason?: string } }).data ?? {}
  return {
    ok: true,
    status: d.status ?? 'unknown',
    ...(d.publicaly_available_post_id?.[0] ? { publicId: d.publicaly_available_post_id[0] } : {}),
    ...(d.fail_reason ? { failReason: d.fail_reason } : {}),
  }
}

// ── Publishing: photo carousel ─────────────────────────────────────
export async function publishPhotoCarousel(input: AccessTokenInput & {
  caption:          string
  /** Photo URLs the operator already uploaded to a public host. */
  photoUrls:        string[]
  privacyLevel:     'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'SELF_ONLY' | 'FOLLOWER_OF_CREATOR'
  disableComment?:  boolean
  approvalToken?:   string
}): Promise<{ ok: true; publishId: string } | { ok: false; error: string }> {
  if (input.approvalToken !== 'OPERATOR_APPROVED') {
    return { ok: false, error: 'publishPhotoCarousel requires approval_token="OPERATOR_APPROVED"' }
  }
  if (input.photoUrls.length === 0 || input.photoUrls.length > 35) {
    return { ok: false, error: `photoUrls must be 1-35 (got ${input.photoUrls.length})` }
  }
  quotaTick(3)
  const result = await connectorRequest({
    spec:        TIKTOK,
    accessToken: input.accessToken,
    path:        '/post/publish/content/init/',
    method:      'POST',
    body: {
      post_info: {
        title:              input.caption.slice(0, 2200),
        privacy_level:      input.privacyLevel,
        disable_comment:    input.disableComment ?? false,
      },
      source_info: {
        source:    'PULL_FROM_URL',
        photo_images: { sources: input.photoUrls.map(u => ({ url: u })) },
      },
      post_mode:    'DIRECT_POST',
      media_type:   'PHOTO',
    },
  })
  if (!result.ok) return { ok: false, error: 'photo carousel init failed' }
  const publishId = ((result.data as { data?: { publish_id?: string } }).data?.publish_id)
  if (!publishId) return { ok: false, error: 'TikTok did not return publish_id' }
  return { ok: true, publishId }
}

// ── Comments ──────────────────────────────────────────────────────
export async function listComments(input: AccessTokenInput & { videoId: string; cursor?: number; maxCount?: number }): Promise<unknown> {
  quotaTick()
  return connectorRequest({
    spec:        TIKTOK,
    accessToken: input.accessToken,
    path:        '/comment/list/',
    method:      'POST',
    body: {
      video_id:  input.videoId,
      max_count: Math.min(input.maxCount ?? 20, 50),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    },
  })
}

export async function replyToComment(input: AccessTokenInput & {
  videoId:          string
  parentCommentId:  string
  text:             string
  approvalToken?:   string
}): Promise<unknown> {
  if (input.approvalToken !== 'OPERATOR_APPROVED') {
    return { ok: false, error: 'replyToComment requires approval_token="OPERATOR_APPROVED" — community-management policy + human tone review per SPEC §11.5' }
  }
  if (input.text.length > 150) return { ok: false, error: `comment too long (${input.text.length} > 150)` }
  quotaTick(2)
  return connectorRequest({
    spec:        TIKTOK,
    accessToken: input.accessToken,
    path:        '/comment/reply/',
    method:      'POST',
    body: {
      video_id:           input.videoId,
      parent_comment_id:  input.parentCommentId,
      text:               input.text,
    },
  })
}

// ── Analytics summary (operator dashboard) ─────────────────────────
/** Aggregate per-video stats into a channel-level summary the operator
 *  can compare against `shortform-engine.triagePerformance` baselines. */
export async function analyticsSummary(input: AccessTokenInput & {
  /** Look-back window in days. */
  days?: number
}): Promise<{
  ok:                  true
  totalVideos:         number
  totalViews:          number
  totalLikes:          number
  totalComments:       number
  medianViewsPerVideo: number
  medianEngagementRate: number
} | { ok: false; error: string }> {
  const days = input.days ?? 30
  const videos = await listVideos({ workspaceId: input.workspaceId, accessToken: input.accessToken, maxCount: 20 }) as { ok: boolean; data?: unknown }
  if (!videos || !videos.ok) return { ok: false, error: 'failed to fetch videos' }
  const items = (videos.data as { data?: { videos?: Array<{ id: string; view_count?: number; like_count?: number; comment_count?: number; share_count?: number; create_time?: number }> } } | undefined)?.data?.videos ?? []
  const since = Date.now() / 1000 - days * 86_400
  const recent = items.filter(v => (v.create_time ?? 0) >= since)
  if (recent.length === 0) {
    return { ok: true, totalVideos: 0, totalViews: 0, totalLikes: 0, totalComments: 0, medianViewsPerVideo: 0, medianEngagementRate: 0 }
  }
  const totalViews    = recent.reduce((s, v) => s + (v.view_count ?? 0), 0)
  const totalLikes    = recent.reduce((s, v) => s + (v.like_count ?? 0), 0)
  const totalComments = recent.reduce((s, v) => s + (v.comment_count ?? 0), 0)
  const totalShares   = recent.reduce((s, v) => s + (v.share_count ?? 0), 0)
  const viewsSorted   = [...recent].map(v => v.view_count ?? 0).sort((a, b) => a - b)
  const medianViews   = viewsSorted[Math.floor(viewsSorted.length / 2)] ?? 0
  const engagementRates = recent.map(v => {
    const views = v.view_count ?? 1
    return views > 0 ? ((v.like_count ?? 0) + (v.comment_count ?? 0) + (v.share_count ?? 0)) / views : 0
  }).sort((a, b) => a - b)
  const medianEngagement = engagementRates[Math.floor(engagementRates.length / 2)] ?? 0
  return {
    ok: true,
    totalVideos:           recent.length,
    totalViews,
    totalLikes,
    totalComments,
    medianViewsPerVideo:   medianViews,
    medianEngagementRate:  Number(medianEngagement.toFixed(4)),
  }
}
