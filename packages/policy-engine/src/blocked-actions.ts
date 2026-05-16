/**
 * Blocked action record builder.
 * The engine builds these; callers persist them via event emission or DB insert.
 */
import { v7 as uuidv7 } from 'uuid'
import type { PolicyContext, PolicyResult, BlockedActionData } from './types.js'

export function buildBlockedAction(
  ctx:    PolicyContext,
  result: PolicyResult,
): BlockedActionData {
  const base: BlockedActionData = {
    id:          uuidv7(),
    workspaceId: ctx.workspaceId,
    action:      ctx.action,
    reason:      result.reason,
    policyId:    result.policyId,
    policyName:  result.policyName,
    riskLevel:   result.riskLevel,
    blockedAt:   Date.now(),
    context:     result.blockedContext?.context ?? (ctx.metadata ?? {}),
  }
  if (ctx.subject !== undefined) base.subject = ctx.subject
  if (ctx.agentId !== undefined) base.agentId = ctx.agentId
  if (ctx.traceId !== undefined) base.traceId = ctx.traceId
  return base
}
