/**
 * AI Router API — provider registry, remote endpoints, health, cost tracking,
 * budget guardrails, failure log, streaming, and proxied chat/embed.
 *
 * Endpoint management:
 *   GET    /endpoints                   — list remote endpoints
 *   POST   /endpoints                   — add remote endpoint
 *   PUT    /endpoints/:id               — update remote endpoint
 *   DELETE /endpoints/:id               — remove remote endpoint
 *   POST   /endpoints/:id/check         — manual health check
 *   POST   /endpoints/:id/discover      — model discovery
 *   POST   /endpoints/:id/test          — send test prompt (non-streaming)
 *   POST   /endpoints/:id/stream        — send test prompt (SSE streaming)
 *   POST   /endpoints/:id/pause         — soft-disable endpoint
 *   POST   /endpoints/:id/resume        — re-enable paused endpoint
 *   GET    /endpoints/:id/usage         — usage log for one endpoint
 *
 * Provider config, health, budget, chat, embed routes also present.
 */
import type { FastifyPluginAsync } from 'fastify'
import { v7 as uuidv7 } from 'uuid'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db }         from '../db/client.js'
import {
  events,
  providerConfigs,
  remoteEndpoints,
  providerHealthLog,
  providerFailures,
  providerBudgets,
  endpointUsageLogs,
} from '../db/schema.js'
import {
  chat, embed, getProviderHealth, getBudgetLimits, enabledProviders,
  checkEndpointHealth, discoverModels, remoteChat, remoteChatStream,
} from '@ops/ai-router'
import { encrypt, decrypt, encryptionAvailable } from '@ops/ai-router/encryption'
import type { RemoteEndpointConfig } from '@ops/ai-router'

// ─── helpers ──────────────────────────────────────────────────────────────────

const ws = (req: unknown) => ((req as { workspaceId?: string }).workspaceId ?? 'default')

async function emit(type: string, workspaceId: string, payload: unknown): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId,
    payload: payload as Record<string, unknown>,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/ai-router', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[ai-router]', e.message); return null })
}

/** Build a RemoteEndpointConfig from a DB row, decrypting credentials. */
function toEndpointConfig(row: typeof remoteEndpoints.$inferSelect): RemoteEndpointConfig {
  let apiKey: string | null = null
  let customHeaders: Record<string, string> | null = null

  if (row.apiKeyEncrypted && row.apiKeyIv && encryptionAvailable()) {
    try { apiKey = decrypt(row.apiKeyEncrypted, row.apiKeyIv) } catch { /* leave null */ }
  }
  if (row.customHeadersEncrypted && row.customHeadersIv && encryptionAvailable()) {
    try {
      customHeaders = JSON.parse(decrypt(row.customHeadersEncrypted, row.customHeadersIv)) as Record<string, string>
    } catch { /* leave null */ }
  }

  return {
    id:               row.id,
    name:             row.name,
    type:             row.type,
    baseUrl:          row.baseUrl,
    apiKey,
    customHeaders,
    modelIds:         row.modelIds,
    maxContextTokens: row.maxContextTokens,
    promptPer1kUsd:   row.promptPer1kUsd,
    outputPer1kUsd:   row.outputPer1kUsd,
    timeoutMs:        row.timeoutMs,
  }
}

