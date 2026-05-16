/**
 * Approval request builder + lifecycle types.
 * The engine builds these; callers persist them to the approvals table.
 */
import { v7 as uuidv7 } from 'uuid'
import type { PolicyContext, PolicyResult, ApprovalRequestData } from './types.js'

export function buildApprovalRequest(
  ctx:    PolicyContext,
  result: PolicyResult,
): ApprovalRequestData {
  const ac = result.approvalContext
  const base: ApprovalRequestData = {
    id:             uuidv7(),
    workspaceId:    ctx.workspaceId,
    action:         ctx.action,
    operationLabel: ac?.operationLabel ?? ctx.action,
    risk:           ac?.risk           ?? result.riskLevel,
    context:        {
      ...(ac?.metadata ?? {}),
      autonomyLevel: ctx.autonomyLevel,
      metadata:      ctx.metadata ?? {},
    },
    expiresAt:  Date.now() + (ac?.expiresInMs ?? 24 * 60 * 60 * 1000),
    policyId:   result.policyId,
    policyName: result.policyName,
  }
  // exactOptionalPropertyTypes: only set if defined
  if (ctx.subject    !== undefined) base.subject    = ctx.subject
  if (ctx.requestedBy !== undefined) base.requestedBy = ctx.requestedBy
  if (ctx.agentId    !== undefined) base.agentId    = ctx.agentId
  if (ctx.traceId    !== undefined) base.traceId    = ctx.traceId
  return base
}

// ─── Approval lifecycle types ──────────────────────────────────────────────────

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired'

export interface ApprovalResolution {
  approvalId:  string
  status:      'approved' | 'denied'
  resolvedBy:  string
  resolvedAt:  number
  comment?:    string
}

/** Build the event payload for approval.approved */
export function buildApprovalApprovedEvent(
  approvalId:  string,
  workspaceId: string,
  resolvedBy:  string,
  traceId?:    string,
): Record<string, unknown> {
  return {
    approvalId, workspaceId, resolvedBy,
    traceId:   traceId ?? null,
    timestamp: Date.now(),
  }
}

/** Build the event payload for approval.denied */
export function buildApprovalDeniedEvent(
  approvalId:  string,
  workspaceId: string,
  resolvedBy:  string,
  reason?:     string,
  traceId?:    string,
): Record<string, unknown> {
  return {
    approvalId, workspaceId, resolvedBy,
    reason:    reason  ?? null,
    traceId:   traceId ?? null,
    timestamp: Date.now(),
  }
}
