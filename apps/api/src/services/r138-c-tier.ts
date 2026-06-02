/**
 * R146.138 — C-tier features 16-20 (final batch).
 */
import { db } from '../db/client.js'
import { workspaceMembers, negotiations, a2aContracts, calendarSignals, commitments } from '../db/schema.js'
import { and, eq, desc, gte } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { createHmac } from 'crypto'

// ─── #16 — Multi-operator org mode ───────────────────────────────────

const ROLE_SCOPES: Record<string, string[]> = {
  owner:      ['*'],
  admin:      ['*'],
  dev:        ['proposals.*', 'patches.*', 'novan.proposeCode', 'docs.*'],
  security:   ['security.*', 'redteam.*', 'injection.*', 'agents.list', 'agent_ops_board.*'],
  va:        ['shortform.*', 'pod.*', 'attribution.list', 'briefing.*'],
  accountant: ['spend.*', 'usage.*', 'autonomy.counts', 'revenue.list', 'skill.roi*'],
  observer:   ['*.list', '*.get', '*.status', '*.summary', 'autonomy.counts'],
}

export async function memberInvite(workspaceId: string, opts: {
  userId: string
  role: keyof typeof ROLE_SCOPES
  invitedBy: string
  scopeOverride?: string[]
}): Promise<{ ok: boolean }> {
  const defaults = ROLE_SCOPES[opts.role]
  if (!defaults) throw new Error(`unknown role: ${opts.role}`)
  const scope: string[] = opts.scopeOverride ?? defaults
  await db.insert(workspaceMembers).values({
    workspaceId, userId: opts.userId, role: opts.role, scope,
    invitedBy: opts.invitedBy,
    joinedAt: Date.now(),
  }).onConflictDoUpdate({
    target: [workspaceMembers.workspaceId, workspaceMembers.userId],
    set: { role: opts.role, scope },
  })
  return { ok: true }
}

export async function memberList(workspaceId: string): Promise<Array<typeof workspaceMembers.$inferSelect>> {
  return db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId))
}

export async function memberHasScope(workspaceId: string, userId: string, opName: string): Promise<boolean> {
  const [row] = await db.select().from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId))).limit(1)
  if (!row) return false
  for (const pat of row.scope ?? []) {
    if (pat === '*') return true
    if (pat.endsWith('*') && opName.startsWith(pat.slice(0, -1))) return true
    if (pat === opName) return true
  }
  return false
}

// ─── #17 — Negotiation agent ─────────────────────────────────────────

export async function negotiationDraft(workspaceId: string, opts: {
  counterparty: string
  topic: 'stripe_fees' | 'ig_ad_rate' | 'contractor_sow' | 'sponsor_rate'
  context: string
}): Promise<{ id: string; positionOpen: Record<string, unknown>; positionWalk: Record<string, unknown>; batna: string }> {
  let positionOpen: Record<string, unknown> = {}
  let positionWalk: Record<string, unknown> = {}
  let batna = ''
  try {
    const { streamChat } = await import('./chat-providers.js')
    const sys = `You prepare negotiations. Output STRICT JSON: {"positionOpen":{...specific dollar/term targets...},"positionWalk":{...non-negotiable floors...},"batna":"<<best alternative to negotiated agreement, 1-2 sentences>>"}. Be specific to topic: stripe_fees → bps reduction; ig_ad_rate → CPM; contractor_sow → scope + price + deadline; sponsor_rate → flat fee + deliverables.`
    const gen = streamChat(workspaceId, [
      { role: 'system', content: sys },
      { role: 'user',   content: `Counterparty: ${opts.counterparty}\nTopic: ${opts.topic}\nContext: ${opts.context.slice(0, 2000)}` },
    ], { taskType: 'other' } as Parameters<typeof streamChat>[2])
    let acc = ''
    for await (const ch of gen) acc += ch.delta
    const m = acc.match(/\{[\s\S]*\}/)
    if (m) {
      const parsed = JSON.parse(m[0]) as { positionOpen?: Record<string, unknown>; positionWalk?: Record<string, unknown>; batna?: string }
      positionOpen = parsed.positionOpen ?? {}
      positionWalk = parsed.positionWalk ?? {}
      batna = String(parsed.batna ?? '').slice(0, 500)
    }
  } catch { /* defaults */ }
  const id = uuidv7()
  await db.insert(negotiations).values({
    id, workspaceId,
    counterparty: opts.counterparty.slice(0, 240),
    topic: opts.topic,
    positionOpen, positionWalk, batna,
    transcript: [],
    status: 'drafted',
    createdAt: Date.now(), updatedAt: Date.now(),
  })
  return { id, positionOpen, positionWalk, batna }
}

export async function negotiationAppendTurn(workspaceId: string, opts: { id: string; role: 'us' | 'them'; content: string }): Promise<{ ok: boolean }> {
  const [row] = await db.select().from(negotiations).where(and(eq(negotiations.workspaceId, workspaceId), eq(negotiations.id, opts.id))).limit(1)
  if (!row) return { ok: false }
  const transcript = [...(row.transcript ?? []), { role: opts.role, content: opts.content.slice(0, 4000), at: Date.now() }]
  await db.update(negotiations).set({ transcript, status: 'active', updatedAt: Date.now() }).where(eq(negotiations.id, opts.id))
  return { ok: true }
}

