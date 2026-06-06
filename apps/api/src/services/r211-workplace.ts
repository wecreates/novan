/**
 * R146.211-214 — workplace layer.
 *
 * R211: persistent semantic memory per workspace (KV with importance score)
 *       + chapter markers on long sessions
 *       + chat-injected memory summary at session start
 * R212: event hooks (when emit('feed.poll_failed') → run op X)
 *       + NL scheduled tasks ("every Tuesday at 9am, run niche.score")
 * R213: spawn-task chips (flag side-tasks for later dispatch)
 *       + operator questions (structured 2-4 option prompts with answer capture)
 * R214: MCP connector marketplace (register external service connectors)
 */
import { db } from '../db/client.js'
import {
  workspaceMemory, sessionChapters, eventHooks, nlSchedules,
  spawnTasks, operatorQuestions, mcpConnectors,
} from '../db/schema.js'
import { and, eq, desc, sql, gte } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── R211 — Workspace memory ─────────────────────────────────────────

export interface MemoryEntry { key: string; value: string; scope?: string; importance?: number }

export async function memoryRemember(workspaceId: string, e: MemoryEntry): Promise<void> {
  const now = Date.now()
  await db.insert(workspaceMemory).values({
    workspaceId, key: e.key, value: e.value,
    scope: e.scope ?? 'general',
    importance: Math.max(0, Math.min(100, e.importance ?? 50)),
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [workspaceMemory.workspaceId, workspaceMemory.key],
    set: { value: e.value, scope: e.scope ?? 'general',
           importance: Math.max(0, Math.min(100, e.importance ?? 50)), updatedAt: now },
  }).catch(() => null)
}

export async function memoryRecall(workspaceId: string, scope?: string, limit = 50): Promise<Array<{ key: string; value: string; scope: string; importance: number }>> {
  const q = db.select({ key: workspaceMemory.key, value: workspaceMemory.value, scope: workspaceMemory.scope, importance: workspaceMemory.importance })
    .from(workspaceMemory).where(eq(workspaceMemory.workspaceId, workspaceId))
    .orderBy(desc(workspaceMemory.importance), desc(workspaceMemory.updatedAt))
    .limit(limit)
  const rows = scope
    ? await db.select({ key: workspaceMemory.key, value: workspaceMemory.value, scope: workspaceMemory.scope, importance: workspaceMemory.importance })
        .from(workspaceMemory)
        .where(and(eq(workspaceMemory.workspaceId, workspaceId), eq(workspaceMemory.scope, scope)))
        .orderBy(desc(workspaceMemory.importance), desc(workspaceMemory.updatedAt))
        .limit(limit)
    : await q
  return rows
}

export async function memoryForget(workspaceId: string, key: string): Promise<void> {
  await db.delete(workspaceMemory)
    .where(and(eq(workspaceMemory.workspaceId, workspaceId), eq(workspaceMemory.key, key)))
    .catch(() => null)
}

/** Format the workspace memory as a compact system-prompt block. */
export async function memoryDigest(workspaceId: string, maxBytes = 1500): Promise<string> {
  const rows = await memoryRecall(workspaceId, undefined, 50)
  if (rows.length === 0) return ''
  const lines: string[] = ['Workspace memory (recall in chat by key):']
  let used = lines[0]!.length
  for (const r of rows) {
    const line = `• [${r.scope}] ${r.key} = ${r.value.slice(0, 200)}`
    if (used + line.length > maxBytes) break
    lines.push(line)
    used += line.length + 1
  }
  return lines.join('\n')
}

// ─── R211 — Chapter markers ──────────────────────────────────────────

export async function chapterMark(workspaceId: string, input: { title: string; summary?: string; conversationId?: string; messageAnchorId?: string }): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(sessionChapters).values({
    id, workspaceId, title: input.title,
    summary: input.summary ?? null,
    conversationId: input.conversationId ?? null,
    messageAnchorId: input.messageAnchorId ?? null,
    createdAt: Date.now(),
  }).catch(() => null)
  return { id }
}

