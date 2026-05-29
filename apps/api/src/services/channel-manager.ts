/**
 * channel-manager.ts — multi-account / multi-platform credential storage
 * and parallel publish coordination.
 *
 * Operators can configure N channels (each tied to a workspace + platform
 * + account label), then call publishAcrossChannels(videoPath, filter)
 * to publish to every matching channel in parallel.
 *
 * Credentials stored as JSON in CHANNELS_DIR. NEVER published without
 * explicit operator confirm:true (same gate as video-publisher).
 */

import { existsSync, mkdirSync } from 'node:fs'
import { writeFile, readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

// ─── At-rest token encryption ──────────────────────────────────────────
// Channels store OAuth tokens. Storing them plaintext on disk is a
// security hole — anyone with FS read can hijack the account. We
// AES-256-GCM encrypt every secret value before write, decrypt on read.
// Master key derived from CHANNEL_ENCRYPTION_KEY env (or a stable
// machine-scoped fallback so it survives restarts).
const ENC_KEY = (() => {
  const raw = process.env['CHANNEL_ENCRYPTION_KEY'] ?? ''
  if (raw.length >= 32) return scryptSync(raw, 'novan-channels', 32)
  // Fallback: derive from machine hostname + node version. Stable
  // across restarts on the same box but not portable — operator should
  // set CHANNEL_ENCRYPTION_KEY for proper hygiene.
  return scryptSync(`${process.env['COMPUTERNAME'] ?? process.env['HOSTNAME'] ?? 'novan'}:${process.version}`, 'novan-channels-fallback', 32)
})()

function encrypt(plain: string): string {
  if (!plain) return ''
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', ENC_KEY, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`
}

function decrypt(blob: string): string {
  if (!blob || !blob.startsWith('enc:v1:')) return blob   // legacy plaintext
  const [, , ivB64, tagB64, ctB64] = blob.split(':')
  if (!ivB64 || !tagB64 || !ctB64) return ''
  const iv  = Buffer.from(ivB64, 'base64')
  const tag = Buffer.from(tagB64, 'base64')
  const ct  = Buffer.from(ctB64, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', ENC_KEY, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

const CHANNELS_DIR = process.env['CHANNELS_DIR'] ?? join(tmpdir(), 'novan-channels')
if (!existsSync(CHANNELS_DIR)) mkdirSync(CHANNELS_DIR, { recursive: true })

export interface Channel {
  id:         string                   // unique
  workspaceId: string
  platform:   'youtube' | 'tiktok' | 'instagram'
  label:      string                   // operator-friendly name e.g. "Main Channel"
  accessToken: string                  // platform OAuth token
  refreshToken?: string
  /** Optional: IG_USER_ID for Instagram graph API. */
  igUserId?:  string
  /** Default privacy when publishing to this channel. */
  privacy?:   'public' | 'private' | 'unlisted'
  /** Default tags appended to every post. */
  defaultTags?: string[]
  /** Posting cadence target (videos/day) — used by scheduled-production. */
  dailyQuota?: number
  createdAt:  number
}

function channelPath(id: string): string { return join(CHANNELS_DIR, `${id}.json`) }

export async function saveChannel(c: Omit<Channel, 'createdAt'>): Promise<{ ok: boolean; id: string }> {
  const full: Channel = { ...c, createdAt: Date.now() }
  // Encrypt secrets before write
  const onDisk = { ...full, accessToken: encrypt(full.accessToken), ...(full.refreshToken ? { refreshToken: encrypt(full.refreshToken) } : {}) }
  await writeFile(channelPath(c.id), JSON.stringify(onDisk, null, 2), 'utf8')
  // Auto-populate world-model node so emergent-strategy + war-gaming
  // see this channel immediately (instead of waiting for the next 30-min
  // twin sweep). Previously: a freshly-created channel was invisible to
  // graph queries until digital-twin ran.
  try {
    const { upsertNode } = await import('./world-model.js')
    await upsertNode({
      id: `channel:${full.id}`, workspaceId: full.workspaceId, kind: 'channel',
      label: full.label, attrs: { platform: full.platform, createdAt: full.createdAt },
      health: 1.0, importance: 0.7,
    })
  } catch { /* world-model is best-effort */ }
  return { ok: true, id: c.id }
}

export async function deleteChannel(id: string): Promise<{ ok: boolean }> {
  const p = channelPath(id)
  if (!existsSync(p)) return { ok: false }
  await unlink(p)
  return { ok: true }
}

export async function listChannels(workspaceId?: string, platform?: Channel['platform']): Promise<Channel[]> {
  const files = await readdir(CHANNELS_DIR)
  const out: Channel[] = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    try {
      const c = JSON.parse(await readFile(join(CHANNELS_DIR, f), 'utf8')) as Channel
      if (workspaceId && c.workspaceId !== workspaceId) continue
      if (platform && c.platform !== platform) continue
      // Decrypt for in-memory use; never expose ciphertext to callers
      c.accessToken = decrypt(c.accessToken)
      if (c.refreshToken) c.refreshToken = decrypt(c.refreshToken)
      out.push(c)
    } catch { /* */ }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

export async function getChannel(id: string): Promise<Channel | null> {
  const p = channelPath(id)
  if (!existsSync(p)) return null
  try {
    const c = JSON.parse(await readFile(p, 'utf8')) as Channel
    c.accessToken = decrypt(c.accessToken)
    if (c.refreshToken) c.refreshToken = decrypt(c.refreshToken)
    return c
  } catch { return null }
}

/**
 * Publish a video to every channel matching the filter, in parallel.
 * Sets per-platform env vars from each channel's stored token, then
 * calls into video-publisher. Returns per-channel results.
 */
export interface MultiPublishInput {
  videoPath:    string
  workspaceId?: string
  platforms?:   Array<'youtube' | 'tiktok' | 'instagram'>
  title?:       string
  description?: string
  tags?:        string[]
  publishAt?:   string
  privacy?:     'public' | 'private' | 'unlisted'
  /** Channel IDs to target. If omitted, all channels for workspace+platforms. */
  channelIds?:  string[]
  /** REQUIRED — operator approval gate. */
  confirm:      true
}

export interface MultiPublishResult {
  channelId:  string
  channel:    string
  platform:   string
  ok:         boolean
  url?:       string
  videoId?:   string
  scheduled?: boolean
  error?:     string
}

export async function publishAcrossChannels(input: MultiPublishInput): Promise<MultiPublishResult[]> {
  if (!input.confirm) return [{ channelId: '-', channel: '-', platform: '-', ok: false, error: 'confirm:true required' }]
  let channels = input.channelIds
    ? (await Promise.all(input.channelIds.map(getChannel))).filter((c): c is Channel => !!c)
    : await listChannels(input.workspaceId)
  if (input.platforms) channels = channels.filter(c => input.platforms!.includes(c.platform))
  if (channels.length === 0) return [{ channelId: '-', channel: '-', platform: '-', ok: false, error: 'no matching channels' }]

  const { publishToYouTube, publishToTikTok, publishToInstagram } = await import('./video-publisher.js')
  // SECURITY: previously injected per-channel tokens via process.env mutation
  // inside the Promise.all map. process.env is process-global; concurrent
  // YouTube+TikTok+IG publishes would race — task B's env-write could be
  // observed by task A's fetch (which yields on awaits), leaking tokenB
  // into task A's request. Result: videos published to wrong account.
  // Now we pass tokens through publish input explicitly; each task is
  // isolated.
  const tasks = channels.map(async (c): Promise<MultiPublishResult> => {
    const pubInput = {
      videoPath: input.videoPath, confirm: true as const,
      ...(input.title ? { title: input.title } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...((input.tags || c.defaultTags) ? { tags: [...(input.tags ?? []), ...(c.defaultTags ?? [])] } : {}),
      ...(input.publishAt ? { publishAt: input.publishAt } : {}),
      ...(input.privacy ?? c.privacy ? { privacy: input.privacy ?? c.privacy! } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : { workspaceId: c.workspaceId }),
      // EXPLICIT token injection — no shared state.
      ...(c.platform === 'youtube'   ? { youtubeAccessToken: c.accessToken } : {}),
      ...(c.platform === 'tiktok'    ? { tiktokAccessToken: c.accessToken } : {}),
      ...(c.platform === 'instagram' ? { igAccessToken: c.accessToken, igUserId: c.igUserId } : {}),
    }
    const r = c.platform === 'youtube'   ? await publishToYouTube(pubInput)
            : c.platform === 'tiktok'    ? await publishToTikTok(pubInput)
            :                              await publishToInstagram(pubInput)
    const out: MultiPublishResult = { channelId: c.id, channel: c.label, platform: c.platform, ok: r.ok }
    if (r.url)       out.url       = r.url
    if (r.videoId)   out.videoId   = r.videoId
    if (r.scheduled) out.scheduled = r.scheduled
    if (r.error)     out.error     = r.error
    return out
  })
  return Promise.all(tasks)
}
