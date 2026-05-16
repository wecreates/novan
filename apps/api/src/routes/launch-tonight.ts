/**
 * Launch Tonight Routes — /api/v1/launch-tonight
 *
 * Safety flags : GET /flags  POST /flags  POST /tonight-mode/enable  POST /tonight-mode/disable
 * Providers    : POST /validate-providers
 * Checklist    : GET /checklist
 * Runtime      : GET /runtime-status
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  getSafetyFlags, setFlag, enableTonightMode, disableTonightMode,
}                            from '../services/safety-mode.js'
import type { SafetyFlagKey } from '../services/safety-mode.js'
import { validateProviders } from '../services/provider-validation.js'
import { runAudit, getLaunchLock } from '../services/production-readiness.js'
import { listSecurityAgents, getFindingStats } from '../services/security-team.js'
import { listAgents }        from '../services/orchestrator.js'
import { db }                from '../db/client.js'
import { events, incidents, failureMemory, sandboxSessions, agentRegistrations } from '../db/schema.js'
import { eq, and, gt }       from 'drizzle-orm'

const launchTonightRoutes: FastifyPluginAsync = async (fastify) => {

  // ── Safety flags ─────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/flags', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const data = await getSafetyFlags(ws)
    return { success: true, data }
  })

  fastify.post<{
    Body: { workspace_id?: string; key?: SafetyFlagKey; value?: boolean; actor?: string; note?: string }
  }>('/flags', async (req, reply) => {
    const { workspace_id, key, value, actor, note } = req.body
    if (!workspace_id || !key || value === undefined) {
      return reply.code(400).send({ success: false, error: 'workspace_id, key, value required' })
    }
    await setFlag(workspace_id, key, value, actor ?? 'ops-admin', note)
    const updated = await getSafetyFlags(workspace_id)
    return { success: true, data: updated }
  })

  fastify.post<{ Body: { workspace_id?: string; actor?: string } }>('/tonight-mode/enable', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    await enableTonightMode(ws, req.body.actor ?? 'ops-admin')
    const flags = await getSafetyFlags(ws)
    return { success: true, data: flags }
  })

  fastify.post<{
    Body: { workspace_id?: string; actor?: string; confirmation_code?: string }
  }>('/tonight-mode/disable', async (req, reply) => {
    const { workspace_id, actor, confirmation_code } = req.body
    if (!workspace_id || !confirmation_code) {
      return reply.code(400).send({ success: false, error: 'workspace_id and confirmation_code required' })
    }
    const result = await disableTonightMode(workspace_id, actor ?? 'ops-admin', confirmation_code)
    if (!result.ok) return reply.code(400).send({ success: false, error: result.reason })
    return { success: true, data: await getSafetyFlags(workspace_id) }
  })

  // ── Provider validation ──────────────────────────────────────────────────
  fastify.post<{ Body: { workspace_id?: string } }>('/validate-providers', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const data = await validateProviders(ws)
    return { success: true, data }
  })

  // ── Launch checklist (consolidated tonight readiness) ────────────────────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/checklist', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })

    const flags     = await getSafetyFlags(ws)
    const audit     = await runAudit(ws, 'launch-tonight-checklist')
    const lock      = await getLaunchLock(ws)
    const findings  = await getFindingStats(ws)
    const providers = await validateProviders(ws)

    // Tonight-mode-specific checks (in addition to production-readiness)
    const tonightChecks: Array<{ name: string; status: 'pass' | 'fail' | 'warn'; reason: string }> = []

    tonightChecks.push({
      name: 'tonight_mode_active',
      status: flags.tonightModeActive ? 'pass' : 'warn',
      reason: flags.tonightModeActive ? 'Tonight Mode is active — dangerous autonomy disabled' : 'Tonight Mode is OFF — dangerous autonomy may be enabled',
    })
    tonightChecks.push({
      name: 'autonomous_deploy_blocked',
      status: !flags.autonomousDeployAllowed ? 'pass' : 'warn',
      reason: !flags.autonomousDeployAllowed ? 'Autonomous deploy is blocked' : 'Autonomous deploy is ENABLED — risk for tonight',
    })
    tonightChecks.push({
      name: 'self_edit_loops_blocked',
      status: !flags.selfEditLoopsAllowed ? 'pass' : 'warn',
      reason: !flags.selfEditLoopsAllowed ? 'Self-edit loops are blocked' : 'Self-edit loops are ENABLED',
    })
    tonightChecks.push({
      name: 'destructive_migrations_blocked',
      status: !flags.destructiveMigrationsAllowed ? 'pass' : 'fail',
      reason: !flags.destructiveMigrationsAllowed ? 'Destructive migrations blocked' : 'CRITICAL: destructive migrations enabled',
    })
    tonightChecks.push({
      name: 'approval_gated_patches_enabled',
      status: flags.approvalGatedPatchesEnabled ? 'pass' : 'fail',
      reason: flags.approvalGatedPatchesEnabled ? 'Patch approvals enforced' : 'CRITICAL: approval gating disabled',
    })
    tonightChecks.push({
      name: 'failure_learning_enabled',
      status: flags.failureLearningEnabled ? 'pass' : 'warn',
      reason: flags.failureLearningEnabled ? 'Failure memory loop active' : 'Failure learning disabled',
    })
    tonightChecks.push({
      name: 'observability_enabled',
      status: flags.observabilityEnabled ? 'pass' : 'warn',
      reason: flags.observabilityEnabled ? 'Telemetry on' : 'Telemetry disabled',
    })
    tonightChecks.push({
      name: 'cron_scans_enabled',
      status: flags.cronScansEnabled ? 'pass' : 'warn',
      reason: flags.cronScansEnabled ? 'Background scans running' : 'Background scans paused',
    })
    tonightChecks.push({
      name: 'providers_reachable',
      status: providers.configuredCount === 0 ? 'warn'
        : providers.reachableCount === providers.configuredCount ? 'pass' : 'fail',
      reason: providers.configuredCount === 0
        ? 'No providers configured — set env API keys'
        : `${providers.reachableCount}/${providers.configuredCount} configured providers reachable`,
    })
    tonightChecks.push({
      name: 'security_team_no_blockers',
      status: findings.blocksLaunch === 0 ? 'pass' : 'fail',
      reason: findings.blocksLaunch === 0
        ? 'No security findings block launch'
        : `${findings.blocksLaunch} launch-blocking security finding(s)`,
    })

    const launchBlockers = tonightChecks.filter((c) => c.status === 'fail').map((c) => `${c.name}: ${c.reason}`)
    const readyToLaunch = launchBlockers.length === 0 && (!lock || !lock.locked || lock.overrideActive)

    return {
      success: true,
      data: {
        readyToLaunch,
        tonightModeActive: flags.tonightModeActive,
        launchBlockers,
        tonightChecks,
        productionReadinessAudit: {
          score:            audit.readinessScore,
          passedCount:      audit.passedCount,
          failedCount:      audit.failedCount,
          unverifiedCount:  audit.unverifiedCount,
          criticalBlockers: audit.criticalBlockers,
        },
        providerSummary: {
          configured: providers.configuredCount,
          reachable:  providers.reachableCount,
          probes:     providers.results,
        },
        securityFindings: findings,
        launchLock: lock,
        flags,
      },
    }
  })

  // ── Runtime status (live snapshot) ───────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/runtime-status', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })

    const since = Date.now() - 60 * 60_000  // last hour

    const [agents, secAgents, openInc, recentFailures, recentSandboxes, recentEvents] = await Promise.all([
      listAgents(ws),
      listSecurityAgents(),
      db.select({ id: incidents.id }).from(incidents).where(and(
        eq(incidents.workspaceId, ws), eq(incidents.status, 'open'),
      )).limit(100),
      db.select({ id: failureMemory.id, blocked: failureMemory.blocked })
        .from(failureMemory).where(and(
          eq(failureMemory.workspaceId, ws),
          gt(failureMemory.lastSeenAt, since),
        )).limit(100),
      db.select({ id: sandboxSessions.id, status: sandboxSessions.status })
        .from(sandboxSessions).where(and(
          eq(sandboxSessions.workspaceId, ws),
          gt(sandboxSessions.startedAt, since),
        )).limit(100),
      db.select({ id: events.id }).from(events).where(and(
        eq(events.workspaceId, ws), gt(events.createdAt, since),
      )).limit(500),
    ])

    const activeAgents = agents.filter((a) => a.status === 'idle' || a.status === 'busy').length
    const downAgents   = agents.filter((a) => a.status === 'down').length
    const sandboxOk    = recentSandboxes.filter((s) => s.status === 'complete').length
    const sandboxFail  = recentSandboxes.filter((s) => s.status === 'failed' || s.status === 'isolation_violation').length

    return {
      success: true,
      data: {
        windowMinutes:       60,
        eventsLastHour:      recentEvents.length,
        agents: {
          orchestratorActive: activeAgents,
          orchestratorDown:   downAgents,
          orchestratorTotal:  agents.length,
          securityTeamCount:  secAgents.length,
        },
        learningLoop: {
          failuresLastHour:        recentFailures.length,
          blockedSignatures:       recentFailures.filter((f) => f.blocked).length,
          loopActive:              true,  // wired in verification-engine + patch-executor + audit dispatch
        },
        sandbox: {
          completed:           sandboxOk,
          failed:              sandboxFail,
          totalLastHour:       recentSandboxes.length,
        },
        incidents: {
          openCount:           openInc.length,
        },
      },
    }
  })

  // ── Agent readiness summary (which agents are ready to act tonight) ──────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/agents-ready', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })

    const flags = await getSafetyFlags(ws)
    const orchestrationAgents = await db.select({
      id: agentRegistrations.id, agentName: agentRegistrations.agentName,
      status: agentRegistrations.status, capabilities: agentRegistrations.capabilities,
    }).from(agentRegistrations).where(eq(agentRegistrations.workspaceId, ws))

    const securityAgents = await listSecurityAgents()

    return {
      success: true,
      data: {
        orchestrationAgents: orchestrationAgents.map((a) => ({
          id: a.id, name: a.agentName, status: a.status,
          capabilities: a.capabilities,
          readyToAct: a.status === 'idle' || a.status === 'busy',
        })),
        securityAgents: securityAgents.map((a) => ({
          id: a.id, name: a.name, role: a.role, active: a.isActive,
          readyToScan: a.isActive,
        })),
        safetyConstraints: {
          autonomousDeploy:      flags.autonomousDeployAllowed,
          selfEditLoops:         flags.selfEditLoopsAllowed,
          destructiveMigrations: flags.destructiveMigrationsAllowed,
          autonomousDepsUpgrade: flags.autonomousDepsUpgradesAllowed,
          internetLearningSwarm: flags.internetLearningSwarmAllowed,
        },
      },
    }
  })
}

export default launchTonightRoutes
