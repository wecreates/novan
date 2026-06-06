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
  // R146.303 — was SELECT → branch on !existing → INSERT or UPDATE. Two
  // concurrent calls would both see existing=null, both INSERT, second
  // would PK-collide (workspace_id, user_id) → silently swallowed by the
  // outer .catch() and the second caller's mutations vanish.
  //
  // Fix: build the row from DEFAULTS+patch and onConflictDoUpdate so a
  // race is resolved by Postgres. The setWhere clause restricts UPDATE
  // to only the fields the caller actually patched — so the conflict
  // path doesn't overwrite settings the other thread set.
  const row = { ...DEFAULTS(workspaceId, userId), ...patch }
  row.preferredSpeed = clampSpeed(row.preferredSpeed)
  const updateSet: Record<string, unknown> = { updatedAt: now }
  if (patch.preferredVoice       !== undefined) updateSet['preferredVoice']       = patch.preferredVoice
  if (patch.preferredSpeed       !== undefined) updateSet['preferredSpeed']       = clampSpeed(patch.preferredSpeed)
  if (patch.preferredLength      !== undefined) updateSet['preferredLength']      = patch.preferredLength
  if (patch.confirmationStyle    !== undefined) updateSet['confirmationStyle']    = patch.confirmationStyle
  if (patch.preferredWake        !== undefined) updateSet['preferredWake']        = patch.preferredWake
  if (patch.preferredDefaultMode !== undefined) updateSet['preferredDefaultMode'] = patch.preferredDefaultMode
  if (patch.responseMode         !== undefined) updateSet['responseMode']         = patch.responseMode
  await db.insert(operatorVoicePrefs).values({
    workspaceId, userId,
    preferredVoice:       row.preferredVoice,
    preferredSpeed:       row.preferredSpeed,
    preferredLength:      row.preferredLength,
    confirmationStyle:    row.confirmationStyle,
    preferredWake:        row.preferredWake,
    preferredDefaultMode: row.preferredDefaultMode,
    responseMode:         row.responseMode,
    createdAt:            now,
    updatedAt:            now,
  }).onConflictDoUpdate({
    target: [operatorVoicePrefs.workspaceId, operatorVoicePrefs.userId],
    set: updateSet,
  }).catch((e: Error) => { console.error('[voice-operator-prefs]', e.message); return null })
  return getOperatorPrefs(workspaceId, userId)
}

/** Operator-deletable — required by the directive's editability rule. */
export async function resetOperatorPrefs(workspaceId: string, userId: string): Promise<void> {
  await db.delete(operatorVoicePrefs)
    .where(and(eq(operatorVoicePrefs.workspaceId, workspaceId), eq(operatorVoicePrefs.userId, userId)))
    .catch((e: Error) => { console.error('[voice-operator-prefs]', e.message); return null })
}
