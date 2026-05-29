/**
 * production-log.ts — audit trail for everything the brain produces.
 *
 * Every music render, video edit, mass-produce run, scheduled fire, and
 * publish appends a row here so the operator can answer:
 *   • What did the brain make last week?
 *   • Which prompts produced the most-viewed clips?
 *   • What's currently in flight?
 *   • What failed and why?
 *
 * Also exposes cancellation tokens so long-running pipelines (mass-
 * produce, scheduled production) can be aborted mid-flight.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { writeFile, readFile, appendFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const LOG_DIR = process.env['PRODUCTION_LOG_DIR'] ?? join(tmpdir(), 'novan-production-log')
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })

export interface ProductionEvent {
  id:           string
  workspaceId:  string
  kind:         'music' | 'video' | 'mass-produce' | 'schedule' | 'publish' | 'thumbnail' | 'repurpose'
  status:       'started' | 'completed' | 'failed' | 'cancelled'
  brief?:       string
  outputPath?:  string
  durationMs?:  number
  meta?:        Record<string, unknown>
  error?:       string
  startedAt:    number
  finishedAt?:  number
}

function logFile(date = new Date()): string {
  // One JSONL file per day, easy to rotate / archive
  const ymd = date.toISOString().slice(0, 10)
  return join(LOG_DIR, `${ymd}.jsonl`)
}

export async function record(event: Omit<ProductionEvent, 'id' | 'startedAt'> & { id?: string; startedAt?: number }): Promise<string> {
  const full: ProductionEvent = {
    id: event.id ?? randomUUID(),
    startedAt: event.startedAt ?? Date.now(),
    ...event,
  }
  await appendFile(logFile(), JSON.stringify(full) + '\n', 'utf8')
  return full.id
}

export async function complete(id: string, patch: Partial<ProductionEvent>): Promise<void> {
  // Append a "completed" delta; the listEvents reader merges by id.
  await appendFile(logFile(), JSON.stringify({ id, finishedAt: Date.now(), ...patch }) + '\n', 'utf8')
}

export async function listEvents(opts: { workspaceId?: string; kind?: ProductionEvent['kind']; days?: number; limit?: number } = {}): Promise<ProductionEvent[]> {
  const days = opts.days ?? 7
  const limit = opts.limit ?? 200
  const merged = new Map<string, ProductionEvent>()
  for (let d = 0; d < days; d++) {
    const date = new Date(Date.now() - d * 86_400_000)
    const f = logFile(date)
    if (!existsSync(f)) continue
    try {
      const raw = await readFile(f, 'utf8')
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const ev = JSON.parse(line) as Partial<ProductionEvent>
          if (!ev.id) continue
          const existing = merged.get(ev.id)
          merged.set(ev.id, { ...(existing ?? {}), ...ev } as ProductionEvent)
        } catch { /* */ }
      }
    } catch { /* */ }
  }
  let events = Array.from(merged.values())
  if (opts.workspaceId) events = events.filter(e => e.workspaceId === opts.workspaceId)
  if (opts.kind)        events = events.filter(e => e.kind === opts.kind)
  events.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  return events.slice(0, limit)
}

// ─── Cancellation tokens ───────────────────────────────────────────────
// Long-running ops (mass-produce, schedule.tick) register a token here.
// Operator calls cancel(id) → the op polls isCancelled(id) and bails
// at the next checkpoint.
const _cancelled = new Set<string>()

export function newCancelToken(): string {
  return randomUUID()
}
export function cancel(id: string): { ok: boolean } {
  _cancelled.add(id)
  return { ok: true }
}
export function isCancelled(id: string): boolean {
  return _cancelled.has(id)
}
export function clearCancelToken(id: string): void {
  _cancelled.delete(id)
}
export function listActiveCancelTokens(): string[] {
  return Array.from(_cancelled)
}
