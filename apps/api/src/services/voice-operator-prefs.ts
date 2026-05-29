/**
 * voice-operator-prefs.ts — per-operator voice preferences.
 *
 * Distinct from `workspace_voice_prefs` (which configures the workspace
 * as a whole). These belong to a single user and persist across sessions.
 * Editable + deletable via the routes layer.
 */
import { db } from '../db/client.js'
import { operatorVoicePrefs } from '../db/schema.js'
import { and, eq } from 'drizzle-orm'

export type ResponseLength = 'short' | 'normal' | 'detailed'
export type ConfirmationStyle = 'chip' | 'spoken' | 'both'
export type DefaultMode = 'push_to_talk' | 'wake' | 'hands_free'
export type ResponseMode = 'normal' | 'engineer' | 'executive' | 'brain_ui'

export interface OperatorVoicePrefs {
  workspaceId:          string
  userId:               string
  preferredVoice:       string | null
  preferredSpeed:       number              // 0.5 .. 1.5
  preferredLength:      ResponseLength
  confirmationStyle:    ConfirmationStyle
  preferredWake:        string | null
  preferredDefaultMode: DefaultMode
  responseMode:         ResponseMode
}

const DEFAULTS = (workspaceId: string, userId: string): OperatorVoicePrefs => ({
  workspaceId, userId,
  preferredVoice:       null,
  preferredSpeed:       1.0,
  preferredLength:      'short',
  confirmationStyle:    'chip',
  preferredWake:        null,
  preferredDefaultMode: 'push_to_talk',
  responseMode:         'normal',
})

function clampSpeed(n: number): number { return Math.max(0.5, Math.min(1.5, n)) }

export async function getOperatorPrefs(workspaceId: string, userId: string): Promise<OperatorVoicePrefs> {
  const row = await db.select().from(operatorVoicePrefs)
    .where(and(eq(operatorVoicePrefs.workspaceId, workspaceId), eq(operatorVoicePrefs.userId, userId)))
    .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[voice-operator-prefs]', e.message); return null })
  if (!row) return DEFAULTS(workspaceId, userId)
  return {
    workspaceId, userId,
    preferredVoice:       row.preferredVoice,
    preferredSpeed:       row.preferredSpeed,
    preferredLength:      row.preferredLength as ResponseLength,
    confirmationStyle:    row.confirmationStyle as ConfirmationStyle,
    preferredWake:        row.preferredWake,
    preferredDefaultMode: row.preferredDefaultMode as DefaultMode,
    responseMode:         row.responseMode as ResponseMode,
  }
}

export async function patchOperatorPrefs(workspaceId: string, userId: string, patch: Partial<OperatorVoicePrefs>): Promise<OperatorVoicePrefs> {
  const now = Date.now()
  const existing = await db.select().from(operatorVoicePrefs)
    .where(and(eq(operatorVoicePrefs.workspaceId, workspaceId), eq(operatorVoicePrefs.userId, userId)))
    .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[voice-operator-prefs]', e.message); return null })
  if (!existing) {
    const next = { ...DEFAULTS(workspaceId, userId), ...patch }
    next.preferredSpeed = clampSpeed(next.preferredSpeed)
    await db.insert(operatorVoicePrefs).values({
      workspaceId, userId,
      preferredVoice:       next.preferredVoice,
      preferredSpeed:       next.preferredSpeed,
      preferredLength:      next.preferredLength,
      confirmationStyle:    next.confirmationStyle,
      preferredWake:        next.preferredWake,
      preferredDefaultMode: next.preferredDefaultMode,
      responseMode:         next.responseMode,
      createdAt:            now,
      updatedAt:            now,
    }).catch((e: Error) => { console.error('[voice-operator-prefs]', e.message); return null })
    return next
  }
  const upd: Record<string, unknown> = { updatedAt: now }
  if (patch.preferredVoice       !== undefined) upd['preferredVoice']       = patch.preferredVoice
  if (patch.preferredSpeed       !== undefined) upd['preferredSpeed']       = clampSpeed(patch.preferredSpeed)
  if (patch.preferredLength      !== undefined) upd['preferredLength']      = patch.preferredLength
  if (patch.confirmationStyle    !== undefined) upd['confirmationStyle']    = patch.confirmationStyle
  if (patch.preferredWake        !== undefined) upd['preferredWake']        = patch.preferredWake
  if (patch.preferredDefaultMode !== undefined) upd['preferredDefaultMode'] = patch.preferredDefaultMode
  if (patch.responseMode         !== undefined) upd['responseMode']         = patch.responseMode
  await db.update(operatorVoicePrefs).set(upd)
    .where(and(eq(operatorVoicePrefs.workspaceId, workspaceId), eq(operatorVoicePrefs.userId, userId)))
    .catch((e: Error) => { console.error('[voice-operator-prefs]', e.message); return null })
  return getOperatorPrefs(workspaceId, userId)
}

/** Operator-deletable — required by the directive's editability rule. */
export async function resetOperatorPrefs(workspaceId: string, userId: string): Promise<void> {
  await db.delete(operatorVoicePrefs)
    .where(and(eq(operatorVoicePrefs.workspaceId, workspaceId), eq(operatorVoicePrefs.userId, userId)))
    .catch((e: Error) => { console.error('[voice-operator-prefs]', e.message); return null })
}
