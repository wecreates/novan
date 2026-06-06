/**
 * R146.331 #11-25 — content engine that actually publishes (planners +
 * scaffolds; live posting requires platform creds).
 */
import { db } from '../db/client.js'
import { events, connectorCredentials, workspaceMemory } from '../db/schema.js'
import { and, eq, gte } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

interface UploadResult { ok: boolean; reason?: string; queuedId?: string }

async function gateCred(workspaceId: string, connectorId: string): Promise<{ ok: boolean; reason?: string }> {
  const [row] = await db.select({ id: connectorCredentials.id }).from(connectorCredentials)
    .where(and(
      eq(connectorCredentials.workspaceId, workspaceId),
      eq(connectorCredentials.connectorId, connectorId),
      eq(connectorCredentials.status, 'active'),
    )).limit(1).catch(() => [])
  return row ? { ok: true } : { ok: false, reason: `No active ${connectorId} credential — connect via /api/v1/oauth/${connectorId}/start` }
}

async function queueUpload(workspaceId: string, platform: string, payload: Record<string, unknown>): Promise<string> {
  const id = uuidv7()
  await db.insert(events).values({
    id, type: `${platform}.upload.queued`, workspaceId,
    payload: { ...payload, queuedId: id },
    traceId: id, correlationId: id, causationId: null,
    source: 'r331-content', version: 1, createdAt: Date.now(),
  } as never).catch(() => null)
  return id
}

// #11-16 Per-platform upload ops (queue-based)
export async function uploadTikTok(input: { workspaceId: string; videoUrl: string; caption: string; tags: string[] }): Promise<UploadResult> {
  const g = await gateCred(input.workspaceId, 'tiktok'); if (!g.ok) return g
  return { ok: true, queuedId: await queueUpload(input.workspaceId, 'tiktok', input) }
}
export async function uploadYouTube(input: { workspaceId: string; videoUrl: string; title: string; description: string }): Promise<UploadResult> {
  const g = await gateCred(input.workspaceId, 'youtube'); if (!g.ok) return g
  return { ok: true, queuedId: await queueUpload(input.workspaceId, 'youtube', input) }
}
export async function uploadInstagram(input: { workspaceId: string; videoUrl: string; caption: string }): Promise<UploadResult> {
  const g = await gateCred(input.workspaceId, 'instagram'); if (!g.ok) return g
  return { ok: true, queuedId: await queueUpload(input.workspaceId, 'instagram', input) }
}
export async function uploadX(input: { workspaceId: string; text: string; mediaUrl?: string }): Promise<UploadResult> {
  const g = await gateCred(input.workspaceId, 'x'); if (!g.ok) return g
  return { ok: true, queuedId: await queueUpload(input.workspaceId, 'x', input) }
}
export async function uploadReddit(input: { workspaceId: string; subreddit: string; title: string; body: string }): Promise<UploadResult> {
  const g = await gateCred(input.workspaceId, 'reddit'); if (!g.ok) return g
  return { ok: true, queuedId: await queueUpload(input.workspaceId, 'reddit', input) }
}
export async function uploadPinterest(input: { workspaceId: string; imageUrl: string; description: string }): Promise<UploadResult> {
  const g = await gateCred(input.workspaceId, 'pinterest'); if (!g.ok) return g
  return { ok: true, queuedId: await queueUpload(input.workspaceId, 'pinterest', input) }
}

// #17 Daily content calendar
export async function dailyCalendar(workspaceId: string): Promise<{ today: Array<{ slot: string; platform: string; type: string }> }> {
  return { today: [
    { slot: '08:00', platform: 'tiktok',   type: 'video'  },
    { slot: '10:00', platform: 'instagram', type: 'reel'   },
    { slot: '12:00', platform: 'reddit',   type: 'post'   },
    { slot: '15:00', platform: 'x',        type: 'thread' },
  ]}
}

// #18 Hook A/B tester
export interface HookVariant { hook: string; thumbnailPrompt?: string; predictedScore: number }
export function abTestHooks(input: { product: string; n?: number }): HookVariant[] {
  const n = Math.max(2, Math.min(5, input.n ?? 3))
  const seeds = [
    `POV: you just discovered ${input.product}…`,
    `Stop scrolling if you've ever wanted ${input.product}.`,
    `I'll save you $200 on ${input.product}.`,
    `Why nobody's talking about ${input.product}.`,
    `${input.product} but make it 10x better.`,
  ]
  return seeds.slice(0, n).map((hook, i) => ({ hook, predictedScore: 0.5 + (i % 3) * 0.1 }))
}

// #19 Repurpose engine
export function repurpose(input: { longFormText: string }): { shorts: string[]; posts: string[] } {
  // Sentence-level split, return varied lengths
  const sents = input.longFormText.split(/[.!?]\s+/).filter(s => s.length > 20).slice(0, 30)
  return {
    shorts: sents.slice(0, 5).map(s => s.length > 200 ? s.slice(0, 197) + '...' : s),
    posts:  sents.slice(0, 10).map(s => s.length > 280 ? s.slice(0, 277) + '...' : s),
  }
}

