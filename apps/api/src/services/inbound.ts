/**
 * inbound.ts — Tier-2: inbound signal ingestion.
 *
 * Scope: webhook landing pad + dedupe + lightweight intent classification.
 * Real Slack/Gmail/Discord adapters live elsewhere — this is the single
 * persistence + processing target they all converge on.
 */
import { db } from '../db/client.js'
import { inboundMessages } from '../db/schema.js'
import { and, eq, desc, gte, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

export type Channel = 'email' | 'slack' | 'discord' | 'sms' | 'webhook'
export type Intent  = 'question' | 'task' | 'fyi' | 'alert' | 'unknown'

export interface IngestInput {
  workspaceId: string
  channel:     Channel
  externalId?: string
  fromAddr?:   string
  subject?:    string
  body:        string
  receivedAt?: number
  metadata?:   Record<string, unknown>
}

/** Lightweight rule-based classifier. No LLM call — keeps cost zero. */
function classify(body: string, subject?: string): Intent {
  const t = `${subject ?? ''} ${body}`.toLowerCase()
  if (/\b(alert|incident|outage|down|failed|error|critical)\b/.test(t)) return 'alert'
  if (/\?$|\bcan you|\bcould you|\bwhat|\bwhen|\bwhere|\bwho|\bwhy|\bhow\b/.test(t)) return 'question'
  if (/\bplease|\baction\b|\btodo\b|\bdeadline|\bdue\b|\bneed(s|ed)?\b/.test(t)) return 'task'
  if (/\bfyi\b|\bjust\b|\bheads.?up\b|\bnotice\b/.test(t)) return 'fyi'
  return 'unknown'
}

export async function ingest(i: IngestInput): Promise<{ id: string; intent: Intent; deduped: boolean }> {
  // Dedupe by (workspace, channel, externalId)
  if (i.externalId) {
    const existing = await db.select({ id: inboundMessages.id }).from(inboundMessages)
      .where(and(
        eq(inboundMessages.workspaceId, i.workspaceId),
        eq(inboundMessages.channel,     i.channel),
        eq(inboundMessages.externalId,  i.externalId),
      )).limit(1).then(r => r[0]).catch(() => null)
    if (existing) return { id: existing.id, intent: 'unknown', deduped: true }
  }
  const id = uuidv7()
  const intent = classify(i.body, i.subject)
  await db.insert(inboundMessages).values({
    id, workspaceId: i.workspaceId, channel: i.channel,
    externalId: i.externalId ?? null,
    fromAddr:   i.fromAddr   ?? null,
    subject:    i.subject    ?? null,
    body:       i.body.slice(0, 50_000),
    receivedAt: i.receivedAt ?? Date.now(),
    intent,
    metadata:   i.metadata   ?? {},
  }).catch(() => null)
  return { id, intent, deduped: false }
}

export async function listRecent(workspaceId: string, opts?: { channel?: Channel; intent?: Intent; limit?: number }) {
  const conds = [eq(inboundMessages.workspaceId, workspaceId)]
  if (opts?.channel) conds.push(eq(inboundMessages.channel, opts.channel))
  if (opts?.intent)  conds.push(eq(inboundMessages.intent,  opts.intent))
  return db.select().from(inboundMessages)
    .where(and(...conds))
    .orderBy(desc(inboundMessages.receivedAt))
    .limit(opts?.limit ?? 50).catch(() => [])
}

export async function markProcessed(workspaceId: string, id: string): Promise<void> {
  await db.update(inboundMessages).set({ processedAt: Date.now() })
    .where(and(eq(inboundMessages.workspaceId, workspaceId), eq(inboundMessages.id, id)))
    .catch(() => null)
}

export async function summary(workspaceId: string, windowDays = 7) {
  const since = Date.now() - windowDays * 24 * 60 * 60_000
  const rows = await db.select({
    channel: inboundMessages.channel,
    intent:  inboundMessages.intent,
    n:       sql<number>`count(*)::int`,
  }).from(inboundMessages)
    .where(and(eq(inboundMessages.workspaceId, workspaceId), gte(inboundMessages.receivedAt, since)))
    .groupBy(inboundMessages.channel, inboundMessages.intent)
    .catch(() => [])
  const byChannel: Record<string, number> = {}
  const byIntent:  Record<string, number> = {}
  let total = 0
  for (const r of rows) {
    const n = Number(r.n)
    total += n
    byChannel[r.channel] = (byChannel[r.channel] ?? 0) + n
    if (r.intent) byIntent[r.intent] = (byIntent[r.intent] ?? 0) + n
  }
  return { windowDays, total, byChannel, byIntent }
}
