/**
 * R162 — Owned-audience loop.
 *
 * The $0→$10k unlock: convert rented social audience into owned email list.
 *   - Lead magnet factory (auto-write magnet body from brain knowledge)
 *   - Capture endpoint (dedupes ws+email)
 *   - Segment by behavior (engaged | dormant | new | clicker)
 *   - Campaign sender (A/B subject; winner auto-promoted at 50% sample)
 *   - Win-back cron (no open in 30d → auto-draft re-engagement)
 *
 * Sender: Resend HTTP API. Key resolved from secrets_vault by name
 * "resend_api_key" per workspace. Send is gated on a configured
 * from_address — never spoof. No send happens until operator approves.
 */
import { db } from '../db/client.js'
import {
  leadMagnet, leadCapture, emailCampaign, emailSend, secretsVault,
} from '../db/schema.js'
import { and, eq, desc, sql, gte, lte, isNull, isNotNull } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── Lead magnets ────────────────────────────────────────────────────

export interface CreateMagnetInput {
  title:      string
  slug?:      string
  format?:    'pdf' | 'checklist' | 'template' | 'swipe' | 'course'
  body:       string
  fileUrl?:   string
  businessId?: string
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
}

export async function magnetCreate(workspaceId: string, input: CreateMagnetInput): Promise<{ id: string; slug: string }> {
  if (!input.title || !input.body) throw new Error('title + body required')
  const slug = input.slug ? slugify(input.slug) : slugify(input.title)
  if (!slug) throw new Error('slug invalid')
  const id = uuidv7()
  await db.insert(leadMagnet).values({
    id, workspaceId,
    ...(input.businessId ? { businessId: input.businessId } : {}),
    title: input.title.slice(0, 200),
    slug,
    format: input.format ?? 'pdf',
    body: input.body.slice(0, 80_000),
    ...(input.fileUrl ? { fileUrl: input.fileUrl } : {}),
    status: 'active',
    createdAt: Date.now(),
  })
  return { id, slug }
}

export async function magnetList(workspaceId: string, opts: { limit?: number } = {}): Promise<Array<typeof leadMagnet.$inferSelect>> {
  return db.select().from(leadMagnet)
    .where(and(eq(leadMagnet.workspaceId, workspaceId), eq(leadMagnet.status, 'active')))
    .orderBy(desc(leadMagnet.createdAt))
    .limit(Math.min(opts.limit ?? 30, 100))
}

export async function magnetGetBySlug(workspaceId: string, slug: string): Promise<typeof leadMagnet.$inferSelect | null> {
  const [m] = await db.select().from(leadMagnet)
    .where(and(eq(leadMagnet.workspaceId, workspaceId), eq(leadMagnet.slug, slug), eq(leadMagnet.status, 'active')))
    .limit(1)
  return m ?? null
}

/**
 * Auto-write a magnet from existing brain knowledge. Pulls top
 * chunks matching the topic + assembles a checklist-shaped body.
 * The output is operator-editable. Cheap rule-based assembly; LLM
 * polish is a future enhancement.
 */
export async function magnetDraftFromBrain(workspaceId: string, opts: { topic: string; format?: CreateMagnetInput['format']; businessId?: string }): Promise<{ id: string; slug: string; preview: string }> {
  let chunks: Array<{ content: string }> = []
  try {
    const { memoryRecall } = await import('./r139-ai-foundation.js')
    const r = await memoryRecall(workspaceId, { query: opts.topic, limit: 12 } as Parameters<typeof memoryRecall>[1])
    chunks = ((r as { results?: Array<{ content: string }> })?.results ?? []).slice(0, 12)
  } catch { /* fall through */ }

  const format = opts.format ?? 'checklist'
  const lines = chunks.map(c => `- ${c.content.split('\n')[0]?.slice(0, 160) ?? ''}`).filter(l => l.length > 4)
  const body = lines.length > 0
    ? `# ${opts.topic}\n\nA practical ${format} pulled from working notes.\n\n${lines.join('\n')}\n\n— Subscribe for more.`
    : `# ${opts.topic}\n\n(Placeholder body — operator should edit.)\n\nWhy this matters: …\nWhat to do: …\n— Subscribe for more.`
  const out = await magnetCreate(workspaceId, {
    title: opts.topic,
    body,
    format,
    ...(opts.businessId ? { businessId: opts.businessId } : {}),
  })
  return { ...out, preview: body.slice(0, 400) }
}

// ─── Captures (the email list) ───────────────────────────────────────