export async function negotiationList(workspaceId: string, limit = 30): Promise<Array<typeof negotiations.$inferSelect>> {
  return db.select().from(negotiations).where(eq(negotiations.workspaceId, workspaceId))
    .orderBy(desc(negotiations.createdAt)).limit(Math.min(limit, 200))
}

// ─── #18 — Agent-to-agent commerce ───────────────────────────────────

/**
 * Propose a contract with another Novan workspace.
 *
 * Skeleton: persists contract proposal. Actual peer-to-peer
 * verification (DID, signed handshake, escrow) is future work — for
 * now this is single-sided record-keeping the operator can use to
 * track informal partnerships.
 */
export async function a2aPropose(workspaceId: string, opts: {
  peerWorkspace: string
  capability: string
  revenueSplit?: number
}): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(a2aContracts).values({
    id, workspaceId,
    peerWorkspace: opts.peerWorkspace.slice(0, 240),
    capability: opts.capability.slice(0, 240),
    revenueSplit: Math.max(0, Math.min(opts.revenueSplit ?? 0.5, 1)),
    status: 'proposed',
    createdAt: Date.now(),
  })
  return { id }
}

export async function a2aActivate(workspaceId: string, contractId: string): Promise<{ ok: boolean }> {
  await db.update(a2aContracts).set({ status: 'active' })
    .where(and(eq(a2aContracts.workspaceId, workspaceId), eq(a2aContracts.id, contractId)))
  return { ok: true }
}

export async function a2aList(workspaceId: string): Promise<Array<typeof a2aContracts.$inferSelect>> {
  return db.select().from(a2aContracts).where(eq(a2aContracts.workspaceId, workspaceId))
    .orderBy(desc(a2aContracts.createdAt)).limit(100)
}

// ─── #19 — Predictive content from calendar ──────────────────────────

/**
 * Record an energy/load signal for a date (operator integrates with
 * their calendar export). Used by content scheduler to defer
 * cognitively-heavy drafts on low-energy days.
 */
export async function calendarSignalRecord(workspaceId: string, opts: {
  signalDate: string             // YYYY-MM-DD UTC
  energyLevel: 'high' | 'medium' | 'low'
  predictedLoad?: number         // back-to-back meeting count
  recommendations?: string[]
}): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(calendarSignals).values({
    id, workspaceId,
    signalDate: opts.signalDate,
    energyLevel: opts.energyLevel,
    predictedLoad: Math.max(0, Math.min(opts.predictedLoad ?? 0, 20)),
    recommendations: opts.recommendations ?? [],
    recordedAt: Date.now(),
  })
  return { id }
}

export async function calendarUpcoming(workspaceId: string, days = 7): Promise<Array<typeof calendarSignals.$inferSelect>> {
  const today = new Date().toISOString().slice(0, 10)
  const horizon = new Date(Date.now() + days * 24 * 60 * 60_000).toISOString().slice(0, 10)
  return db.select().from(calendarSignals)
    .where(and(eq(calendarSignals.workspaceId, workspaceId), gte(calendarSignals.signalDate, today)))
    .orderBy(calendarSignals.signalDate)
    .limit(Math.min(days, 31))
    .then(rows => rows.filter(r => r.signalDate <= horizon))
}

// ─── #20 — Time-locked commitments ───────────────────────────────────

const COMMITMENT_SECRET = () => process.env['COMMITMENT_SIGNING_KEY'] ?? 'novan-commit-default-please-rotate'

export async function commitmentCreate(workspaceId: string, opts: {
  statement: string
  deadlineAt: number
  forfeitUsd?: number
  forfeitTo?: string
}): Promise<{ id: string; signature: string }> {
  const id = uuidv7()
  const canonical = `${id}|${workspaceId}|${opts.statement}|${opts.deadlineAt}|${opts.forfeitUsd ?? 0}|${opts.forfeitTo ?? ''}`
  const signature = createHmac('sha256', COMMITMENT_SECRET()).update(canonical).digest('hex')
  await db.insert(commitments).values({
    id, workspaceId,
    statement: opts.statement.slice(0, 1000),
    deadlineAt: opts.deadlineAt,
    forfeitUsd: Math.max(0, opts.forfeitUsd ?? 0),
    forfeitTo: opts.forfeitTo ?? null,
    signature,
    status: 'active',
    createdAt: Date.now(),
  })
  return { id, signature }
}

export async function commitmentResolve(workspaceId: string, opts: { id: string; fulfilled: boolean }): Promise<{ ok: boolean; status: 'fulfilled' | 'forfeited' }> {
  const status: 'fulfilled' | 'forfeited' = opts.fulfilled ? 'fulfilled' : 'forfeited'
  await db.update(commitments).set({ status, resolvedAt: Date.now() })
    .where(and(eq(commitments.workspaceId, workspaceId), eq(commitments.id, opts.id)))
  return { ok: true, status }
}

export async function commitmentList(workspaceId: string, status?: string): Promise<Array<typeof commitments.$inferSelect>> {
  const where = status
    ? and(eq(commitments.workspaceId, workspaceId), eq(commitments.status, status))
    : eq(commitments.workspaceId, workspaceId)
  return db.select().from(commitments).where(where).orderBy(desc(commitments.deadlineAt)).limit(200)
}

export async function commitmentOverdue(workspaceId: string): Promise<Array<typeof commitments.$inferSelect>> {
  const now = Date.now()
  const rows = await db.select().from(commitments)
    .where(and(eq(commitments.workspaceId, workspaceId), eq(commitments.status, 'active')))
  return rows.filter(r => r.deadlineAt < now)
}
