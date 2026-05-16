/**
 * Runtime Mode Service
 *
 * Manages workspace runtime mode: local | hybrid | cloud-api-only.
 * Provides enforcement checks before compute dispatch.
 */

import { v7 as uuidv7 }  from 'uuid'
import { eq }             from 'drizzle-orm'
import { db }             from '../db/client.js'
import {
  runtimeSettings, events,
} from '../db/schema.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export type RuntimeMode = 'local' | 'hybrid' | 'cloud-api-only'

export interface RuntimeConfig {
  id:                string
  workspaceId:       string
  mode:              RuntimeMode
  allowLocalGpu:     boolean
  allowLocalBrowser: boolean
  preferredProviders: string[]
  createdAt:         number
  updatedAt:         number
}

export type ComputeType = 'gpu' | 'browser' | 'ai' | 'remote'

export interface ModeCheckResult {
  allowed:    boolean
  reason:     string | null
  mustUseRemote: boolean
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_MODE: RuntimeMode = 'local'

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function emitEvent(
  workspaceId: string, type: string, payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId,
    payload, traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/runtime-mode', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/** Get (or create default) runtime settings for a workspace. */
export async function getRuntimeSettings(workspaceId: string): Promise<RuntimeConfig> {
  const rows = await db.select().from(runtimeSettings)
    .where(eq(runtimeSettings.workspaceId, workspaceId))

  if (rows[0]) return rows[0] as RuntimeConfig

  // Auto-create with defaults
  const now = Date.now()
  const [row] = await db.insert(runtimeSettings).values({
    id: uuidv7(), workspaceId,
    mode: DEFAULT_MODE,
    allowLocalGpu:      true,
    allowLocalBrowser:  true,
    preferredProviders: [],
    createdAt: now, updatedAt: now,
  }).onConflictDoNothing().returning()

  if (row) return row as RuntimeConfig

  // Race condition — another process inserted first; fallback to in-memory default
  const [existing] = await db.select().from(runtimeSettings)
    .where(eq(runtimeSettings.workspaceId, workspaceId))
  if (existing) return existing as RuntimeConfig

  // Should never reach here in production; return synthetic default
  const ts = Date.now()
  return {
    id: uuidv7(), workspaceId, mode: DEFAULT_MODE,
    allowLocalGpu: true, allowLocalBrowser: true, preferredProviders: [],
    createdAt: ts, updatedAt: ts,
  }
}

/** Update runtime settings for a workspace. */
export async function setRuntimeSettings(
  workspaceId: string,
  updates: Partial<Omit<RuntimeConfig, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt'>>,
): Promise<RuntimeConfig> {
  const now     = Date.now()
  const current = await getRuntimeSettings(workspaceId)

  const [row] = await db.update(runtimeSettings)
    .set({ ...updates, updatedAt: now })
    .where(eq(runtimeSettings.workspaceId, workspaceId))
    .returning()

  if (updates.mode && updates.mode !== current.mode) {
    await emitEvent(workspaceId, 'runtime.mode_changed', {
      previousMode: current.mode,
      newMode:      updates.mode,
    })
  }

  return (row ?? current) as RuntimeConfig
}

// ─── Enforcement ──────────────────────────────────────────────────────────────

/**
 * Check if a given compute type is allowed under the current runtime mode.
 *
 * Rules:
 *   cloud-api-only → blocks local GPU and local browser; all LLM/AI goes remote
 *   hybrid         → allows both local and remote; remote preferred
 *   local          → local preferred; remote allowed
 */
export async function checkComputeAllowed(
  workspaceId: string,
  computeType: ComputeType,
): Promise<ModeCheckResult> {
  const settings = await getRuntimeSettings(workspaceId)
  const mode     = settings.mode as RuntimeMode

  if (mode === 'cloud-api-only') {
    if (computeType === 'gpu' && !settings.allowLocalGpu) {
      return {
        allowed:      false,
        reason:       'Local GPU execution is disabled in cloud-api-only mode',
        mustUseRemote: true,
      }
    }
    if (computeType === 'browser' && !settings.allowLocalBrowser) {
      return {
        allowed:      false,
        reason:       'Local browser execution is disabled in cloud-api-only mode',
        mustUseRemote: true,
      }
    }
    // AI requests always routed to remote in cloud-api-only
    if (computeType === 'ai') {
      return { allowed: true, reason: null, mustUseRemote: true }
    }
    if (computeType === 'remote') {
      return { allowed: true, reason: null, mustUseRemote: false }
    }
  }

  if (mode === 'hybrid') {
    // Everything allowed; AI prefers remote
    return {
      allowed:      true,
      reason:       null,
      mustUseRemote: computeType === 'ai',
    }
  }

  // local mode — everything allowed locally
  return { allowed: true, reason: null, mustUseRemote: false }
}

/** Convenience: is this workspace in cloud-api-only mode? */
export async function isCloudApiOnly(workspaceId: string): Promise<boolean> {
  const s = await getRuntimeSettings(workspaceId)
  return s.mode === 'cloud-api-only'
}
