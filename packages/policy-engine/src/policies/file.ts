/**
 * File action policy.
 *
 * Rules:
 *   - observe_only / recommend_only → deny all writes, allow reads
 *   - safe_low_risk_automation → allow read, require_approval for write/delete
 *   - approval_required_execution → allow read/write, require_approval for delete
 *   - restricted_supervised_orchestration → allow read/write, require_approval for delete
 *   - delete is always at least require_approval
 */
import type { Policy, PolicyContext, PolicyResult } from '../types.js'

const FILE_READ_ACTIONS   = new Set(['file.read', 'file.list', 'file.stat', 'file.exists'])
const FILE_WRITE_ACTIONS  = new Set(['file.write', 'file.create', 'file.append', 'file.move', 'file.copy'])
const FILE_DELETE_ACTIONS = new Set(['file.delete', 'file.rmdir', 'file.unlink'])

export const fileActionPolicy: Policy = {
  id:          'policy:file-action',
  name:        'File Action Policy',
  description: 'Controls file system access by risk level and action type',
  category:    'file',

  evaluate(ctx: PolicyContext): PolicyResult {
    const base     = { policyId: this.id, policyName: this.name }
    const isRead   = FILE_READ_ACTIONS.has(ctx.action)
    const isWrite  = FILE_WRITE_ACTIONS.has(ctx.action)
    const isDelete = FILE_DELETE_ACTIONS.has(ctx.action)

    // Non-read actions blocked for observe/recommend
    if (!isRead && (ctx.autonomyLevel === 'observe_only' || ctx.autonomyLevel === 'recommend_only')) {
      return {
        ...base,
        verdict:   'deny',
        reason:    `Autonomy level '${ctx.autonomyLevel}' cannot modify files`,
        riskLevel: 'high',
        blockedContext: { reason: 'insufficient_autonomy', context: { action: ctx.action } },
      }
    }

    // Read operations always allowed
    if (isRead) {
      return { ...base, verdict: 'allow', reason: 'File read operation permitted', riskLevel: 'low' }
    }

    // Delete operations always require approval
    if (isDelete) {
      return {
        ...base,
        verdict:   'require_approval',
        reason:    'File deletion requires human approval',
        riskLevel: 'high',
        approvalContext: {
          operationLabel: `Delete: ${ctx.subject ?? ctx.action}`,
          risk:           'high',
          expiresInMs:    4 * 60 * 60 * 1000,
          metadata:       { action: ctx.action, path: ctx.subject ?? null },
        },
      }
    }

    // Write: safe_low_risk_automation requires approval
    if (isWrite && ctx.autonomyLevel === 'safe_low_risk_automation') {
      return {
        ...base,
        verdict:   'require_approval',
        reason:    'File write requires approval at safe_low_risk_automation level',
        riskLevel: 'medium',
        approvalContext: {
          operationLabel: `Write: ${ctx.subject ?? ctx.action}`,
          risk:           'medium',
          expiresInMs:    4 * 60 * 60 * 1000,
          metadata:       { action: ctx.action, path: ctx.subject ?? null },
        },
      }
    }

    // Write: approval_required_execution and above → allow
    return { ...base, verdict: 'allow', reason: 'File write permitted at current autonomy level', riskLevel: 'medium' }
  },
}
