/**
 * Launch Readiness Gate
 *
 * Checks all preconditions before a deployment is allowed.
 * All checks are wrapped in try/catch — errors become warn/fail, never throw.
 */

import { db }                        from '../db/client.js'
import { killSwitches, budgetCaps, providerConfigs, providerQuarantine, userProviderCreds } from '../db/schema.js'
import { eq, and, isNull }           from 'drizzle-orm'
import { computeHealthScore }        from './stability-monitor.js'
import { getRuntimeSettings }        from './runtime-mode.js'
import { getLatestSnapshot }         from '@ops/service-recovery'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GateCheck {
  name:     string
  status:   'pass' | 'fail' | 'warn' | 'skip'
  message:  string
  blocking: boolean
}

export interface ReadinessReport {
  ready:     boolean
  score:     number
  checks:    GateCheck[]
  blockers:  GateCheck[]
  warnings:  GateCheck[]
  checkedAt: number
}

// ─── Individual checks ────────────────────────────────────────────────────────

async function checkRuntimeHealth(workspaceId: string): Promise<{ check: GateCheck; report: Awaited<ReturnType<typeof computeHealthScore>> | null }> {
  try {
    const report = await computeHealthScore(workspaceId)
    const overall = report.overall
    let status: GateCheck['status']
    let blocking: boolean
    if (overall >= 70) {
      status = 'pass'; blocking = false
    } else if (overall >= 40) {
      status = 'warn'; blocking = false
    } else {
      status = 'fail'; blocking = true
    }
    return {
      report,
      check: { name: 'runtime_health', status, blocking, message: `Health score: ${overall}/100` },
    }
  } catch {
    return {
      report: null,
      check: { name: 'runtime_health', status: 'fail', blocking: true, message: 'Health score: 0/100' },
    }
  }
}

async function checkCriticalAlerts(report: Awaited<ReturnType<typeof computeHealthScore>> | null): Promise<GateCheck> {
  try {
    const alerts = report?.alerts ?? []
    const critical = alerts.filter(a => a.level === 'critical')
    if (critical.length === 0) {
      return { name: 'critical_alerts', status: 'pass', blocking: false, message: '0 critical alerts' }
    }
    return {
      name: 'critical_alerts',
      status: 'fail',
      blocking: true,
      message: `${critical.length} critical alert(s): ${critical[0]?.message ?? 'unknown'}`,
    }
  } catch {
    return { name: 'critical_alerts', status: 'fail', blocking: true, message: 'Could not evaluate critical alerts' }
  }
}

async function checkKillSwitches(workspaceId: string): Promise<GateCheck> {
  try {
    const rows = await db
      .select()
      .from(killSwitches)
      .where(and(eq(killSwitches.workspaceId, workspaceId), eq(killSwitches.enabled, true)))
    if (rows.length === 0) {
      return { name: 'kill_switches', status: 'pass', blocking: false, message: 'No active kill switches' }
    }
    const types = rows.map(r => r.switchType).join(', ')
    return {
      name: 'kill_switches',
      status: 'fail',
      blocking: true,
      message: `Active kill switches: ${types}`,
    }
  } catch {
    return { name: 'kill_switches', status: 'warn', blocking: false, message: 'Could not query kill switches' }
  }
}

async function checkBudgetGuards(workspaceId: string): Promise<GateCheck> {
  try {
    const rows = await db
      .select()
      .from(budgetCaps)
      .where(and(eq(budgetCaps.workspaceId, workspaceId), eq(budgetCaps.enabled, true)))
    if (rows.length > 0) {
      return { name: 'budget_guards', status: 'pass', blocking: false, message: `${rows.length} budget cap(s) configured` }
    }
    return {
      name: 'budget_guards',
      status: 'warn',
      blocking: false,
      message: 'No budget caps configured — unguarded spend risk',
    }
  } catch {
    return { name: 'budget_guards', status: 'warn', blocking: false, message: 'Could not query budget caps' }
  }
}

async function checkProviderAvailability(workspaceId: string): Promise<GateCheck> {
  try {
    const configs = await db
      .select()
      .from(providerConfigs)
      .where(and(eq(providerConfigs.workspaceId, workspaceId), eq(providerConfigs.enabled, true)))

    const quarantined = await db
      .select()
      .from(providerQuarantine)
      .where(and(eq(providerQuarantine.workspaceId, workspaceId), isNull(providerQuarantine.releasedAt)))

    const quarantinedIds = new Set(quarantined.map(q => q.providerId))
    const available = configs.filter(c => !quarantinedIds.has(c.providerId))

    if (available.length > 0) {
      return { name: 'provider_availability', status: 'pass', blocking: false, message: `${available.length} provider(s) available` }
    }
    return {
      name: 'provider_availability',
      status: 'warn',
      blocking: false,
      message: 'No enabled providers available',
    }
  } catch {
    return { name: 'provider_availability', status: 'warn', blocking: false, message: 'Could not evaluate provider availability' }
  }
}

async function checkRollbackAvailable(): Promise<GateCheck> {
  try {
    // Probe the snapshot service — if it resolves (even null), the service is up
    await getLatestSnapshot('__probe__')
    return { name: 'rollback_available', status: 'pass', blocking: false, message: 'Rollback service is available' }
  } catch {
    return { name: 'rollback_available', status: 'fail', blocking: true, message: 'Rollback service is unavailable' }
  }
}

async function checkCloudApiReadiness(workspaceId: string): Promise<GateCheck> {
  try {
    const settings = await getRuntimeSettings(workspaceId)
    if (settings.mode === 'cloud-api-only') {
      const creds = await db
        .select()
        .from(userProviderCreds)
        .where(and(eq(userProviderCreds.workspaceId, workspaceId), eq(userProviderCreds.enabled, true)))
      if (creds.length > 0) {
        return { name: 'cloud_api_readiness', status: 'pass', blocking: false, message: 'Cloud-API-Only mode: credentials configured' }
      }
      return {
        name: 'cloud_api_readiness',
        status: 'warn',
        blocking: false,
        message: 'Cloud-API-Only mode: no user credentials configured',
      }
    }
    return { name: 'cloud_api_readiness', status: 'pass', blocking: false, message: `Runtime mode: ${settings.mode}` }
  } catch {
    return { name: 'cloud_api_readiness', status: 'warn', blocking: false, message: 'Could not evaluate cloud API readiness' }
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function checkReadiness(workspaceId: string): Promise<ReadinessReport> {
  const { check: healthCheck, report: healthReport } = await checkRuntimeHealth(workspaceId)

  const checks: GateCheck[] = [
    healthCheck,
    await checkCriticalAlerts(healthReport),
    await checkKillSwitches(workspaceId),
    await checkBudgetGuards(workspaceId),
    await checkProviderAvailability(workspaceId),
    await checkRollbackAvailable(),
    await checkCloudApiReadiness(workspaceId),
  ]

  const passing = checks.filter(c => c.status === 'pass').length
  const score = Math.round((passing / checks.length) * 100)
  const blockers = checks.filter(c => c.blocking && c.status === 'fail')
  const warnings = checks.filter(c => c.status === 'warn')
  const ready = blockers.length === 0

  return { ready, score, checks, blockers, warnings, checkedAt: Date.now() }
}
