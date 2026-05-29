/**
 * brain-actions.ts — Safe action dispatch from the 3D Brain view.
 *
 * All brain actions are whitelisted + risk-gated. Destructive actions
 * require an explicit approval_token. Every action emits a runtime event.
 */
import { dispatch as dispatchAction, type ActionType } from './action-dispatcher.js'
import { setAgentPaused } from './trust-governance.js'
import { setProposalStatus } from './code-writer.js'
import { db } from '../db/client.js'
import { events } from '../db/schema.js'
import { v7 as uuidv7 } from 'uuid'

type BrainActionId =
  | 'pause_agent' | 'resume_agent'
  | 'approve_proposal' | 'reject_proposal'
  | 'open_audit' | 'open_incident' | 'inspect_provider'
  | 'view_memory' | 'run_diagnostic' | 'focus_mission'
  | 'engage_kill_switch'

const RISK: Record<BrainActionId, 'low' | 'medium' | 'high' | 'critical'> = {
  pause_agent: 'medium', resume_agent: 'medium',
  approve_proposal: 'low', reject_proposal: 'low',
  open_audit: 'low', open_incident: 'low', inspect_provider: 'low',
  view_memory: 'low', run_diagnostic: 'low', focus_mission: 'low',
  engage_kill_switch: 'critical',
}

export interface BrainActionInput {
  workspaceId: string
  actionId:    BrainActionId
  nodeId:      string
  payload:     Record<string, unknown>
  approvalToken?: string
}

export interface BrainActionResult {
  ok: boolean
  status: 'executed' | 'blocked' | 'redirect'
  data?: Record<string, unknown>
  reason?: string
  redirectTo?: string
}

export async function performBrainAction(i: BrainActionInput): Promise<BrainActionResult> {
  const risk = RISK[i.actionId]
  if (!risk) return { ok: false, status: 'blocked', reason: `unknown action: ${i.actionId}` }

  // Critical actions require approval token
  if ((risk === 'critical' || risk === 'high') && i.approvalToken !== 'OPERATOR_APPROVED') {
    return { ok: false, status: 'blocked', reason: `${risk} risk: approval_token=OPERATOR_APPROVED required` }
  }

  // Emit attempt event
  await db.insert(events).values({
    id: uuidv7(), type: 'brain.action_attempted', workspaceId: i.workspaceId,
    payload: { actionId: i.actionId, nodeId: i.nodeId, risk },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'brain-actions', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[brain-actions]', e.message); return null })

  try {
    switch (i.actionId) {
      case 'pause_agent': {
        const name = String(i.payload['agentName'] ?? '')
        if (!name) return { ok: false, status: 'blocked', reason: 'agentName required' }
        await setAgentPaused(i.workspaceId, name, true, 'brain-action', 'paused via 3D brain')
        return { ok: true, status: 'executed', data: { paused: name } }
      }
      case 'resume_agent': {
        const name = String(i.payload['agentName'] ?? '')
        if (!name) return { ok: false, status: 'blocked', reason: 'agentName required' }
        await setAgentPaused(i.workspaceId, name, false, 'brain-action', 'resumed via 3D brain')
        return { ok: true, status: 'executed', data: { resumed: name } }
      }
      case 'approve_proposal': {
        const id = String(i.payload['proposalId'] ?? '')
        if (!id) return { ok: false, status: 'blocked', reason: 'proposalId required' }
        await setProposalStatus(i.workspaceId, id, 'approved')
        return { ok: true, status: 'executed', data: { approved: id } }
      }
      case 'reject_proposal': {
        const id = String(i.payload['proposalId'] ?? '')
        if (!id) return { ok: false, status: 'blocked', reason: 'proposalId required' }
        await setProposalStatus(i.workspaceId, id, 'rejected')
        return { ok: true, status: 'executed', data: { rejected: id } }
      }
      case 'engage_kill_switch': {
        const r = await dispatchAction({
          workspaceId: i.workspaceId, type: 'engage_kill_switch' as ActionType,
          payload: { ...i.payload, approvalToken: 'OPERATOR_APPROVED' },
          requestedBy: 'brain-action',
        })
        return { ok: r.status === 'succeeded', status: r.status === 'succeeded' ? 'executed' : 'blocked', data: (r as unknown as Record<string, unknown>) }
      }
      // Low-risk navigational actions: return a redirect path the UI can open
      case 'open_audit':       return { ok: true, status: 'redirect', redirectTo: '/audit-trail' }
      case 'open_incident':    return { ok: true, status: 'redirect', redirectTo: '/incidents' }
      case 'inspect_provider': return { ok: true, status: 'redirect', redirectTo: '/economy' }
      case 'view_memory':      return { ok: true, status: 'redirect', redirectTo: '/cognition' }
      case 'run_diagnostic':   return { ok: true, status: 'redirect', redirectTo: '/runtime' }
      case 'focus_mission':    return { ok: true, status: 'redirect', redirectTo: '/mission' }
    }
  } catch (e) {
    return { ok: false, status: 'blocked', reason: (e as Error).message }
  }
}
