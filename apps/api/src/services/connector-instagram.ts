/**
 * connector-instagram.ts — Instagram Graph API (via Meta) wrappers.
 *
 * Completes the short-form trio (TikTok + YouTube Shorts + IG Reels)
 * + Instagram-specific surfaces (feed posts, Stories, carousels).
 * Mirrors the YouTube/Etsy/TikTok pattern from rounds 118/129/117.
 *
 * Instagram uses Meta's Graph API. Operator needs:
 *   - Meta developer app + Instagram Basic Display OR Instagram Graph API permissions
 *   - The account must be a Business or Creator account (personal accounts
 *     can't use the Graph API for content publishing)
 *   - Scopes: instagram_basic, instagram_content_publish,
 *     instagram_manage_comments, pages_show_list, pages_read_engagement
 *
 * High-value endpoints exposed:
 *   - getAccount             — verify auth + identify IG account
 *   - listMedia              — recent posts (feed + Reels + carousels)
 *   - getMediaInsights       — per-post analytics
 *   - createMediaContainer   — two-phase publish phase 1
 *   - publishMediaContainer  — two-phase publish phase 2
 *   - publishCarousel        — multi-image carousel
 *   - listComments           — comments on a post
 *   - replyToComment         — operator-confirmed reply
 *   - hideComment            — moderate without deleting
 *   - listStories            — recent Stories
 *
 * Honest scope:
 *   - Stories publishing via Graph API is permission-gated by Meta and
 *     not granted to all apps. This module exposes the call but operator
 *     must have the right Meta App Review approval.
 *   - All write operations gated by `approval_token="OPERATOR_APPROVED"`
 *     per SPEC §11.6.
 *   - Multi-account ethics: per SPEC §11.5, no engagement-manipulation
 *     helpers (no auto-like, no engagement between own accounts).
 */
import { connectorRequest, getConnectorSpec } from './connector-base.js'
import { recordAiUsage } from './ai-cost-tracker.js'

const IG = getConnectorSpec('instagram')!

type AccessTokenInput = { workspaceId: string; accessToken: string; igUserId: string }

function quotaTick(units = 1): void {
  recordAiUsage({
    workspaceId:  'instagram-quota',
    provider:     'meta',
    model:        'graph-api-v21',
    promptTokens: 0,
    outputTokens: units,
    costUsd:      0,
    latencyMs:    0,
    taskType:     'other',
  })
}

// ── Account ────────────────────────────────────────────────────────
export async function getAccount(input: { workspaceId: string; accessToken: string; igUserId: string }): Promise<unknown> {
  quotaTick()
  return connectorRequest({
    spec:        IG,
    accessToken: input.accessToken,
    path:        `/${input.igUserId}`,
    query:       {
      fields: 'id,username,name,profile_picture_url,followers_count,follows_count,media_count,biography',
    },
  })
}

// ── Media (posts + Reels + carousels) ──────────────────────────────
export async function listMedia(input: AccessTokenInput & { limit?: number; afterCursor?: string }): Promise<unknown> {
  quotaTick()
  return connectorRequest({
    spec:        IG,
    accessToken: input.accessToken,
    path:        `/${input.igUserId}/media`,
    query: {
      fields:    'id,media_type,media_url,permalink,thumbnail_url,caption,timestamp,like_count,comments_count,is_comment_enabled,media_product_type',
      limit:     Math.min(input.limit ?? 25, 100),
      ...(input.afterCursor ? { after: input.afterCursor } : {}),
    },
  })
}

export async function getMediaInsights(input: AccessTokenInput & { mediaId: string; metrics?: string }): Promise<unknown> {
  quotaTick()
  // Reels metrics vs feed-post metrics differ; default covers both safely.
  const metrics = input.metrics ?? 'impressions,reach,saved,video_views,plays,shares,total_interactions,likes,comments'
  return connectorRequest({
    spec:        IG,
    accessToken: input.accessToken,
    path:        `/${input.mediaId}/insights`,
    query:       { metric: metrics },
  })
}

