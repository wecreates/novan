/**
 * safety-mode.ts — Tonight Mode runtime safety gate.
 *
 * Every dangerous autonomous action calls `isAllowed(ws, key)` before
 * proceeding. Default state is Tonight Mode = ALL dangerous categories OFF.
 *
 * Flag changes are audited via events + securityAudits.
 */
import { db }                  from '../db/client.js'
import { runtimeSafetyFlags, events, securityAudits } from '../db/schema.js'
import { eq }                  from 'drizzle-orm'
import { v7 as uuidv7 }        from 'uuid'

export type SafetyAction =
  | 'autonomous_deploy'
  | 'self_edit_loop'
  | 'autonomous_deps_upgrade'
  | 'destructive_migration'
  | 'internet_learning_swarm'

export type SafetyFlagKey = keyof Pick<
  typeof runtimeSafetyFlags.$inferSelect,
  | 'autonomousDeployAllowed' | 'selfEditLoopsAllowed' | 'autonomousDepsUpgradesAllowed'
  | 'destructiveMigrationsAllowed' | 'internetLearningSwarmAllowed'
  | 'approvalGatedPatchesEnabled' | 'failureLearningEnabled' | 'observabilityEnabled'
  | 'warRoomEnabled' | 'cronScansEnabled' | 'incidentAlertsEnabled'
>

const ACTION_TO_FLAG: Record<SafetyAction, SafetyFlagKey> = {
  autonomous_deploy:       'autonomousDeployAllowed',
  self_edit_loop:          'selfEditLoopsAllowed',
  autonomous_deps_upgrade: 'autonomousDepsUpgradesAllowed',
  destructive_migration:   'destructiveMigrationsAllowed',
  internet_learning_swarm: 'internetLearningSwarmAllowed',
}

async function audit(workspaceId: string, type: string, payload: Record<string, unknown>, severity: 'info' | 'warning' | 'critical' = 'info') {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'safety-mode', version: 1, createdAt: Date.now(),
  }).catch(() => null)
  await db.insert(securityAudits).values({
    id: uuidv7(), workspaceId,
    userId: (payload['setBy'] as string) ?? null,
    eventType: 'compliance_action', severity,
    resource: 'safety_flags', action: type, outcome: 'recorded',
    context: payload, immutable: true,
    ipAddress: null, userAgent: null,
    createdAt: Date.now(),
  }).catch(() => null)
}

// ─── Read / init ──────────────────────────────────────────────────────────────

export async function getSafetyFlags(workspaceId: string) {
  let rows = await db.select().from(runtimeSafetyFlags)
    .where(eq(runtimeSafetyFlags.id, workspaceId)).limit(1)
  if (rows.length === 0) {
    // Initialize Tonight Mode defaults
    const now = Date.now()
    await db.insert(runtimeSafetyFlags).values({
      id: workspaceId, workspaceId,
      autonomousDeployAllowed:       false,
      selfEditLoopsAllowed:          false,
      autonomousDepsUpgradesAllowed: false,
      destructiveMigrationsAllowed:  false,
      internetLearningSwarmAllowed:  false,
      approvalGatedPatchesEnabled:   true,
      failureLearningEnabled:        true,
      observabilityEnabled:          true,
      warRoomEnabled:                true,
      cronScansEnabled:              true,
      incidentAlertsEnabled:         true,
      tonightModeActive:             true,
      setBy:                         'system',
      notes:                         'Tonight Mode — safe defaults initialized',
      updatedAt:                     now,
    }).onConflictDoNothing()
    rows = await db.select().from(runtimeSafetyFlags)
      .where(eq(runtimeSafetyFlags.id, workspaceId)).limit(1)
    await audit(workspaceId, 'safety_flags.tonight_mode_initialized', { setBy: 'system' })
  }
  return rows[0]!
}

/** Check if a dangerous action is currently allowed. */
export async function isAllowed(workspaceId: string, action: SafetyAction): Promise<boolean> {
  const flags = await getSafetyFlags(workspaceId)
  const key = ACTION_TO_FLAG[action]
  return Boolean(flags[key])
}

/** Throws if action is blocked, otherwise returns. */
export async function assertAllowed(workspaceId: string, action: SafetyAction): Promise<void> {
  const ok = await isAllowed(workspaceId, action)
  if (!ok) {
    await audit(workspaceId, 'safety_flags.action_blocked', { action }, 'warning')
    throw new Error(`Safety mode blocked action '${action}' — flag is disabled. Toggle via /api/v1/launch-tonight/flags`)
  }
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export async function setFlag(
  workspaceId: string, key: SafetyFlagKey, value: boolean, actor: string, note?: string,
): Promise<void> {
  await getSafetyFlags(workspaceId)  // ensure row exists
  const now = Date.now()
  await db.update(runtimeSafetyFlags).set({
    [key]: value, setBy: actor, notes: note ?? null, updatedAt: now,
    // Disable tonight mode if any dangerous flag is flipped ON
    tonightModeActive: value && [
      'autonomousDeployAllowed', 'selfEditLoopsAllowed', 'autonomousDepsUpgradesAllowed',
      'destructiveMigrationsAllowed', 'internetLearningSwarmAllowed',
    ].includes(key as string) ? false : undefined,
  } as Partial<typeof runtimeSafetyFlags.$inferInsert>).where(eq(runtimeSafetyFlags.id, workspaceId))

  await audit(workspaceId, 'safety_flags.flag_changed', { key, value, setBy: actor, note }, 'warning')
}

/** Enable Tonight Mode — set all dangerous flags OFF, all safe flags ON. */
export async function enableTonightMode(workspaceId: string, actor: string): Promise<void> {
  await getSafetyFlags(workspaceId)
  const now = Date.now()
  await db.update(runtimeSafetyFlags).set({
    autonomousDeployAllowed:       false,
    selfEditLoopsAllowed:          false,
    autonomousDepsUpgradesAllowed: false,
    destructiveMigrationsAllowed:  false,
    internetLearningSwarmAllowed:  false,
    approvalGatedPatchesEnabled:   true,
    failureLearningEnabled:        true,
    observabilityEnabled:          true,
    warRoomEnabled:                true,
    cronScansEnabled:              true,
    incidentAlertsEnabled:         true,
    tonightModeActive:             true,
    setBy:                         actor,
    notes:                         'Tonight Mode enabled — safe defaults restored',
    updatedAt:                     now,
  }).where(eq(runtimeSafetyFlags.id, workspaceId))

  await audit(workspaceId, 'safety_flags.tonight_mode_enabled', { actor }, 'info')
}

/** Disable Tonight Mode — requires explicit confirmation. */
export async function disableTonightMode(
  workspaceId: string, actor: string, confirmationCode: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (confirmationCode !== 'I_UNDERSTAND_THE_RISK') {
    return { ok: false, reason: 'Must pass confirmation_code = "I_UNDERSTAND_THE_RISK"' }
  }
  await getSafetyFlags(workspaceId)
  const now = Date.now()
  await db.update(runtimeSafetyFlags).set({
    tonightModeActive: false, setBy: actor,
    notes: 'Tonight Mode disabled — dangerous flags now operator-controlled',
    updatedAt: now,
  }).where(eq(runtimeSafetyFlags.id, workspaceId))

  await audit(workspaceId, 'safety_flags.tonight_mode_disabled', { actor }, 'critical')
  return { ok: true }
}
