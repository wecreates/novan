/**
 * Browser routes — web-capture task submission + session queries.
 *
 * POST /api/v1/browser/tasks          — submit a web-capture task
 * GET  /api/v1/browser/sessions       — list recent sessions for workspace
 * GET  /api/v1/browser/sessions/:id   — get session detail with actions
 */
import type { FastifyPluginAsync } from 'fastify'
import { z }                       from 'zod'
import { v7 as uuidv7 }            from 'uuid'
import { desc, eq, and }           from 'drizzle-orm'
import { db }                      from '../db/client.js'
import { browserSessions, browserActions } from '../db/schema.js'
import { queues }                  from '../queues/index.js'
import {
  evaluatePolicy,
  extractActionCategory,
} from '@ops/policy-engine'
import type { AutonomyLevel }      from '@ops/policy-engine'
import type { WorkspaceId }        from '@ops/shared-types'
import { isInternalHost }          from '../services/image-storage.js'

// ─── Validation helpers ───────────────────────────────────────────────────────

// R146.45 — broadened blocklist + reuses isInternalHost from R146.37
// (image-storage SSRF defense). Previous local check missed:
//   - internal Docker hostnames (novan-redis-1, novan-postgres-1, etc)
//   - .local / .internal TLDs
//   - IPv6 loopback + link-local + ULA (::1, fe80::/10, fc00::/7)
//   - full 127.0.0.0/8 (not just 127.0.0.1)
//   - 0.0.0.0/8 reserved range
// Also explicitly rejects non-http(s) schemes (file:, gopher:, data:)
// which Playwright will happily navigate.
function isBlockedUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true
    // Empty hostname (e.g. file:///path) is unreachable yet doesn't match
    // any blocklist entry — reject explicitly.
    if (!parsed.hostname) return true
    // Defer to the shared SSRF predicate (R146.37 image-storage).
    return isInternalHost(parsed.hostname)
  } catch {
    return true
  }
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const WebCaptureSchema = z.object({
  url:   z.string().url(),
  label: z.string().default('capture'),
  autonomyLevel: z.enum([
    'observe_only',
    'approval_required_execution',
    'restricted_supervised_orchestration',
  ]).default('approval_required_execution'),
})

// ─── Routes ───────────────────────────────────────────────────────────────────

export const browserRoutes: FastifyPluginAsync = async (app) => {

  // POST /tasks — submit a web-capture task
  app.post('/tasks', {
    onRequest: [app.authenticate],
    // Each task spawns a Playwright session — expensive, cap at 15/min.
    config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const workspaceId = req.workspaceId as WorkspaceId
    const parsed = WebCaptureSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({
        success: false, error: 'Invalid request body',
        details: parsed.error.flatten().fieldErrors,
        code: 'VALIDATION_ERROR', requestId: req.id,
      })
    }

    const { url, label, autonomyLevel } = parsed.data

    if (isBlockedUrl(url)) {
      return reply.status(400).send({
        success: false, error: 'URL refers to a blocked host',
        code: 'BLOCKED_URL', requestId: req.id,
      })
    }

    // Policy check
    const traceId = uuidv7()
    const policyCtx = {
      workspaceId,
      action:         'browser.navigate',
      actionCategory: extractActionCategory('browser.navigate'),
      subject:        url,
      autonomyLevel:  autonomyLevel as AutonomyLevel,
      traceId,
      targetDomain:   new URL(url).hostname,
      requestedBy:    req.userId,
    }

    const report = evaluatePolicy(policyCtx)

    if (report.verdict === 'deny') {
      return reply.status(403).send({
        success: false,
        error:   `Action blocked by policy: ${report.decidingPolicy.reason}`,
        code:    'POLICY_DENIED',
        policy:  report.decidingPolicy.policyId,
        requestId: req.id,
      })
    }

    if (report.verdict === 'require_approval') {
      // Return 202 — browser job queued only after human approval
      return reply.status(202).send({
        success: true,
        status:  'approval_required',
        traceId,
        approval: {
          operationLabel: report.approvalRequest?.operationLabel ?? `Capture ${url}`,
          risk:           report.approvalRequest?.risk ?? report.decidingPolicy.riskLevel,
          policyId:       report.decidingPolicy.policyId,
          expiresAt:      report.approvalRequest?.expiresAt,
        },
        message: 'This action requires human approval before executing.',
      })
    }

    // Allow — enqueue immediately
    const jobId = uuidv7()
    await queues.browser.add('web-capture', {
      jobId,
      workspaceId,
      traceId,
      url,
      label,
      autonomyLevel,
    }, {
      jobId,
      priority: 2,
    })

    return reply.status(202).send({
      success:   true,
      status:    'queued',
      jobId,
      traceId,
      url,
    })
  })

  // GET /sessions — list recent sessions
  app.get('/sessions', { onRequest: [app.authenticate] }, async (req, reply) => {
    const workspaceId = req.workspaceId as WorkspaceId

    const sessions = await db
      .select()
      .from(browserSessions)
      .where(eq(browserSessions.workspaceId, workspaceId))
      .orderBy(desc(browserSessions.startedAt))
      .limit(20)

    return reply.send({ success: true, data: sessions })
  })

  // GET /sessions/:id — session detail with actions
  app.get('/sessions/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id }      = req.params as { id: string }
    const workspaceId = req.workspaceId as WorkspaceId

    const [session] = await db
      .select()
      .from(browserSessions)
      .where(and(
        eq(browserSessions.id, id),
        eq(browserSessions.workspaceId, workspaceId),
      ))

    if (!session) {
      return reply.status(404).send({
        success: false, error: 'Session not found',
        code: 'NOT_FOUND', requestId: req.id,
      })
    }

    const actions = await db
      .select()
      .from(browserActions)
      .where(eq(browserActions.sessionId, id))
      .orderBy(browserActions.executedAt)

    return reply.send({ success: true, data: { ...session, actions } })
  })
}
