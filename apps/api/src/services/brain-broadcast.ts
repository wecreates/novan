/**
 * brain-broadcast.ts — Brain → operator proactive messaging.
 *
 * The brain initiates conversation in a dedicated "Brain broadcast"
 * conversation whenever something significant happens. The operator
 * sees it in their normal /talk inbox.
 *
 * Triggers covered:
 *   - CEO cycle: when delegations were created OR a division flipped red
 *   - autonomous-mind: when capability gaps were detected
 *   - issue auto-loop: when a patch was applied
 *   - security-team: when blocking findings were created
 *   - research-engine: when a high-relevance finding lands
 *
 * Implementation: instead of polling every event source, a single cron
 * (every 5 min) reads recent events + composes a digest. Dedupe via
 * lastBroadcastAt marker — never repeat the same digest within an hour.
 */
import { db } from '../db/client.js'
import { conversations, messages, events } from '../db/schema.js'
import { and, eq, desc, gte } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

const BROADCAST_CONVO_TITLE = 'Brain broadcast'
const QUIET_WINDOW_MS       = 30 * 60_000   // don't broadcast twice within 30 min

export interface BroadcastResult {
  workspaceId:  string
  broadcasted:  boolean
  reason:       string
  messageId?:   string
  conversationId?: string
}

interface DigestSection { title: string; lines: string[] }

async function ensureBroadcastConversation(workspaceId: string): Promise<string> {
  const existing = await db.select({ id: conversations.id }).from(conversations)
    .where(and(
      eq(conversations.workspaceId, workspaceId),
      eq(conversations.title, BROADCAST_CONVO_TITLE),
    ))
    .limit(1).then(r => r[0]).catch(() => undefined)
  if (existing) return existing.id
  const id = uuidv7()
  const now = Date.now()
  await db.insert(conversations).values({
    id, workspaceId,
    title: BROADCAST_CONVO_TITLE,
    messageCount: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    createdAt: now,
    updatedAt: now,
  }).catch((e: Error) => { console.error('[brain-broadcast]', e.message); return null })
  return id
}

async function lastBroadcastAge(workspaceId: string, convoId: string): Promise<number> {
  const latest = await db.select({ createdAt: messages.createdAt })
    .from(messages)
    .where(and(
      eq(messages.workspaceId, workspaceId),
      eq(messages.conversationId, convoId),
      eq(messages.role, 'assistant'),
    ))
    .orderBy(desc(messages.createdAt))
    .limit(1).then(r => r[0]).catch(() => undefined)
  if (!latest) return Number.MAX_SAFE_INTEGER
  return Date.now() - latest.createdAt
}