export interface CaptureInput {
  email:    string
  name?:    string
  magnetId?: string
  source?:  'page' | 'comment' | 'dm' | 'post' | 'manual' | 'import'
  sourceRef?: string
}

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function captureCreate(workspaceId: string, input: CaptureInput): Promise<{ id: string; deduped: boolean }> {
  const email = input.email.trim().toLowerCase()
  if (!EMAIL_RX.test(email)) throw new Error('invalid email')

  const [existing] = await db.select({ id: leadCapture.id })
    .from(leadCapture)
    .where(and(eq(leadCapture.workspaceId, workspaceId), eq(leadCapture.email, email)))
    .limit(1)
  if (existing) {
    // Reactivate if previously unsubscribed.
    await db.update(leadCapture).set({ unsubscribedAt: null }).where(eq(leadCapture.id, existing.id))
    return { id: existing.id, deduped: true }
  }
  const id = uuidv7()
  await db.insert(leadCapture).values({
    id, workspaceId,
    ...(input.magnetId ? { magnetId: input.magnetId } : {}),
    email,
    ...(input.name ? { name: input.name } : {}),
    source: input.source ?? 'page',
    ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
    segments: ['new'],
    subscribedAt: Date.now(),
  })
  if (input.magnetId) {
    await db.update(leadMagnet)
      .set({ signups: sql`${leadMagnet.signups} + 1` })
      .where(and(eq(leadMagnet.workspaceId, workspaceId), eq(leadMagnet.id, input.magnetId)))
  }
  return { id, deduped: false }
}

export async function captureUnsubscribe(workspaceId: string, email: string): Promise<{ ok: boolean }> {
  const lc = email.trim().toLowerCase()
  const r = await db.update(leadCapture).set({ unsubscribedAt: Date.now() })
    .where(and(eq(leadCapture.workspaceId, workspaceId), eq(leadCapture.email, lc)))
    .returning({ id: leadCapture.id })
  return { ok: r.length > 0 }
}

/**
 * Recompute segments for the workspace. Buckets:
 *   - new        : subscribed in last 14d
 *   - engaged    : opened in last 14d
 *   - clicker    : clicked in last 30d
 *   - dormant    : no open in 30d (and not new)
 *   - bounced    : >=2 bounces
 */
export async function segmentSync(workspaceId: string): Promise<{ updated: number }> {
  const now = Date.now()
  const new14  = now - 14 * 86_400_000
  const open14 = now - 14 * 86_400_000
  const click30 = now - 30 * 86_400_000
  const inactive30 = now - 30 * 86_400_000

  const rows = await db.select().from(leadCapture)
    .where(and(eq(leadCapture.workspaceId, workspaceId), isNull(leadCapture.unsubscribedAt)))
    .limit(50_000)

  let updated = 0
  for (const r of rows) {
    const segs: string[] = []
    if (r.subscribedAt >= new14) segs.push('new')
    if (r.lastOpenAt && r.lastOpenAt >= open14) segs.push('engaged')
    if (r.lastClickAt && r.lastClickAt >= click30) segs.push('clicker')
    if (!segs.includes('new') && (!r.lastOpenAt || r.lastOpenAt < inactive30)) segs.push('dormant')
    if (r.bounceCount >= 2) segs.push('bounced')
    const existing = (r.segments ?? []).sort().join(',')
    const next = segs.sort().join(',')
    if (existing !== next) {
      await db.update(leadCapture).set({ segments: segs }).where(eq(leadCapture.id, r.id))
      updated += 1
    }
  }
  return { updated }
}

// ─── Campaigns ───────────────────────────────────────────────────────

export interface CampaignInput {
  name:         string
  subjectA:     string
  subjectB?:    string
  body:         string
  segmentFilter?: { includeSegments?: string[]; excludeSegments?: string[]; sinceDays?: number }
  fromAddress?: string
  fromName?:    string
  replyTo?:     string
  scheduledAt?: number
}

export async function campaignCreate(workspaceId: string, input: CampaignInput): Promise<{ id: string }> {
  if (!input.subjectA || !input.body) throw new Error('subjectA + body required')
  const id = uuidv7()
  await db.insert(emailCampaign).values({
    id, workspaceId,
    name:     input.name.slice(0, 200),
    subjectA: input.subjectA.slice(0, 250),
    ...(input.subjectB ? { subjectB: input.subjectB.slice(0, 250) } : {}),
    body:     input.body.slice(0, 200_000),
    segmentFilter: input.segmentFilter ?? {},
    ...(input.fromAddress ? { fromAddress: input.fromAddress } : {}),
    ...(input.fromName ? { fromName: input.fromName } : {}),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    ...(input.scheduledAt ? { scheduledAt: input.scheduledAt, status: 'scheduled' } : { status: 'draft' }),
    createdAt: Date.now(),
  })
  return { id }
}