export async function chapterList(workspaceId: string, conversationId?: string, limit = 50): Promise<Array<{ id: string; title: string; summary: string | null; createdAt: number }>> {
  const where = conversationId
    ? and(eq(sessionChapters.workspaceId, workspaceId), eq(sessionChapters.conversationId, conversationId))
    : eq(sessionChapters.workspaceId, workspaceId)
  return db.select({ id: sessionChapters.id, title: sessionChapters.title, summary: sessionChapters.summary, createdAt: sessionChapters.createdAt })
    .from(sessionChapters).where(where).orderBy(desc(sessionChapters.createdAt)).limit(limit)
}

// ─── R212 — Event hooks ──────────────────────────────────────────────

export async function hookCreate(workspaceId: string, input: { name: string; eventPattern: string; opName: string; opParams?: Record<string, unknown> }): Promise<{ id: string }> {
  const now = Date.now()
  const id = uuidv7()
  await db.insert(eventHooks).values({
    id, workspaceId, name: input.name,
    eventPattern: input.eventPattern, opName: input.opName,
    opParams: input.opParams ?? {},
    createdAt: now, updatedAt: now,
  }).onConflictDoUpdate({
    target: [eventHooks.workspaceId, eventHooks.name],
    set: { eventPattern: input.eventPattern, opName: input.opName,
           opParams: input.opParams ?? {}, updatedAt: now, enabled: true },
  }).catch(() => null)
  return { id }
}

export async function hookList(workspaceId: string): Promise<Array<{ id: string; name: string; eventPattern: string; opName: string; enabled: boolean; fires: number }>> {
  return db.select({ id: eventHooks.id, name: eventHooks.name, eventPattern: eventHooks.eventPattern,
                     opName: eventHooks.opName, enabled: eventHooks.enabled, fires: eventHooks.fires })
    .from(eventHooks).where(eq(eventHooks.workspaceId, workspaceId)).orderBy(desc(eventHooks.fires))
}

export async function hookSetEnabled(workspaceId: string, name: string, enabled: boolean): Promise<void> {
  await db.update(eventHooks).set({ enabled, updatedAt: Date.now() })
    .where(and(eq(eventHooks.workspaceId, workspaceId), eq(eventHooks.name, name))).catch(() => null)
}

/** Called by event emit() to dispatch matching hooks. */
export async function hookDispatch(workspaceId: string, eventType: string, _payload: Record<string, unknown>): Promise<number> {
  const hooks = await db.select().from(eventHooks)
    .where(and(eq(eventHooks.workspaceId, workspaceId), eq(eventHooks.enabled, true)))
    .catch(() => [])
  let fired = 0
  for (const h of hooks) {
    if (!matchPattern(h.eventPattern, eventType)) continue
    try {
      const { OPERATIONS } = await import('./brain-task.js')
      const spec = OPERATIONS[h.opName]
      if (!spec) continue
      await spec.handler(workspaceId, (h.opParams ?? {}) as Record<string, unknown>).catch(() => null)
      await db.update(eventHooks).set({
        fires: sql`${eventHooks.fires} + 1`, lastFiredAt: Date.now(),
      }).where(eq(eventHooks.id, h.id)).catch(() => null)
      fired++
    } catch { /* tolerated */ }
  }
  return fired
}

function matchPattern(pattern: string, eventType: string): boolean {
  if (pattern === eventType) return true
  if (pattern.endsWith('.*')) return eventType.startsWith(pattern.slice(0, -2) + '.')
  if (pattern === '*') return true
  return false
}

// ─── R212 — NL scheduled tasks ───────────────────────────────────────

/** Very small NL → cron translator. Supports: every Nh, every Nd, daily at HH:MM,
 *  weekly on <day> at HH:MM, hourly. Returns 5-field cron expression. */
