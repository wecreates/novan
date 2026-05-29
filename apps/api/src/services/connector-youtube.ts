/**
 * connector-youtube.ts — YouTube Data API v3 endpoint wrappers.
 *
 * Builds on connector-base for OAuth + REST plumbing. This module
 * exposes the high-value operator endpoints:
 *
 *   listChannels()         — channels the OAuth token controls
 *   listVideos()           — recent videos for a channel
 *   uploadVideo()          — resumable upload (size-aware)
 *   updateVideoMetadata()  — title/description/tags/thumbnail
 *   schedulePublish()      — set scheduledStartTime
 *   listComments()         — comment threads for a video
 *   replyToComment()       — reply to a comment (always operator-confirmed)
 *   moderateComment()      — set moderation status
 *   getAnalytics()         — basic views/watch-time/CTR
 *
 * Honest scope:
 *   - "uploadVideo" implementation here returns the resumable-upload
 *     URL the caller hits with the actual file body. Streaming the
 *     video bytes is the caller's responsibility (the upload may be
 *     gigabytes — we don't want to buffer in this service).
 *   - All write operations route through brain-task at risk=high so
 *     the policy engine + approval flow gates them.
 *   - YouTube Analytics API is a separate API (youtubeAnalytics.v2) —
 *     this module includes a thin wrapper but it's per-channel scoped.
 *
 * Quota: YouTube Data API has daily quota units. Reads cost 1 unit;
 * uploads cost 1,600 units; updates cost 50; comment inserts cost 50.
 * Default project gets 10,000/day. We track usage via ai_usage where
 * possible so operators can spot quota pressure.
 */
import { connectorRequest, getConnectorSpec } from './connector-base.js'
import { recordAiUsage } from './ai-cost-tracker.js'

type AccessTokenInput = { workspaceId: string; accessToken: string }

const YT = getConnectorSpec('youtube')!

function quotaCost(units: number): void {
  // Approximate dollar cost is $0 (quota is hard-capped, not metered)
  // but we record events so the operator dashboard tracks consumption.
  // costUsd=0 means it shows up as quota-unit ledger without dollar drag.
  recordAiUsage({
    workspaceId:  'youtube-quota',
    provider:     'youtube',
    model:        'data-v3',
    promptTokens: 0,
    outputTokens: units,          // overload: outputTokens = quota units
    costUsd:      0,
    latencyMs:    0,
    taskType:     'other',
  })
}

// ─── Channel + video reads ─────────────────────────────────────────
export async function listChannels(input: AccessTokenInput): Promise<unknown> {
  quotaCost(1)
  return connectorRequest({
    spec:        YT,
    accessToken: input.accessToken,
    path:        '/channels',
    query:       { part: 'snippet,statistics,contentDetails', mine: 'true', maxResults: 50 },
  })
}

export async function listVideos(input: AccessTokenInput & { channelId: string; maxResults?: number }): Promise<unknown> {
  quotaCost(1)
  // First fetch uploads playlist id from contentDetails.
  const ch = await connectorRequest({
    spec:        YT,
    accessToken: input.accessToken,
    path:        '/channels',
    query:       { part: 'contentDetails', id: input.channelId },
  })
  if (!ch.ok) return ch
  const uploads = (ch.data as { items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }> })
    .items?.[0]?.contentDetails?.relatedPlaylists?.uploads
  if (!uploads) return { ok: false, error: 'no uploads playlist found on channel' }
  // Then list playlistItems.
  quotaCost(1)
  return connectorRequest({
    spec:        YT,
    accessToken: input.accessToken,
    path:        '/playlistItems',
    query:       { part: 'snippet,contentDetails', playlistId: uploads, maxResults: input.maxResults ?? 25 },
  })
}

// ─── Upload (resumable) ────────────────────────────────────────────
export interface UploadRequest {
  workspaceId:  string
  accessToken:  string
  title:        string
  description:  string
  tags?:        string[]
  categoryId?:  string       // YouTube category, e.g. '22' = People & Blogs
  privacyStatus: 'private' | 'public' | 'unlisted'
  /** ISO 8601 UTC time; sets scheduled publish if privacyStatus='private'. */
  publishAt?:    string
  /** File size in bytes — needed for the resumable upload init. */
  fileSizeBytes: number
  /** MIME of the video file. Usually video/mp4. */
  mimeType:      string
  /** Set this to OPERATOR_APPROVED to actually invoke the network call. */
  approvalToken?: string
}

