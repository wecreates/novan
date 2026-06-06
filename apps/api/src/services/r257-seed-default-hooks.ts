/**
 * R146.257 — Seed default event hooks so a fresh workspace has
 * actionable wiring out of the box.
 *
 * Hooks:
 *   brain.critical → issue.create (severity=critical, source=brain-alert)
 *   brain.degraded → issue.create (severity=warning,  source=brain-alert)
 *   cron.error.*  → issue.create  (severity=warning,  source=cron-error)
 *
 * Idempotent: skips inserts where (workspaceId, name) already exists.
 */
import { db } from '../db/client.js'
import { eventHooks } from '../db/schema.js'
import { v7 as uuidv7 } from 'uuid'

interface SeedHook {
  name:         string
  eventPattern: string
  opName:       string
  opParams:     Record<string, unknown>
}

const SEEDS: SeedHook[] = [
  {
    name: 'brain-critical→issue',
    eventPattern: 'brain.critical',
    opName: 'issue.create',
    opParams: {
      severity: 'critical',
      source:   'brain-alert',
      symptom:  'brain.health overall=critical (cost over, backup missing, or applier dead)',
      fingerprint: 'brain-alert:critical',
    },
  },
  {
    name: 'brain-degraded→issue',
    eventPattern: 'brain.degraded',
    opName: 'issue.create',
    opParams: {
      severity: 'warning',
      source:   'brain-alert',
      symptom:  'brain.health overall=degraded',
      fingerprint: 'brain-alert:degraded',
    },
  },
]

export interface SeedResult { workspaceId: string; created: number; skipped: number }

export async function seedDefaultHooks(workspaceId: string): Promise<SeedResult> {
  let created = 0, skipped = 0
  const now = Date.now()
  for (const h of SEEDS) {
    // Atomic upsert-or-skip on the (workspaceId, name) unique index.
    // returning() tells us whether the row was actually inserted.
    const inserted = await db.insert(eventHooks).values({
      id: uuidv7(),
      workspaceId,
      name:         h.name,
      eventPattern: h.eventPattern,
      opName:       h.opName,
      opParams:     h.opParams,
      enabled:      true,
      fires:        0,
      createdAt:    now,
      updatedAt:    now,
    }).onConflictDoNothing({
      target: [eventHooks.workspaceId, eventHooks.name],
    }).returning({ id: eventHooks.id }).catch(() => [])
    if (inserted.length > 0) created++; else skipped++
  }
  return { workspaceId, created, skipped }
}