export function nlToCron(nl: string): { cronExpr: string } {
  const s = nl.toLowerCase().trim()
  // every N min
  const m1 = s.match(/^every\s+(\d+)\s*(?:m|min|minutes?)$/)
  if (m1) return { cronExpr: `*/${m1[1]} * * * *` }
  // every N hours
  const m2 = s.match(/^every\s+(\d+)\s*(?:h|hr|hours?)$/)
  if (m2) return { cronExpr: `0 */${m2[1]} * * *` }
  // hourly
  if (s === 'hourly') return { cronExpr: '0 * * * *' }
  // daily at HH:MM (UTC)
  const m3 = s.match(/^(?:daily|every day)\s+at\s+(\d{1,2}):(\d{2})$/)
  if (m3) return { cronExpr: `${m3[2]} ${m3[1]} * * *` }
  // weekly on <day> at HH:MM
  const days: Record<string, string> = { sunday: '0', monday: '1', tuesday: '2', wednesday: '3', thursday: '4', friday: '5', saturday: '6' }
  const m4 = s.match(/^(?:every\s+)?(\w+)\s+at\s+(\d{1,2}):(\d{2})$/)
  if (m4 && days[m4[1]!]) return { cronExpr: `${m4[3]} ${m4[2]} * * ${days[m4[1]!]}` }
  // default: daily at 09:00 UTC
  return { cronExpr: '0 9 * * *' }
}

export async function scheduleCreate(workspaceId: string, input: { description: string; opName: string; opParams?: Record<string, unknown> }): Promise<{ id: string; cronExpr: string }> {
  const id = uuidv7()
  const { cronExpr } = nlToCron(input.description)
  const now = Date.now()
  await db.insert(nlSchedules).values({
    id, workspaceId, description: input.description,
    cronExpr, opName: input.opName, opParams: input.opParams ?? {},
    createdAt: now, updatedAt: now,
  }).catch(() => null)
  return { id, cronExpr }
}

export async function scheduleList(workspaceId: string): Promise<Array<{ id: string; description: string; cronExpr: string; opName: string; enabled: boolean; lastRunAt: number | null }>> {
  return db.select({ id: nlSchedules.id, description: nlSchedules.description, cronExpr: nlSchedules.cronExpr,
                     opName: nlSchedules.opName, enabled: nlSchedules.enabled, lastRunAt: nlSchedules.lastRunAt })
    .from(nlSchedules).where(eq(nlSchedules.workspaceId, workspaceId))
}

/** R146.227 — cron-driven NL schedule processor. Reads schedules whose
 *  cron expression matches the current minute, runs the op, updates
 *  lastRunAt. Called from learning-cron once per minute. Returns the
 *  number of schedules fired. Pure 5-field cron parser; supports the
 *  same forms nlToCron emits (no full crontab spec). */
export async function processNlSchedules(now = new Date()): Promise<{ fired: number }> {
  const rows = await db.select({
    id: nlSchedules.id, workspaceId: nlSchedules.workspaceId,
    cronExpr: nlSchedules.cronExpr, opName: nlSchedules.opName,
    opParams: nlSchedules.opParams, lastRunAt: nlSchedules.lastRunAt,
  }).from(nlSchedules).where(eq(nlSchedules.enabled, true)).catch(() => [])
  let fired = 0
  for (const r of rows) {
    if (!cronMatchesNow(r.cronExpr, now)) continue
    // Skip if already fired this minute (idempotency guard)
    if (r.lastRunAt && now.getTime() - r.lastRunAt < 50_000) continue
    try {
      const { OPERATIONS } = await import('./brain-task.js')
      const spec = OPERATIONS[r.opName]
      if (!spec) continue
      await spec.handler(r.workspaceId, (r.opParams ?? {}) as Record<string, unknown>).catch(() => null)
      await db.update(nlSchedules).set({ lastRunAt: now.getTime(), updatedAt: now.getTime() })
        .where(eq(nlSchedules.id, r.id)).catch(() => null)
      fired++
    } catch { /* tolerated */ }
  }
  return { fired }
}

/** Minimal cron matcher: 5 fields (min hour dom mon dow). Supports
 *  literal, *, list (1,2,3), and step (*\/N). */
