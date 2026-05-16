/**
 * Autonomy level definitions and permission maps.
 */
import type { AutonomyLevel, RiskLevel } from './types.js'

export interface AutonomyPermissions {
  canRead:                boolean
  canRecommend:           boolean
  canExecuteLowRisk:      boolean
  canExecuteWithApproval: boolean
  canOrchestrate:         boolean
  maxAutoRiskLevel:       RiskLevel  // max risk level allowed without approval
}

export const AUTONOMY_PERMISSIONS: Record<AutonomyLevel, AutonomyPermissions> = {
  observe_only: {
    canRead: true, canRecommend: false, canExecuteLowRisk: false,
    canExecuteWithApproval: false, canOrchestrate: false, maxAutoRiskLevel: 'low',
  },
  recommend_only: {
    canRead: true, canRecommend: true, canExecuteLowRisk: false,
    canExecuteWithApproval: false, canOrchestrate: false, maxAutoRiskLevel: 'low',
  },
  safe_low_risk_automation: {
    canRead: true, canRecommend: true, canExecuteLowRisk: true,
    canExecuteWithApproval: false, canOrchestrate: false, maxAutoRiskLevel: 'low',
  },
  approval_required_execution: {
    canRead: true, canRecommend: true, canExecuteLowRisk: true,
    canExecuteWithApproval: true, canOrchestrate: false, maxAutoRiskLevel: 'medium',
  },
  restricted_supervised_orchestration: {
    canRead: true, canRecommend: true, canExecuteLowRisk: true,
    canExecuteWithApproval: true, canOrchestrate: true, maxAutoRiskLevel: 'high',
  },
}

/** Return true if this autonomy level can auto-execute at the given risk level. */
export function canAutoExecute(level: AutonomyLevel, risk: RiskLevel): boolean {
  const perms = AUTONOMY_PERMISSIONS[level]
  const riskOrder: RiskLevel[] = ['low', 'medium', 'high', 'critical']
  const maxIdx  = riskOrder.indexOf(perms.maxAutoRiskLevel)
  const riskIdx = riskOrder.indexOf(risk)
  return riskIdx <= maxIdx && perms.canExecuteLowRisk
}

/** Return true if this level can execute at all (with or without approval). */
export function canExecute(level: AutonomyLevel): boolean {
  return AUTONOMY_PERMISSIONS[level].canExecuteLowRisk || AUTONOMY_PERMISSIONS[level].canExecuteWithApproval
}