// ── Publishing: single media (image / video / Reel) ────────────────
export interface CreateMediaInput {
  workspaceId:    string
  accessToken:    string
  igUserId:       string
  /** Media type the operator's publishing. */
  mediaType:      'IMAGE' | 'VIDEO' | 'REELS' | 'STORIES'
  /** Image: image_url. Video / Reel / Story: video_url. */
  url:            string
  caption?:       string           // not used for STORIES
  /** Reel-specific: cover image url + share-to-feed. */
  coverUrl?:      string
  shareToFeed?:   boolean
  /** Stories — sticker overlays + link sticker (operator's URL). */
  linkUrl?:       string
  approvalToken?: string
}

export async function createMediaContainer(input: CreateMediaInput): Promise<{ ok: true; containerId: string } | { ok: false; error: string }> {
  if (input.approvalToken !== 'OPERATOR_APPROVED') {
    return { ok: false, error: 'createMediaContainer requires approval_token="OPERATOR_APPROVED"' }
  }
  if (input.caption && input.caption.length > 2200) {
    return { ok: false, error: `caption too long (${input.caption.length} > 2200)` }
  }
  quotaTick(3)
  const body: Record<string, unknown> = {
    media_type: input.mediaType,
  }
  if (input.mediaType === 'IMAGE') body['image_url'] = input.url
  else                              body['video_url'] = input.url
  if (input.caption && input.mediaType !== 'STORIES') body['caption'] = input.caption
  if (input.mediaType === 'REELS') {
    if (input.coverUrl)     body['cover_url']     = input.coverUrl
    if (input.shareToFeed !== undefined) body['share_to_feed'] = input.shareToFeed
  }
  if (input.mediaType === 'STORIES' && input.linkUrl) {
    // Story stickers require additional permission; surface as-is.
    body['link_sticker'] = { url: input.linkUrl }
  }

  const result = await connectorRequest({
    spec:        IG,
    accessToken: input.accessToken,
    path:        `/${input.igUserId}/media`,
    method:      'POST',
    body,
  })
  if (!result.ok) return { ok: false, error: 'create container failed' }
  const containerId = (result.data as { id?: string }).id
  if (!containerId) return { ok: false, error: 'Instagram did not return container id — check media url + permissions' }
  return { ok: true, containerId }
}

export async function publishMediaContainer(input: AccessTokenInput & {
  containerId:    string
  approvalToken?: string
}): Promise<{ ok: true; mediaId: string } | { ok: false; error: string }> {
  if (input.approvalToken !== 'OPERATOR_APPROVED') {
    return { ok: false, error: 'publishMediaContainer requires approval_token="OPERATOR_APPROVED"' }
  }
  quotaTick(2)
  const result = await connectorRequest({
    spec:        IG,
    accessToken: input.accessToken,
    path:        `/${input.igUserId}/media_publish`,
    method:      'POST',
    body:        { creation_id: input.containerId },
  })
  if (!result.ok) return { ok: false, error: 'publish failed' }
  const mediaId = (result.data as { id?: string }).id
  if (!mediaId) return { ok: false, error: 'Instagram did not return media id — media may not be ready (poll status)' }
  return { ok: true, mediaId }
}

/** Get container status — for polling the create→publish gap.
 *  Video / Reel containers take seconds-to-minutes to process. */
export async function getContainerStatus(input: AccessTokenInput & { containerId: string }): Promise<unknown> {
  quotaTick()
  return connectorRequest({
    spec:        IG,
    accessToken: input.accessToken,
    path:        `/${input.containerId}`,
    query:       { fields: 'status_code,status' },
  })
}