export function cronMatchesNow(expr: string, now: Date): boolean {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return false
  const fields: number[] = [
    now.getUTCMinutes(),
    now.getUTCHours(),
    now.getUTCDate(),
    now.getUTCMonth() + 1,
    now.getUTCDay(),
  ]
  for (let i = 0; i < 5; i++) {
    if (!matchField(parts[i]!, fields[i]!)) return false
  }
  return true
}
function matchField(expr: string, val: number): boolean {
  if (expr === '*') return true
  const stepMatch = expr.match(/^\*\/(\d+)$/)
  if (stepMatch) return val % Number(stepMatch[1]) === 0
  for (const token of expr.split(',')) {
    if (Number(token) === val) return true
  }
  return false
}

// ─── R213 — Spawn-task chips ─────────────────────────────────────────

export async function spawnTaskCreate(workspaceId: string, input: { title: string; tldr?: string; prompt: string }): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(spawnTasks).values({
    id, workspaceId, title: input.title.slice(0, 60),
    tldr: input.tldr ?? null,
    prompt: input.prompt,
    createdAt: Date.now(),
  }).catch(() => null)
  return { id }
}

export async function spawnTaskList(workspaceId: string, status?: string): Promise<Array<{ id: string; title: string; tldr: string | null; status: string; createdAt: number }>> {
  const where = status
    ? and(eq(spawnTasks.workspaceId, workspaceId), eq(spawnTasks.status, status))
    : eq(spawnTasks.workspaceId, workspaceId)
  return db.select({ id: spawnTasks.id, title: spawnTasks.title, tldr: spawnTasks.tldr, status: spawnTasks.status, createdAt: spawnTasks.createdAt })
    .from(spawnTasks).where(where).orderBy(desc(spawnTasks.createdAt)).limit(50)
}

export async function spawnTaskDismiss(workspaceId: string, id: string): Promise<void> {
  await db.update(spawnTasks).set({ status: 'dismissed', dismissedAt: Date.now() })
    .where(and(eq(spawnTasks.workspaceId, workspaceId), eq(spawnTasks.id, id))).catch(() => null)
}

// ─── R213 — Operator questions ───────────────────────────────────────

export interface AskInput {
  question:    string
  options:     Array<{ label: string; description?: string }>
  multiSelect?: boolean
  context?:    string
}

export async function operatorAsk(workspaceId: string, input: AskInput): Promise<{ id: string }> {
  if (input.options.length < 2 || input.options.length > 4) {
    throw new Error('options must have 2-4 entries')
  }
  const id = uuidv7()
  await db.insert(operatorQuestions).values({
    id, workspaceId,
    question: input.question, options: input.options,
    multiSelect: input.multiSelect ?? false,
    context: input.context ?? null,
    askedAt: Date.now(),
  }).catch(() => null)
  return { id }
}

export async function operatorAnswer(workspaceId: string, id: string, answer: unknown): Promise<void> {
  await db.update(operatorQuestions).set({
    answer: { value: answer } as Record<string, unknown>,
    status: 'answered', answeredAt: Date.now(),
  }).where(and(eq(operatorQuestions.workspaceId, workspaceId), eq(operatorQuestions.id, id))).catch(() => null)
}

export async function operatorQuestionsPending(workspaceId: string): Promise<Array<{ id: string; question: string; options: unknown; multiSelect: boolean; context: string | null; askedAt: number }>> {
  return db.select({ id: operatorQuestions.id, question: operatorQuestions.question,
                     options: operatorQuestions.options, multiSelect: operatorQuestions.multiSelect,
                     context: operatorQuestions.context, askedAt: operatorQuestions.askedAt })
    .from(operatorQuestions)
    .where(and(eq(operatorQuestions.workspaceId, workspaceId), eq(operatorQuestions.status, 'pending')))
    .orderBy(desc(operatorQuestions.askedAt))
}

// ─── R214 — MCP connector marketplace ────────────────────────────────