/** Initialise a resumable upload. Returns the URL the caller streams
 *  the file body to via subsequent PUT requests. */
export async function initUpload(input: UploadRequest): Promise<{ ok: true; uploadUrl: string; quotaUnits: number } | { ok: false; error: string }> {
  if (input.approvalToken !== 'OPERATOR_APPROVED') {
    return { ok: false, error: 'YouTube upload requires approval_token="OPERATOR_APPROVED"; operator must explicitly confirm' }
  }
  if (input.fileSizeBytes <= 0 || input.fileSizeBytes > 256 * 1024 * 1024 * 1024) {
    return { ok: false, error: `fileSizeBytes ${input.fileSizeBytes} out of supported range (1 byte to 256 GB)` }
  }

  // Resumable upload uses the uploads.googleapis.com host, not the
  // standard googleapis.com. Build URL manually.
  const url = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status'
  const metadata = {
    snippet: {
      title:       input.title.slice(0, 100),
      description: input.description.slice(0, 5_000),
      tags:        (input.tags ?? []).slice(0, 30).map(t => t.slice(0, 30)),
      categoryId:  input.categoryId ?? '22',
    },
    status: {
      privacyStatus: input.privacyStatus,
      ...(input.publishAt ? { publishAt: input.publishAt } : {}),
      selfDeclaredMadeForKids: false,
    },
  }
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization':         `Bearer ${input.accessToken}`,
      'Content-Type':          'application/json; charset=UTF-8',
      'X-Upload-Content-Type': input.mimeType,
      'X-Upload-Content-Length': String(input.fileSizeBytes),
    },
    body: JSON.stringify(metadata),
  }).catch(e => ({ ok: false, status: 0, headers: new Headers(), error: (e as Error).message }))
  if (!('ok' in r) || !r.ok) return { ok: false, error: `YouTube init failed (status ${(r as Response).status ?? 'network'})` }
  const uploadUrl = (r as Response).headers.get('location')
  if (!uploadUrl) return { ok: false, error: 'YouTube did not return upload URL — check scopes (youtube.upload)' }
  quotaCost(1_600)
  return { ok: true, uploadUrl, quotaUnits: 1_600 }
}

// ─── Update metadata / schedule publish ────────────────────────────
export async function updateVideoMetadata(input: AccessTokenInput & {
  videoId:       string
  title?:        string
  description?:  string
  tags?:         string[]
  publishAt?:    string
  privacyStatus?: 'private' | 'public' | 'unlisted'
  approvalToken?: string
}): Promise<unknown> {
  if (input.approvalToken !== 'OPERATOR_APPROVED') {
    return { ok: false, error: 'updateVideoMetadata requires approval_token="OPERATOR_APPROVED"' }
  }
  const body: Record<string, unknown> = { id: input.videoId }
  const snippetParts: Record<string, unknown> = {}
  if (input.title)       snippetParts['title']       = input.title.slice(0, 100)
  if (input.description) snippetParts['description'] = input.description.slice(0, 5_000)
  if (input.tags)        snippetParts['tags']        = input.tags.slice(0, 30)
  if (Object.keys(snippetParts).length > 0) {
    // YouTube requires categoryId when updating snippet — fetch existing first.
    const existing = await connectorRequest({
      spec:        YT,
      accessToken: input.accessToken,
      path:        '/videos',
      query:       { part: 'snippet', id: input.videoId },
    })
    quotaCost(1)
    if (!existing.ok) return existing
    const cat = (existing.data as { items?: Array<{ snippet?: { categoryId?: string } }> }).items?.[0]?.snippet?.categoryId ?? '22'
    body['snippet'] = { ...snippetParts, categoryId: cat }
  }
  const statusParts: Record<string, unknown> = {}
  if (input.privacyStatus) statusParts['privacyStatus'] = input.privacyStatus
  if (input.publishAt)     statusParts['publishAt']     = input.publishAt
  if (Object.keys(statusParts).length > 0) body['status'] = statusParts

  const parts: string[] = []
  if (body['snippet']) parts.push('snippet')
  if (body['status'])  parts.push('status')
  if (parts.length === 0) return { ok: false, error: 'no metadata fields to update' }

  quotaCost(50)
  return connectorRequest({
    spec:        YT,
    accessToken: input.accessToken,
    path:        '/videos',
    method:      'PUT',
    query:       { part: parts.join(',') },
    body,
  })
}

