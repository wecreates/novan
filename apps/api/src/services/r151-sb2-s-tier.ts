/**
 * R146.151 — SB2 S-tier: habits, OKRs, focus sessions, mood, templates.
 */
import { db } from '../db/client.js'
import { habits, habitLogs, objectives, keyResults, focusSessions, moodLogs, noteTemplates } from '../db/schema.js'
import { and, eq, desc, gte, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

const DAY_MS = 24 * 60 * 60_000
function utcDate(t = Date.now()): string { return new Date(t).toISOString().slice(0, 10) }
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return utcDate(d.getTime())
}

// ─── #1 — Habits ─────────────────────────────────────────────────────

export async function habitAdd(workspaceId: string, opts: { name: string; cadence?: 'daily' | 'weekly' | 'weekdays' }): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(habits).values({
    id, workspaceId,
    name: opts.name.slice(0, 240),
    cadence: opts.cadence ?? 'daily',
    active: true, currentStreak: 0, longestStreak: 0,
    createdAt: Date.now(),
  })
  return { id }
}

export async function habitLog(workspaceId: string, opts: { habitId: string; date?: string; done?: boolean; notes?: string }): Promise<{ currentStreak: number }> {
  const date = opts.date ?? utcDate()
  const done = opts.done !== false
  await db.insert(habitLogs).values({
    workspaceId, habitId: opts.habitId, date, done,
    notes: opts.notes ?? null,
    loggedAt: Date.now(),
  }).onConflictDoUpdate({
    target: [habitLogs.workspaceId, habitLogs.habitId, habitLogs.date],
    set: { done, notes: opts.notes ?? null, loggedAt: Date.now() },
  })
  // Recompute streak: walk back from today as long as done
  const [h] = await db.select().from(habits).where(eq(habits.id, opts.habitId)).limit(1)
  if (!h) return { currentStreak: 0 }
  let streak = 0
  let cursor = date
  for (let i = 0; i < 366; i++) {
    const [log] = await db.select({ done: habitLogs.done }).from(habitLogs)
      .where(and(eq(habitLogs.workspaceId, workspaceId), eq(habitLogs.habitId, opts.habitId), eq(habitLogs.date, cursor))).limit(1)
    if (!log || !log.done) break
    streak++
    cursor = addDays(cursor, -1)
  }
  const longest = Math.max(h.longestStreak, streak)
  await db.update(habits).set({ currentStreak: streak, longestStreak: longest, lastDoneDate: done ? date : h.lastDoneDate })
    .where(eq(habits.id, opts.habitId))
  return { currentStreak: streak }
}

export async function habitList(workspaceId: string): Promise<Array<typeof habits.$inferSelect>> {
  return db.select().from(habits).where(eq(habits.workspaceId, workspaceId)).orderBy(desc(habits.currentStreak)).limit(200)
}

export async function habitBroken(workspaceId: string): Promise<Array<{ id: string; name: string; lastDoneDate: string | null; daysSince: number }>> {
  const today = utcDate()
  const rows = await db.select().from(habits)
    .where(and(eq(habits.workspaceId, workspaceId), eq(habits.active, true)))
  const broken: Array<{ id: string; name: string; lastDoneDate: string | null; daysSince: number }> = []
  for (const h of rows) {
    if (!h.lastDoneDate) { broken.push({ id: h.id, name: h.name, lastDoneDate: null, daysSince: Infinity }); continue }
    const daysSince = Math.floor((new Date(today).getTime() - new Date(h.lastDoneDate).getTime()) / DAY_MS)
    if (h.cadence === 'daily' && daysSince > 1) broken.push({ id: h.id, name: h.name, lastDoneDate: h.lastDoneDate, daysSince })
    else if (h.cadence === 'weekly' && daysSince > 7) broken.push({ id: h.id, name: h.name, lastDoneDate: h.lastDoneDate, daysSince })
  }
  return broken
}

// ─── #2 — OKRs ───────────────────────────────────────────────────────

export async function objectiveAdd(workspaceId: string, opts: { title: string; quarter: string }): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(objectives).values({
    id, workspaceId,
    title: opts.title.slice(0, 500),
    quarter: opts.quarter.slice(0, 20),
    status: 'active',
    createdAt: Date.now(),
  })
  return { id }
}