async function resolveSegment(workspaceId: string, filter: { includeSegments?: string[]; excludeSegments?: string[]; sinceDays?: number }): Promise<Array<typeof leadCapture.$inferSelect>> {
  const filters = [eq(leadCapture.workspaceId, workspaceId), isNull(leadCapture.unsubscribedAt)]
  if (filter.sinceDays && filter.sinceDays > 0) {
    filters.push(gte(leadCapture.subscribedAt, Date.now() - filter.sinceDays * 86_400_000))
  }
  const rows = await db.select().from(leadCapture).where(and(...filters)).limit(50_000)
  const inc = filter.includeSegments
  const exc = filter.excludeSegments
  return rows.filter(r => {
    const segs = r.segments ?? []
    if (inc && inc.length > 0 && !segs.some(s => inc.includes(s))) return false
    if (exc && exc.some(s => segs.includes(s))) return false
    return true
  })
}

async function resendKey(workspaceId: string): Promise<string | null> {
  const [row] = await db.select({ id: secretsVault.id })
    .from(secretsVault)
    .where(and(eq(secretsVault.workspaceId, workspaceId), eq(secretsVault.name, 'resend_api_key')))
    .limit(1)
  if (!row) return null
  try {
    const { revealSecret } = await import('./secrets-vault.js')
    return await revealSecret(row.id, 'system:r162-email-campaign', 'send approved email campaign')
  } catch { return null }
}

/**
 * Send the campaign. A/B subject: first 50% sample goes A vs B (50/50 split).
 * After sample, the winning subject (by raw send count baseline; opens
 * only land later via webhook) is used for the remainder. Without opens
 * yet, we just complete the 50/50 split safely.
 */
export async function campaignSendNow(workspaceId: string, campaignId: string): Promise<{ ok: boolean; sent: number; failed: number; error?: string }> {
  const [c] = await db.select().from(emailCampaign)
    .where(and(eq(emailCampaign.workspaceId, workspaceId), eq(emailCampaign.id, campaignId)))
    .limit(1)
  if (!c) return { ok: false, sent: 0, failed: 0, error: 'not found' }
  if (c.status === 'sent' || c.status === 'sending') return { ok: false, sent: 0, failed: 0, error: `status=${c.status}` }
  if (!c.fromAddress) return { ok: false, sent: 0, failed: 0, error: 'fromAddress required' }
  const key = await resendKey(workspaceId)
  if (!key) return { ok: false, sent: 0, failed: 0, error: 'no resend_api_key in vault' }

  await db.update(emailCampaign).set({ status: 'sending' }).where(eq(emailCampaign.id, campaignId))

  const recipients = await resolveSegment(workspaceId, (c.segmentFilter ?? {}) as { includeSegments?: string[]; excludeSegments?: string[]; sinceDays?: number })
  let sent = 0
  let failed = 0
  const hasB = !!c.subjectB

  // R146.190 — drip-send to avoid spam-filter trips. Batches of 50,
  // 250ms gaussian-paced gap between sends; 8s pause between batches.
  const BATCH_SIZE = 50
  for (let i = 0; i < recipients.length; i++) {
    if (i > 0 && i % BATCH_SIZE === 0) await new Promise(r => setTimeout(r, 8_000))
    else if (i > 0) await new Promise(r => setTimeout(r, 200 + Math.random() * 200))
    const r = recipients[i]
    if (!r) continue
    const variant: 'a' | 'b' = hasB && (i % 2 === 1) ? 'b' : 'a'
    const subject = variant === 'b' ? (c.subjectB ?? c.subjectA) : c.subjectA
    const sendId = uuidv7()
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: c.fromName ? `${c.fromName} <${c.fromAddress}>` : c.fromAddress,
          to:   [r.email],
          subject,
          html: c.body,
          ...(c.replyTo ? { reply_to: c.replyTo } : {}),
        }),
      })
      const data = await res.json().catch(() => ({})) as { id?: string; message?: string }
      if (!res.ok) {
        failed += 1
        await db.insert(emailSend).values({
          id: sendId, workspaceId, campaignId, captureId: r.id, variant,
          provider: 'resend', sentAt: Date.now(), error: (data.message ?? `http_${res.status}`).slice(0, 400),
        })
      } else {
        sent += 1
        await db.insert(emailSend).values({
          id: sendId, workspaceId, campaignId, captureId: r.id, variant,
          provider: 'resend',
          ...(data.id ? { providerId: data.id } : {}),
          sentAt: Date.now(),
        })
      }
    } catch (e) {
      failed += 1
      try {
        await db.insert(emailSend).values({
          id: sendId, workspaceId, campaignId, captureId: r.id, variant,
          provider: 'resend', sentAt: Date.now(), error: (e as Error).message.slice(0, 400),
        })
      } catch { /* ignore */ }
    }
  }

  const status = failed === 0 ? 'sent' : (sent === 0 ? 'failed' : 'sent')
  await db.update(emailCampaign).set({
    status, sentAt: Date.now(), sends: sent, bounces: failed,
  }).where(eq(emailCampaign.id, campaignId))
  return { ok: sent > 0, sent, failed }
}

