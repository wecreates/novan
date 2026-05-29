/**
 * video-publisher.ts — upload + schedule produced videos.
 *
 * Platforms:
 *   • YouTube       — Google Data API v3 (token-based; operator authorizes once)
 *   • TikTok        — Content Posting API (token-based via TIKTOK_ACCESS_TOKEN)
 *   • Instagram     — Graph API (via IG_ACCESS_TOKEN; container → publish flow)
 *
 * Each platform method:
 *   1. validates auth token
 *   2. generates metadata if not supplied (title/description/tags via LLM)
 *   3. uploads + returns publish URL
 *
 * NEVER auto-publishes without explicit operator approval (publish.confirm
 * flag in the input) — this is the brain's hard rule for irreversible
 * outbound actions.
 */

import { createReadStream, existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

export interface PublishInput {
  videoPath:     string
  title?:        string
  description?:  string
  tags?:         string[]
  /** Required for posting — operator-confirmation gate. */
  confirm:       true
  /** Schedule for ISO datetime instead of immediate publish. */
  publishAt?:    string
  /** 'public' | 'private' | 'unlisted' */
  privacy?:      'public' | 'private' | 'unlisted'
  workspaceId?:  string
  // ── Per-call token override (used by channel-manager for multi-account
  //    publishes). Without these we fall back to process.env reads.
  youtubeAccessToken?: string
  tiktokAccessToken?:  string
  igAccessToken?:      string
  igUserId?:           string
}

export interface PublishResult {
  ok:        boolean
  platform:  string
  videoId?:  string
  url?:      string
  scheduled?: boolean
  error?:    string
}

// ─── LLM metadata generator ────────────────────────────────────────────
async function generateMetadata(videoPath: string, workspaceId: string): Promise<{ title: string; description: string; tags: string[] }> {
  // Get the first 30s of caption via Whisper for context
  try {
    const { transcribeToSrt } = await import('./caption-service.js')
    const tr = await transcribeToSrt(videoPath)
    const transcriptSnippet = (tr.segments ?? []).slice(0, 10).map(s => s.text).join(' ').slice(0, 1500)
    const { streamChat } = await import('./chat-providers.js')
    const sys = 'You generate YouTube/TikTok metadata. Output STRICT JSON: {"title":"...","description":"...","tags":["..."]}. Title under 70 chars, hook-forward. Description 2-3 paragraphs with CTA. 8-15 tags, lowercase, no #.'
    let raw = ''
    for await (const chunk of streamChat(workspaceId, [
      { role: 'system', content: sys },
      { role: 'user',   content: `Transcript opener:\n${transcriptSnippet}\n\nReturn the JSON.` },
    ])) { if (chunk.delta) raw += chunk.delta }
    const m = raw.match(/\{[\s\S]*\}/)
    if (m) {
      const j = JSON.parse(m[0]) as { title?: string; description?: string; tags?: string[] }
      return {
        title: (j.title ?? 'Untitled').slice(0, 95),
        description: j.description ?? '',
        tags: (j.tags ?? []).slice(0, 15),
      }
    }
  } catch { /* */ }
  return { title: 'Untitled', description: '', tags: [] }
}

// ─── YouTube ───────────────────────────────────────────────────────────
export async function publishToYouTube(input: PublishInput): Promise<PublishResult> {
  if (!input.confirm) return { ok: false, platform: 'youtube', error: 'confirm:true required (operator approval gate)' }
  if (!existsSync(input.videoPath)) return { ok: false, platform: 'youtube', error: 'video not found' }
  // Prefer per-call token (race-safe for multi-account); fall back to env
  const token = input.youtubeAccessToken ?? process.env['YOUTUBE_ACCESS_TOKEN']
  if (!token) return { ok: false, platform: 'youtube', error: 'YOUTUBE_ACCESS_TOKEN not set' }

  const meta = input.title ? { title: input.title, description: input.description ?? '', tags: input.tags ?? [] }
                           : await generateMetadata(input.videoPath, input.workspaceId ?? 'default')
  const snippet: Record<string, unknown> = {
    title: meta.title.slice(0, 95),
    description: meta.description,
    tags: meta.tags,
    categoryId: '22',     // People & Blogs (general)
  }
  const status: Record<string, unknown> = {
    privacyStatus: input.publishAt ? 'private' : (input.privacy ?? 'public'),
    selfDeclaredMadeForKids: false,
  }
  if (input.publishAt) status['publishAt'] = input.publishAt

  // YouTube resumable upload: 1) metadata init, 2) file PUT
  try {
    const initRes = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'video/*',
        'X-Upload-Content-Length': String(statSync(input.videoPath).size),
      },
      body: JSON.stringify({ snippet, status }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!initRes.ok) return { ok: false, platform: 'youtube', error: `init ${initRes.status}: ${(await initRes.text()).slice(0, 200)}` }
    const uploadUrl = initRes.headers.get('location')
    if (!uploadUrl) return { ok: false, platform: 'youtube', error: 'no resumable URL returned' }
    const fileBuf = await readFile(input.videoPath)
    const upRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/*', 'Content-Length': String(fileBuf.length) },
      body: new Uint8Array(fileBuf),
      signal: AbortSignal.timeout(60 * 60_000),
    })
    if (!upRes.ok) return { ok: false, platform: 'youtube', error: `upload ${upRes.status}` }
    const j = await upRes.json() as { id?: string }
    if (!j.id) return { ok: false, platform: 'youtube', error: 'no video id returned' }
    const result: PublishResult = { ok: true, platform: 'youtube', videoId: j.id, url: `https://youtu.be/${j.id}` }
    if (input.publishAt) result.scheduled = true
    // Schedule first analytics snapshot 24h post-publish via production-log
    // event — the daily research scan will pick it up. We also fire an
    // immediate snapshot so the operator has a baseline.
    try {
      const { recordPerformance } = await import('./content-analytics.js')
      void recordPerformance(input.workspaceId ?? 'default', 'youtube', j.id, input.title)
    } catch { /* analytics is best-effort */ }
    try {
      const { record } = await import('./production-log.js')
      void record({ workspaceId: input.workspaceId ?? 'default', kind: 'publish', status: 'completed',
        ...(input.title ? { brief: input.title } : {}),
        meta: { platform: 'youtube', videoId: j.id, url: result.url, scheduled: !!input.publishAt } })
    } catch { /* */ }
    // Mirror to world-model so the published video becomes a graph node
    // war-gaming, twin snapshots, and causal-chain queries can reach.
    try {
      const { upsertNode } = await import('./world-model.js')
      void upsertNode({
        id: `youtube:${j.id}`, workspaceId: input.workspaceId ?? 'default',
        kind: 'product', label: input.title ?? `YouTube ${j.id}`,
        attrs: { platform: 'youtube', url: result.url, publishedAt: Date.now() },
        health: 1.0, importance: 0.6,
      })
    } catch { /* */ }
    // Defer economic scoring — analytics need ~24h to populate views/CTR.
    // Schedule a delayed scoring run via setTimeout (in-process; persists
    // only if API stays up. For production, this would queue to BullMQ.)
    try {
      const { scorePublishedVideo } = await import('./economic-engine.js')
      const wsId = input.workspaceId ?? 'default'
      const vid  = j.id
      setTimeout(() => { void scorePublishedVideo(wsId, vid) }, 24 * 3_600_000).unref()
      // Also fire a 1h follow-up for early-signal early-RPM platforms
      setTimeout(() => { void scorePublishedVideo(wsId, vid) }, 60 * 60_000).unref()
    } catch { /* */ }
    return result
  } catch (e) { return { ok: false, platform: 'youtube', error: (e as Error).message } }
}