export interface ConnectorInput {
  name:         string
  category:     string
  description?: string
  endpointUrl?: string
  authKind?:    string
  meta?:        Record<string, unknown>
}

export async function connectorRegister(workspaceId: string, input: ConnectorInput): Promise<{ id: string }> {
  const id = uuidv7()
  const now = Date.now()
  await db.insert(mcpConnectors).values({
    id, workspaceId, name: input.name, category: input.category,
    description: input.description ?? null,
    endpointUrl: input.endpointUrl ?? null,
    authKind: input.authKind ?? null,
    meta: input.meta ?? null,
    createdAt: now, updatedAt: now,
  }).onConflictDoUpdate({
    target: [mcpConnectors.workspaceId, mcpConnectors.name],
    set: { category: input.category, description: input.description ?? null,
           endpointUrl: input.endpointUrl ?? null, authKind: input.authKind ?? null,
           meta: input.meta ?? null, updatedAt: now },
  }).catch(() => null)
  return { id }
}

export async function connectorList(workspaceId: string): Promise<Array<{ id: string; name: string; category: string; description: string | null; installed: boolean; enabled: boolean }>> {
  return db.select({ id: mcpConnectors.id, name: mcpConnectors.name, category: mcpConnectors.category,
                     description: mcpConnectors.description, installed: mcpConnectors.installed, enabled: mcpConnectors.enabled })
    .from(mcpConnectors).where(eq(mcpConnectors.workspaceId, workspaceId))
}

export async function connectorSet(workspaceId: string, name: string, fields: { installed?: boolean; enabled?: boolean }): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: Date.now() }
  if (fields.installed !== undefined) set['installed'] = fields.installed
  if (fields.enabled   !== undefined) set['enabled']   = fields.enabled
  await db.update(mcpConnectors).set(set)
    .where(and(eq(mcpConnectors.workspaceId, workspaceId), eq(mcpConnectors.name, name))).catch(() => null)
}

/** Aggregate count for platform.status surface. */
export async function workplaceCounts(workspaceId: string): Promise<{ memories: number; chapters: number; hooks: number; schedules: number; spawnTasks: number; pendingQuestions: number; connectors: number }> {
  const since = Date.now() - 7 * 86400_000
  const [m]  = await db.select({ n: sql<number>`count(*)::int` }).from(workspaceMemory).where(eq(workspaceMemory.workspaceId, workspaceId))
  const [c]  = await db.select({ n: sql<number>`count(*)::int` }).from(sessionChapters).where(and(eq(sessionChapters.workspaceId, workspaceId), gte(sessionChapters.createdAt, since)))
  const [h]  = await db.select({ n: sql<number>`count(*)::int` }).from(eventHooks).where(and(eq(eventHooks.workspaceId, workspaceId), eq(eventHooks.enabled, true)))
  const [s]  = await db.select({ n: sql<number>`count(*)::int` }).from(nlSchedules).where(and(eq(nlSchedules.workspaceId, workspaceId), eq(nlSchedules.enabled, true)))
  const [st] = await db.select({ n: sql<number>`count(*)::int` }).from(spawnTasks).where(and(eq(spawnTasks.workspaceId, workspaceId), eq(spawnTasks.status, 'pending')))
  const [q]  = await db.select({ n: sql<number>`count(*)::int` }).from(operatorQuestions).where(and(eq(operatorQuestions.workspaceId, workspaceId), eq(operatorQuestions.status, 'pending')))
  const [cn] = await db.select({ n: sql<number>`count(*)::int` }).from(mcpConnectors).where(eq(mcpConnectors.workspaceId, workspaceId))
  return {
    memories: Number(m?.n ?? 0), chapters: Number(c?.n ?? 0), hooks: Number(h?.n ?? 0),
    schedules: Number(s?.n ?? 0), spawnTasks: Number(st?.n ?? 0),
    pendingQuestions: Number(q?.n ?? 0), connectors: Number(cn?.n ?? 0),
  }
}