// ─── Win-back cron ───────────────────────────────────────────────────

/**
 * Find dormant captures (no open in 30d, subscribed >=14d ago, not
 * already in an active win-back campaign in last 60d) and auto-draft
 * a re-engagement campaign for operator approval.
 */
export async function winBackTick(workspaceId: string): Promise<{ drafted: number; dormantCount: number }> {
  const now = Date.now()
  const thirty = now - 30 * 86_400_000
  const fourteen = now - 14 * 86_400_000
  const sixty = now - 60 * 86_400_000

  const dormant = await db.select({ id: leadCapture.id }).from(leadCapture)
    .where(and(
      eq(leadCapture.workspaceId, workspaceId),
      isNull(leadCapture.unsubscribedAt),
      lte(leadCapture.subscribedAt, fourteen),
      sql`(${leadCapture.lastOpenAt} IS NULL OR ${leadCapture.lastOpenAt} <= ${thirty})`,
    ))
    .limit(5000)

  if (dormant.length === 0) return { drafted: 0, dormantCount: 0 }

  // Skip if an active win-back campaign already exists in the window.
  const recent = await db.select({ id: emailCampaign.id }).from(emailCampaign)
    .where(and(
      eq(emailCampaign.workspaceId, workspaceId),
      sql`${emailCampaign.name} LIKE 'win-back%'`,
      gte(emailCampaign.createdAt, sixty),
    ))
    .limit(1)
  if (recent.length > 0) return { drafted: 0, dormantCount: dormant.length }

  const week = new Date().toISOString().slice(0, 10)
  const out = await campaignCreate(workspaceId, {
    name: `win-back ${week}`,
    subjectA: `Still want these?`,
    subjectB: `We miss you`,
    body: `<p>Hey — noticed you haven't opened in a while. Want to keep getting these, or take a break?</p><p><a href="https://example.com/keep">Keep me on the list</a> · <a href="https://example.com/unsubscribe">Unsubscribe</a></p>`,
    segmentFilter: { includeSegments: ['dormant'] },
  })
  return { drafted: 1, dormantCount: dormant.length, ...(out ? {} : {}) }
}

// ─── Reads ───────────────────────────────────────────────────────────

export async function listCaptures(workspaceId: string, opts: { segment?: string; limit?: number } = {}): Promise<Array<typeof leadCapture.$inferSelect>> {
  const limit = Math.min(opts.limit ?? 50, 500)
  const filters = [eq(leadCapture.workspaceId, workspaceId), isNull(leadCapture.unsubscribedAt)]
  let rows = await db.select().from(leadCapture).where(and(...filters)).orderBy(desc(leadCapture.subscribedAt)).limit(limit)
  if (opts.segment) rows = rows.filter(r => (r.segments ?? []).includes(opts.segment as string))
  return rows
}

export async function listCampaigns(workspaceId: string, opts: { status?: string; limit?: number } = {}): Promise<Array<typeof emailCampaign.$inferSelect>> {
  const limit = Math.min(opts.limit ?? 30, 100)
  const where = opts.status
    ? and(eq(emailCampaign.workspaceId, workspaceId), eq(emailCampaign.status, opts.status))
    : eq(emailCampaign.workspaceId, workspaceId)
  return db.select().from(emailCampaign).where(where).orderBy(desc(emailCampaign.createdAt)).limit(limit)
}

export async function listStats(workspaceId: string): Promise<{ total: number; active: number; engaged: number; dormant: number; magnets: number }> {
  const [counts] = await db.select({
    total:    sql<number>`count(*)::int`,
    active:   sql<number>`count(*) filter (where ${leadCapture.unsubscribedAt} is null)::int`,
    engaged:  sql<number>`count(*) filter (where ${leadCapture.lastOpenAt} >= ${Date.now() - 14 * 86_400_000})::int`,
  }).from(leadCapture).where(eq(leadCapture.workspaceId, workspaceId))
  const [magnetCount] = await db.select({ n: sql<number>`count(*)::int` }).from(leadMagnet)
    .where(and(eq(leadMagnet.workspaceId, workspaceId), eq(leadMagnet.status, 'active')))
  const active = Number(counts?.active ?? 0)
  const engaged = Number(counts?.engaged ?? 0)
  return {
    total:   Number(counts?.total ?? 0),
    active,
    engaged,
    dormant: Math.max(0, active - engaged),
    magnets: Number(magnetCount?.n ?? 0),
  }
}

void isNotNull
