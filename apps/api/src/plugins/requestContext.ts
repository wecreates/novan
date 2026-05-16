/**
 * Request context plugin — attaches trace/correlation IDs to every request.
 * Sets x-request-id and x-trace-id response headers.
 */
import type { FastifyPluginAsync } from 'fastify'
import { v7 as uuidv7 }           from 'uuid'
import fp                          from 'fastify-plugin'

const requestContextImpl: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req, reply) => {
    const traceId = req.headers['x-trace-id'] as string ?? uuidv7()
    req.log = req.log.child({ traceId })
    reply.header('x-trace-id',   traceId)
    reply.header('x-request-id', req.id)
  })
}

export const requestContextPlugin = fp(requestContextImpl, { name: 'request-context' })