export async function krAdd(workspaceId: string, opts: { objectiveId: string; title: string; targetValue?: number; unit?: string }): Promise<{ id: string }> {
  const id = uuidv7()
  const now = Date.now()
  await db.insert(keyResults).values({
    id, workspaceId,
    objectiveId: opts.objectiveId,
    title: opts.title.slice(0, 500),
    targetValue: opts.targetValue ?? null,
    currentValue: 0,
    unit: opts.unit ?? null,
    confidence: 0.5,
    createdAt: now, updatedAt: now,
  })
  return { id }
}

export async function krUpdate(workspaceId: string, opts: { id: string; currentValue?: number; confidence?: number }): Promise<{ ok: boolean }> {
  const set: Record<string, unknown> = { updatedAt: Date.now() }
  if (typeof opts.currentValue === 'number') set['currentValue'] = opts.currentValue
  if (typeof opts.confidence === 'number') set['confidence'] = Math.max(0, Math.min(opts.confidence, 1))
  await db.update(keyResults).set(set).where(and(eq(keyResults.workspaceId, workspaceId), eq(keyResults.id, opts.id)))
  return { ok: true }
}

export async function okrSummary(workspaceId: string, quarter: string): Promise<Array<{ objective: typeof objectives.$inferSelect; krs: Array<typeof keyResults.$inferSelect & { progress: number }> }>> {
  const objs = await db.select().from(objectives)
    .where(and(eq(objectives.workspaceId, workspaceId), eq(objectives.quarter, quarter)))
  const out: Array<{ objective: typeof objectives.$inferSelect; krs: Array<typeof keyResults.$inferSelect & { progress: number }> }> = []
  for (const o of objs) {
    const krs = await db.select().from(keyResults).where(eq(keyResults.objectiveId, o.id))
    out.push({
      objective: o,
      krs: krs.map(kr => ({
        ...kr,
        progress: kr.targetValue && kr.targetValue > 0 ? Math.min(kr.currentValue / kr.targetValue, 1) : 0,
      })),
    })
  }
  return out
}

// ─── #3 — Pomodoro focus log ─────────────────────────────────────────

export async function focusStart(workspaceId: string, opts: { description: string; durationMin: number; tags?: string[] }): Promise<{ id: string; startedAt: number }> {
  const id = uuidv7()
  const startedAt = Date.now()
  await db.insert(focusSessions).values({
    id, workspaceId,
    description: opts.description.slice(0, 500),
    durationMin: Math.max(1, Math.min(opts.durationMin, 240)),
    tags: opts.tags ?? [],
    startedAt,
  })
  return { id, startedAt }
}

export async function focusFinish(workspaceId: string, opts: { id: string; outputChunkId?: string }): Promise<{ ok: boolean; actualMin: number }> {
  const [row] = await db.select().from(focusSessions).where(and(eq(focusSessions.workspaceId, workspaceId), eq(focusSessions.id, opts.id))).limit(1)
  if (!row) return { ok: false, actualMin: 0 }
  const finishedAt = Date.now()
  const actualMin = Math.round((finishedAt - row.startedAt) / 60_000)
  await db.update(focusSessions).set({ finishedAt, outputChunkId: opts.outputChunkId ?? null }).where(eq(focusSessions.id, opts.id))
  return { ok: true, actualMin }
}

export async function focusStats(workspaceId: string, windowDays = 7): Promise<{ totalMin: number; sessions: number; topTags: Array<{ tag: string; min: number }> }> {
  const since = Date.now() - windowDays * DAY_MS
  const rows = await db.select().from(focusSessions)
    .where(and(eq(focusSessions.workspaceId, workspaceId), gte(focusSessions.startedAt, since), sql`${focusSessions.finishedAt} IS NOT NULL`))
  const byTag = new Map<string, number>()
  let totalMin = 0
  for (const r of rows) {
    totalMin += r.durationMin
    for (const t of r.tags ?? []) byTag.set(t, (byTag.get(t) ?? 0) + r.durationMin)
  }
  const topTags = [...byTag.entries()].map(([tag, min]) => ({ tag, min })).sort((a, b) => b.min - a.min).slice(0, 10)
  return { totalMin, sessions: rows.length, topTags }
}

// ─── #4 — Mood / energy log ──────────────────────────────────────────

