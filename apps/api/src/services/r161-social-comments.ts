/**
 * R161 — Social comment harvesting + self-improvement loop.
 *
 * Reads comments from every active social account, classifies sentiment +
 * intent, rolls up themes, and feeds the patterns back into:
 *   - prompt-evolution (if a theme correlates with positive/negative)
 *   - video PAI lessons (themes become creative directives)
 *   - reply-draft queue (high-priority comments get auto-drafted answers)
 *
 * The connectors (youtube/instagram/tiktok) already expose listComments +
 * replyToComment. This module is the orchestration + learning layer on
 * top of them, plus a unified store so the operator UI sees one feed.
 */
import { db } from '../db/client.js'
import {
  socialComment, socialCommentTheme, socialReplyDraft,
  connectorAccounts, secretsVault, socialPosts, videoPaiLesson,
} from '../db/schema.js'
import { and, eq, desc, sql, gte, isNull } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── Sentiment + intent classification (rules-based, cheap) ──────────

const POS_TOKENS = ['love', 'amazing', 'great', 'awesome', 'best', 'incredible', 'helpful', 'thank', 'thanks', '🔥', '❤', '👍', '😍', 'goat', 'fire']
const NEG_TOKENS = ['hate', 'bad', 'worst', 'terrible', 'awful', 'broken', 'disappointed', 'sucks', 'boring', 'cringe', 'mid', 'trash', '👎', '😡', 'lame']
const SPAM_TOKENS = ['check my', 'sub4sub', 'follow me', 'dm me', 'link in bio', 'free crypto', 'click here', 'visit my']
const QUESTION_TOKENS = ['?', 'how', 'why', 'when', 'where', 'what', 'which', 'can you', 'do you', 'tutorial']
const REQUEST_TOKENS = ['can you make', 'please make', 'do a video on', 'cover', 'show us', 'we need', 'i want', 'wish you would']

const STOP = new Set(['the','a','an','and','or','but','of','to','in','on','for','is','was','be','it','this','that','i','you','we','they','he','she','my','your','our','their','at','as','so','if','do','did','does','have','has','had','will','would','should','can','could','not','no','yes','just','very','really','also','too','then','than','because','about','from','with','by','out','up','down','over','more','most','some','any','all','one','two','three','its','it\'s','im','i\'m','its','dont','don\'t','its','thats'])

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !STOP.has(w))
}

function classifySentiment(body: string): 'pos' | 'neg' | 'neutral' | 'mixed' {
  const lc = body.toLowerCase()
  const pos = POS_TOKENS.filter(t => lc.includes(t)).length
  const neg = NEG_TOKENS.filter(t => lc.includes(t)).length
  if (pos > 0 && neg > 0) return 'mixed'
  if (pos > neg) return 'pos'
  if (neg > pos) return 'neg'
  return 'neutral'
}

function classifyIntent(body: string): 'question' | 'request' | 'praise' | 'complaint' | 'spam' | 'other' {
  const lc = body.toLowerCase()
  if (SPAM_TOKENS.some(t => lc.includes(t))) return 'spam'
  if (REQUEST_TOKENS.some(t => lc.includes(t))) return 'request'
  if (QUESTION_TOKENS.some(t => lc.includes(t))) return 'question'
  const sentiment = classifySentiment(body)
  if (sentiment === 'pos') return 'praise'
  if (sentiment === 'neg') return 'complaint'
  return 'other'
}

function priorityScore(intent: string, sentiment: string, bodyLen: number): number {
  let s = 30
  if (intent === 'question') s += 40
  if (intent === 'request') s += 30
  if (intent === 'complaint') s += 25
  if (intent === 'spam') s = 0
  if (sentiment === 'neg') s += 10
  if (bodyLen > 60) s += 5
  return Math.max(0, Math.min(100, s))
}

