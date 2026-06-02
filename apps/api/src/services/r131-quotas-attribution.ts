/**
 * R146.131 — Platform quota counters + revenue attribution graph.
 */
import { db } from '../db/client.js'
import { platformQuotaUsage, attributionEdges } from '../db/schema.js'
import { and, eq, sql, desc } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── P2.8 — Platform quota counters ──────────────────────────────────

// Daily caps based on published platform limits as of 2025-06.
// Conservative; operator can override per (workspace, platform, action).
const DEFAULT_CAPS: Record<string, Record<string, number>> = {
  instagram: { post: 25, api_call: 200 },
  youtube:   { upload: 6, api_call: 100 },
  tiktok:    { post: 6, api_call: 100 },
  shopify:   { api_call: 1000 },
  etsy:      { api_call: 500 },
  printful:  { api_call: 200 },
}

function utcDayBucket(now = Date.now()): string {
  const d = new Date(now)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

export async function quotaCheck(workspaceId: string, platform: string, action: string): Promise<{ used: number; cap: number; remaining: number; blocked: boolean }> {
  const day = utcDayBucket()
  const cap = DEFAULT_CAPS[platform]?.[action] ?? 100
  const [row] = await db.select().from(platformQuotaUsage)
    .where(and(
      eq(platformQuotaUsage.workspaceId, workspaceId),
      eq(platformQuotaUsage.platform, platform),
      eq(platformQuotaUsage.bucketDay, day),
      eq(platformQuotaUsage.action, action),
    )).limit(1)
  const used = row?.count ?? 0
  const effectiveCap = row?.dailyCap ?? cap
  return { used, cap: effectiveCap, remaining: Math.max(0, effectiveCap - used), blocked: used >= effectiveCap }
}

/**
 * Atomically increment usage. UPSERT keeps it race-free across concurrent
 * posters. Throws QUOTA_EXCEEDED if already at cap.
 */
export async function quotaConsume(workspaceId: string, platform: string, action: string): Promise<{ used: number; cap: number }> {
  const day = utcDayBucket()
  const cap = DEFAULT_CAPS[platform]?.[action] ?? 100
  const now = Date.now()
  // UPSERT increments atomically
  await db.insert(platformQuotaUsage).values({
    workspaceId, platform, bucketDay: day, action,
    count: 1, dailyCap: cap, updatedAt: now,
  }).onConflictDoUpdate({
    target: [platformQuotaUsage.workspaceId, platformQuotaUsage.platform, platformQuotaUsage.bucketDay, platformQuotaUsage.action],
    set: { count: sql`${platformQuotaUsage.count} + 1`, updatedAt: now },
  })
  // Re-read
  const status = await quotaCheck(workspaceId, platform, action)
  if (status.used > status.cap) throw new Error(`QUOTA_EXCEEDED: ${platform}/${action} ${status.used}/${status.cap}`)
  return { used: status.used, cap: status.cap }
}

export async function quotaSummary(workspaceId: string): Promise<Array<{ platform: string; action: string; used: number; cap: number; remaining: number }>> {
  const day = utcDayBucket()
  const rows = await db.select().from(platformQuotaUsage)
    .where(and(eq(platformQuotaUsage.workspaceId, workspaceId), eq(platformQuotaUsage.bucketDay, day)))
  const out: Array<{ platform: string; action: string; used: number; cap: number; remaining: number }> = []
  // Include all known caps even when zero usage
  for (const [platform, actions] of Object.entries(DEFAULT_CAPS)) {
    for (const [action, defaultCap] of Object.entries(actions)) {
      const row = rows.find(r => r.platform === platform && r.action === action)
      const used = row?.count ?? 0
      const cap = row?.dailyCap ?? defaultCap
      out.push({ platform, action, used, cap, remaining: Math.max(0, cap - used) })
    }
  }
  return out
}

export async function setQuotaCap(workspaceId: string, platform: string, action: string, cap: number): Promise<void> {
  const day = utcDayBucket()
  const now = Date.now()
  await db.insert(platformQuotaUsage).values({
    workspaceId, platform, bucketDay: day, action,
    count: 0, dailyCap: Math.max(0, cap), updatedAt: now,
  }).onConflictDoUpdate({
    target: [platformQuotaUsage.workspaceId, platformQuotaUsage.platform, platformQuotaUsage.bucketDay, platformQuotaUsage.action],
    set: { dailyCap: Math.max(0, cap), updatedAt: now },
  })
}

// ─── P2.9 — Revenue attribution graph ─────────────────────────────────

export type EntityType = 'clip' | 'post' | 'channel' | 'business' | 'product' | 'sale'

export async function linkEdge(workspaceId: string, opts: {
  srcType: EntityType; srcId: string
  dstType: EntityType; dstId: string
  relation: 'published_to' | 'belongs_to' | 'sold_via' | 'attributed_to'
  weight?: number
  metadata?: Record<string, unknown>
}): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(attributionEdges).values({
    id, workspaceId,
    srcType: opts.srcType, srcId: opts.srcId,
    dstType: opts.dstType, dstId: opts.dstId,
    relation: opts.relation,
    weight: opts.weight ?? 1.0,
    metadata: opts.metadata ?? {},
    createdAt: Date.now(),
  })
  return { id }
}

