/**
 * operator-preferences.ts — Per-workspace settings (items #25 + #26).
 *
 * Drives:
 *   - UI theme + default page
 *   - Governor limit overrides (resource-governor reads these)
 *   - Risk tolerance + auto-apply confidence threshold
 */
import { db }                          from '../db/client.js'
import { operatorPreferences }         from '../db/schema.js'
import { eq }                          from 'drizzle-orm'

export interface OperatorPreferences {
  workspaceId:                    string
  theme:                          'dark' | 'light'
  defaultPage:                    string | null
  maxConcurrentAgents:            number | null
  maxResearchPerHour:             number | null
  maxImagesPerHour:               number | null
  maxAutonomousPatchesPerDay:     number | null
  maxDeploymentsPerDay:           number | null
  approvalAutoApplyMinConfidence: number
  riskTolerance:                  'conservative' | 'balanced' | 'aggressive'
  metadata:                       Record<string, unknown>
  createdAt:                      number
  updatedAt:                      number
}

const DEFAULTS: Omit<OperatorPreferences, 'workspaceId' | 'createdAt' | 'updatedAt'> = {
  theme:                          'dark',
  defaultPage:                    null,
  maxConcurrentAgents:            null,
  maxResearchPerHour:             null,
  maxImagesPerHour:               null,
  maxAutonomousPatchesPerDay:     null,
  maxDeploymentsPerDay:           null,
  approvalAutoApplyMinConfidence: 0.8,
  riskTolerance:                  'balanced',
  metadata:                       {},
}

export async function getPreferences(workspaceId: string): Promise<OperatorPreferences> {
  const row = await db.select().from(operatorPreferences)
    .where(eq(operatorPreferences.workspaceId, workspaceId)).limit(1)
    .then(r => r[0]).catch(() => null)
  if (!row) {
    const now = Date.now()
    return { workspaceId, ...DEFAULTS, createdAt: now, updatedAt: now }
  }
  return {
    workspaceId: row.workspaceId,
    theme:                          row.theme as 'dark' | 'light',
    defaultPage:                    row.defaultPage,
    maxConcurrentAgents:            row.maxConcurrentAgents,
    maxResearchPerHour:             row.maxResearchPerHour,
    maxImagesPerHour:               row.maxImagesPerHour,
    maxAutonomousPatchesPerDay:     row.maxAutonomousPatchesPerDay,
    maxDeploymentsPerDay:           row.maxDeploymentsPerDay,
    approvalAutoApplyMinConfidence: row.approvalAutoApplyMinConfidence,
    riskTolerance:                  row.riskTolerance as 'conservative' | 'balanced' | 'aggressive',
    metadata:                       (row.metadata as Record<string, unknown>) ?? {},
    createdAt:                      row.createdAt,
    updatedAt:                      row.updatedAt,
  }
}

export type Patch = Partial<Omit<OperatorPreferences, 'workspaceId' | 'createdAt' | 'updatedAt'>>

export async function setPreferences(workspaceId: string, patch: Patch): Promise<OperatorPreferences> {
  const existing = await db.select().from(operatorPreferences)
    .where(eq(operatorPreferences.workspaceId, workspaceId)).limit(1)
    .then(r => r[0]).catch(() => null)

  const now = Date.now()
  if (!existing) {
    await db.insert(operatorPreferences).values({
      workspaceId,
      theme:                          patch.theme        ?? DEFAULTS.theme,
      defaultPage:                    patch.defaultPage  ?? null,
      maxConcurrentAgents:            patch.maxConcurrentAgents        ?? null,
      maxResearchPerHour:             patch.maxResearchPerHour         ?? null,
      maxImagesPerHour:               patch.maxImagesPerHour           ?? null,
      maxAutonomousPatchesPerDay:     patch.maxAutonomousPatchesPerDay ?? null,
      maxDeploymentsPerDay:           patch.maxDeploymentsPerDay       ?? null,
      approvalAutoApplyMinConfidence: patch.approvalAutoApplyMinConfidence ?? DEFAULTS.approvalAutoApplyMinConfidence,
      riskTolerance:                  patch.riskTolerance              ?? DEFAULTS.riskTolerance,
      metadata:                       patch.metadata                   ?? {},
      createdAt: now, updatedAt: now,
    }).onConflictDoNothing().catch(() => null)
  } else {
    const update: Record<string, unknown> = { updatedAt: now }
    if (patch.theme        !== undefined) update['theme']        = patch.theme
    if (patch.defaultPage  !== undefined) update['defaultPage']  = patch.defaultPage
    if (patch.maxConcurrentAgents        !== undefined) update['maxConcurrentAgents']        = patch.maxConcurrentAgents
    if (patch.maxResearchPerHour         !== undefined) update['maxResearchPerHour']         = patch.maxResearchPerHour
    if (patch.maxImagesPerHour           !== undefined) update['maxImagesPerHour']           = patch.maxImagesPerHour
    if (patch.maxAutonomousPatchesPerDay !== undefined) update['maxAutonomousPatchesPerDay'] = patch.maxAutonomousPatchesPerDay
    if (patch.maxDeploymentsPerDay       !== undefined) update['maxDeploymentsPerDay']       = patch.maxDeploymentsPerDay
    if (patch.approvalAutoApplyMinConfidence !== undefined) update['approvalAutoApplyMinConfidence'] = patch.approvalAutoApplyMinConfidence
    if (patch.riskTolerance !== undefined) update['riskTolerance'] = patch.riskTolerance
    if (patch.metadata      !== undefined) update['metadata']      = patch.metadata
    await db.update(operatorPreferences).set(update)
      .where(eq(operatorPreferences.workspaceId, workspaceId)).catch(() => null)
  }
  return getPreferences(workspaceId)
}

/** Risk-tolerance-aware confidence floor for auto-apply (used by recommendation engine). */
export async function autoApplyConfidenceFloor(workspaceId: string): Promise<number> {
  const p = await getPreferences(workspaceId)
  const base = p.approvalAutoApplyMinConfidence
  if (p.riskTolerance === 'conservative') return Math.max(0.9, base)
  if (p.riskTolerance === 'aggressive')   return Math.max(0.6, base - 0.1)
  return base
}