export async function schedulePublish(input: AccessTokenInput & {
  videoId:    string
  publishAt:  string                // ISO 8601 UTC
  approvalToken?: string
}): Promise<unknown> {
  return updateVideoMetadata({
    workspaceId:   input.workspaceId,
    accessToken:   input.accessToken,
    videoId:       input.videoId,
    publishAt:     input.publishAt,
    privacyStatus: 'private',       // must be private for scheduled publish
    ...(input.approvalToken ? { approvalToken: input.approvalToken } : {}),
  })
}

// ─── Comments ──────────────────────────────────────────────────────
export async function listComments(input: AccessTokenInput & { videoId: string; maxResults?: number }): Promise<unknown> {
  quotaCost(1)
  return connectorRequest({
    spec:        YT,
    accessToken: input.accessToken,
    path:        '/commentThreads',
    query:       { part: 'snippet,replies', videoId: input.videoId, maxResults: input.maxResults ?? 50 },
  })
}

export async function replyToComment(input: AccessTokenInput & {
  parentCommentId:  string
  text:             string
  approvalToken?:   string
}): Promise<unknown> {
  if (input.approvalToken !== 'OPERATOR_APPROVED') {
    return { ok: false, error: 'replyToComment requires approval_token="OPERATOR_APPROVED" — community-management policy + human tone review' }
  }
  if (input.text.length > 10_000) return { ok: false, error: 'comment too long (max 10000 chars)' }
  quotaCost(50)
  return connectorRequest({
    spec:        YT,
    accessToken: input.accessToken,
    path:        '/comments',
    method:      'POST',
    query:       { part: 'snippet' },
    body: {
      snippet: {
        parentId:     input.parentCommentId,
        textOriginal: input.text,
      },
    },
  })
}

export async function moderateComment(input: AccessTokenInput & {
  commentId:        string
  moderationStatus: 'published' | 'heldForReview' | 'rejected'
  banAuthor?:       boolean
  approvalToken?:   string
}): Promise<unknown> {
  if (input.approvalToken !== 'OPERATOR_APPROVED') {
    return { ok: false, error: 'moderateComment requires approval_token="OPERATOR_APPROVED"' }
  }
  quotaCost(50)
  return connectorRequest({
    spec:        YT,
    accessToken: input.accessToken,
    path:        '/comments/setModerationStatus',
    method:      'POST',
    query:       {
      id:               input.commentId,
      moderationStatus: input.moderationStatus,
      ...(input.banAuthor ? { banAuthor: 'true' } : {}),
    },
  })
}

// ─── Analytics (separate API host) ─────────────────────────────────
/** Fetch basic analytics — uses youtubeAnalytics.v2 host so we issue
 *  the request manually rather than via connectorRequest (different
 *  baseUrl). */
export async function getAnalytics(input: AccessTokenInput & {
  channelId:  string
  startDate:  string     // YYYY-MM-DD
  endDate:    string
  metrics?:   string     // default: views,estimatedMinutesWatched,averageViewDuration,subscribersGained
}): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const url = new URL('https://youtubeanalytics.googleapis.com/v2/reports')
  url.searchParams.set('ids',        `channel==${input.channelId}`)
  url.searchParams.set('startDate',  input.startDate)
  url.searchParams.set('endDate',    input.endDate)
  url.searchParams.set('metrics',    input.metrics ?? 'views,estimatedMinutesWatched,averageViewDuration,subscribersGained')
  url.searchParams.set('dimensions', 'day')
  const r = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${input.accessToken}` },
  }).catch(e => ({ ok: false, status: 0, text: () => Promise.resolve(`network: ${(e as Error).message}`) }))
  if (!('ok' in r) || !r.ok) return { ok: false, error: `analytics failed (status ${(r as Response).status ?? 'network'})` }
  quotaCost(1)
  return { ok: true, data: await (r as Response).json().catch(() => ({})) }
}