// ─── TikTok ────────────────────────────────────────────────────────────
export async function publishToTikTok(input: PublishInput): Promise<PublishResult> {
  if (!input.confirm) return { ok: false, platform: 'tiktok', error: 'confirm:true required' }
  if (!existsSync(input.videoPath)) return { ok: false, platform: 'tiktok', error: 'video not found' }
  const token = input.tiktokAccessToken ?? process.env['TIKTOK_ACCESS_TOKEN']
  if (!token) return { ok: false, platform: 'tiktok', error: 'TIKTOK_ACCESS_TOKEN not set' }

  try {
    const meta = input.title ? { title: input.title, description: input.description ?? '', tags: input.tags ?? [] }
                             : await generateMetadata(input.videoPath, input.workspaceId ?? 'default')
    const stat = statSync(input.videoPath)
    // Initialize upload
    const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({
        post_info: {
          title: (meta.title + ' ' + (meta.tags ?? []).map(t => '#' + t).join(' ')).slice(0, 2200),
          privacy_level: input.privacy === 'private' ? 'SELF_ONLY' : 'PUBLIC_TO_EVERYONE',
          disable_duet: false, disable_comment: false, disable_stitch: false,
        },
        source_info: { source: 'FILE_UPLOAD', video_size: stat.size, chunk_size: stat.size, total_chunk_count: 1 },
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!initRes.ok) return { ok: false, platform: 'tiktok', error: `init ${initRes.status}` }
    const init = await initRes.json() as { data?: { publish_id?: string; upload_url?: string } }
    if (!init.data?.upload_url || !init.data?.publish_id) return { ok: false, platform: 'tiktok', error: 'no upload URL' }
    const fileBuf = await readFile(input.videoPath)
    const up = await fetch(init.data.upload_url, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes 0-${fileBuf.length - 1}/${fileBuf.length}`, 'Content-Type': 'video/mp4' },
      body: new Uint8Array(fileBuf),
      signal: AbortSignal.timeout(60 * 60_000),
    })
    if (!up.ok) return { ok: false, platform: 'tiktok', error: `upload ${up.status}` }
    const result: PublishResult = { ok: true, platform: 'tiktok', videoId: init.data.publish_id, url: `https://www.tiktok.com/@me/video/${init.data.publish_id}` }
    try {
      const { recordPerformance } = await import('./content-analytics.js')
      void recordPerformance(input.workspaceId ?? 'default', 'tiktok', init.data.publish_id, input.title)
    } catch { /* */ }
    try {
      const { record } = await import('./production-log.js')
      void record({ workspaceId: input.workspaceId ?? 'default', kind: 'publish', status: 'completed',
        ...(input.title ? { brief: input.title } : {}),
        meta: { platform: 'tiktok', videoId: init.data.publish_id, url: result.url } })
    } catch { /* */ }
    try {
      const { upsertNode } = await import('./world-model.js')
      void upsertNode({
        id: `tiktok:${init.data.publish_id}`, workspaceId: input.workspaceId ?? 'default',
        kind: 'product', label: input.title ?? `TikTok ${init.data.publish_id}`,
        attrs: { platform: 'tiktok', url: result.url, publishedAt: Date.now() },
        health: 1.0, importance: 0.6,
      })
    } catch { /* */ }
    return result
  } catch (e) { return { ok: false, platform: 'tiktok', error: (e as Error).message } }
}

// ─── Instagram (Reels via Graph API) ───────────────────────────────────
export async function publishToInstagram(input: PublishInput): Promise<PublishResult> {
  if (!input.confirm) return { ok: false, platform: 'instagram', error: 'confirm:true required' }
  if (!existsSync(input.videoPath)) return { ok: false, platform: 'instagram', error: 'video not found' }
  const token    = input.igAccessToken ?? process.env['IG_ACCESS_TOKEN']
  const igUserId = input.igUserId      ?? process.env['IG_USER_ID']
  if (!token || !igUserId) return { ok: false, platform: 'instagram', error: 'IG_ACCESS_TOKEN + IG_USER_ID required' }

  // IG Graph API requires the video to be hosted at a public URL — local
  // files cannot be uploaded directly. Operator must provide a publicly
  // reachable URL via input.title-encoded videoUrl OR run a side uploader.
  // For now: return a clear error so the operator wires this up.
  void readFile
  void createReadStream
  return { ok: false, platform: 'instagram', error: 'Instagram requires the video to be hosted at a public URL. Upload to S3/Cloudflare R2 first, then use video.publish.instagram with the public URL via a custom op.' }
}

/** Multi-platform: publish to all configured platforms in parallel. */
export async function publishEverywhere(input: PublishInput, platforms: Array<'youtube' | 'tiktok' | 'instagram'> = ['youtube', 'tiktok']): Promise<PublishResult[]> {
  const tasks: Promise<PublishResult>[] = []
  if (platforms.includes('youtube'))   tasks.push(publishToYouTube(input))
  if (platforms.includes('tiktok'))    tasks.push(publishToTikTok(input))
  if (platforms.includes('instagram')) tasks.push(publishToInstagram(input))
  return Promise.all(tasks)
}
