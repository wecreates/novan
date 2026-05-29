/**
 * Connectors routes — /api/v1/connectors/*
 * Registry, accounts, action runtime, approval queue.
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  listConnectors, getConnector,
  listAccounts, getAccount, createAccount, updateAccountStatus, setAccountPermission,
  dispatchAction, approveAction, rejectAction,
  listActions, listPendingApprovals,
  getKillSwitch, setKillSwitch,
  type Permission, type ActionPhase,
} from '../services/connectors.js'
import { parseIntent } from '../services/connector-intent.js'
import { buildStart, completeCallback, OAUTH_PROVIDERS, type StartInput } from '../services/connector-oauth.js'
import type { Permission as OauthPermission } from '../services/connectors.js'

const connectorsRoutes: FastifyPluginAsync = async (fastify) => {

  // ── Registry ───────────────────────────────────────────────────────
  fastify.get('/', async () => ({ success: true, data: await listConnectors() }))
  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = await getConnector(req.params.id)
    if (!row) return reply.code(404).send({ success: false, error: 'connector not found' })
    return { success: true, data: row }
  })

  // ── Accounts ───────────────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/accounts', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await listAccounts(ws) }
  })

  fastify.get<{ Params: { id: string }; Querystring: { workspace_id?: string } }>('/accounts/:id', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const row = await getAccount(ws, req.params.id)
    if (!row) return reply.code(404).send({ success: false, error: 'account not found' })
    return { success: true, data: row }
  })

  fastify.post<{
    Body: {
      workspace_id?: string
      connector_id?: string
      label?: string
      external_account?: string
      secret_ref?: string
      granted_scopes?: string[]
      permission?: string
      metadata?: Record<string, unknown>
      created_by?: string
    }
  }>('/accounts', { onRequest: [fastify.authenticate] }, async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.connector_id || !b.label) {
      return reply.code(400).send({ success: false, error: 'workspace_id, connector_id, label required' })
    }
    try {
      const row = await createAccount({
        workspaceId: b.workspace_id,
        connectorId: b.connector_id,
        label:       b.label,
        ...(b.external_account ? { externalAccount: b.external_account } : {}),
        ...(b.secret_ref       ? { secretRef:       b.secret_ref } : {}),
        ...(b.granted_scopes   ? { grantedScopes:   b.granted_scopes } : {}),
        ...(b.permission       ? { permission:      b.permission as Permission } : {}),
        ...(b.metadata         ? { metadata:        b.metadata } : {}),
        ...(b.created_by       ? { createdBy:       b.created_by } : {}),
      })
      return reply.code(201).send({ success: true, data: row })
    } catch (e) {
      return reply.code(400).send({ success: false, error: (e as Error).message })
    }
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; status?: string } }>('/accounts/:id/status', { onRequest: [fastify.authenticate] }, async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.status) return reply.code(400).send({ success: false, error: 'workspace_id, status required' })
    const row = await updateAccountStatus(b.workspace_id, req.params.id, b.status as 'active'|'paused'|'revoked'|'expired')
    if (!row) return reply.code(404).send({ success: false, error: 'account not found' })
    return { success: true, data: row }
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; permission?: string } }>('/accounts/:id/permission', { onRequest: [fastify.authenticate] }, async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.permission) return reply.code(400).send({ success: false, error: 'workspace_id, permission required' })
    const row = await setAccountPermission(b.workspace_id, req.params.id, b.permission as Permission)
    if (!row) return reply.code(404).send({ success: false, error: 'account not found' })
    return { success: true, data: row }
  })

  // ── Actions ────────────────────────────────────────────────────────

  fastify.post<{
    Body: {
      workspace_id?: string
      account_id?:   string
      action?:       string
      intent?:       string
      params?:       Record<string, unknown>
      initiated_by?: string
      correlation_id?: string
    }
  }>('/actions/dispatch', { onRequest: [fastify.authenticate] }, async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.account_id || !b.action || !b.intent) {
      return reply.code(400).send({ success: false, error: 'workspace_id, account_id, action, intent required' })
    }
    const r = await dispatchAction({
      workspaceId:  b.workspace_id,
      accountId:    b.account_id,
      action:       b.action,
      intent:       b.intent,
      params:       b.params ?? {},
      ...(b.initiated_by    ? { initiatedBy:   b.initiated_by } : {}),
      ...(b.correlation_id  ? { correlationId: b.correlation_id } : {}),
    })
    // Status codes:
    //   200 completed / awaiting_approval (action accepted)
    //   409 blocked (hard rules)
    //   422 failed (handler missing / config error)
    const code = r.phase === 'completed' || r.phase === 'awaiting_approval' ? 200
              : r.phase === 'blocked'                                       ? 409
              :                                                               422
    return reply.code(code).send({ success: code === 200, data: r })
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; approver?: string } }>('/actions/:id/approve', { onRequest: [fastify.authenticate] }, async (req, reply) => {
    const b = req.body
    if (!b.workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const r = await approveAction(b.workspace_id, req.params.id, b.approver ?? 'operator')
    const code = r.phase === 'completed' ? 200 : r.phase === 'awaiting_approval' ? 409 : 422
    return reply.code(code).send({ success: code === 200, data: r })
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; by?: string; reason?: string } }>('/actions/:id/reject', { onRequest: [fastify.authenticate] }, async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.reason) return reply.code(400).send({ success: false, error: 'workspace_id, reason required' })
    const row = await rejectAction(b.workspace_id, req.params.id, b.by ?? 'operator', b.reason)
    if (!row) return reply.code(404).send({ success: false, error: 'action not found' })
    return { success: true, data: row }
  })

  fastify.get<{ Querystring: { workspace_id?: string; phase?: string; limit?: string } }>('/actions', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await listActions(ws, {
      ...(req.query.phase ? { phase: req.query.phase as ActionPhase } : {}),
      ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
    }) }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/approvals/pending', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await listPendingApprovals(ws) }
  })

  // ── Kill switch ────────────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/kill-switch', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await getKillSwitch(ws) }
  })

  fastify.post<{
    Body: {
      workspace_id?: string
      all_blocked?:  boolean
      category_blocked?:  string[]
      connector_blocked?: string[]
      reason?: string | null
      by?: string
    }
  }>('/kill-switch', { onRequest: [fastify.authenticate] }, async (req, reply) => {
    const b = req.body
    if (!b.workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const patch: Parameters<typeof setKillSwitch>[1] = {}
    if (b.all_blocked       !== undefined) patch.allBlocked       = b.all_blocked
    if (b.category_blocked  !== undefined) patch.categoryBlocked  = b.category_blocked
    if (b.connector_blocked !== undefined) patch.connectorBlocked = b.connector_blocked
    if (b.reason            !== undefined) patch.reason           = b.reason
    return { success: true, data: await setKillSwitch(b.workspace_id, patch, b.by ?? 'operator') }
  })

  // ── Intent parser — non-destructive helper ─────────────────────────
  // Returns what the natural-language intent maps to. Does NOT execute.
  fastify.post<{ Body: { text?: string } }>('/intent/parse', { onRequest: [fastify.authenticate] }, async (req, reply) => {
    if (!req.body.text) return reply.code(400).send({ success: false, error: 'text required' })
    const m = parseIntent(req.body.text)
    return { success: true, data: m }
  })

  // ── OAuth flow ─────────────────────────────────────────────────────
  // GET  /oauth/providers          → which connectors support OAuth + readiness (env vars set?)
  // POST /oauth/start              → { state, authorizeUrl }
  // GET  /oauth/callback?code&state → exchange code, store tokens, create account

  fastify.get('/oauth/providers', async () => {
    const list = Object.values(OAUTH_PROVIDERS).map(p => ({
      connectorId: p.connectorId,
      authorizationUrl: p.authorizationUrl,
      defaultScopes:    p.defaultScopes,
      // "ready" only when both env vars are set — surfaced to UI
      ready: Boolean(process.env[p.clientIdEnv] && process.env[p.clientSecretEnv]),
      clientIdEnv:     p.clientIdEnv,
      clientSecretEnv: p.clientSecretEnv,
    }))
    return { success: true, data: list }
  })

  fastify.post<{
    Body: {
      workspace_id?: string
      connector_id?: string
      label?:        string
      scopes?:       string[]
      permission?:   string
      operator_id?:  string
    }
  }>('/oauth/start', { onRequest: [fastify.authenticate] }, async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.connector_id || !b.label) {
      return reply.code(400).send({ success: false, error: 'workspace_id, connector_id, label required' })
    }
    const apiBaseUrl = `${req.protocol}://${req.headers.host}`
    try {
      const r = buildStart({
        workspaceId: b.workspace_id,
        connectorId: b.connector_id,
        label:       b.label,
        ...(b.scopes      ? { scopes:     b.scopes } : {}),
        ...(b.permission  ? { permission: b.permission as OauthPermission } : {}),
        ...(b.operator_id ? { operatorId: b.operator_id } : {}),
        apiBaseUrl,
      } as StartInput)
      return { success: true, data: r }
    } catch (e) {
      return reply.code(400).send({ success: false, error: (e as Error).message })
    }
  })

  // Escape user-supplied text before interpolating into the OAuth callback
  // HTML responses. The provider can redirect with an arbitrary `error` /
  // `error_description` querystring, and the error path interpolates the
  // thrown Error message — both are untrusted relative to the operator's
  // browser session. Without escaping, an attacker who controls the OAuth
  // redirect URL (or coerces a victim into clicking one) can land XSS on
  // the Novan origin.
  const esc = (s: string) => s.replace(/[&<>"']/g, ch => (
    ch === '&' ? '&amp;' :
    ch === '<' ? '&lt;' :
    ch === '>' ? '&gt;' :
    ch === '"' ? '&quot;' :
                 '&#39;'
  ))
  fastify.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>('/oauth/callback', async (req, reply) => {
    if (req.query.error) {
      return reply.type('text/html').send(`<h1>OAuth error</h1><p>${esc(req.query.error)}</p><p>${esc(req.query.error_description ?? '')}</p>`)
    }
    if (!req.query.code || !req.query.state) {
      return reply.code(400).send({ success: false, error: 'code and state required' })
    }
    const apiBaseUrl = `${req.protocol}://${req.headers.host}`
    try {
      const r = await completeCallback({ code: req.query.code, state: req.query.state, apiBaseUrl })
      // Return a tiny HTML page so the operator's browser sees a friendly
      // "connection complete" message after the provider redirect.
      return reply.type('text/html').send(
        `<!doctype html><html><body style="font-family:system-ui;padding:40px;max-width:500px;margin:auto">
         <h2>Connected ✓</h2>
         <p>Novan can now use your <strong>${esc(r.connectorId)}</strong> account
         "${r.workspaceId ? esc(r.connectorId) : ''}" with scopes:
         <code>${esc(r.scopesGranted.join(', '))}</code></p>
         <p>You can close this tab and return to Novan.</p>
         </body></html>`,
      )
    } catch (e) {
      return reply.code(400).type('text/html').send(
        `<!doctype html><html><body style="font-family:system-ui;padding:40px">
         <h2>OAuth failed</h2><p><code>${esc((e as Error).message)}</code></p></body></html>`,
      )
    }
  })
}

export default connectorsRoutes
