/**
 * Provider Router Service
 *
 * Pre-execution routing decision engine.
 * Chains: runtime mode → kill switch → budget preflight → provider selection.
 * Emits runtime events for all routing decisions.
 */

import { v7 as uuidv7 }   from 'uuid'
import { and, eq, desc }  from 'drizzle-orm'
import { db }              from '../db/client.js'
import {
  events, providerConfigs, providerScores, killSwitches, providerPreferences,
} from '../db/schema.js'
import {
  evaluateKillSwitches, checkBudgetPreflight,
} from '@ops/ai-router'
import type { KillSwitchRecord, BudgetCap } from '@ops/ai-router'
import { loadActiveCaps }  from './budget-guard.js'
import { checkComputeAllowed } from './runtime-mode.js'
import type { ComputeType } from './runtime-mode.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RouteRequest {
  workspaceId:      string
  userId?:          string
  computeType:      ComputeType
  providerId?:      string           // preferred provider (optional)
  estimatedCostUsd: number
  scopeType:        string
  scopeId:          string
  executionId:      string
  isWorkflow?:      boolean
  requiredCapabilities?: string[]
  taskType?:        string           // routes through provider_preferences when active
}

export interface RouteDecision {
  approved:    boolean
  blockReason: string | null
  providerId:  string | null
  mustUseRemote: boolean
  guardId:     string | null
  checkedAt:   number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function emitEvent(
  workspaceId: string, type: string, payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId,
    payload, traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/provider-router', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[provider-router]', e.message); return null })
}

/** Select the best enabled provider by composite score. */
async function selectProvider(
  workspaceId: string,
  preferredId?: string,
  taskType?: string,
): Promise<string | null> {
  // If specific provider requested and it's enabled, use it
  if (preferredId) {
    const configs = await db.select().from(providerConfigs)
      .where(and(
        eq(providerConfigs.workspaceId, workspaceId),
        eq(providerConfigs.providerId, preferredId),
        eq(providerConfigs.enabled, true),
      ))
    if (configs.length > 0) return preferredId
  }

  // Operator-approved preference for this task type (status='active')
  if (taskType) {
    const pref = await db.select().from(providerPreferences)
      .where(and(
        eq(providerPreferences.workspaceId, workspaceId),
        eq(providerPreferences.taskType, taskType),
        eq(providerPreferences.status, 'active'),
      )).limit(1).then(r => r[0]).catch((e: Error) => { console.error('[provider-router]', e.message); return null })
    if (pref) {
      const configs = await db.select().from(providerConfigs)
        .where(and(
          eq(providerConfigs.workspaceId, workspaceId),
          eq(providerConfigs.providerId, pref.preferredProvider),
          eq(providerConfigs.enabled, true),
        )).catch(() => [])
      if (configs.length > 0) return pref.preferredProvider
    }
  }

  // Pick best by composite score (highest first, circuit must not be open)
  const scores = await db.select().from(providerScores)
    .where(and(
      eq(providerScores.workspaceId, workspaceId),
    ))
    .orderBy(desc(providerScores.compositeScore))

  for (const s of scores) {
    if (s.circuitState !== 'open') return s.providerId
  }

  // Fallback: any enabled config
  const configs = await db.select().from(providerConfigs)
    .where(and(
      eq(providerConfigs.workspaceId, workspaceId),
      eq(providerConfigs.enabled, true),
    ))
    .orderBy(providerConfigs.priority)

  return configs[0]?.providerId ?? null
}

// ─── Main routing decision ────────────────────────────────────────────────────

/**
 * Evaluate a full routing decision:
 * 1. Runtime mode check
 * 2. Kill switch evaluation
 * 3. Budget preflight
 * 4. Provider selection
 *
 * Returns RouteDecision — caller must check .approved before proceeding.
 */
export async function routeRequest(req: RouteRequest): Promise<RouteDecision> {
  const now      = Date.now()
  const guardId  = uuidv7()

  // ── 1. Runtime mode check ─────────────────────────────────────────────────
  const modeCheck = await checkComputeAllowed(req.workspaceId, req.computeType)

  if (!modeCheck.allowed) {
    await emitEvent(req.workspaceId, 'router.blocked.mode', {
      guardId, executionId: req.executionId,
      computeType: req.computeType, reason: modeCheck.reason,
    })
    return {
      approved: false,
      blockReason: modeCheck.reason,
      providerId: null,
      mustUseRemote: true,
      guardId,
      checkedAt: now,
    }
  }

  // ── 2. Kill switch check ──────────────────────────────────────────────────
  const switches = await db.select().from(killSwitches)
    .where(and(
      eq(killSwitches.workspaceId, req.workspaceId),
      eq(killSwitches.enabled, true),
    ))

  const ksRecords: KillSwitchRecord[] = switches.map((s) => ({
    switchType: s.switchType,
    enabled:    s.enabled,
  }))

  const ksResult = evaluateKillSwitches(ksRecords, {
    jobType:    req.computeType,
    ...(req.providerId !== undefined ? { providerId: req.providerId } : {}),
  })

  if (ksResult.blocked) {
    await emitEvent(req.workspaceId, 'router.blocked.kill_switch', {
      guardId, executionId: req.executionId,
      switchType: ksResult.switchType, detail: ksResult.detail,
    })
    return {
      approved: false,
      blockReason: ksResult.detail,
      providerId: null,
      mustUseRemote: modeCheck.mustUseRemote,
      guardId,
      checkedAt: now,
    }
  }

  // ── 3. Budget preflight ───────────────────────────────────────────────────
  const caps = await loadActiveCaps(req.workspaceId)
  const budgetResult = checkBudgetPreflight(
    req.estimatedCostUsd,
    caps as BudgetCap[],
    req.isWorkflow ?? false,
  )

  if (!budgetResult.approved) {
    await emitEvent(req.workspaceId, 'router.blocked.budget', {
      guardId, executionId: req.executionId,
      estimatedCostUsd: req.estimatedCostUsd,
      blockReason: budgetResult.blockReason,
      capId: budgetResult.capId,
    })
    return {
      approved: false,
      blockReason: budgetResult.blockReason,
      providerId: null,
      mustUseRemote: modeCheck.mustUseRemote,
      guardId,
      checkedAt: now,
    }
  }

  // ── 4. Provider selection ─────────────────────────────────────────────────
  const selectedProvider = await selectProvider(req.workspaceId, req.providerId, req.taskType)

  await emitEvent(req.workspaceId, 'router.approved', {
    guardId, executionId: req.executionId,
    computeType: req.computeType,
    estimatedCostUsd: req.estimatedCostUsd,
    selectedProvider,
    mustUseRemote: modeCheck.mustUseRemote,
  })

  return {
    approved: true,
    blockReason: null,
    providerId: selectedProvider,
    mustUseRemote: modeCheck.mustUseRemote,
    guardId,
    checkedAt: now,
  }
}