// ── Publishing: carousel (multi-image) ─────────────────────────────
export async function publishCarousel(input: AccessTokenInput & {
  caption?:       string
  /** Pre-uploaded image URLs (operator hosts publicly accessible). */
  imageUrls:      string[]
  approvalToken?: string
}): Promise<{ ok: true; mediaId: string } | { ok: false; error: string }> {
  if (input.approvalToken !== 'OPERATOR_APPROVED') {
    return { ok: false, error: 'publishCarousel requires approval_token="OPERATOR_APPROVED"' }
  }
  if (input.imageUrls.length < 2 || input.imageUrls.length > 10) {
    return { ok: false, error: `carousel needs 2-10 images (got ${input.imageUrls.length})` }
  }

  // Step 1 — create container per image, marked as carousel item.
  const childIds: string[] = []
  for (const url of input.imageUrls) {
    quotaTick(2)
    const child = await connectorRequest({
      spec:        IG,
      accessToken: input.accessToken,
      path:        `/${input.igUserId}/media`,
      method:      'POST',
      body: { image_url: url, is_carousel_item: true },
    })
    if (!child.ok) return { ok: false, error: 'carousel child creation failed' }
    const id = (child.data as { id?: string }).id
    if (!id) return { ok: false, error: 'child container missing id' }
    childIds.push(id)
  }

  // Step 2 — create parent carousel container.
  quotaTick(2)
  const parent = await connectorRequest({
    spec:        IG,
    accessToken: input.accessToken,
    path:        `/${input.igUserId}/media`,
    method:      'POST',
    body: {
      media_type:  'CAROUSEL',
      children:    childIds.join(','),
      ...(input.caption ? { caption: input.caption } : {}),
    },
  })
  if (!parent.ok) return { ok: false, error: 'carousel parent creation failed' }
  const parentId = (parent.data as { id?: string }).id
  if (!parentId) return { ok: false, error: 'parent container missing id' }

  // Step 3 — publish.
  return publishMediaContainer({
    workspaceId:   input.workspaceId,
    accessToken:   input.accessToken,
    igUserId:      input.igUserId,
    containerId:   parentId,
    approvalToken: input.approvalToken,
  })
}

// ── Comments ──────────────────────────────────────────────────────
export async function listComments(input: AccessTokenInput & { mediaId: string; limit?: number }): Promise<unknown> {
  quotaTick()
  return connectorRequest({
    spec:        IG,
    accessToken: input.accessToken,
    path:        `/${input.mediaId}/comments`,
    query: {
      fields: 'id,text,username,timestamp,like_count,parent_id,replies,hidden',
      limit:  Math.min(input.limit ?? 50, 100),
    },
  })
}

export async function replyToComment(input: AccessTokenInput & {
  commentId:      string
  text:           string
  approvalToken?: string
}): Promise<unknown> {
  if (input.approvalToken !== 'OPERATOR_APPROVED') {
    return { ok: false, error: 'replyToComment requires approval_token="OPERATOR_APPROVED" — community management policy + human tone review per SPEC §11.5' }
  }
  if (input.text.length > 2200) return { ok: false, error: `reply too long (${input.text.length} > 2200)` }
  quotaTick(2)
  return connectorRequest({
    spec:        IG,
    accessToken: input.accessToken,
    path:        `/${input.commentId}/replies`,
    method:      'POST',
    body:        { message: input.text },
  })
}

export async function hideComment(input: AccessTokenInput & {
  commentId:      string
  hide:           boolean
  approvalToken?: string
}): Promise<unknown> {
  if (input.approvalToken !== 'OPERATOR_APPROVED') {
    return { ok: false, error: 'hideComment requires approval_token="OPERATOR_APPROVED"' }
  }
  quotaTick(2)
  return connectorRequest({
    spec:        IG,
    accessToken: input.accessToken,
    path:        `/${input.commentId}`,
    method:      'POST',
    body:        { hide: input.hide },
  })
}

// ── Stories ────────────────────────────────────────────────────────
export async function listStories(input: AccessTokenInput): Promise<unknown> {
  quotaTick()
  return connectorRequest({
    spec:        IG,
    accessToken: input.accessToken,
    path:        `/${input.igUserId}/stories`,
    query:       { fields: 'id,media_type,media_url,permalink,timestamp' },
  })
}
