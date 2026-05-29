/**
 * business-attachments.ts — Wire concrete revenue sources to a business.
 *
 * A YouTube channel, an Etsy shop, a TikTok account, a Stripe product —
 * each is an "attachment" to a business row. The portfolio system uses
 * these attachments to:
 *   1. Roll up revenue (content-analytics signals → business_revenue)
 *   2. Roll up performance (per-channel CTR/AVD → prompt-evolution scores)
 *   3. Decide which business owns a piece of content the brain is making
 *
 * Without attachments the portfolio system has no way to know "this
 * YouTube video belongs to which business" — the operator would have
 * to manually attribute every revenue event. With them, every signal
 * from the content-analytics service automatically lands in the right
 * business's gap-to-$10k math.
 */
import { v7 as uuidv7 } from 'uuid'
import { and, eq }      from 'drizzle-orm'
import { db }           from '../db/client.js'
import { businessAttachments, businesses, events } from '../db/schema.js'

export type AttachmentSource =
  | 'youtube_channel'
  | 'etsy_shop'
  | 'tiktok_account'
  | 'instagram_account'
  | 'twitter_account'
  | 'newsletter'
  | 'stripe_product'
  | 'shopify_store'
  | 'other'

const VALID_SOURCES: readonly AttachmentSource[] = [
  'youtube_channel', 'etsy_shop', 'tiktok_account', 'instagram_account',
  'twitter_account', 'newsletter', 'stripe_product', 'shopify_store', 'other',
] as const

export interface AttachInput {
  workspaceId: string
  businessId:  string
  source:      AttachmentSource
  sourceRef:   string                     // platform-stable id
  label?:      string
  metadata?:   Record<string, unknown>
}

export async function attach(input: AttachInput): Promise<{ id: string; created: boolean }> {
  if (!VALID_SOURCES.includes(input.source)) {
    throw new Error(`business-attachments: invalid source "${input.source}"`)
  }
  // Validate business exists + scope to workspace (defense in depth — without
  // this, an attacker with one workspace's auth token could attach a channel
  // to a business in another workspace by guessing its id).
  const [biz] = await db.select({ id: businesses.id }).from(businesses)
    .where(and(eq(businesses.workspaceId, input.workspaceId), eq(businesses.id, input.businessId)))
    .limit(1)
  if (!biz) throw new Error(`business-attachments: business ${input.businessId} not found in workspace ${input.workspaceId}`)

  // Idempotent upsert keyed on the (workspace, business, source, sourceRef)
  // unique index. If an attachment exists, we re-enable it + refresh the
  // label/metadata; we don't create a duplicate row.
  const now = Date.now()
  const row: typeof businessAttachments.$inferInsert = {
    id:          uuidv7(),
    workspaceId: input.workspaceId,
    businessId:  input.businessId,
    source:      input.source,
    sourceRef:   input.sourceRef,
    enabled:     true,
    attachedAt:  now,
    metadata:    input.metadata ?? {},
    createdAt:   now,
    updatedAt:   now,
  }
  if (input.label !== undefined) row.label = input.label

  const existing = await db.select({ id: businessAttachments.id }).from(businessAttachments)
    .where(and(
      eq(businessAttachments.workspaceId, input.workspaceId),
      eq(businessAttachments.businessId,  input.businessId),
      eq(businessAttachments.source,      input.source),
      eq(businessAttachments.sourceRef,   input.sourceRef),
    ))
    .limit(1)

  if (existing[0]) {
    await db.update(businessAttachments).set({
      enabled:   true,
      label:     input.label ?? null,
      metadata:  input.metadata ?? {},
      updatedAt: now,
    }).where(eq(businessAttachments.id, existing[0].id))
    await emit(input.workspaceId, 'business.attachment.re_enabled', { ...input, attachmentId: existing[0].id })
    return { id: existing[0].id, created: false }
  }

  await db.insert(businessAttachments).values(row)
  await emit(input.workspaceId, 'business.attachment.created', { ...input, attachmentId: row.id })
  return { id: row.id, created: true }
}

export async function detach(workspaceId: string, attachmentId: string): Promise<{ ok: boolean }> {
  // Soft-disable rather than delete — preserves revenue-attribution
  // history. A re-attach via attach() re-enables instead of creating
  // a new row.
  const r = await db.update(businessAttachments).set({
    enabled: false, updatedAt: Date.now(),
  }).where(and(
    eq(businessAttachments.workspaceId, workspaceId),
    eq(businessAttachments.id, attachmentId),
  )).returning({ id: businessAttachments.id })
  const ok = r.length > 0
  if (ok) await emit(workspaceId, 'business.attachment.disabled', { attachmentId })
  return { ok }
}

export interface ListedAttachment {
  id:          string
  businessId:  string
  source:      AttachmentSource
  sourceRef:   string
  label:       string | null
  enabled:     boolean
  attachedAt:  number
  lastSyncedAt: number | null
}

export async function listForBusiness(workspaceId: string, businessId: string): Promise<ListedAttachment[]> {
  const rows = await db.select().from(businessAttachments)
    .where(and(
      eq(businessAttachments.workspaceId, workspaceId),
      eq(businessAttachments.businessId,  businessId),
    ))
  return rows.map(r => ({
    id: r.id, businessId: r.businessId,
    source: r.source as AttachmentSource,
    sourceRef: r.sourceRef,
    label: r.label, enabled: r.enabled,
    attachedAt: r.attachedAt, lastSyncedAt: r.lastSyncedAt,
  }))
}

/** Reverse lookup — given a (source, sourceRef), find which business
 *  owns it. Used by content-analytics to auto-roll-up revenue events. */
export async function findOwningBusiness(workspaceId: string, source: AttachmentSource, sourceRef: string): Promise<{ businessId: string; attachmentId: string } | null> {
  const [row] = await db.select({
    id: businessAttachments.id,
    businessId: businessAttachments.businessId,
  }).from(businessAttachments)
    .where(and(
      eq(businessAttachments.workspaceId, workspaceId),
      eq(businessAttachments.source, source),
      eq(businessAttachments.sourceRef, sourceRef),
      eq(businessAttachments.enabled, true),
    ))
    .limit(1)
  if (!row) return null
  return { businessId: row.businessId, attachmentId: row.id }
}

/** Mark an attachment as just-synced — content-analytics calls this
 *  after a successful performance pull. Lets analytics-pull crons skip
 *  recently-touched attachments. */
export async function markSynced(attachmentId: string): Promise<void> {
  await db.update(businessAttachments).set({
    lastSyncedAt: Date.now(), updatedAt: Date.now(),
  }).where(eq(businessAttachments.id, attachmentId)).catch(() => null)
}

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'business-attachments', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}
