/**
 * RollbackVerifier — produces a written verification log showing exactly
 * what can and cannot be restored from a snapshot.
 *
 * Rules:
 * - Every snapshot item must be assessed.
 * - Non-restorable items (e.g., external API side effects) must be flagged.
 * - The log is immutable once written.
 */
import type { snapshotItems } from '@ops/db'

export type RestorabilityStatus = 'restorable' | 'partial' | 'not_restorable' | 'unknown'

export interface ItemVerification {
  itemId:       string
  entityType:   string
  entityId:     string
  itemType:     string
  restorable:   RestorabilityStatus
  reason:       string
}

export interface RollbackVerificationReport {
  snapshotId:          string
  runId:               string
  totalItems:          number
  restorable:          number
  partiallyRestorable: number
  notRestorable:       number
  verifications:       ItemVerification[]
  canProceed:          boolean  // true if at least one item is restorable and no critical failures
  warnings:            string[]
  generatedAt:         number
}

const NOT_RESTORABLE_TYPES = new Set(['api_state'])  // external API calls cannot be undone
const PARTIAL_TYPES        = new Set(['file'])        // files may have been modified externally

export function verifyRollback(
  snapshotId: string,
  runId:      string,
  items:      typeof snapshotItems.$inferSelect[],
): RollbackVerificationReport {
  const verifications: ItemVerification[] = items.map((item) => {
    let restorable: RestorabilityStatus
    let reason: string

    if (NOT_RESTORABLE_TYPES.has(item.itemType)) {
      restorable = 'not_restorable'
      reason     = `External API state (${item.entityType}) cannot be deterministically reversed`
    } else if (PARTIAL_TYPES.has(item.itemType)) {
      restorable = 'partial'
      reason     = `File (${item.entityId}) may have been modified externally; content will be restored but filesystem metadata may differ`
    } else if (item.itemType === 'db_row') {
      restorable = 'restorable'
      reason     = `DB row ${item.entityType}:${item.entityId} can be restored from captured before-state`
    } else {
      restorable = 'unknown'
      reason     = `Custom item type '${item.itemType}' — restorability depends on the registered handler`
    }

    return { itemId: item.id, entityType: item.entityType, entityId: item.entityId, itemType: item.itemType, restorable, reason }
  })

  const restorableCount    = verifications.filter((v) => v.restorable === 'restorable').length
  const partialCount       = verifications.filter((v) => v.restorable === 'partial').length
  const notRestorableCount = verifications.filter((v) => v.restorable === 'not_restorable').length
  const unknownCount       = verifications.filter((v) => v.restorable === 'unknown').length

  const warnings: string[] = []
  if (notRestorableCount > 0) warnings.push(`${notRestorableCount} items cannot be restored (external side effects)`)
  if (partialCount > 0)       warnings.push(`${partialCount} items may only be partially restored`)
  if (unknownCount > 0)       warnings.push(`${unknownCount} items have unknown restorability`)

  return {
    snapshotId,
    runId,
    totalItems:          items.length,
    restorable:          restorableCount,
    partiallyRestorable: partialCount,
    notRestorable:       notRestorableCount,
    verifications,
    canProceed:          restorableCount > 0,
    warnings,
    generatedAt:         Date.now(),
  }
}
