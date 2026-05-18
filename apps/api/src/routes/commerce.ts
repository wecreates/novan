/**
 * Commerce + creative + trust + governance routes — /api/v1/commerce/*
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  requestSession, approveSession, endSession, recordBrowserEvent,
  registerAccount, pauseAccount, listAccounts,
  checkGovernor, draftSocialPost, publishSocialPost,
  createDesignConcept, createListing,
  recordTrendFinding, recentTrends, commerceWarRoom, notifyApprovalNeeded,
} from '../services/commerce-ops.js'
import {
  getTrustScore, adjustTrust, listTrustScores, autoDeriveTrust,
  setAgentPaused, listPausedAgents, recordOverride, recentOverrides,
  recentEthicalBlocks, ethicalBlocksSummary, alignmentReport, checkSovereignty,
  type SubjectType,
} from '../services/trust-governance.js'
import { checkPurchaseIntent, checkPublishContent, scoreSlop } from '../services/commerce-policy.js'

const commerceRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Browser sessions ─────────────────────────────────────────────────
  fastify.post<{ Body: { workspace_id?: string; platform?: string; account_ref?: string; scopes?: string[] } }>('/sessions', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.platform || !b.account_ref) return reply.code(400).send({ success: false, error: 'workspace_id, platform, account_ref required' })
    return reply.code(201).send({ success: true, data: await requestSession({
      workspaceId: b.workspace_id, platform: b.platform, accountRef: b.account_ref,
      scopes: b.scopes ?? [],
    }) })
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; by?: string } }>('/sessions/:id/approve', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    await approveSession(ws, req.params.id, req.body.by ?? 'operator')
    return { success: true }
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; status?: 'ended' | 'revoked' } }>('/sessions/:id/end', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    await endSession(ws, req.params.id, req.body.status ?? 'ended')
    return { success: true }
  })

  fastify.post<{
    Body: { workspace_id?: string; session_id?: string; event_type?: string; url?: string; action_text?: string; requires_confirm?: boolean; screenshot_path?: string }
  }>('/sessions/event', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.session_id || !b.event_type) return reply.code(400).send({ success: false, error: 'workspace_id, session_id, event_type required' })
    return { success: true, data: await recordBrowserEvent({
      workspaceId: b.workspace_id, sessionId: b.session_id,
      eventType: b.event_type as 'navigate' | 'click' | 'type' | 'screenshot' | 'wait' | 'confirm_required' | 'confirmed' | 'blocked',
      ...(b.url !== undefined ? { url: b.url } : {}),
      ...(b.action_text !== undefined ? { actionText: b.action_text } : {}),
      ...(b.requires_confirm !== undefined ? { requiresConfirm: b.requires_confirm } : {}),
      ...(b.screenshot_path !== undefined ? { screenshotPath: b.screenshot_path } : {}),
    }) }
  })

  // ── Account vault ─────────────────────────────────────────────────────
  fastify.post<{ Body: { workspace_id?: string; platform?: string; account_ref?: string; scopes?: string[]; vault_secret_id?: string } }>('/accounts', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.platform || !b.account_ref) return reply.code(400).send({ success: false, error: 'workspace_id, platform, account_ref required' })
    const id = await registerAccount(b.workspace_id, b.platform, b.account_ref, b.scopes ?? [], b.vault_secret_id)
    return reply.code(201).send({ success: true, data: { id } })
  })

  fastify.post<{ Body: { workspace_id?: string; platform?: string; account_ref?: string; paused?: boolean } }>('/accounts/pause', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.platform || !b.account_ref || typeof b.paused !== 'boolean') return reply.code(400).send({ success: false, error: 'workspace_id, platform, account_ref, paused required' })
    await pauseAccount(b.workspace_id, b.platform, b.account_ref, b.paused)
    return { success: true }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/accounts', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const rows = await listAccounts(ws)
    return { success: true, data: rows.map(a => ({ ...a, vaultSecretId: a.vaultSecretId ? '[REDACTED]' : null })) }
  })

  // ── Social posts ─────────────────────────────────────────────────────
  fastify.post<{ Body: { workspace_id?: string; platform?: string; account_ref?: string; body?: string; asset_refs?: string[] } }>('/social/draft', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.platform || !b.account_ref || !b.body) return reply.code(400).send({ success: false, error: 'workspace_id, platform, account_ref, body required' })
    return reply.code(201).send({ success: true, data: await draftSocialPost(b.workspace_id, b.platform, b.account_ref, b.body, b.asset_refs ?? []) })
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; by?: string } }>('/social/:id/publish', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const r = await publishSocialPost(ws, req.params.id, req.body.by ?? 'operator')
    if (!r.ok) return reply.code(400).send({ success: false, error: r.reason })
    return { success: true }
  })

  fastify.get<{ Querystring: { workspace_id?: string; platform?: string; account_ref?: string } }>('/social/governor', async (req, reply) => {
    const { workspace_id, platform, account_ref } = req.query
    if (!workspace_id || !platform || !account_ref) return reply.code(400).send({ success: false, error: 'workspace_id, platform, account_ref required' })
    return { success: true, data: await checkGovernor(workspace_id, platform, account_ref) }
  })

  // ── Design concepts ──────────────────────────────────────────────────
  fastify.post<{ Body: { workspace_id?: string; brief?: string; prompt?: string; trend_refs?: string[] } }>('/concepts', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.brief || !b.prompt) return reply.code(400).send({ success: false, error: 'workspace_id, brief, prompt required' })
    return reply.code(201).send({ success: true, data: await createDesignConcept(b.workspace_id, b.brief, b.prompt, b.trend_refs ?? []) })
  })

  // ── POD listings ─────────────────────────────────────────────────────
  fastify.post<{
    Body: { workspace_id?: string; platform?: string; title?: string; description?: string; tags?: string[]; concept_id?: string; asset_refs?: string[] }
  }>('/listings', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.platform || !b.title || !b.description) return reply.code(400).send({ success: false, error: 'workspace_id, platform, title, description required' })
    return reply.code(201).send({ success: true, data: await createListing(b.workspace_id, b.platform, b.title, b.description, b.tags ?? [], b.concept_id, b.asset_refs ?? []) })
  })

  // ── Trend findings ───────────────────────────────────────────────────
  fastify.post<{
    Body: { workspace_id?: string; source?: string; niche?: string; signal?: string; score?: number; confidence?: number; citations?: Array<{ url: string; title: string; capturedAt: number }> }
  }>('/trends', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.source || !b.niche || !b.signal) return reply.code(400).send({ success: false, error: 'workspace_id, source, niche, signal required' })
    const id = await recordTrendFinding({
      workspaceId: b.workspace_id, source: b.source, niche: b.niche, signal: b.signal,
      score: b.score ?? 0, confidence: b.confidence ?? 0, citations: b.citations ?? [],
    })
    return reply.code(201).send({ success: true, data: { id } })
  })

  fastify.get<{ Querystring: { workspace_id?: string; limit?: string } }>('/trends', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await recentTrends(ws, req.query.limit ? Number(req.query.limit) : 50) }
  })

  // ── War room ─────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/war-room', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await commerceWarRoom(ws) }
  })

  fastify.post<{ Body: { workspace_id?: string; subject?: string; body?: string } }>('/notify-approval', async (req, reply) => {
    const { workspace_id, subject, body } = req.body
    if (!workspace_id || !subject || !body) return reply.code(400).send({ success: false, error: 'workspace_id, subject, body required' })
    await notifyApprovalNeeded(workspace_id, subject, body)
    return { success: true }
  })

  // ── Policy probes (for clients to pre-check before submitting) ──────
  fastify.post<{ Body: { text?: string } }>('/policy/purchase-check', async (req, reply) => {
    if (!req.body.text) return reply.code(400).send({ success: false, error: 'text required' })
    return { success: true, data: checkPurchaseIntent(req.body.text) }
  })
  fastify.post<{ Body: { text?: string } }>('/policy/content-check', async (req, reply) => {
    if (!req.body.text) return reply.code(400).send({ success: false, error: 'text required' })
    return { success: true, data: checkPublishContent(req.body.text) }
  })
  fastify.post<{ Body: { text?: string } }>('/policy/slop-score', async (req, reply) => {
    if (!req.body.text) return reply.code(400).send({ success: false, error: 'text required' })
    return { success: true, data: scoreSlop(req.body.text) }
  })

  // ── Trust scores ─────────────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string; subject_type?: string } }>('/trust', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await listTrustScores(ws, {
      ...(req.query.subject_type ? { subjectType: req.query.subject_type as SubjectType } : {}),
    }) }
  })

  fastify.post<{ Body: { workspace_id?: string; subject_type?: string; subject_id?: string; delta?: number; reason?: string } }>('/trust/adjust', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.subject_type || !b.subject_id || typeof b.delta !== 'number' || !b.reason) return reply.code(400).send({ success: false, error: 'workspace_id, subject_type, subject_id, delta, reason required' })
    const next = await adjustTrust(b.workspace_id, b.subject_type as SubjectType, b.subject_id, b.delta, b.reason)
    return { success: true, data: { score: next } }
  })

  fastify.post<{ Body: { workspace_id?: string } }>('/trust/auto-derive', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await autoDeriveTrust(ws) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; subject_type?: string; subject_id?: string } }>('/trust/get', async (req, reply) => {
    const { workspace_id, subject_type, subject_id } = req.query
    if (!workspace_id || !subject_type || !subject_id) return reply.code(400).send({ success: false, error: 'workspace_id, subject_type, subject_id required' })
    return { success: true, data: { score: await getTrustScore(workspace_id, subject_type as SubjectType, subject_id) } }
  })

  // ── Governance — agent pause / override / ethical / alignment ───────
  fastify.post<{ Body: { workspace_id?: string; agent_name?: string; paused?: boolean; reason?: string; by?: string } }>('/governance/agent-pause', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.agent_name || typeof b.paused !== 'boolean') return reply.code(400).send({ success: false, error: 'workspace_id, agent_name, paused required' })
    await setAgentPaused(b.workspace_id, b.agent_name, b.paused, b.by ?? 'operator', b.reason)
    return { success: true }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/governance/paused-agents', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await listPausedAgents(ws) }
  })

  fastify.post<{
    Body: { workspace_id?: string; action_type?: string; subject_id?: string; original_status?: string; override_status?: string; operator_id?: string; reason?: string }
  }>('/governance/override', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.action_type || !b.original_status || !b.override_status) return reply.code(400).send({ success: false, error: 'workspace_id, action_type, original_status, override_status required' })
    const id = await recordOverride({
      workspaceId: b.workspace_id, actionType: b.action_type,
      ...(b.subject_id !== undefined ? { subjectId: b.subject_id } : {}),
      originalStatus: b.original_status, overrideStatus: b.override_status,
      ...(b.operator_id !== undefined ? { operatorId: b.operator_id } : {}),
      ...(b.reason !== undefined ? { reason: b.reason } : {}),
    })
    return reply.code(201).send({ success: true, data: { id } })
  })

  fastify.get<{ Querystring: { workspace_id?: string; limit?: string } }>('/governance/overrides', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await recentOverrides(ws, req.query.limit ? Number(req.query.limit) : 50) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; hours?: string } }>('/governance/ethical-blocks', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await recentEthicalBlocks(ws, req.query.hours ? Number(req.query.hours) : 24) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; hours?: string } }>('/governance/ethical-summary', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await ethicalBlocksSummary(ws, req.query.hours ? Number(req.query.hours) : 24) }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/governance/alignment', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await alignmentReport(ws) }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/governance/sovereignty', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await checkSovereignty(ws) }
  })
}

export default commerceRoutes
