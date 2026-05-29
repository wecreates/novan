/**
 * maintenance.ts — Read-only operator routes that surface the
 * self-maintaining + compliance + operational-readiness state.
 *
 *   GET /api/v1/compliance/controls          — SOC2 control catalog + summary
 *   GET /api/v1/operational-readiness        — 50-component catalog + summary
 *   GET /api/v1/lock-integrity/verdict       — Most recent lock-integrity check
 *   GET /api/v1/recovery-playbooks           — Playbook registry + summary
 *
 * All four are GET-only. State-changing ops (attestReadinessItem,
 * acknowledgeLockChange) live in their service modules and are exposed
 * via the existing op surface — this route file is purely for read.
 */
import type { FastifyPluginAsync } from 'fastify'

export const maintenanceRoutes: FastifyPluginAsync = async (app) => {

  // ─── Compliance / SOC2 ─────────────────────────────────────────────────────
  app.get('/compliance/controls', async (_req, reply) => {
    const { SOC2_CONTROLS, listControlsByCategory, controlSummary } =
      await import('../services/compliance-soc2.js')
    return reply.send({
      success: true,
      data: {
        controls: SOC2_CONTROLS,
        byCategory: listControlsByCategory(),
        summary: controlSummary(),
      },
    })
  })

  // ─── Operational readiness — 50-item catalog ──────────────────────────────
  app.get('/operational-readiness', async (_req, reply) => {
    const { listReadinessItems, summarizeReadiness } =
      await import('../services/operational-readiness.js')
    return reply.send({
      success: true,
      data: {
        items: listReadinessItems(),
        summary: summarizeReadiness(),
      },
    })
  })

  // ─── Lock integrity — most recent verdict ─────────────────────────────────
  app.get('/lock-integrity/verdict', async (_req, reply) => {
    const { runLockIntegrityCheck, LOCKED_PATHS } =
      await import('../services/lock-integrity.js')
    // Run on-demand. Fast — 9 sha256 hashes.
    const verdict = await runLockIntegrityCheck().catch((e: Error) => ({
      checked: LOCKED_PATHS.length, matches: 0,
      tampered: [], bootstrapped: [], missing: [],
      uncoveredCanonical: [],
      error: e.message,
    }))
    return reply.send({ success: true, data: { lockedPaths: LOCKED_PATHS, verdict } })
  })

  // ─── Recovery playbook registry ───────────────────────────────────────────
  app.get('/recovery-playbooks', async (_req, reply) => {
    const { PLAYBOOKS, playbookSummary } =
      await import('../services/recovery-playbook.js')
    return reply.send({
      success: true,
      data: {
        playbooks: PLAYBOOKS,
        summary: playbookSummary(),
      },
    })
  })
}

export default maintenanceRoutes