/**
 * Trace from a node forward (out-edges) up to maxDepth. Used to ask
 * "what businesses did this clip drive revenue to" or "what posts
 * came from this clip".
 */
export async function traceForward(workspaceId: string, srcType: EntityType, srcId: string, maxDepth = 4): Promise<Array<{ depth: number; type: string; id: string; relation: string }>> {
  const out: Array<{ depth: number; type: string; id: string; relation: string }> = []
  let frontier = [{ type: srcType as string, id: srcId }]
  const seen = new Set<string>([`${srcType}:${srcId}`])
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: typeof frontier = []
    for (const node of frontier) {
      const edges = await db.select().from(attributionEdges)
        .where(and(eq(attributionEdges.workspaceId, workspaceId),
                   eq(attributionEdges.srcType, node.type),
                   eq(attributionEdges.srcId, node.id)))
        .limit(50)
      for (const e of edges) {
        const key = `${e.dstType}:${e.dstId}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ depth, type: e.dstType, id: e.dstId, relation: e.relation })
        next.push({ type: e.dstType, id: e.dstId })
      }
    }
    frontier = next
  }
  return out
}

/**
 * Trace backward: given a sale or revenue event, find which clips,
 * channels, businesses contributed.
 */
export async function traceBackward(workspaceId: string, dstType: EntityType, dstId: string, maxDepth = 4): Promise<Array<{ depth: number; type: string; id: string; relation: string }>> {
  const out: Array<{ depth: number; type: string; id: string; relation: string }> = []
  let frontier = [{ type: dstType as string, id: dstId }]
  const seen = new Set<string>([`${dstType}:${dstId}`])
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: typeof frontier = []
    for (const node of frontier) {
      const edges = await db.select().from(attributionEdges)
        .where(and(eq(attributionEdges.workspaceId, workspaceId),
                   eq(attributionEdges.dstType, node.type),
                   eq(attributionEdges.dstId, node.id)))
        .limit(50)
      for (const e of edges) {
        const key = `${e.srcType}:${e.srcId}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ depth, type: e.srcType, id: e.srcId, relation: e.relation })
        next.push({ type: e.srcType, id: e.srcId })
      }
    }
    frontier = next
  }
  return out
}

export async function listEdges(workspaceId: string, limit = 50): Promise<Array<typeof attributionEdges.$inferSelect>> {
  return db.select().from(attributionEdges)
    .where(eq(attributionEdges.workspaceId, workspaceId))
    .orderBy(desc(attributionEdges.createdAt))
    .limit(Math.min(limit, 200))
}
