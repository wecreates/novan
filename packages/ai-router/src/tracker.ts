import type { ProviderId, TaskType } from './types.js'
import { v4 as uuid } from 'uuid'

// ─── Usage tracker — logs to aiUsage table ────────────────────────────────────
// DB client is injected to avoid circular deps + allow null in non-DB contexts.

export interface UsageRecord {
  workspaceId:  string
  provider:     ProviderId
  model:        string
  promptTokens: number
  outputTokens: number
  costUsd:      number
  latencyMs:    number
  cached:       boolean
  taskType:     TaskType
}

type DbClient = {
  insert: (table: unknown) => { values: (v: unknown) => { onConflictDoNothing: () => Promise<unknown> } }
}

let _db: DbClient | null = null
let _table: unknown      = null

export function initTracker(db: DbClient, aiUsageTable: unknown): void {
  _db    = db
  _table = aiUsageTable
}

export async function trackUsage(rec: UsageRecord): Promise<void> {
  if (!_db || !_table) return // no-op if not initialized
  try {
    await _db
      .insert(_table)
      .values({
        id:           uuid(),
        workspaceId:  rec.workspaceId,
        provider:     rec.provider,
        model:        rec.model,
        promptTokens: rec.promptTokens,
        outputTokens: rec.outputTokens,
        costUsd:      rec.costUsd,
        latencyMs:    rec.latencyMs,
        cached:       rec.cached,
        taskType:     rec.taskType,
        timestamp:    Date.now(),
      })
      .onConflictDoNothing()
  } catch {
    // non-critical — tracking failure must never break the actual request
  }
}
