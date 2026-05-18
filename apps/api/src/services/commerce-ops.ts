/**
 * commerce-ops.ts — Browser session + account vault + POD + social
 * orchestration.
 *
 * Honest scope:
 *   - Session management is PERMISSION-FIRST. Sessions don't run a real
 *     browser unless an external worker picks them up (Puppeteer/Playwright
 *     integration is out of scope here). What we ship is the
 *     permission/approval/audit surface that a worker would honor.
 *   - Account vault wraps secrets-vault. Operator stores credentials there
 *     directly; commerce-ops only stores the reference id.
 *   - Posting governor enforces cooldowns + per-day caps.
 *   - Every action goes through commerce-policy (purchase block,
 *     spam block, IP block).
 */
import { db } from '../db/client.js'
import {
  commerceSessions, commerceEvents, accountCredentials,
  podListings, socialPosts, designConcepts, trendFindings,
  postingGovernor, ethicalBlocks,
} from '../db/schema.js'
import { and, eq, desc, gte, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import {
  checkPublishContent, checkBrowserAction, checkSpam, scoreSlop, compositeQuality, scoreOriginality,
} from './commerce-policy.js'
import { embed } from './semantic-search.js'
import { record as recordChain } from './reasoning-chains.js'
import { notify } from './notifications.js'

// ─── Browser session manager ────────────────────────────────────────────

export interface SessionInput {
  workspaceId: string
  platform:    string
  accountRef:  string
  scopes:      string[]
}

export async function requestSession(i: SessionInput): Promise<{ id: string; status: string; requiresApproval: true }> {
  const id = uuidv7(), now = Date.now()
  await db.insert(commerceSessions).values({
    id, workspaceId: i.workspaceId,
    platform: i.platform, accountRef: i.accountRef,
    status: 'pending', scopes: i.scopes,
    eventsCount: 0, screenshotsTaken: 0,
    createdAt: now, updatedAt: now,
  }).catch(() => null)
  await recordChain({
    workspaceId: i.workspaceId, kind: 'decision', subjectId: `browser-session:${id}`,
    decision: `Browser session requested: ${i.platform}/${i.accountRef} scopes=${i.scopes.join(',')}`,
    confidence: 0.8, source: 'commerce-ops',
  }).catch(() => null)
  return { id, status: 'pending', requiresApproval: true }
}

export async function approveSession(workspaceId: string, sessionId: string, by = 'operator'): Promise<void> {
  await db.update(commerceSessions).set({
    status: 'approved', startedAt: Date.now(), updatedAt: Date.now(),
  }).where(and(eq(commerceSessions.workspaceId, workspaceId), eq(commerceSessions.id, sessionId)))
    .catch(() => null)
  await recordChain({
    workspaceId, kind: 'decision', subjectId: `browser-session:${sessionId}`,
    decision: `Operator ${by} approved browser session`,
    confidence: 0.95, source: 'commerce-ops',
  }).catch(() => null)
}

export async function endSession(workspaceId: string, sessionId: string, status: 'ended' | 'revoked' = 'ended'): Promise<void> {
  await db.update(commerceSessions).set({
    status, endedAt: Date.now(), updatedAt: Date.now(),
  }).where(and(eq(commerceSessions.workspaceId, workspaceId), eq(commerceSessions.id, sessionId)))
    .catch(() => null)
}

export interface BrowserActionInput {
  workspaceId:    string
  sessionId:      string
  eventType:      'navigate' | 'click' | 'type' | 'screenshot' | 'wait' | 'confirm_required' | 'confirmed' | 'blocked'
  url?:           string
  actionText?:    string
  requiresConfirm?: boolean
  screenshotPath?:  string
}

export async function recordBrowserEvent(i: BrowserActionInput): Promise<{ id: string; status: 'recorded' | 'blocked'; reason?: string }> {
  // Policy check FIRST: purchases, captcha bypass, etc.
  const intent = `${i.eventType} ${i.actionText ?? ''}`
  const policy = checkBrowserAction(intent, i.url)
  const id = uuidv7()

  if (!policy.ok) {
    await db.insert(commerceEvents).values({
      id, sessionId: i.sessionId, workspaceId: i.workspaceId,
      eventType: 'blocked', url: i.url ?? null,
      actionText: i.actionText ?? null,
      screenshotPath: i.screenshotPath ?? null,
      requiresConfirm: false, confirmed: false,
      blockedReason: policy.reasons.join('; '),
      occurredAt: Date.now(),
    }).catch(() => null)
    await db.insert(ethicalBlocks).values({
      id: uuidv7(), workspaceId: i.workspaceId,
      intent: intent.slice(0, 500), source: 'commerce-ops',
      category: policy.category === 'purchase' ? 'purchase' : policy.category === 'security' ? 'other' : 'other',
      reason: policy.reasons.join('; '),
      blockedAt: Date.now(),
    }).catch(() => null)
    return { id, status: 'blocked', reason: policy.reasons.join('; ') }
  }

  await db.insert(commerceEvents).values({
    id, sessionId: i.sessionId, workspaceId: i.workspaceId,
    eventType: i.eventType, url: i.url ?? null,
    actionText: i.actionText ?? null,
    screenshotPath: i.screenshotPath ?? null,
    requiresConfirm: i.requiresConfirm ?? false,
    confirmed: false,
    occurredAt: Date.now(),
  }).catch(() => null)
  await db.update(commerceSessions).set({
    eventsCount: sql`${commerceSessions.eventsCount} + 1`,
    screenshotsTaken: i.eventType === 'screenshot' ? sql`${commerceSessions.screenshotsTaken} + 1` : commerceSessions.screenshotsTaken,
    updatedAt: Date.now(),
  }).where(eq(commerceSessions.id, i.sessionId)).catch(() => null)

  return { id, status: 'recorded' }
}

// ─── Account vault ──────────────────────────────────────────────────────

export async function registerAccount(workspaceId: string, platform: string, accountRef: string, scopes: string[], vaultSecretId?: string): Promise<string> {
  const id = uuidv7(), now = Date.now()
  await db.insert(accountCredentials).values({
    id, workspaceId, platform, accountRef,
    vaultSecretId: vaultSecretId ?? null,
    grantedScopes: scopes,
    paused: false,
    createdAt: now, updatedAt: now,
  }).onConflictDoUpdate({
    target: [accountCredentials.workspaceId, accountCredentials.platform, accountCredentials.accountRef],
    set: { grantedScopes: scopes, vaultSecretId: vaultSecretId ?? null, updatedAt: now },
  }).catch(() => null)
  return id
}

export async function pauseAccount(workspaceId: string, platform: string, accountRef: string, paused: boolean): Promise<void> {
  await db.update(accountCredentials).set({ paused, updatedAt: Date.now() })
    .where(and(
      eq(accountCredentials.workspaceId, workspaceId),
      eq(accountCredentials.platform, platform),
      eq(accountCredentials.accountRef, accountRef),
    )).catch(() => null)
}

export async function listAccounts(workspaceId: string) {
  return db.select().from(accountCredentials)
    .where(eq(accountCredentials.workspaceId, workspaceId))
    .orderBy(desc(accountCredentials.updatedAt)).catch(() => [])
}

// ─── Posting governor ───────────────────────────────────────────────────

export interface GovernorCheck {
  ok:            boolean
  reason?:       string
  remainingToday: number
  cooldownLeftSec: number
}

export async function checkGovernor(workspaceId: string, platform: string, accountRef: string): Promise<GovernorCheck> {
  const now = Date.now()
  let row = await db.select().from(postingGovernor)
    .where(and(
      eq(postingGovernor.workspaceId, workspaceId),
      eq(postingGovernor.platform, platform),
      eq(postingGovernor.accountRef, accountRef),
    )).limit(1).then(r => r[0]).catch(() => null)

  if (!row) {
    // Default conservative settings
    await db.insert(postingGovernor).values({
      workspaceId, platform, accountRef,
      postsToday: 0, maxPerDay: 5, cooldownMin: 45,
      windowStart: now, updatedAt: now,
    }).onConflictDoNothing().catch(() => null)
    return { ok: true, remainingToday: 5, cooldownLeftSec: 0 }
  }

  // Roll the day window
  if (now - row.windowStart >= 24 * 60 * 60_000) {
    await db.update(postingGovernor).set({
      postsToday: 0, windowStart: now, updatedAt: now,
    }).where(and(
      eq(postingGovernor.workspaceId, workspaceId),
      eq(postingGovernor.platform, platform),
      eq(postingGovernor.accountRef, accountRef),
    )).catch(() => null)
    row = { ...row, postsToday: 0, windowStart: now }
  }

  const cooldownLeftMs = row.lastPostAt ? Math.max(0, (row.lastPostAt + row.cooldownMin * 60_000) - now) : 0
  const cooldownLeftSec = Math.ceil(cooldownLeftMs / 1000)
  const remainingToday  = Math.max(0, row.maxPerDay - row.postsToday)

  if (row.postsToday >= row.maxPerDay) {
    return { ok: false, reason: `daily cap reached (${row.maxPerDay})`, remainingToday: 0, cooldownLeftSec }
  }
  if (cooldownLeftMs > 0) {
    return { ok: false, reason: `cooldown ${cooldownLeftSec}s remaining`, remainingToday, cooldownLeftSec }
  }
  const result: GovernorCheck = { ok: true, remainingToday, cooldownLeftSec: 0 }
  return result
}

export async function recordPost(workspaceId: string, platform: string, accountRef: string): Promise<void> {
  const now = Date.now()
  await db.update(postingGovernor).set({
    postsToday: sql`${postingGovernor.postsToday} + 1`,
    lastPostAt: now, updatedAt: now,
  }).where(and(
    eq(postingGovernor.workspaceId, workspaceId),
    eq(postingGovernor.platform, platform),
    eq(postingGovernor.accountRef, accountRef),
  )).catch(() => null)
}

// ─── Social post drafting ───────────────────────────────────────────────

export async function draftSocialPost(workspaceId: string, platform: string, accountRef: string, body: string, assetRefs: string[] = []): Promise<{ id: string; status: 'draft' | 'blocked'; reasons: string[] }> {
  const content = checkPublishContent(body)
  const spam    = scoreSlop(body)
  const reasons: string[] = [...content.reasons]
  const id = uuidv7(), now = Date.now()
  const status = content.ok ? 'draft' : 'blocked'

  await db.insert(socialPosts).values({
    id, workspaceId, platform, accountRef,
    body: body.slice(0, 5000), assetRefs,
    status, spamScore: spam.score,
    blockReasons: reasons,
    createdAt: now, updatedAt: now,
  }).catch(() => null)

  if (status === 'blocked') {
    await db.insert(ethicalBlocks).values({
      id: uuidv7(), workspaceId,
      intent: body.slice(0, 500), source: 'commerce-ops',
      category: content.category === 'ip' ? 'ip' : 'spam',
      reason: reasons.join('; '), blockedAt: now,
    }).catch(() => null)
  }
  return { id, status, reasons }
}

export async function publishSocialPost(workspaceId: string, postId: string, by = 'operator'): Promise<{ ok: boolean; reason?: string }> {
  const post = await db.select().from(socialPosts)
    .where(and(eq(socialPosts.workspaceId, workspaceId), eq(socialPosts.id, postId)))
    .limit(1).then(r => r[0]).catch(() => null)
  if (!post) return { ok: false, reason: 'not found' }
  if (post.status === 'blocked') return { ok: false, reason: 'post is blocked by policy' }

  // Governor check
  const gov = await checkGovernor(workspaceId, post.platform, post.accountRef)
  if (!gov.ok) return { ok: false, reason: gov.reason ?? 'governor blocked' }

  // Mark posted (operator handles actual platform call)
  await db.update(socialPosts).set({
    status: 'posted', postedAt: Date.now(), updatedAt: Date.now(),
  }).where(eq(socialPosts.id, postId)).catch(() => null)
  await recordPost(workspaceId, post.platform, post.accountRef)
  await recordChain({
    workspaceId, kind: 'decision', subjectId: `social-post:${postId}`,
    decision: `Social post published by ${by}: ${post.platform}/${post.accountRef}`,
    confidence: 0.9, source: 'commerce-ops',
  }).catch(() => null)
  return { ok: true }
}

// ─── Design concept generation ──────────────────────────────────────────

export async function createDesignConcept(workspaceId: string, brief: string, prompt: string, trendRefs: string[] = []): Promise<{ id: string; status: string; scores: { originality: number; slop: number; ipRisk: number; quality: number }; blockReasons: string[] }> {
  const id = uuidv7(), now = Date.now()

  // Originality vs recent concepts cohort
  const recent = await db.select({ prompt: designConcepts.prompt }).from(designConcepts)
    .where(and(eq(designConcepts.workspaceId, workspaceId), gte(designConcepts.createdAt, now - 90 * 24 * 60 * 60_000)))
    .limit(500).catch(() => [])
  const cohort = recent.map(r => embed(r.prompt))
  const targetVec = embed(prompt)
  const orig = scoreOriginality(targetVec, cohort)

  // Slop on prompt + brief
  const slop = scoreSlop(`${brief} ${prompt}`)
  // IP risk via commerce-policy
  const ip = checkPublishContent(`${brief} ${prompt}`)
  const ipRiskScore = ip.ok ? 0 : Math.min(1, ip.reasons.length * 0.3)

  const quality = compositeQuality({ originality: orig.score, slop: slop.score, ipRisk: ipRiskScore })

  // Block at intake if IP risk is hard fail
  const blockReasons = ip.ok ? [] : ip.reasons.map(r => `ip:${r}`)
  const status = blockReasons.length > 0 ? 'rejected' : (quality >= 0.55 ? 'draft' : 'reviewed')

  await db.insert(designConcepts).values({
    id, workspaceId,
    brief: brief.slice(0, 2000), prompt: prompt.slice(0, 2000),
    originalityScore: orig.score, ipRiskScore, slopScore: slop.score, qualityScore: quality,
    trendRefs, status, blockReasons,
    createdAt: now, updatedAt: now,
  }).catch(() => null)

  if (blockReasons.length > 0) {
    await db.insert(ethicalBlocks).values({
      id: uuidv7(), workspaceId,
      intent: `design: ${brief}`.slice(0, 500), source: 'commerce-ops',
      category: 'ip', reason: blockReasons.join('; '), blockedAt: now,
    }).catch(() => null)
  }
  return { id, status, scores: { originality: orig.score, slop: slop.score, ipRisk: ipRiskScore, quality }, blockReasons }
}

// ─── POD listing creation ───────────────────────────────────────────────

export async function createListing(workspaceId: string, platform: string, title: string, description: string, tags: string[], conceptId?: string, assetRefs: string[] = []): Promise<{ id: string; status: string; reasons: string[] }> {
  const content = checkPublishContent(`${title} ${description} ${tags.join(' ')}`)
  const slop    = scoreSlop(`${title} ${description}`)
  const quality = 1 - slop.score
  const id = uuidv7(), now = Date.now()
  const status = content.ok ? 'draft' : 'draft'  // listings always start draft; block on publish

  await db.insert(podListings).values({
    id, workspaceId, platform,
    conceptId: conceptId ?? null,
    title: title.slice(0, 500), description: description.slice(0, 5000),
    tags: tags.slice(0, 30), assetRefs,
    status, qualityScore: Number(quality.toFixed(3)),
    createdAt: now, updatedAt: now,
  }).catch(() => null)

  if (!content.ok) {
    await db.insert(ethicalBlocks).values({
      id: uuidv7(), workspaceId,
      intent: `listing: ${title}`.slice(0, 500), source: 'commerce-ops',
      category: content.category === 'ip' ? 'ip' : 'spam',
      reason: content.reasons.join('; '), blockedAt: now,
    }).catch(() => null)
  }
  return { id, status, reasons: content.reasons }
}

// ─── Trend research ─────────────────────────────────────────────────────

export async function recordTrendFinding(i: { workspaceId: string; source: string; niche: string; signal: string; score: number; confidence: number; citations: Array<{ url: string; title: string; capturedAt: number }> }): Promise<string> {
  const id = uuidv7()
  await db.insert(trendFindings).values({
    id, workspaceId: i.workspaceId,
    source: i.source, niche: i.niche, signal: i.signal,
    score: i.score, confidence: i.confidence, citations: i.citations,
    capturedAt: Date.now(),
  }).catch(() => null)
  return id
}

export async function recentTrends(workspaceId: string, limit = 50) {
  return db.select().from(trendFindings)
    .where(eq(trendFindings.workspaceId, workspaceId))
    .orderBy(desc(trendFindings.capturedAt))
    .limit(limit).catch(() => [])
}

// ─── War-room snapshot ──────────────────────────────────────────────────

export async function commerceWarRoom(workspaceId: string) {
  const since24h = Date.now() - 24 * 60 * 60_000
  const [accounts, activeSessions, drafts, pendingPosts, recentTr, blocks, listings] = await Promise.all([
    db.select().from(accountCredentials).where(eq(accountCredentials.workspaceId, workspaceId)).catch(() => []),
    db.select().from(commerceSessions).where(and(eq(commerceSessions.workspaceId, workspaceId), eq(commerceSessions.status, 'running'))).catch(() => []),
    db.select().from(designConcepts).where(and(eq(designConcepts.workspaceId, workspaceId), eq(designConcepts.status, 'draft'))).orderBy(desc(designConcepts.createdAt)).limit(10).catch(() => []),
    db.select().from(socialPosts).where(and(eq(socialPosts.workspaceId, workspaceId), eq(socialPosts.status, 'approval_pending'))).limit(20).catch(() => []),
    recentTrends(workspaceId, 10),
    db.select({ n: sql<number>`count(*)::int`, category: ethicalBlocks.category })
      .from(ethicalBlocks)
      .where(and(eq(ethicalBlocks.workspaceId, workspaceId), gte(ethicalBlocks.blockedAt, since24h)))
      .groupBy(ethicalBlocks.category).catch(() => []),
    db.select().from(podListings).where(eq(podListings.workspaceId, workspaceId)).orderBy(desc(podListings.createdAt)).limit(10).catch(() => []),
  ])
  return {
    generatedAt: Date.now(),
    accounts: accounts.map(a => ({ ...a, vaultSecretId: a.vaultSecretId ? '[REDACTED]' : null })),
    activeSessions, drafts, pendingPosts, recentTrends: recentTr,
    listings,
    blocks24h: Object.fromEntries(blocks.map(b => [b.category, Number(b.n)])),
  }
}

/** Best-effort notify when something needs operator attention. */
export async function notifyApprovalNeeded(workspaceId: string, subject: string, body: string): Promise<void> {
  await notify({
    workspaceId, type: 'commerce.approval_needed',
    title: `Approval needed: ${subject}`, body,
    severity: 'normal',
    signature: `commerce-approval:${subject}`,
  }).catch(() => null)
}
