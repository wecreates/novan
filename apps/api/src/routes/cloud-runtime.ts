/**
 * Cloud Runtime Mode Routes
 *
 * Runtime mode management, per-user provider credentials,
 * API key validation, and pre-execution routing preflight.
 *
 * Prefix: /api/v1/cloud-runtime
 */

import type { FastifyPluginAsync } from 'fastify'
import { v7 as uuidv7 }           from 'uuid'
import { and, eq }                from 'drizzle-orm'
import { db }                      from '../db/client.js'
import {
  userProviderCreds, events,
} from '../db/schema.js'
import {
  getRuntimeSettings, setRuntimeSettings,
} from '../services/runtime-mode.js'
import { routeRequest }           from '../services/provider-router.js'
import { encrypt, encryptionAvailable } from '@ops/ai-router/encryption'

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function emitEvent(
  workspaceId: string, type: string, payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId,
    payload, traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/cloud-runtime', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[cloud-runtime]', e.message); return null })
}

/** Validate a provider API key by hitting its models endpoint. */
async function validateProviderKey(
  providerId: string,
  apiKey:     string,
): Promise<{ valid: boolean; error?: string }> {
  const urls: Record<string, string> = {
    openai:     'https://api.openai.com/v1/models',
    anthropic:  'https://api.anthropic.com/v1/models',
    groq:       'https://api.groq.com/openai/v1/models',
    openrouter: 'https://openrouter.ai/api/v1/models',
    gemini:     'https://generativelanguage.googleapis.com/v1/models',
  }

  const url = urls[providerId]
  if (!url) return { valid: true }  // Unknown provider — assume valid

  try {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${apiKey}`,
      'x-api-key':     apiKey,
    }
    // Gemini uses ?key= param
    const reqUrl = providerId === 'gemini' ? `${url}?key=${encodeURIComponent(apiKey)}` : url

    const res = await fetch(reqUrl, {
      method:  'GET',
      headers,
      signal:  AbortSignal.timeout(8_000),
    })

    if (res.ok || res.status === 403) return { valid: true }   // 403 = valid key, no permission
    if (res.status === 401)           return { valid: false, error: 'Invalid API key (401)' }
    return { valid: true }  // Other errors are ambiguous — treat as valid
  } catch (err) {
    // Network errors don't mean key is invalid
    return { valid: true, error: (err as Error).message }
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

const cloudRuntimeRoutes: FastifyPluginAsync = async (app) => {

  // ── Runtime Mode ───────────────────────────────────────────────────────────

  /** Get runtime settings for a workspace */
  app.get<{ Querystring: { workspaceId: string } }>('/mode', {
    schema: {
      tags: ['cloud-runtime'],
      querystring: {
        type: 'object', required: ['workspaceId'],
        properties: { workspaceId: { type: 'string' } },
      },
    },
  }, async (req) => {
    const settings = await getRuntimeSettings(req.query.workspaceId)
    return { settings }
  })

  /** Update runtime mode and flags */
  app.put<{
    Body: {
      workspaceId:        string
      mode?:              string
      allowLocalGpu?:     boolean
      allowLocalBrowser?: boolean
      preferredProviders?: string[]
    }
  }>('/mode', {
    schema: {
      tags: ['cloud-runtime'],
      body: {
        type: 'object', required: ['workspaceId'],
        properties: {
          workspaceId:         { type: 'string' },
          mode:                { type: 'string', enum: ['local', 'hybrid', 'cloud-api-only'] },
          allowLocalGpu:       { type: 'boolean' },
          allowLocalBrowser:   { type: 'boolean' },
          preferredProviders:  { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (req) => {
    const { workspaceId, ...updates } = req.body
    const settings = await setRuntimeSettings(workspaceId, updates as never)
    return { settings }
  })

  // ── Provider Key Validation ────────────────────────────────────────────────

  /** Validate a provider API key (without revealing it) */
  app.post<{
    Body: {
      workspaceId: string
      providerId:  string
      apiKey:      string
    }
  }>('/validate-key', {
    schema: {
      tags: ['cloud-runtime'],
      body: {
        type: 'object', required: ['workspaceId', 'providerId', 'apiKey'],
        properties: {
          workspaceId: { type: 'string' },
          providerId:  { type: 'string' },
          apiKey:      { type: 'string' },
        },
      },
    },
  }, async (req) => {
    const { workspaceId, providerId, apiKey } = req.body
    const result = await validateProviderKey(providerId, apiKey)

    await emitEvent(workspaceId, 'provider.key_validated', {
      providerId, valid: result.valid,
    })

    // Never echo back the key
    return { valid: result.valid, ...(result.error ? { error: result.error } : {}) }
  })

  // ── Per-User Provider Credentials ──────────────────────────────────────────

  /** List user's provider credentials (keys redacted) */
  app.get<{ Querystring: { workspaceId: string; userId: string } }>('/user-creds', {
    schema: {
      tags: ['cloud-runtime'],
      querystring: {
        type: 'object', required: ['workspaceId', 'userId'],
        properties: {
          workspaceId: { type: 'string' },
          userId:      { type: 'string' },
        },
      },
    },
  }, async (req) => {
    const { workspaceId, userId } = req.query
    const rows = await db.select().from(userProviderCreds)
      .where(and(
        eq(userProviderCreds.workspaceId, workspaceId),
        eq(userProviderCreds.userId, userId),
      ))

    const creds = rows.map((r) => ({
      id:               r.id,
      providerId:       r.providerId,
      label:            r.label,
      hasApiKey:        !!(r.apiKeyEncrypted),
      enabled:          r.enabled,
      validationStatus: r.validationStatus,
      lastValidatedAt:  r.lastValidatedAt,
      createdAt:        r.createdAt,
      updatedAt:        r.updatedAt,
    }))

    return { creds }
  })

  /** Add or rotate a user provider credential */
  app.post<{
    Body: {
      workspaceId: string
      userId:      string
      providerId:  string
      label:       string
      apiKey:      string
      validate?:   boolean
    }
  }>('/user-creds', {
    schema: {
      tags: ['cloud-runtime'],
      body: {
        type: 'object', required: ['workspaceId', 'userId', 'providerId', 'label', 'apiKey'],
        properties: {
          workspaceId: { type: 'string' },
          userId:      { type: 'string' },
          providerId:  { type: 'string' },
          label:       { type: 'string' },
          apiKey:      { type: 'string' },
          validate:    { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    const { workspaceId, userId, providerId, label, apiKey, validate } = req.body

    if (!encryptionAvailable()) {
      return reply.code(500).send({ error: 'ENCRYPTION_KEY not configured' })
    }

    const enc = encrypt(apiKey)
    const now = Date.now()

    let validationStatus = 'unknown'
    let lastValidatedAt: number | null = null

    if (validate) {
      const vResult = await validateProviderKey(providerId, apiKey)
      validationStatus = vResult.valid ? 'valid' : 'invalid'
      lastValidatedAt  = now
    }

    const [row] = await db.insert(userProviderCreds).values({
      id:               uuidv7(),
      workspaceId,
      userId,
      providerId,
      label,
      apiKeyEncrypted:  enc.ciphertext,
      apiKeyIv:         enc.iv,
      enabled:          true,
      validationStatus,
      ...(lastValidatedAt !== null ? { lastValidatedAt } : {}),
      createdAt:        now,
      updatedAt:        now,
    }).onConflictDoUpdate({
      target: [userProviderCreds.workspaceId, userProviderCreds.userId, userProviderCreds.providerId],
      set: {
        label,
        apiKeyEncrypted:  enc.ciphertext,
        apiKeyIv:         enc.iv,
        validationStatus,
        ...(lastValidatedAt !== null ? { lastValidatedAt } : {}),
        updatedAt: now,
      },
    }).returning()

    await emitEvent(workspaceId, 'user_cred.saved', { userId, providerId, validationStatus })

    return reply.code(201).send({
      id:               row!.id,
      hasApiKey:        true,
      validationStatus: row!.validationStatus,
    })
  })

  /** Delete a user provider credential */
  app.delete<{
    Params:      { id: string }
    Querystring: { workspaceId: string; userId: string }
  }>('/user-creds/:id', {
    schema: {
      tags: ['cloud-runtime'],
      params: {
        type: 'object', required: ['id'],
        properties: { id: { type: 'string' } },
      },
      querystring: {
        type: 'object', required: ['workspaceId', 'userId'],
        properties: {
          workspaceId: { type: 'string' },
          userId:      { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { id } = req.params
    const { workspaceId, userId } = req.query

    const rows = await db.delete(userProviderCreds)
      .where(and(
        eq(userProviderCreds.id, id),
        eq(userProviderCreds.workspaceId, workspaceId),
        eq(userProviderCreds.userId, userId),
      ))
      .returning({ id: userProviderCreds.id })

    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Credential not found' })
    }

    await emitEvent(workspaceId, 'user_cred.deleted', { userId, credId: id })
    return { deleted: true }
  })

  // ── Routing Preflight ──────────────────────────────────────────────────────

  /**
   * Full pre-execution routing decision:
   * mode check → kill switch → budget → provider selection.
   */
  app.post<{
    Body: {
      workspaceId:      string
      userId?:          string
      computeType:      string
      providerId?:      string
      estimatedCostUsd: number
      scopeType:        string
      scopeId:          string
      executionId:      string
      isWorkflow?:      boolean
    }
  }>('/route-preflight', {
    schema: {
      tags: ['cloud-runtime'],
      body: {
        type: 'object',
        required: ['workspaceId', 'computeType', 'estimatedCostUsd', 'scopeType', 'scopeId', 'executionId'],
        properties: {
          workspaceId:      { type: 'string' },
          userId:           { type: 'string' },
          computeType:      { type: 'string', enum: ['gpu', 'browser', 'ai', 'remote'] },
          providerId:       { type: 'string' },
          estimatedCostUsd: { type: 'number' },
          scopeType:        { type: 'string' },
          scopeId:          { type: 'string' },
          executionId:      { type: 'string' },
          isWorkflow:       { type: 'boolean' },
        },
      },
    },
  }, async (req) => {
    const decision = await routeRequest({
      ...req.body,
      computeType: req.body.computeType as 'gpu' | 'browser' | 'ai' | 'remote',
    })
    return { decision }
  })
}

export default cloudRuntimeRoutes
