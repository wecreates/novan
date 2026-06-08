/**
 * R146.328 — public routes for R326+R327 brain ops.
 *
 * The admin loopback bridge isn't usable from the operator UI (uses
 * x-admin-token, loopback-only). These routes expose the same ops with
 * standard JWT/Bearer auth so the React UI can call them.
 *
 *   GET  /api/v1/setup/state
 *   POST /api/v1/setup/mark
 *   POST /api/v1/clarify/resolve
 *   GET  /api/v1/clarify/outcomes
 *   GET  /api/v1/capabilities
 *   GET  /api/v1/cost/forecast
 *   GET  /api/v1/cost/by-business
 *   POST /api/v1/relationships/upsert
 *   GET  /api/v1/relationships/recall
 *   GET  /api/v1/oauth/:connectorId/start
 *   GET  /api/v1/oauth/:connectorId/callback
 *   GET  /api/v1/timeline/today
 */
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { wsOf } from '../util/ws-of.js'

const r328PublicRoutes: FastifyPluginAsync = async (app) => {
  type AuthFn = (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  const authenticate = (app as unknown as { authenticate: AuthFn }).authenticate
  const gated = { onRequest: [authenticate] }

  // ─── Setup ────────────────────────────────────────────────────────
  app.get('/setup/state', gated, async (req, reply) => {
    const ws = wsOf(req)
    const { getSetupState } = await import('../services/r327-onboarding.js')
    return reply.send({ success: true, data: await getSetupState(ws) })
  })

  app.post<{ Body: { step?: string } }>('/setup/mark', gated, async (req, reply) => {
    const ws = wsOf(req)
    const step = req.body?.step
    if (!step) return reply.code(400).send({ success: false, error: 'step required' })
    const { markStep } = await import('../services/r327-onboarding.js')
    return reply.send({ success: true, data: await markStep(ws, step as 'persona' | 'firstGoal' | 'connector' | 'budget' | 'preview') })
  })

  // ─── Clarify outcomes ─────────────────────────────────────────────
  app.post<{ Body: { id?: string; answer?: string } }>('/clarify/resolve', gated, async (req, reply) => {
    const id     = String(req.body?.id ?? '').trim()
    const answer = String(req.body?.answer ?? '')
    if (!id) return reply.code(400).send({ success: false, error: 'id required' })
    const { clarifyResolve } = await import('../services/r328-extras.js')
    return reply.send({ success: true, data: await clarifyResolve({ id, answer }) })
  })

  app.get('/clarify/outcomes', gated, async (req, reply) => {
    const ws = wsOf(req)
    const { clarifyOutcomes } = await import('../services/r328-extras.js')
    return reply.send({ success: true, data: await clarifyOutcomes(ws) })
  })

  // ─── Capabilities ─────────────────────────────────────────────────
  app.get('/capabilities', gated, async (_req, reply) => {
    const { completenessReport, CAPABILITIES } = await import('../services/brain-completeness.js')
    return reply.send({ success: true, data: { report: completenessReport(), all: CAPABILITIES } })
  })

  // ─── Cost ─────────────────────────────────────────────────────────
  app.get<{ Querystring: { capUsd?: string } }>('/cost/forecast', gated, async (req, reply) => {
    const ws = wsOf(req)
    const { costForecast } = await import('../services/r327-misc.js')
    return reply.send({ success: true, data: await costForecast(ws, Number(req.query.capUsd ?? 5)) })
  })

  app.get<{ Querystring: { days?: string } }>('/cost/by-business', gated, async (req, reply) => {
    const ws = wsOf(req)
    const { costByBusiness } = await import('../services/r328-extras.js')
    return reply.send({ success: true, data: await costByBusiness(ws, Number(req.query.days ?? 30)) })
  })

  // ─── Relationships ────────────────────────────────────────────────
  app.post<{ Body: { kind?: string; name?: string; attrs?: Record<string, unknown> } }>('/relationships/upsert', gated, async (req, reply) => {
    const ws = wsOf(req)
    const kind = req.body?.kind
    const name = req.body?.name
    if (!kind || !name) return reply.code(400).send({ success: false, error: 'kind + name required' })
    const { relationshipUpsert } = await import('../services/r327-relationship-graph.js')
    return reply.send({ success: true, data: await relationshipUpsert({
      workspaceId: ws, kind: kind as 'person' | 'business' | 'vendor' | 'partner' | 'team' | 'other',
      name, ...(req.body?.attrs ? { attrs: req.body.attrs } : {}),
    })})
  })

  app.get<{ Querystring: { q?: string; limit?: string } }>('/relationships/recall', gated, async (req, reply) => {
    const ws = wsOf(req)
    const { relationshipRecall } = await import('../services/r327-relationship-graph.js')
    return reply.send({ success: true, data: await relationshipRecall({
      workspaceId: ws, query: req.query.q ?? '', limit: Number(req.query.limit ?? 10),
    })})
  })

  // ─── Timeline ─────────────────────────────────────────────────────
  app.get<{ Querystring: { hours?: string; narrative?: string } }>('/timeline/today', gated, async (req, reply) => {
    const ws    = wsOf(req)
    const hours = Number(req.query.hours ?? 24)
    if (req.query.narrative === '1') {
      const { summarizeTimeline } = await import('../services/r328-extras.js')
      return reply.send({ success: true, data: await summarizeTimeline(ws, hours) })
    }
    const { whatDidYouDo } = await import('../services/r327-misc.js')
    return reply.send({ success: true, data: await whatDidYouDo(ws, hours) })
  })

  // ─── OAuth ────────────────────────────────────────────────────────
  app.get<{ Params: { connectorId: string } }>('/oauth/:connectorId/start', gated, async (req, reply) => {
    const ws = wsOf(req)
    const { startFlow } = await import('../services/r328-connectors.js')
    const base = process.env['NOVAN_PUBLIC_URL'] ?? `https://${req.headers.host}`
    const r = startFlow({ connectorId: req.params.connectorId, workspaceId: ws, redirectBase: base })
    if (!r.ok) return reply.code(400).send({ success: false, error: r.reason })
    return reply.send({ success: true, data: { redirectUrl: r.redirectUrl, state: r.state } })
  })

  // Callback is intentionally NOT auth-gated — the provider redirects the
  // operator's browser here without a Novan auth header. Workspace identity
  // is recovered from the signed `state` param.
  app.get<{ Params: { connectorId: string }; Querystring: { code?: string; state?: string; error?: string } }>(
    '/oauth/:connectorId/callback',
    async (req, reply) => {
      const { code, state, error } = req.query
      if (error) return reply.code(400).type('text/html').send(`<html><body>OAuth error: ${error}</body></html>`)
      if (!code || !state) return reply.code(400).send({ success: false, error: 'code + state required' })
      const { verifyState, exchangeCode } = await import('../services/r328-connectors.js')
      const v = verifyState(state)
      if (!v.ok || !v.workspaceId) return reply.code(400).send({ success: false, error: 'invalid state' })
      const base = process.env['NOVAN_PUBLIC_URL'] ?? `https://${req.headers.host}`
      const ex = await exchangeCode({
        connectorId: req.params.connectorId,
        code,
        redirectBase: base,
        ...(v.codeVerifier ? { codeVerifier: v.codeVerifier } : {}),
      })
      if (!ex.ok) return reply.code(400).type('text/html').send(`<html><body>OAuth exchange failed: ${ex.reason}</body></html>`)
      // Persist into secrets_vault + connector_credentials.
      // R332 fix: actual export is `storeSecret({workspaceId,name,value})`,
      // not `writeSecret(ws,key,value)`. Don't swallow errors — surface them
      // in the response so a silent vault failure doesn't return "Connected!"
      let persistError: string | null = null
      try {
        const { storeSecret } = await import('../services/secrets-vault.js')
        const baseName = `connector.${req.params.connectorId}.${v.workspaceId}.${Date.now()}`
        await storeSecret({
          workspaceId: v.workspaceId,
          name:        baseName,
          provider:    req.params.connectorId,
          value:       ex.accessToken ?? '',
          createdBy:   'oauth-callback',
        })
        if (ex.refreshToken) {
          await storeSecret({
            workspaceId: v.workspaceId,
            name:        `${baseName}.refresh`,
            provider:    req.params.connectorId,
            value:       ex.refreshToken,
            createdBy:   'oauth-callback',
          })
        }
        const { connectorCredCreate } = await import('../services/r327-misc.js')
        await connectorCredCreate({
          workspaceId: v.workspaceId,
          connectorId: req.params.connectorId,
          accountLabel: `operator@${req.params.connectorId}`,
          vaultKey:    baseName,
          scopes:      [],
          ...(ex.expiresIn ? { expiresAt: Date.now() + ex.expiresIn * 1000 } : {}),
        })
      } catch (e) {
        persistError = (e as Error).message.slice(0, 300)
        req.log.error({ err: persistError, connectorId: req.params.connectorId }, '[oauth-callback] persistence failed')
      }
      if (persistError) {
        return reply.code(500).type('text/html').send(`<html><body><h2>Almost there!</h2><p>Provider authorized, but Novan couldn't save the credential:</p><pre>${persistError}</pre><p>Operator can retry the OAuth flow once this is fixed.</p></body></html>`)
      }
      return reply.type('text/html').send(`<html><body><h2>Connected!</h2><p>You can close this tab.</p><script>setTimeout(()=>window.close(),1500)</script></body></html>`)
    },
  )

  // ─── Failover test ───────────────────────────────────────────────
  app.post('/chat/failover-test', gated, async (req, reply) => {
    const ws = wsOf(req)
    const { chatFailoverTest } = await import('../services/r328-extras.js')
    return reply.send({ success: true, data: await chatFailoverTest(ws) })
  })
}

export default r328PublicRoutes