export async function moodLog(workspaceId: string, opts: { slot: 'morning' | 'midday' | 'evening'; mood: number; energy: number; notes?: string; date?: string }): Promise<{ ok: boolean }> {
  const date = opts.date ?? utcDate()
  await db.insert(moodLogs).values({
    workspaceId, date, slot: opts.slot,
    mood: Math.max(1, Math.min(opts.mood, 5)),
    energy: Math.max(1, Math.min(opts.energy, 5)),
    notes: opts.notes ?? null,
    loggedAt: Date.now(),
  }).onConflictDoUpdate({
    target: [moodLogs.workspaceId, moodLogs.date, moodLogs.slot],
    set: { mood: Math.max(1, Math.min(opts.mood, 5)), energy: Math.max(1, Math.min(opts.energy, 5)), notes: opts.notes ?? null, loggedAt: Date.now() },
  })
  return { ok: true }
}

export async function moodTrend(workspaceId: string, days = 30): Promise<Array<{ date: string; avgMood: number; avgEnergy: number }>> {
  const rows = await db.execute(sql`
    SELECT date, AVG(mood)::real AS avg_mood, AVG(energy)::real AS avg_energy
    FROM mood_logs
    WHERE workspace_id = ${workspaceId} AND date >= ${addDays(utcDate(), -days)}
    GROUP BY date ORDER BY date DESC
  `) as unknown as Array<{ date: string; avg_mood: number; avg_energy: number }>
  return rows.map(r => ({ date: r.date, avgMood: r.avg_mood, avgEnergy: r.avg_energy }))
}

// ─── #5 — Note templates ─────────────────────────────────────────────

const STARTER_TEMPLATES: Array<{ name: string; body: string; variables: string[] }> = [
  { name: 'meeting',     body: '# Meeting: {{topic}}\n**Date:** {{date}}\n**Attendees:** {{attendees}}\n\n## Agenda\n- \n\n## Decisions\n- \n\n## Action items\n- ', variables: ['topic', 'date', 'attendees'] },
  { name: 'retro',       body: '# Retro: {{period}}\n\n## What worked\n- \n\n## What didn\'t\n- \n\n## What to change\n- ', variables: ['period'] },
  { name: '1on1',        body: '# 1:1 with {{person}}\n**Date:** {{date}}\n\n## Their topics\n- \n\n## My topics\n- \n\n## Follow-ups\n- ', variables: ['person', 'date'] },
  { name: 'postmortem',  body: '# Postmortem: {{incident}}\n**Date:** {{date}}\n\n## Timeline\n- \n\n## Root cause\n\n## What went well\n- \n\n## What we\'ll change\n- ', variables: ['incident', 'date'] },
  { name: 'weekly-review', body: '# Weekly review: {{week}}\n\n## Wins\n- \n\n## Misses\n- \n\n## Learnings\n- \n\n## Next week priorities\n- ', variables: ['week'] },
]

export async function templateSeed(workspaceId: string): Promise<{ seeded: number }> {
  let seeded = 0
  for (const tpl of STARTER_TEMPLATES) {
    const [existing] = await db.select().from(noteTemplates)
      .where(and(eq(noteTemplates.workspaceId, workspaceId), eq(noteTemplates.name, tpl.name))).limit(1)
    if (existing) continue
    await db.insert(noteTemplates).values({
      id: uuidv7(), workspaceId,
      name: tpl.name, body: tpl.body, variables: tpl.variables,
      createdAt: Date.now(),
    })
    seeded++
  }
  return { seeded }
}

export async function templateUse(workspaceId: string, opts: { name: string; vars: Record<string, string> }): Promise<{ chunkId: string }> {
  const [tpl] = await db.select().from(noteTemplates)
    .where(and(eq(noteTemplates.workspaceId, workspaceId), eq(noteTemplates.name, opts.name))).limit(1)
  if (!tpl) throw new Error(`template '${opts.name}' not found — run templateSeed first`)
  let body = tpl.body
  for (const [k, v] of Object.entries(opts.vars)) {
    body = body.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), String(v))
  }
  const { memoryStore } = await import('./r139-ai-foundation.js')
  const stored = await memoryStore(workspaceId, {
    content: body,
    sourceType: 'manual',
    metadata: { kind: 'from_template', template: opts.name },
  })
  return { chunkId: stored.id }
}

export async function templateList(workspaceId: string): Promise<Array<typeof noteTemplates.$inferSelect>> {
  return db.select().from(noteTemplates).where(eq(noteTemplates.workspaceId, workspaceId)).orderBy(noteTemplates.name).limit(100)
}