/** Build the digest from recent events. Empty array if nothing worth saying. */
async function composeDigest(workspaceId: string, sinceMs: number): Promise<DigestSection[]> {
  const since = Date.now() - sinceMs
  const sections: DigestSection[] = []

  // CEO delegations dispatched
  const ceoEvents = await db.select().from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      eq(events.type, 'ceo.delegation_dispatched'),
      gte(events.createdAt, since),
    )).limit(20).catch(() => [])
  if (ceoEvents.length > 0) {
    sections.push({
      title: `CEO dispatched ${ceoEvents.length} delegation${ceoEvents.length === 1 ? '' : 's'}`,
      lines: ceoEvents.slice(0, 5).map(e => {
        const p = e.payload as { division?: string; health?: string; agent?: string; businessName?: string } | null
        return `· **${p?.division ?? '?'}** (${p?.health ?? '?'}) → ${p?.agent ?? '?'}${p?.businessName ? ` for *${p.businessName}*` : ''}`
      }),
    })
  }

  // Patches applied
  const patchEvents = await db.select().from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      eq(events.type, 'issue.auto_applied'),
      gte(events.createdAt, since),
    )).limit(10).catch(() => [])
  if (patchEvents.length > 0) {
    sections.push({
      title: `${patchEvents.length} autonomous patch${patchEvents.length === 1 ? '' : 'es'} applied`,
      lines: patchEvents.map(e => {
        const p = e.payload as { proposalId?: string; applied?: number } | null
        return `· patch ${(p?.proposalId ?? '').slice(0, 8)} — ${p?.applied ?? 0} file(s)`
      }),
    })
  }

  // Blocking security findings
  const secEvents = await db.select().from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      eq(events.type, 'security_team.finding_created'),
      gte(events.createdAt, since),
    )).limit(10).catch(() => [])
  const blockingSec = secEvents.filter(e => {
    const p = e.payload as { blocksLaunch?: boolean } | null
    return p?.blocksLaunch === true
  })
  if (blockingSec.length > 0) {
    sections.push({
      title: `${blockingSec.length} blocking security finding${blockingSec.length === 1 ? '' : 's'}`,
      lines: blockingSec.map(e => {
        const p = e.payload as { title?: string; severity?: string } | null
        return `· [${p?.severity ?? '?'}] ${p?.title ?? 'unknown'}`
      }),
    })
  }

  // High-confidence research findings (last hour only, separate threshold)
  const researchSince = Date.now() - 60 * 60_000
  const researchEvents = await db.select().from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      eq(events.type, 'research.finding_landed'),
      gte(events.createdAt, researchSince),
    )).limit(5).catch(() => [])
  if (researchEvents.length > 0) {
    sections.push({
      title: `${researchEvents.length} research finding${researchEvents.length === 1 ? '' : 's'} landed`,
      lines: researchEvents.map(e => {
        const p = e.payload as { title?: string; topic?: string } | null
        return `· **${p?.topic ?? 'unknown'}**: ${p?.title?.slice(0, 100) ?? ''}`
      }),
    })
  }

  return sections
}

function renderDigest(sections: DigestSection[]): string {
  const ts = new Date().toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })
  const lines: string[] = [`📡 **Brain broadcast** · ${ts}`, '']
  for (const s of sections) {
    lines.push(`### ${s.title}`)
    lines.push(...s.lines)
    lines.push('')
  }
  lines.push(`*Reply here to dispatch follow-up tasks. Brain ops: /safety /smoke /issues*`)
  return lines.join('\n')
}

/**
 * Cron entry — composes and posts a broadcast if something meaningful
 * happened since the last broadcast.
 */
export async function runBroadcastCycle(workspaceId: string): Promise<BroadcastResult> {
  const convoId = await ensureBroadcastConversation(workspaceId)
  const ageMs   = await lastBroadcastAge(workspaceId, convoId)
  if (ageMs < QUIET_WINDOW_MS) {
    return { workspaceId, broadcasted: false, reason: `quiet window (${Math.round(ageMs / 60_000)}min < 30min)`, conversationId: convoId }
  }
  // Look at events since last broadcast (capped at 6h to avoid stale digest)
  const lookback = Math.min(ageMs, 6 * 60 * 60_000)
  const sections = await composeDigest(workspaceId, lookback)
  if (sections.length === 0) {
    return { workspaceId, broadcasted: false, reason: 'no notable activity in window', conversationId: convoId }
  }
  const content = renderDigest(sections)
  const msgId = uuidv7()
  const now = Date.now()
  await db.insert(messages).values({
    id: msgId, conversationId: convoId, workspaceId,
    role: 'assistant', content,
    citations: [], streamComplete: true, createdAt: now,
    provider: 'brain-broadcast', model: 'cron',
  }).catch((e: Error) => { console.error('[brain-broadcast]', e.message); return null })
  await db.update(conversations).set({
    messageCount: 1, updatedAt: now,
  }).where(eq(conversations.id, convoId)).catch((e: Error) => { console.error('[brain-broadcast]', e.message); return null })
  return { workspaceId, broadcasted: true, reason: `${sections.length} section(s)`, messageId: msgId, conversationId: convoId }
}
