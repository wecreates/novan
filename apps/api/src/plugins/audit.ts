/**
 * Audit logging plugin — logs sensitive API actions to the events table.
 *
 * Captures: method, url, workspaceId, statusCode, durationMs, requestId
 * Logs mutations (POST/PUT/DELETE/PATCH) on sensitive routes:
 *   /api/v1/auth/*, /api/v1/workflows/*, /api/v1/approvals/*,
 *   /api/v1/webhooks/*, /api/v1/scheduler/*
 */
import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { db } from '../db/client.js'
import { events } from '../db/schema.js'
import { v7 as uuidv7 } from 'uuid'

const SENSITIVE_PREFIXES = [
  '/api/v1/auth',
  '/api/v1/workflows',
  '/api/v1/approvals',
  '/api/v1/webhooks',
  '/api/v1/scheduler',
]
const MUTATION_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH'])

const auditPluginImpl: FastifyPluginAsync = async (app) => {
  app.addHook('onResponse', async (req, reply) => {
    if (!MUTATION_METHODS.has(req.method)) return
    if (!SENSITIVE_PREFIXES.some((p) => req.url.startsWith(p))) return

    const workspaceId = req.workspaceId ?? 'unknown'
    const durationMs = reply.elapsedTime

    // Fire and forget — never block the response
    db.insert(events).values({
      id:            uuidv7(),
      type:          'audit.api.mutation',
      workspaceId,
      payload:       {
        method:      req.method,
        url:         req.url,
        statusCode:  reply.statusCode,
        durationMs:  Math.round(durationMs),
        requestId:   req.id,
      } as Record<string, unknown>,
      traceId:       uuidv7(),
      correlationId: req.id,
      causationId:   null,
      source:        'audit-plugin',
      version:       1,
      createdAt:     Date.now(),
    }).catch((e: Error) => { console.error('[audit]', e.message); return null }) // never throw
  })
}

export const auditPlugin = fp(auditPluginImpl, { name: 'audit' })
