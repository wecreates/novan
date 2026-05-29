/**
 * voice-preferences.ts — workspace-level operator preferences for voice.
 *
 * These persist across sessions and feed into provider routing. The
 * router reads `preferredProvider` + `qualityWeight` and combines them
 * with the per-workspace `providerQualityRollup` to bias selection.
 */
import { db } from '../db/client.js'
import { workspaceVoicePrefs } from '../db/schema.js'
import { eq } from 'drizzle-orm'

export interface WorkspaceVoicePrefs {
  workspaceId:             string
  preferredProvider:       string | null
  preferredPreset:         string | null
  preferredLocale:         string
  transcriptRetained:      boolean
  autoConfirmLowRisk:      boolean
  bargeInEnabled:          boolean
  qualityWeight:           number
  // Wake / hands-free / ambient (migration 0029)
  wakePhrases:             string[]
  wakeEnabled:             boolean
  handsFreeEnabled:        boolean
  handsFreeAllowedIntents: string[]
  ambientAlertsEnabled:    boolean
  ambientSeverityFloor:    'normal' | 'high' | 'critical'
  pushToTalkDefault:       boolean
}

const DEFAULTS = (workspaceId: string): WorkspaceVoicePrefs => ({
  workspaceId,
  preferredProvider:       null,
  preferredPreset:         null,
  preferredLocale:         'en-US',
  transcriptRetained:      true,
  autoConfirmLowRisk:      false,
  bargeInEnabled:          true,
  qualityWeight:           0.15,
  wakePhrases:             ['hey novan', 'novan'],
  wakeEnabled:             false,
  handsFreeEnabled:        false,
  handsFreeAllowedIntents: [],
  ambientAlertsEnabled:    true,
  ambientSeverityFloor:    'critical',
  pushToTalkDefault:       true,
})

export async function getVoicePrefs(workspaceId: string): Promise<WorkspaceVoicePrefs> {
  const row = await db.select().from(workspaceVoicePrefs)
    .where(eq(workspaceVoicePrefs.workspaceId, workspaceId))
    .limit(1).then(r => r[0]).catch(() => null)
  if (!row) return DEFAULTS(workspaceId)
  return {
    workspaceId,
    preferredProvider:       row.preferredProvider,
    preferredPreset:         row.preferredPreset,
    preferredLocale:         row.preferredLocale,
    transcriptRetained:      row.transcriptRetained,
    autoConfirmLowRisk:      row.autoConfirmLowRisk,
    bargeInEnabled:          row.bargeInEnabled,
    qualityWeight:           row.qualityWeight,
    wakePhrases:             (row.wakePhrases as string[]) ?? ['hey novan', 'novan'],
    wakeEnabled:             row.wakeEnabled,
    handsFreeEnabled:        row.handsFreeEnabled,
    handsFreeAllowedIntents: (row.handsFreeAllowedIntents as string[]) ?? [],
    ambientAlertsEnabled:    row.ambientAlertsEnabled,
    ambientSeverityFloor:    (row.ambientSeverityFloor as 'normal' | 'high' | 'critical') ?? 'critical',
    pushToTalkDefault:       row.pushToTalkDefault,
  }
}

export async function patchVoicePrefs(workspaceId: string, patch: Partial<WorkspaceVoicePrefs>): Promise<WorkspaceVoicePrefs> {
  const now = Date.now()
  const existing = await db.select().from(workspaceVoicePrefs).where(eq(workspaceVoicePrefs.workspaceId, workspaceId)).limit(1).then(r => r[0]).catch(() => null)
  if (!existing) {
    const next = { ...DEFAULTS(workspaceId), ...patch, workspaceId }
    await db.insert(workspaceVoicePrefs).values({
      workspaceId,
      preferredProvider:       next.preferredProvider,
      preferredPreset:         next.preferredPreset,
      preferredLocale:         next.preferredLocale,
      transcriptRetained:      next.transcriptRetained,
      autoConfirmLowRisk:      next.autoConfirmLowRisk,
      bargeInEnabled:          next.bargeInEnabled,
      qualityWeight:           Math.max(0, Math.min(1, next.qualityWeight)),
      wakePhrases:             next.wakePhrases,
      wakeEnabled:             next.wakeEnabled,
      handsFreeEnabled:        next.handsFreeEnabled,
      handsFreeAllowedIntents: next.handsFreeAllowedIntents,
      ambientAlertsEnabled:    next.ambientAlertsEnabled,
      ambientSeverityFloor:    next.ambientSeverityFloor,
      pushToTalkDefault:       next.pushToTalkDefault,
      updatedAt:               now,
    }).catch(() => null)
    return next
  }
  const update: Record<string, unknown> = { updatedAt: now }
  if (patch.preferredProvider  !== undefined) update['preferredProvider']  = patch.preferredProvider
  if (patch.preferredPreset    !== undefined) update['preferredPreset']    = patch.preferredPreset
  if (patch.preferredLocale    !== undefined) update['preferredLocale']    = patch.preferredLocale
  if (patch.transcriptRetained !== undefined) update['transcriptRetained'] = patch.transcriptRetained
  if (patch.autoConfirmLowRisk !== undefined) update['autoConfirmLowRisk'] = patch.autoConfirmLowRisk
  if (patch.bargeInEnabled     !== undefined) update['bargeInEnabled']     = patch.bargeInEnabled
  if (patch.qualityWeight           !== undefined) update['qualityWeight']           = Math.max(0, Math.min(1, patch.qualityWeight))
  if (patch.wakePhrases             !== undefined) update['wakePhrases']             = patch.wakePhrases
  if (patch.wakeEnabled             !== undefined) update['wakeEnabled']             = patch.wakeEnabled
  if (patch.handsFreeEnabled        !== undefined) update['handsFreeEnabled']        = patch.handsFreeEnabled
  if (patch.handsFreeAllowedIntents !== undefined) update['handsFreeAllowedIntents'] = patch.handsFreeAllowedIntents
  if (patch.ambientAlertsEnabled    !== undefined) update['ambientAlertsEnabled']    = patch.ambientAlertsEnabled
  if (patch.ambientSeverityFloor    !== undefined) update['ambientSeverityFloor']    = patch.ambientSeverityFloor
  if (patch.pushToTalkDefault       !== undefined) update['pushToTalkDefault']       = patch.pushToTalkDefault
  await db.update(workspaceVoicePrefs).set(update).where(eq(workspaceVoicePrefs.workspaceId, workspaceId)).catch(() => null)
  return getVoicePrefs(workspaceId)
}