function extractThemes(body: string, max = 4): string[] {
  const counts = new Map<string, number>()
  for (const w of tokenize(body)) counts.set(w, (counts.get(w) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([k]) => k)
}

// ─── Per-platform fetchers ───────────────────────────────────────────

interface ActiveAccount {
  id: string
  workspaceId: string
  connectorId: string  // 'youtube' | 'instagram' | 'tiktok'
  secretRef: string | null
}

async function loadActiveAccounts(workspaceId: string): Promise<ActiveAccount[]> {
  const rows = await db.select({
    id: connectorAccounts.id, workspaceId: connectorAccounts.workspaceId,
    connectorId: connectorAccounts.connectorId, secretRef: connectorAccounts.secretRef,
  })
    .from(connectorAccounts)
    .where(and(
      eq(connectorAccounts.workspaceId, workspaceId),
      eq(connectorAccounts.status, 'active'),
      sql`${connectorAccounts.connectorId} IN ('youtube','instagram','tiktok')`,
    ))
  return rows
}

async function loadAccessToken(account: ActiveAccount): Promise<string | null> {
  if (!account.secretRef) return null
  try {
    const { revealSecret } = await import('./secrets-vault.js')
    return revealSecret(account.secretRef, 'system:r161-social-comments', 'harvest comments for self-improvement loop')
  } catch { return null }
}

async function recentExternalPostIds(workspaceId: string, platform: string, limit = 10): Promise<Array<{ postId: string; externalId: string }>> {
  const rows = await db.select({ id: socialPosts.id, externalId: socialPosts.externalId })
    .from(socialPosts)
    .where(and(
      eq(socialPosts.workspaceId, workspaceId),
      eq(socialPosts.platform, platform),
      eq(socialPosts.status, 'published'),
      sql`${socialPosts.externalId} IS NOT NULL`,
    ))
    .orderBy(desc(socialPosts.postedAt))
    .limit(limit)
  return rows.filter(r => r.externalId).map(r => ({ postId: r.id, externalId: r.externalId as string }))
}

// Normalize per-platform responses into a single shape.
interface RawComment {
  externalId: string
  body: string
  authorHandle?: string
  authorId?: string
  publishedAt?: number
}

async function fetchComments(account: ActiveAccount, accessToken: string, externalPostId: string): Promise<RawComment[]> {
  try {
    if (account.connectorId === 'youtube') {
      const yt = await import('./connector-youtube.js')
      const raw = await yt.listComments({ workspaceId: account.workspaceId, accessToken, videoId: externalPostId, maxResults: 50 })
      const items = (raw as { items?: Array<Record<string, unknown>> })?.items ?? []
      return items.map(it => {
        const snip = (it as { snippet?: { topLevelComment?: { snippet?: Record<string, unknown> } } }).snippet?.topLevelComment?.snippet ?? {}
        return {
          externalId:   String((it as { id?: string }).id ?? ''),
          body:         String(snip['textOriginal'] ?? snip['textDisplay'] ?? ''),
          ...(snip['authorDisplayName'] ? { authorHandle: String(snip['authorDisplayName']) } : {}),
          ...(snip['authorChannelId'] ? { authorId: String((snip['authorChannelId'] as { value?: string })?.value ?? '') } : {}),
          ...(snip['publishedAt'] ? { publishedAt: Date.parse(String(snip['publishedAt'])) || undefined } : {}),
        } as RawComment
      }).filter(c => c.externalId && c.body)
    }
    if (account.connectorId === 'instagram') {
      const ig = await import('./connector-instagram.js')
      // IG needs an igUserId — pull from account metadata if present.
      const [accRow] = await db.select({ metadata: connectorAccounts.metadata, externalAccount: connectorAccounts.externalAccount })
        .from(connectorAccounts).where(eq(connectorAccounts.id, account.id)).limit(1)
      const meta = (accRow?.metadata ?? {}) as Record<string, unknown>
      const igUserId = String(meta['igUserId'] ?? accRow?.externalAccount ?? '')
      if (!igUserId) return []
      const raw = await ig.listComments({ workspaceId: account.workspaceId, accessToken, igUserId, mediaId: externalPostId, limit: 50 })
      const items = (raw as { data?: Array<Record<string, unknown>> })?.data ?? []
      return items.map(it => ({
        externalId: String(it['id'] ?? ''),
        body:       String(it['text'] ?? ''),
        ...(it['username'] ? { authorHandle: String(it['username']) } : {}),
        ...(it['timestamp'] ? { publishedAt: Date.parse(String(it['timestamp'])) || undefined } : {}),
      } as RawComment)).filter(c => c.externalId && c.body)
    }
    if (account.connectorId === 'tiktok') {
      const tt = await import('./connector-tiktok.js')
      const raw = await tt.listComments({ workspaceId: account.workspaceId, accessToken, videoId: externalPostId, maxCount: 50 })
      const items = (raw as { data?: { comments?: Array<Record<string, unknown>> } })?.data?.comments ?? []
      return items.map(it => ({
        externalId: String(it['id'] ?? it['comment_id'] ?? ''),
        body:       String(it['text'] ?? ''),
        ...(it['username'] ? { authorHandle: String(it['username']) } : {}),
        ...(it['create_time'] ? { publishedAt: Number(it['create_time']) * 1000 } : {}),
      } as RawComment)).filter(c => c.externalId && c.body)
    }
  } catch { /* per-post failures are ok */ }
  return []
}

// ─── Harvest ────────────────────────────────────────────────────────

export async function commentsHarvest(workspaceId: string): Promise<{ scanned: number; new: number; perPlatform: Record<string, { new: number; scanned: number }> }> {
  const accounts = await loadActiveAccounts(workspaceId)
  const perPlatform: Record<string, { new: number; scanned: number }> = {}
  let totalScanned = 0
  let totalNew = 0

  for (const acc of accounts) {
    const token = await loadAccessToken(acc)
    if (!token) continue
    const platform = acc.connectorId
    const posts = await recentExternalPostIds(workspaceId, platform, 10)
    const bucket = perPlatform[platform] ?? { new: 0, scanned: 0 }
    perPlatform[platform] = bucket

    for (const post of posts) {
      const comments = await fetchComments(acc, token, post.externalId)
      bucket.scanned += comments.length
      totalScanned   += comments.length
      for (const raw of comments) {
        const sentiment = classifySentiment(raw.body)
        const intent    = classifyIntent(raw.body)
        const themes    = extractThemes(raw.body)
        const priority  = priorityScore(intent, sentiment, raw.body.length)
        try {
          await db.insert(socialComment).values({
            id: uuidv7(),
            workspaceId, platform,
            accountId:       acc.id,
            postId:          post.postId,
            externalPostId:  post.externalId,
            externalId:      raw.externalId,
            ...(raw.authorHandle ? { authorHandle: raw.authorHandle } : {}),
            ...(raw.authorId ? { authorId: raw.authorId } : {}),
            body:            raw.body.slice(0, 4000),
            ...(raw.publishedAt ? { publishedAt: raw.publishedAt } : {}),
            fetchedAt:       Date.now(),
            sentiment, intent, themes,
            replyPriority:   priority,
          }).onConflictDoNothing()
          bucket.new += 1
          totalNew   += 1
        } catch { /* dup or other; skip */ }
      }
    }
  }
  return { scanned: totalScanned, new: totalNew, perPlatform }
}

// ─── Analyze → theme rollup ─────────────────────────────────────────

export async function commentsAnalyze(workspaceId: string, windowDays = 14): Promise<{ themesUpserted: number; commentsConsidered: number }> {
  const since = Date.now() - windowDays * 24 * 60 * 60_000
  const rows = await db.select({
    themes: socialComment.themes, sentiment: socialComment.sentiment, fetchedAt: socialComment.fetchedAt,
  })
    .from(socialComment)
    .where(and(eq(socialComment.workspaceId, workspaceId), gte(socialComment.fetchedAt, since)))
    .limit(5000)

  // Aggregate.
  const agg = new Map<string, { count: number; pos: number; neg: number; first: number; last: number }>()
  for (const r of rows) {
    for (const t of (r.themes ?? [])) {
      const cur = agg.get(t) ?? { count: 0, pos: 0, neg: 0, first: r.fetchedAt, last: r.fetchedAt }
      cur.count += 1
      if (r.sentiment === 'pos') cur.pos += 1
      if (r.sentiment === 'neg') cur.neg += 1
      cur.first = Math.min(cur.first, r.fetchedAt)
      cur.last  = Math.max(cur.last,  r.fetchedAt)
      agg.set(t, cur)
    }
  }

  let upserted = 0
  for (const [theme, v] of agg.entries()) {
    if (v.count < 3) continue           // ignore noise
    if (theme.length > 60) continue
    const sentimentAvg = v.count > 0 ? (v.pos - v.neg) / v.count : 0
    await db.insert(socialCommentTheme).values({
      id: uuidv7(), workspaceId, theme,
      count: v.count, posCount: v.pos, negCount: v.neg,
      sentimentAvg, firstSeenAt: v.first, lastSeenAt: v.last,
    }).onConflictDoUpdate({
      target: [socialCommentTheme.workspaceId, socialCommentTheme.theme],
      set: {
        count: v.count, posCount: v.pos, negCount: v.neg,
        sentimentAvg, lastSeenAt: v.last,
      },
    })
    upserted += 1
  }
  return { themesUpserted: upserted, commentsConsidered: rows.length }
}

// ─── Self-improve: themes → lessons ──────────────────────────────────

export async function commentsSelfImprove(workspaceId: string): Promise<{ lessonsMinted: number }> {
  await commentsAnalyze(workspaceId)
  const themes = await db.select().from(socialCommentTheme)
    .where(eq(socialCommentTheme.workspaceId, workspaceId))
    .orderBy(desc(socialCommentTheme.count))
    .limit(20)

  let minted = 0
  for (const t of themes) {
    if (t.count < 5) continue
    const topic = t.sentimentAvg >= 0.3 ? 'audience-loves'
               : t.sentimentAvg <= -0.3 ? 'audience-dislikes'
               : 'audience-requests'
    const pattern = topic === 'audience-loves'
      ? `Audience repeatedly praises "${t.theme}" (${t.count} mentions, sentiment +${t.sentimentAvg.toFixed(2)}). Lean into it.`
      : topic === 'audience-dislikes'
      ? `Audience repeatedly complains about "${t.theme}" (${t.count} mentions, sentiment ${t.sentimentAvg.toFixed(2)}). Address or avoid.`
      : `Audience repeatedly mentions "${t.theme}" (${t.count} mentions). Consider creating content about it.`
    const confidence = Math.min(0.95, 0.5 + Math.min(t.count, 30) / 60)
    await db.insert(videoPaiLesson).values({
      id: uuidv7(), workspaceId, topic, pattern,
      evidence: { theme: t.theme, count: t.count, sentimentAvg: t.sentimentAvg, source: 'social-comments' },
      confidence, uses: 0, wins: 0, losses: 0,
      createdAt: Date.now(),
    })
    minted += 1
  }
  return { lessonsMinted: minted }
}

// ─── Reply drafting ─────────────────────────────────────────────────

export async function replyDraftCreate(workspaceId: string, commentId: string): Promise<{ id: string; body: string } | { error: string }> {
  const [c] = await db.select().from(socialComment)
    .where(and(eq(socialComment.workspaceId, workspaceId), eq(socialComment.id, commentId)))
    .limit(1)
  if (!c) return { error: 'comment not found' }
  if (c.intent === 'spam') return { error: 'spam — skip' }

  // Rules-based reply skeleton. LLM enrichment can replace this body later.
  let body = ''
  switch (c.intent) {
    case 'question':
      body = c.authorHandle
        ? `Great question @${c.authorHandle} — short answer: we cover this in our next post. Stay tuned!`
        : `Great question — we cover this in our next post. Stay tuned!`
      break
    case 'request':
      body = `Noted — adding this to the queue. Drop more ideas any time!`
      break
    case 'praise':
      body = c.authorHandle ? `Appreciate you @${c.authorHandle} 🙏` : `Appreciate you 🙏`
      break
    case 'complaint':
      body = `Sorry that didn't land for you — would love to know what would have made it better. DMs open.`
      break
    default:
      body = `Thanks for watching!`
  }
  const id = uuidv7()
  await db.insert(socialReplyDraft).values({
    id, workspaceId, commentId, body, source: 'rules', status: 'draft', createdAt: Date.now(),
  })
  return { id, body }
}

export async function replyDraftApprove(workspaceId: string, draftId: string, approvedBy: string): Promise<{ ok: boolean }> {
  const r = await db.update(socialReplyDraft).set({ status: 'approved', approvedBy, approvedAt: Date.now() })
    .where(and(eq(socialReplyDraft.workspaceId, workspaceId), eq(socialReplyDraft.id, draftId), eq(socialReplyDraft.status, 'draft')))
    .returning({ id: socialReplyDraft.id })
  return { ok: r.length > 0 }
}

export async function replyDraftSend(workspaceId: string, draftId: string): Promise<{ ok: boolean; error?: string }> {
  const [draft] = await db.select().from(socialReplyDraft)
    .where(and(eq(socialReplyDraft.workspaceId, workspaceId), eq(socialReplyDraft.id, draftId), eq(socialReplyDraft.status, 'approved')))
    .limit(1)
  if (!draft) return { ok: false, error: 'no approved draft' }

  const [c] = await db.select().from(socialComment)
    .where(eq(socialComment.id, draft.commentId)).limit(1)
  if (!c) return { ok: false, error: 'comment vanished' }
  const [acc] = await db.select().from(connectorAccounts).where(eq(connectorAccounts.id, c.accountId)).limit(1)
  if (!acc?.secretRef) return { ok: false, error: 'no account/token' }

  const { revealSecret } = await import('./secrets-vault.js')
  const token = await revealSecret(acc.secretRef, 'system:r161-reply-send', `send approved reply ${draftId}`)
  if (!token) return { ok: false, error: 'token resolution failed' }

  try {
    let replyExtId: string | undefined
    if (c.platform === 'youtube') {
      const yt = await import('./connector-youtube.js')
      const r = await yt.replyToComment({ workspaceId, accessToken: token, parentCommentId: c.externalId, text: draft.body, approvalToken: 'OPERATOR_APPROVED' })
      replyExtId = String((r as { id?: string })?.id ?? '')
    } else if (c.platform === 'instagram') {
      const [accRow] = await db.select({ metadata: connectorAccounts.metadata, externalAccount: connectorAccounts.externalAccount })
        .from(connectorAccounts).where(eq(connectorAccounts.id, acc.id)).limit(1)
      const meta = (accRow?.metadata ?? {}) as Record<string, unknown>
      const igUserId = String(meta['igUserId'] ?? accRow?.externalAccount ?? '')
      if (!igUserId) return { ok: false, error: 'instagram account missing igUserId' }
      const ig = await import('./connector-instagram.js')
      const r = await ig.replyToComment({ workspaceId, accessToken: token, igUserId, commentId: c.externalId, text: draft.body, approvalToken: 'OPERATOR_APPROVED' })
      replyExtId = String((r as { id?: string })?.id ?? '')
    } else if (c.platform === 'tiktok') {
      if (!c.externalPostId) return { ok: false, error: 'tiktok comment missing post id' }
      const tt = await import('./connector-tiktok.js')
      const r = await tt.replyToComment({ workspaceId, accessToken: token, videoId: c.externalPostId, parentCommentId: c.externalId, text: draft.body, approvalToken: 'OPERATOR_APPROVED' })
      replyExtId = String((r as { id?: string })?.id ?? '')
    } else {
      return { ok: false, error: `unsupported platform ${c.platform}` }
    }
    const now = Date.now()
    await db.update(socialReplyDraft).set({ status: 'sent', sentAt: now }).where(eq(socialReplyDraft.id, draftId))
    await db.update(socialComment).set({ repliedAt: now, ...(replyExtId ? { replyExternalId: replyExtId } : {}) }).where(eq(socialComment.id, c.id))
    return { ok: true }
  } catch (e) {
    const msg = (e as Error).message.slice(0, 400)
    await db.update(socialReplyDraft).set({ status: 'failed', sendError: msg }).where(eq(socialReplyDraft.id, draftId))
    return { ok: false, error: msg }
  }
}

/**
 * R146.191 — Sweep approved drafts and send them, capped per workspace
 * per hour to avoid spam-pattern detection.
 */
export async function sweepApprovedSends(workspaceId: string, opts: { hourlyCap?: number } = {}): Promise<{ sent: number; failed: number }> {
  const cap = opts.hourlyCap ?? 10
  const since = Date.now() - 60 * 60_000
  const [recent] = await db.select({ n: sql<number>`count(*)::int` })
    .from(socialReplyDraft)
    .where(and(
      eq(socialReplyDraft.workspaceId, workspaceId),
      eq(socialReplyDraft.status, 'sent'),
      gte(socialReplyDraft.sentAt, since),
    ))
  const recentSent = Number(recent?.n ?? 0)
  const remaining = Math.max(0, cap - recentSent)
  if (remaining === 0) return { sent: 0, failed: 0 }

  const approved = await db.select({ id: socialReplyDraft.id }).from(socialReplyDraft)
    .where(and(eq(socialReplyDraft.workspaceId, workspaceId), eq(socialReplyDraft.status, 'approved')))
    .orderBy(socialReplyDraft.approvedAt)
    .limit(remaining)
  let sent = 0, failed = 0
  for (const a of approved) {
    const r = await replyDraftSend(workspaceId, a.id).catch(() => ({ ok: false } as { ok: boolean }))
    if (r.ok) sent += 1; else failed += 1
    // Humanish 30-90s gap between sends — avoids burst pattern.
    await new Promise(r => setTimeout(r, 30_000 + Math.random() * 60_000))
  }
  return { sent, failed }
}

/**
 * Auto-draft replies for the top-N pending high-priority comments.
 * Operator still approves. Idempotent: skips comments that already have a draft.
 */
export async function autoDraftBacklog(workspaceId: string, limit = 10): Promise<{ drafted: number }> {
  const rows = await db.select({ id: socialComment.id })
    .from(socialComment)
    .leftJoin(socialReplyDraft, eq(socialReplyDraft.commentId, socialComment.id))
    .where(and(
      eq(socialComment.workspaceId, workspaceId),
      isNull(socialComment.repliedAt),
      isNull(socialComment.hiddenAt),
      sql`${socialComment.intent} <> 'spam'`,
      gte(socialComment.replyPriority, 50),
      isNull(socialReplyDraft.id),
    ))
    .orderBy(desc(socialComment.replyPriority))
    .limit(limit)

  let drafted = 0
  for (const r of rows) {
    const out = await replyDraftCreate(workspaceId, r.id)
    if ('id' in out) drafted += 1
  }
  return { drafted }
}

// ─── Read APIs ───────────────────────────────────────────────────────

export async function commentsList(workspaceId: string, opts: { intent?: string; sentiment?: string; limit?: number; unrepliedOnly?: boolean } = {}): Promise<Array<typeof socialComment.$inferSelect>> {
  const limit = Math.min(opts.limit ?? 30, 200)
  const filters = [eq(socialComment.workspaceId, workspaceId)]
  if (opts.intent) filters.push(eq(socialComment.intent, opts.intent))
  if (opts.sentiment) filters.push(eq(socialComment.sentiment, opts.sentiment))
  if (opts.unrepliedOnly) filters.push(isNull(socialComment.repliedAt))
  return db.select().from(socialComment).where(and(...filters)).orderBy(desc(socialComment.replyPriority), desc(socialComment.fetchedAt)).limit(limit)
}

export async function themesTop(workspaceId: string, limit = 30): Promise<Array<typeof socialCommentTheme.$inferSelect>> {
  return db.select().from(socialCommentTheme)
    .where(eq(socialCommentTheme.workspaceId, workspaceId))
    .orderBy(desc(socialCommentTheme.count))
    .limit(Math.min(limit, 100))
}