/** Log a usage event for a remote endpoint (non-blocking). */
async function logEndpointUsage(row: {
  workspaceId: string; endpointId: string; model: string; taskType: string
  promptTokens: number; outputTokens: number; costUsd: number; latencyMs: number
  streamed: boolean; success: boolean; errorMessage?: string
}): Promise<void> {
  await db.insert(endpointUsageLogs).values({
    id: uuidv7(), ...row,
    createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[ai-router]', e.message); return null })
}

/** Upsert workspace budget row; create with defaults on first access. */
async function getOrCreateBudget(workspaceId: string) {
  const existing = await db.select().from(providerBudgets)
    .where(eq(providerBudgets.workspaceId, workspaceId))
    .limit(1)
  if (existing[0]) return existing[0]

  const now = Date.now()
  const dayEnd   = new Date(); dayEnd.setUTCHours(23, 59, 59, 999);
  const monthEnd = new Date(); monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 1); monthEnd.setUTCHours(0,0,0,0);

  const row = {
    id: uuidv7(), workspaceId,
    dailyLimitUsd: 10, weeklyLimitUsd: 0, monthlyLimitUsd: 100,
    dailySpendUsd: 0,  weeklySpendUsd: 0, monthlySpendUsd: 0,
    dailyResetAt:  dayEnd.getTime(),
    weeklyResetAt: null as number | null,
    monthlyResetAt: monthEnd.getTime(),
    alertThreshold: 0.8,
    maxPerJobUsd: 0, maxBrowserSessionSecs: 0, maxAiRequestSecs: 0,
    maxRetries: 10, maxConcurrentRemote: 5, hardStop: false,
    updatedAt: now,
  }
  await db.insert(providerBudgets).values(row).onConflictDoNothing()
  return row
}

/** Reset spend counters if their windows have elapsed. */
async function resetIfExpired(budget: typeof providerBudgets.$inferSelect) {
  const now = Date.now()
  let dailySpend    = budget.dailySpendUsd
  let monthlySpend  = budget.monthlySpendUsd
  let dailyReset    = budget.dailyResetAt
  let monthlyReset  = budget.monthlyResetAt
  let changed = false

  if (now > budget.dailyResetAt) {
    dailySpend = 0; dailyReset = (() => { const d = new Date(); d.setUTCHours(23,59,59,999); return d.getTime() })()
    changed = true
  }
  if (now > budget.monthlyResetAt) {
    monthlySpend = 0; monthlyReset = (() => { const d = new Date(); d.setUTCMonth(d.getUTCMonth()+1,1); d.setUTCHours(0,0,0,0); return d.getTime() })()
    changed = true
  }
  if (changed) {
    await db.update(providerBudgets)
      .set({ dailySpendUsd: dailySpend, monthlySpendUsd: monthlySpend, dailyResetAt: dailyReset, monthlyResetAt: monthlyReset, updatedAt: now })
      .where(eq(providerBudgets.workspaceId, budget.workspaceId))
    return { ...budget, dailySpendUsd: dailySpend, monthlySpendUsd: monthlySpend, dailyResetAt: dailyReset, monthlyResetAt: monthlyReset }
  }
  return budget
}

// ─── route plugin ─────────────────────────────────────────────────────────────

const aiRouterRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /providers ────────────────────────────────────────────────────────
  app.get('/providers', {
    schema: { tags: ['ai-router'], summary: 'List in-memory enabled providers + health' },
  }, async (_req, reply) => {
    const health    = await getProviderHealth()
    const providers = enabledProviders().map((p) => ({
      id:      p.id,
      baseUrl: p.baseUrl.replace(/\/v1$/, '').replace(/^https?:\/\/[^/]+/, '[redacted]'),
      models:  p.models.map((m) => ({
        modelId: m.modelId, displayName: m.displayName,
        promptPer1k: m.promptPer1k, outputPer1k: m.outputPer1k,
        taskAffinities: m.taskAffinities, supportsVision: m.supportsVision,
      })),
      health: health.find((h) => h.provider === p.id) ?? null,
    }))
    return reply.send({ success: true, data: { providers } })
  })

  // ── GET /configs ──────────────────────────────────────────────────────────
  app.get<{ Querystring: { workspace_id?: string } }>('/configs', {
    schema: { tags: ['ai-router'], summary: 'List workspace provider configs (keys redacted)' },
  }, async (req, reply) => {
    const workspaceId = req.query.workspace_id ?? ws(req)
    const rows = await db.select().from(providerConfigs)
      .where(eq(providerConfigs.workspaceId, workspaceId))
      .orderBy(providerConfigs.priority)
    const data = rows.map((r) => ({
      ...r,
      apiKeyEncrypted: undefined,
      apiKeyIv:        undefined,
      hasApiKey: !!(r.apiKeyEncrypted),
    }))
    return reply.send({ success: true, data })
  })

  // ── POST /configs ─────────────────────────────────────────────────────────
  app.post<{ Body: {
    workspace_id?:      string
    provider_id:        string
    label:              string
    api_key?:           string
    enabled?:           boolean
    priority?:          number
    max_cost_per_req_usd?: number
    notes?:             string
  } }>('/configs', {
    schema: {
      tags: ['ai-router'], summary: 'Add provider config',
      body: {
        type: 'object', required: ['provider_id', 'label'],
        properties: {
          workspace_id:        { type: 'string' },
          provider_id:         { type: 'string' },
          label:               { type: 'string' },
          api_key:             { type: 'string' },
          enabled:             { type: 'boolean' },
          priority:            { type: 'number' },
          max_cost_per_req_usd: { type: 'number' },
          notes:               { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const workspaceId = req.body.workspace_id ?? ws(req)
    const now = Date.now()
    let apiKeyEncrypted: string | undefined
    let apiKeyIv: string | undefined

    if (req.body.api_key) {
      if (!encryptionAvailable()) {
        return reply.status(500).send({ success: false, error: 'ENCRYPTION_KEY not configured' })
      }
      const enc = encrypt(req.body.api_key)
      apiKeyEncrypted = enc.ciphertext
      apiKeyIv        = enc.iv
    }

    const row = {
      id: uuidv7(), workspaceId,
      providerId:      req.body.provider_id,
      label:           req.body.label,
      apiKeyEncrypted: apiKeyEncrypted ?? null,
      apiKeyIv:        apiKeyIv        ?? null,
      enabled:         req.body.enabled  ?? true,
      priority:        req.body.priority ?? 50,
      maxCostPerReqUsd: req.body.max_cost_per_req_usd ?? null,
      notes:           req.body.notes ?? null,
      createdAt: now, updatedAt: now,
    }
    await db.insert(providerConfigs).values(row)

    await emit('provider.added', workspaceId, {
      configId: row.id, providerId: row.providerId, label: row.label,
      hasApiKey: !!apiKeyEncrypted, source: 'config',
    })

    return reply.status(201).send({ success: true, data: { id: row.id, hasApiKey: !!apiKeyEncrypted } })
  })

  // ── PUT /configs/:id ──────────────────────────────────────────────────────
  app.put<{
    Params: { id: string }
    Body: {
      label?:               string
      api_key?:             string
      enabled?:             boolean
      priority?:            number
      max_cost_per_req_usd?: number
      notes?:               string
    }
  }>('/configs/:id', {
    schema: { tags: ['ai-router'], summary: 'Update provider config' },
  }, async (req, reply) => {
    const workspaceId = ws(req)
    const scope = and(eq(providerConfigs.id, req.params.id), eq(providerConfigs.workspaceId, workspaceId))
    const existing = await db.select().from(providerConfigs).where(scope).limit(1)
    if (!existing[0]) return reply.status(404).send({ success: false, error: 'Not found' })

    const updates: Partial<typeof providerConfigs.$inferInsert> = { updatedAt: Date.now() }
    if (req.body.label     !== undefined) updates.label    = req.body.label
    if (req.body.enabled   !== undefined) updates.enabled  = req.body.enabled
    if (req.body.priority  !== undefined) updates.priority = req.body.priority
    if (req.body.notes     !== undefined) updates.notes    = req.body.notes
    if (req.body.max_cost_per_req_usd !== undefined) updates.maxCostPerReqUsd = req.body.max_cost_per_req_usd

    if (req.body.api_key) {
      if (!encryptionAvailable()) return reply.status(500).send({ success: false, error: 'ENCRYPTION_KEY not configured' })
      const enc = encrypt(req.body.api_key)
      updates.apiKeyEncrypted = enc.ciphertext
      updates.apiKeyIv        = enc.iv
    }

    await db.update(providerConfigs).set(updates).where(scope)
    return reply.send({ success: true })
  })

  // ── DELETE /configs/:id ───────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>('/configs/:id', {
    schema: { tags: ['ai-router'], summary: 'Remove provider config' },
  }, async (req, reply) => {
    const workspaceId = ws(req)
    await db.delete(providerConfigs).where(and(eq(providerConfigs.id, req.params.id), eq(providerConfigs.workspaceId, workspaceId)))
    return reply.send({ success: true })
  })

  // ── GET /endpoints ────────────────────────────────────────────────────────
  app.get<{ Querystring: { workspace_id?: string } }>('/endpoints', {
    schema: { tags: ['ai-router'], summary: 'List remote endpoints' },
  }, async (req, reply) => {
    const workspaceId = req.query.workspace_id ?? ws(req)
    const rows = await db.select().from(remoteEndpoints)
      .where(eq(remoteEndpoints.workspaceId, workspaceId))
      .orderBy(remoteEndpoints.priority)
    const data = rows.map((r) => ({
      ...r,
      apiKeyEncrypted: undefined,
      apiKeyIv:        undefined,
      hasApiKey: !!(r.apiKeyEncrypted),
    }))
    return reply.send({ success: true, data })
  })

  // ── POST /endpoints ───────────────────────────────────────────────────────
  app.post<{ Body: {
    workspace_id?:      string
    name:               string
    type:               string
    base_url:           string
    api_key?:           string
    custom_headers?:    Record<string, string>
    model_ids?:         string[]
    max_context_tokens?: number
    prompt_per_1k_usd?: number
    output_per_1k_usd?: number
    timeout_ms?:        number
    enabled?:           boolean
    priority?:          number
    notes?:             string
  } }>('/endpoints', {
    schema: {
      tags: ['ai-router'], summary: 'Add remote endpoint',
      body: {
        type: 'object', required: ['name', 'type', 'base_url'],
        properties: {
          workspace_id:       { type: 'string' },
          name:               { type: 'string' },
          type:               { type: 'string' },
          base_url:           { type: 'string' },
          api_key:            { type: 'string' },
          custom_headers:     { type: 'object' },
          model_ids:          { type: 'array', items: { type: 'string' } },
          max_context_tokens: { type: 'number' },
          prompt_per_1k_usd:  { type: 'number' },
          output_per_1k_usd:  { type: 'number' },
          timeout_ms:         { type: 'number' },
          enabled:            { type: 'boolean' },
          priority:           { type: 'number' },
          notes:              { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const workspaceId = req.body.workspace_id ?? ws(req)
    const now = Date.now()
    let apiKeyEncrypted: string | null = null
    let apiKeyIv: string | null = null
    let customHeadersEncrypted: string | null = null
    let customHeadersIv: string | null = null

    if (req.body.api_key) {
      if (!encryptionAvailable()) return reply.status(500).send({ success: false, error: 'ENCRYPTION_KEY not configured' })
      const enc = encrypt(req.body.api_key)
      apiKeyEncrypted = enc.ciphertext; apiKeyIv = enc.iv
    }
    if (req.body.custom_headers && Object.keys(req.body.custom_headers).length > 0) {
      if (!encryptionAvailable()) return reply.status(500).send({ success: false, error: 'ENCRYPTION_KEY not configured' })
      const enc = encrypt(JSON.stringify(req.body.custom_headers))
      customHeadersEncrypted = enc.ciphertext; customHeadersIv = enc.iv
    }

    const row = {
      id: uuidv7(), workspaceId,
      name:    req.body.name,
      type:    req.body.type,
      baseUrl: req.body.base_url,
      apiKeyEncrypted,        apiKeyIv,
      customHeadersEncrypted, customHeadersIv,
      modelIds:         req.body.model_ids          ?? [],
      maxContextTokens: req.body.max_context_tokens ?? 8192,
      promptPer1kUsd:   req.body.prompt_per_1k_usd  ?? 0,
      outputPer1kUsd:   req.body.output_per_1k_usd  ?? 0,
      timeoutMs:        req.body.timeout_ms          ?? 60_000,
      enabled:          req.body.enabled             ?? true,
      paused:           false,
      priority:         req.body.priority            ?? 10,
      healthStatus:     'unknown' as const,
      modelCount:       (req.body.model_ids ?? []).length,
      notes:            req.body.notes ?? null,
      createdAt: now, updatedAt: now,
    }
    await db.insert(remoteEndpoints).values(row)

    await emit('provider.added', workspaceId, {
      endpointId: row.id, name: row.name, type: row.type, baseUrl: row.baseUrl,
      hasApiKey: !!apiKeyEncrypted, source: 'endpoint',
    })

    return reply.status(201).send({ success: true, data: { id: row.id } })
  })

  // ── PUT /endpoints/:id ────────────────────────────────────────────────────
  app.put<{
    Params: { id: string }
    Body: {
      name?:               string
      base_url?:           string
      api_key?:            string
      custom_headers?:     Record<string, string>
      model_ids?:          string[]
      max_context_tokens?: number
      prompt_per_1k_usd?:  number
      output_per_1k_usd?:  number
      timeout_ms?:         number
      enabled?:            boolean
      priority?:           number
      notes?:              string
    }
  }>('/endpoints/:id', {
    schema: { tags: ['ai-router'], summary: 'Update remote endpoint' },
  }, async (req, reply) => {
    const workspaceId = ws(req)
    const scope = and(eq(remoteEndpoints.id, req.params.id), eq(remoteEndpoints.workspaceId, workspaceId))
    const existing = await db.select().from(remoteEndpoints).where(scope).limit(1)
    if (!existing[0]) return reply.status(404).send({ success: false, error: 'Not found' })

    const updates: Partial<typeof remoteEndpoints.$inferInsert> = { updatedAt: Date.now() }
    if (req.body.name               !== undefined) updates.name             = req.body.name
    if (req.body.base_url           !== undefined) updates.baseUrl          = req.body.base_url
    if (req.body.model_ids          !== undefined) { updates.modelIds = req.body.model_ids; updates.modelCount = req.body.model_ids.length }
    if (req.body.max_context_tokens !== undefined) updates.maxContextTokens = req.body.max_context_tokens
    if (req.body.prompt_per_1k_usd  !== undefined) updates.promptPer1kUsd   = req.body.prompt_per_1k_usd
    if (req.body.output_per_1k_usd  !== undefined) updates.outputPer1kUsd   = req.body.output_per_1k_usd
    if (req.body.timeout_ms         !== undefined) updates.timeoutMs        = req.body.timeout_ms
    if (req.body.enabled            !== undefined) updates.enabled          = req.body.enabled
    if (req.body.priority           !== undefined) updates.priority         = req.body.priority
    if (req.body.notes              !== undefined) updates.notes            = req.body.notes

    if (req.body.api_key) {
      if (!encryptionAvailable()) return reply.status(500).send({ success: false, error: 'ENCRYPTION_KEY not configured' })
      const enc = encrypt(req.body.api_key)
      updates.apiKeyEncrypted = enc.ciphertext; updates.apiKeyIv = enc.iv
    }
    if (req.body.custom_headers && Object.keys(req.body.custom_headers).length > 0) {
      if (!encryptionAvailable()) return reply.status(500).send({ success: false, error: 'ENCRYPTION_KEY not configured' })
      const enc = encrypt(JSON.stringify(req.body.custom_headers))
      updates.customHeadersEncrypted = enc.ciphertext; updates.customHeadersIv = enc.iv
    }

    await db.update(remoteEndpoints).set(updates).where(scope)
    return reply.send({ success: true })
  })

  // ── DELETE /endpoints/:id ─────────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>('/endpoints/:id', {
    schema: { tags: ['ai-router'], summary: 'Remove remote endpoint' },
  }, async (req, reply) => {
    const workspaceId = ws(req)
    await db.delete(remoteEndpoints).where(and(eq(remoteEndpoints.id, req.params.id), eq(remoteEndpoints.workspaceId, workspaceId)))
    return reply.send({ success: true })
  })

  // ── POST /endpoints/:id/pause ─────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/endpoints/:id/pause', {
    schema: { tags: ['ai-router'], summary: 'Pause (soft-disable) a remote endpoint' },
  }, async (req, reply) => {
    const ep = await db.select().from(remoteEndpoints).where(and(eq(remoteEndpoints.id, req.params.id), eq(remoteEndpoints.workspaceId, ws(req)))).limit(1)
    if (!ep[0]) return reply.status(404).send({ success: false, error: 'Not found' })
    await db.update(remoteEndpoints).set({ paused: true, updatedAt: Date.now() }).where(and(eq(remoteEndpoints.id, req.params.id), eq(remoteEndpoints.workspaceId, ws(req))))
    await emit('provider.health.checked', ep[0].workspaceId, { endpointId: req.params.id, status: 'paused', source: 'manual_pause' })
    return reply.send({ success: true, data: { paused: true } })
  })

  // ── POST /endpoints/:id/resume ────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/endpoints/:id/resume', {
    schema: { tags: ['ai-router'], summary: 'Resume a paused remote endpoint' },
  }, async (req, reply) => {
    const ep = await db.select().from(remoteEndpoints).where(and(eq(remoteEndpoints.id, req.params.id), eq(remoteEndpoints.workspaceId, ws(req)))).limit(1)
    if (!ep[0]) return reply.status(404).send({ success: false, error: 'Not found' })
    await db.update(remoteEndpoints).set({ paused: false, updatedAt: Date.now() }).where(and(eq(remoteEndpoints.id, req.params.id), eq(remoteEndpoints.workspaceId, ws(req))))
    return reply.send({ success: true, data: { paused: false } })
  })

  // ── POST /endpoints/:id/discover ──────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/endpoints/:id/discover', {
    schema: { tags: ['ai-router'], summary: 'Discover available models on a remote endpoint' },
  }, async (req, reply) => {
    const rows = await db.select().from(remoteEndpoints).where(and(eq(remoteEndpoints.id, req.params.id), eq(remoteEndpoints.workspaceId, ws(req)))).limit(1)
    if (!rows[0]) return reply.status(404).send({ success: false, error: 'Not found' })

    const epConfig = toEndpointConfig(rows[0])
    const now = Date.now()

    try {
      const discovered = await discoverModels(epConfig)
      const modelIds   = discovered.map((m) => m.id)

      await db.update(remoteEndpoints).set({
        modelIds,
        modelCount:         modelIds.length,
        lastModelDiscovery: now,
        lastDiscoveryError: null,
        updatedAt:          now,
      }).where(and(eq(remoteEndpoints.id, req.params.id), eq(remoteEndpoints.workspaceId, ws(req))))

      await emit('provider.health.checked', rows[0].workspaceId, {
        endpointId: req.params.id, name: rows[0].name,
        modelCount: modelIds.length, source: 'discovery',
      })

      return reply.send({ success: true, data: { models: discovered, count: discovered.length } })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      await db.update(remoteEndpoints).set({
        lastModelDiscovery: now,
        lastDiscoveryError: errorMsg.substring(0, 500),
        updatedAt:          now,
      }).where(and(eq(remoteEndpoints.id, req.params.id), eq(remoteEndpoints.workspaceId, ws(req))))

      return reply.status(502).send({ success: false, error: errorMsg })
    }
  })

  // ── POST /endpoints/:id/test ──────────────────────────────────────────────
  app.post<{
    Params: { id: string }
    Body: { prompt?: string; model?: string; max_tokens?: number }
  }>('/endpoints/:id/test', {
    schema: {
      tags: ['ai-router'], summary: 'Send test prompt to remote endpoint (non-streaming)',
      body: {
        type: 'object',
        properties: {
          prompt:     { type: 'string' },
          model:      { type: 'string' },
          max_tokens: { type: 'number' },
        },
      },
    },
  }, async (req, reply) => {
    const rows = await db.select().from(remoteEndpoints).where(and(eq(remoteEndpoints.id, req.params.id), eq(remoteEndpoints.workspaceId, ws(req)))).limit(1)
    if (!rows[0]) return reply.status(404).send({ success: false, error: 'Not found' })
    if (rows[0].paused) return reply.status(409).send({ success: false, error: 'Endpoint is paused' })

    const epConfig = toEndpointConfig(rows[0])
    const model    = req.body.model ?? rows[0].modelIds[0] ?? 'default'
    const prompt   = req.body.prompt ?? 'Say "OK" in one word.'

    const t0 = Date.now()
    try {
      await emit('provider.request.started', rows[0].workspaceId, {
        endpointId: req.params.id, name: rows[0].name, model, taskType: 'fast_chat',
      })

      const result = await remoteChat(epConfig, {
        model,
        messages:  [{ role: 'user', content: prompt }],
        maxTokens: req.body.max_tokens ?? 64,
      })

      await logEndpointUsage({
        workspaceId: rows[0].workspaceId, endpointId: req.params.id,
        model, taskType: 'fast_chat',
        promptTokens: result.promptTokens, outputTokens: result.outputTokens,
        costUsd: result.costUsd, latencyMs: result.latencyMs,
        streamed: false, success: true,
      })

      await emit('provider.request.completed', rows[0].workspaceId, {
        endpointId: req.params.id, model, latencyMs: result.latencyMs,
        promptTokens: result.promptTokens, outputTokens: result.outputTokens,
        costUsd: result.costUsd,
      })

      return reply.send({ success: true, data: { content: result.content, model, latencyMs: result.latencyMs, costUsd: result.costUsd, promptTokens: result.promptTokens, outputTokens: result.outputTokens } })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      const latencyMs = Date.now() - t0

      await logEndpointUsage({
        workspaceId: rows[0].workspaceId, endpointId: req.params.id,
        model, taskType: 'fast_chat',
        promptTokens: 0, outputTokens: 0, costUsd: 0, latencyMs,
        streamed: false, success: false, errorMessage: errorMsg,
      })

      await emit('provider.request.failed', rows[0].workspaceId, {
        endpointId: req.params.id, model, error: errorMsg, latencyMs,
      })

      return reply.status(502).send({ success: false, error: errorMsg })
    }
  })

  // ── POST /endpoints/:id/stream ────────────────────────────────────────────
  app.post<{
    Params: { id: string }
    Body: { prompt?: string; model?: string; max_tokens?: number }
  }>('/endpoints/:id/stream', {
    schema: {
      tags: ['ai-router'], summary: 'Stream test prompt from remote endpoint (SSE)',
      body: {
        type: 'object',
        properties: {
          prompt:     { type: 'string' },
          model:      { type: 'string' },
          max_tokens: { type: 'number' },
        },
      },
    },
  }, async (req, reply) => {
    const workspaceId = ws(req)
    const rows = await db.select().from(remoteEndpoints)
      .where(and(eq(remoteEndpoints.id, req.params.id), eq(remoteEndpoints.workspaceId, workspaceId)))
      .limit(1)
    if (!rows[0]) return reply.status(404).send({ success: false, error: 'Not found' })
    if (rows[0].paused) return reply.status(409).send({ success: false, error: 'Endpoint is paused' })

    const epConfig = toEndpointConfig(rows[0])
    const model    = req.body.model ?? rows[0].modelIds[0] ?? 'default'
    const prompt   = req.body.prompt ?? 'Count to 5, one word per line.'

    await emit('provider.request.started', rows[0].workspaceId, {
      endpointId: req.params.id, name: rows[0].name, model, taskType: 'fast_chat', streaming: true,
    })

    // R146.38 — global SSE concurrent-stream cap.
    const { sseSlots } = await import('../services/sse-limit.js')
    if (!sseSlots.tryAcquire()) {
      return reply.code(503).send({ success: false, error: 'too many open streams, retry shortly' })
    }
    reply.raw.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    // Stop relaying (and stop the underlying LLM call) the moment the
    // client disconnects — otherwise the loop keeps consuming provider
    // tokens for a stream nobody is reading. The AbortController feeds
    // into remoteChatStream so the underlying provider fetch is cancelled.
    let cancelled = false
    const abortCtl = new AbortController()
    req.raw.on('close', () => { cancelled = true; abortCtl.abort(); sseSlots.release() })

    const t0 = Date.now()
    let _fullContent = ''
    let outputTokens = 0
    let success = true
    let errorMsg = ''

    try {
      const stream = remoteChatStream(epConfig, {
        model,
        messages:  [{ role: 'user', content: prompt }],
        maxTokens: req.body.max_tokens ?? 256,
        stream:    true,
      }, abortCtl.signal)

      for await (const chunk of stream) {
        if (cancelled) break
        if (chunk.done) {
          reply.raw.write(`data: [DONE]\n\n`)
          break
        }
        _fullContent += chunk.content
        outputTokens += Math.ceil(chunk.content.length / 4)
        reply.raw.write(`data: ${JSON.stringify({ content: chunk.content, model: chunk.model ?? model })}\n\n`)
      }
    } catch (err) {
      success  = false
      errorMsg = err instanceof Error ? err.message : String(err)
      reply.raw.write(`data: ${JSON.stringify({ error: errorMsg })}\n\n`)
      reply.raw.write(`data: [DONE]\n\n`)
    }

    reply.raw.end()

    const latencyMs     = Date.now() - t0
    const promptTokens  = Math.ceil(prompt.length / 4)
    const costUsd       = (promptTokens / 1000) * epConfig.promptPer1kUsd + (outputTokens / 1000) * epConfig.outputPer1kUsd

    await logEndpointUsage({
      workspaceId: rows[0].workspaceId, endpointId: req.params.id,
      model, taskType: 'fast_chat',
      promptTokens, outputTokens, costUsd, latencyMs,
      streamed: true, success,
      ...(errorMsg ? { errorMessage: errorMsg } : {}),
    })

    if (success) {
      await emit('provider.request.completed', rows[0].workspaceId, {
        endpointId: req.params.id, model, latencyMs, promptTokens, outputTokens, costUsd, streaming: true,
      })
    } else {
      await emit('provider.request.failed', rows[0].workspaceId, {
        endpointId: req.params.id, model, error: errorMsg, latencyMs, streaming: true,
      })
    }
  })

  // ── GET /endpoints/:id/usage ──────────────────────────────────────────────
  app.get<{
    Params: { id: string }
    Querystring: { limit?: string }
  }>('/endpoints/:id/usage', {
    schema: { tags: ['ai-router'], summary: 'Usage log for a remote endpoint' },
  }, async (req, reply) => {
    const limit = Math.min(parseInt(req.query.limit ?? '100'), 500)
    const rows  = await db.select().from(endpointUsageLogs)
      .where(eq(endpointUsageLogs.endpointId, req.params.id))
      .orderBy(desc(endpointUsageLogs.createdAt))
      .limit(limit)
    const totalCost = rows.reduce((s, r) => s + r.costUsd, 0)
    return reply.send({ success: true, data: rows, meta: { count: rows.length, totalCostUsd: totalCost } })
  })

  // ── POST /endpoints/:id/check ─────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/endpoints/:id/check', {
    schema: { tags: ['ai-router'], summary: 'Trigger manual health check on remote endpoint' },
  }, async (req, reply) => {
    const rows = await db.select().from(remoteEndpoints).where(and(eq(remoteEndpoints.id, req.params.id), eq(remoteEndpoints.workspaceId, ws(req)))).limit(1)
    if (!rows[0]) return reply.status(404).send({ success: false, error: 'Not found' })

    const endpoint = rows[0]
    const epConfig = toEndpointConfig(endpoint)
    const result   = await checkEndpointHealth(epConfig)
    const now      = Date.now()

    await db.update(remoteEndpoints).set({
      healthStatus:    result.status,
      lastHealthCheck: now,
      latencyMs:       result.latencyMs,
      updatedAt:       now,
    }).where(eq(remoteEndpoints.id, endpoint.id))

    await db.insert(providerHealthLog).values({
      id: uuidv7(), workspaceId: endpoint.workspaceId,
      providerId: endpoint.id, sourceType: 'endpoint',
      status: result.status, latencyMs: result.latencyMs,
      errorRate: result.status === 'down' ? 1 : 0,
      checkedAt: now,
    })

    await emit('provider.health.checked', endpoint.workspaceId, {
      endpointId: endpoint.id, name: endpoint.name,
      status: result.status, latencyMs: result.latencyMs,
      error: result.error ?? null,
      models: result.models ?? null,
      source: 'manual',
    })

    return reply.send({ success: true, data: { status: result.status, latencyMs: result.latencyMs, error: result.error ?? null, models: result.models ?? null } })
  })

  // ── GET /health ───────────────────────────────────────────────────────────
  app.get<{ Querystring: { workspace_id?: string } }>('/health', {
    schema: { tags: ['ai-router'], summary: 'Health overview: in-memory providers + remote endpoints' },
  }, async (req, reply) => {
    const workspaceId = req.query.workspace_id ?? ws(req)
    const [memHealth, endpoints] = await Promise.all([
      getProviderHealth(),
      db.select().from(remoteEndpoints).where(eq(remoteEndpoints.workspaceId, workspaceId)).orderBy(remoteEndpoints.priority),
    ])
    return reply.send({ success: true, data: {
      providers: memHealth,
      endpoints: endpoints.map((e) => ({
        id: e.id, name: e.name, type: e.type, baseUrl: e.baseUrl,
        healthStatus: e.healthStatus, latencyMs: e.latencyMs, lastHealthCheck: e.lastHealthCheck,
        enabled: e.enabled, priority: e.priority, modelIds: e.modelIds,
      })),
    }})
  })

  // ── GET /failures ─────────────────────────────────────────────────────────
  app.get<{ Querystring: { workspace_id?: string; limit?: string } }>('/failures', {
    schema: { tags: ['ai-router'], summary: 'Recent provider failure log' },
  }, async (req, reply) => {
    const workspaceId = req.query.workspace_id ?? ws(req)
    const limit = Math.min(parseInt(req.query.limit ?? '100'), 500)
    const rows = await db.select().from(providerFailures)
      .where(eq(providerFailures.workspaceId, workspaceId))
      .orderBy(desc(providerFailures.createdAt))
      .limit(limit)
    return reply.send({ success: true, data: rows, meta: { count: rows.length } })
  })

  // ── GET /budget ───────────────────────────────────────────────────────────
  app.get<{ Querystring: { workspace_id?: string } }>('/budget', {
    schema: { tags: ['ai-router'], summary: 'Current budget state + limits' },
  }, async (req, reply) => {
    const workspaceId = req.query.workspace_id ?? ws(req)
    const raw    = await getOrCreateBudget(workspaceId)
    const budget = await resetIfExpired(raw)
    const limits = getBudgetLimits()  // in-memory defaults
    return reply.send({ success: true, data: {
      workspaceId,
      dailySpendUsd:    budget.dailySpendUsd,
      monthlySpendUsd:  budget.monthlySpendUsd,
      dailyLimitUsd:    budget.dailyLimitUsd,
      monthlyLimitUsd:  budget.monthlyLimitUsd,
      dailyResetAt:     budget.dailyResetAt,
      monthlyResetAt:   budget.monthlyResetAt,
      alertThreshold:   budget.alertThreshold,
      envLimits:        limits,
    }})
  })

  // ── PUT /budget ───────────────────────────────────────────────────────────
  app.put<{
    Body: {
      workspace_id?:    string
      daily_limit_usd?: number
      monthly_limit_usd?: number
      alert_threshold?: number
    }
  }>('/budget', {
    schema: {
      tags: ['ai-router'], summary: 'Update budget limits',
      body: {
        type: 'object',
        properties: {
          workspace_id:       { type: 'string' },
          daily_limit_usd:    { type: 'number' },
          monthly_limit_usd:  { type: 'number' },
          alert_threshold:    { type: 'number' },
        },
      },
    },
  }, async (req, reply) => {
    const workspaceId = req.body.workspace_id ?? ws(req)
    const budget = await getOrCreateBudget(workspaceId)
    const updates: Partial<typeof providerBudgets.$inferInsert> = { updatedAt: Date.now() }
    if (req.body.daily_limit_usd   !== undefined) updates.dailyLimitUsd   = req.body.daily_limit_usd
    if (req.body.monthly_limit_usd !== undefined) updates.monthlyLimitUsd = req.body.monthly_limit_usd
    if (req.body.alert_threshold   !== undefined) updates.alertThreshold  = req.body.alert_threshold
    await db.update(providerBudgets).set(updates).where(eq(providerBudgets.workspaceId, workspaceId))
    return reply.send({ success: true, data: { ...budget, ...updates } })
  })

  // ── POST /chat ─────────────────────────────────────────────────────────────
  app.post<{ Body: {
    messages:        Array<{ role: string; content: string }>
    task_type:       string
    workspace_id:    string
    max_tokens?:     number
    temperature?:    number
    prefer_provider?: string
    max_cost_usd?:   number
  } }>('/chat', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      tags: ['ai-router'], summary: 'Chat completion via provider router',
      body: {
        type: 'object', required: ['messages', 'task_type', 'workspace_id'],
        properties: {
          messages:        { type: 'array' },
          task_type:       { type: 'string' },
          workspace_id:    { type: 'string' },
          max_tokens:      { type: 'number' },
          temperature:     { type: 'number' },
          prefer_provider: { type: 'string' },
          max_cost_usd:    { type: 'number' },
        },
      },
    },
  }, async (req, reply) => {
    const workspaceId = req.body.workspace_id

    // Budget check
    const budgetRow = await getOrCreateBudget(workspaceId)
    const budget    = await resetIfExpired(budgetRow)
    if (budget.dailySpendUsd >= budget.dailyLimitUsd || budget.monthlySpendUsd >= budget.monthlyLimitUsd) {
      await emit('provider.budget.blocked', workspaceId, {
        daily:  { spend: budget.dailySpendUsd,   limit: budget.dailyLimitUsd },
        monthly: { spend: budget.monthlySpendUsd, limit: budget.monthlyLimitUsd },
        taskType: req.body.task_type,
      })
      return reply.status(402).send({ success: false, error: 'AI budget limit reached', code: 'BUDGET_BLOCKED' })
    }

    await emit('provider.request.started', workspaceId, {
      taskType: req.body.task_type,
      ...(req.body.prefer_provider ? { preferProvider: req.body.prefer_provider } : {}),
    })

    try {
      const result = await chat({
        messages:    req.body.messages as never,
        taskType:    req.body.task_type as never,
        workspaceId,
        ...(req.body.max_tokens      !== undefined ? { maxTokens:      req.body.max_tokens }               : {}),
        ...(req.body.temperature     !== undefined ? { temperature:    req.body.temperature }              : {}),
        ...(req.body.prefer_provider              ? { preferProvider: req.body.prefer_provider as never } : {}),
        ...(req.body.max_cost_usd    !== undefined ? { maxCostUsd:     req.body.max_cost_usd }             : {}),
      })

      // Record spend
      await db.update(providerBudgets)
        .set({
          dailySpendUsd:   sql`daily_spend_usd + ${result.costUsd}`,
          monthlySpendUsd: sql`monthly_spend_usd + ${result.costUsd}`,
          updatedAt: Date.now(),
        })
        .where(eq(providerBudgets.workspaceId, workspaceId))

      await emit('provider.request.completed', workspaceId, {
        provider: result.provider, model: result.model,
        taskType: req.body.task_type,
        promptTokens: result.promptTokens, outputTokens: result.outputTokens,
        costUsd: result.costUsd, latencyMs: result.latencyMs,
      })

      return reply.send({ success: true, data: result })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const isFallback = msg.includes('fallback') || msg.includes('all providers failed')

      if (isFallback) {
        await emit('provider.fallback.used', workspaceId, {
          taskType: req.body.task_type, error: msg,
          ...(req.body.prefer_provider ? { preferProvider: req.body.prefer_provider } : {}),
        })
      }

      await emit('provider.request.failed', workspaceId, {
        taskType: req.body.task_type, error: msg,
        ...(req.body.prefer_provider ? { preferProvider: req.body.prefer_provider } : {}),
      })

      // Log failure to DB
      await db.insert(providerFailures).values({
        id: uuidv7(), workspaceId,
        providerId:   req.body.prefer_provider ?? 'unknown',
        taskType:     req.body.task_type,
        model:        'unknown',
        errorType:    msg.includes('rate') ? 'rate_limit' : msg.includes('auth') ? 'auth' : msg.includes('timeout') ? 'timeout' : 'server_error',
        errorMessage: msg.substring(0, 1000),
        fallbackUsed: isFallback,
        costUsd: 0, createdAt: Date.now(),
      }).catch((e: Error) => { console.error('[ai-router]', e.message); return null })

      return reply.status(503).send({ success: false, error: msg })
    }
  })

  // ── POST /embed ───────────────────────────────────────────────────────────
  app.post<{ Body: { text: string; workspace_id: string; dimensions?: number } }>('/embed', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    schema: {
      tags: ['ai-router'], summary: 'Generate embedding via provider router',
      body: {
        type: 'object', required: ['text', 'workspace_id'],
        properties: {
          text:         { type: 'string' },
          workspace_id: { type: 'string' },
          dimensions:   { type: 'number', enum: [768, 1536] },
        },
      },
    },
  }, async (req, reply) => {
    try {
      const result = await embed({
        text: req.body.text, workspaceId: req.body.workspace_id,
        ...(req.body.dimensions !== undefined ? { dimensions: req.body.dimensions as 768 | 1536 } : {}),
      })
      return reply.send({ success: true, data: result })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.status(503).send({ success: false, error: msg })
    }
  })
}

export default aiRouterRoutes