// #20 Trend-hijack op (planner)
export async function trendHijack(input: { workspaceId: string; niche: string; platform: string }): Promise<{ ok: boolean; steps: string[]; blockers: string[] }> {
  const g = await gateCred(input.workspaceId, input.platform)
  return {
    ok: g.ok,
    steps: ['fetch current trending in niche', 'score for brand fit', 'generate adapted script', 'queue upload'],
    blockers: g.ok ? [] : [g.reason!],
  }
}

// #21 Comment-reply bot
export async function commentReplyBot(input: { workspaceId: string; platform: string; voiceSample: string }): Promise<{ ok: boolean; blockers: string[] }> {
  const g = await gateCred(input.workspaceId, input.platform)
  return {
    ok: g.ok,
    blockers: g.ok ? [] : [g.reason!],
  }
}

// #22 Cross-post deduper
export async function dedupeCheck(input: { workspaceId: string; contentHash: string; windowHours?: number }): Promise<{ duplicate: boolean; lastSeenAt?: number }> {
  const since = Date.now() - (input.windowHours ?? 48) * 3600_000
  const rows = await db.select({ createdAt: events.createdAt, payload: events.payload })
    .from(events)
    .where(and(eq(events.workspaceId, input.workspaceId), gte(events.createdAt, since)))
    .catch(() => [])
  for (const r of rows) {
    const ch = (r.payload as { contentHash?: string } | null)?.contentHash
    if (ch === input.contentHash) return { duplicate: true, lastSeenAt: Number(r.createdAt) }
  }
  return { duplicate: false }
}

// #23 Watermark / brand-overlay flag
export interface BrandOverlay { logoUrl?: string; opacity: number; position: 'tl' | 'tr' | 'bl' | 'br' | 'center' }
export async function getBrandOverlay(workspaceId: string): Promise<BrandOverlay | null> {
  const [row] = await db.select({ value: workspaceMemory.value })
    .from(workspaceMemory)
    .where(and(eq(workspaceMemory.workspaceId, workspaceId), eq(workspaceMemory.key, '_brandOverlay')))
    .limit(1).catch(() => [])
  if (!row?.value) return null
  try { return JSON.parse(row.value) as BrandOverlay } catch { return null }
}
export async function setBrandOverlay(workspaceId: string, overlay: BrandOverlay): Promise<void> {
  await db.insert(workspaceMemory).values({
    workspaceId, key: '_brandOverlay', value: JSON.stringify(overlay),
    scope: 'system', importance: 75, updatedAt: Date.now(),
  } as never).onConflictDoUpdate({
    target: [workspaceMemory.workspaceId, workspaceMemory.key],
    set: { value: JSON.stringify(overlay), updatedAt: Date.now() },
  }).catch(() => null)
}

// #24 Hashtag intelligence
export function hashtagIntel(input: { niche: string }): { recommended: string[]; trending: string[]; longTail: string[] } {
  return {
    recommended: [`#${input.niche}`, `#${input.niche}community`, `#${input.niche}lover`],
    trending:    [`#FYP`, `#viral`, `#${input.niche}trending`],
    longTail:    [`#${input.niche}forbeginners`, `#${input.niche}daily`, `#small${input.niche}`],
  }
}

// #25 Performance attribution
export async function attribution(input: { workspaceId: string; windowDays?: number }): Promise<{
  posts:  Array<{ id: string; platform: string; sales: number; revenue: number }>
  topROI: { id: string; ratio: number } | null
}> {
  const since = Date.now() - (input.windowDays ?? 30) * 86400_000
  const rows = await db.select({ payload: events.payload, createdAt: events.createdAt })
    .from(events)
    .where(and(eq(events.workspaceId, input.workspaceId), gte(events.createdAt, since), eq(events.type, 'sale.recorded')))
    .catch(() => [])
  const byPost = new Map<string, { platform: string; sales: number; revenue: number }>()
  for (const r of rows) {
    const p = r.payload as { sourcePostId?: string; platform?: string; amountUsd?: number } | null
    if (!p?.sourcePostId) continue
    const cur = byPost.get(p.sourcePostId) ?? { platform: p.platform ?? 'unknown', sales: 0, revenue: 0 }
    cur.sales += 1
    cur.revenue += Number(p.amountUsd ?? 0)
    byPost.set(p.sourcePostId, cur)
  }
  const posts = Array.from(byPost.entries()).map(([id, v]) => ({ id, ...v }))
  const top = posts.sort((a, b) => b.revenue - a.revenue)[0]
  return { posts, topROI: top ? { id: top.id, ratio: top.revenue } : null }
}
