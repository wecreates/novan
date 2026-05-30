/**
 * Request context plugin — attaches trace/correlation IDs to every request.
 * Sets x-request-id and x-trace-id response headers.
 */
import type { FastifyPluginAsync } from 'fastify'
import { v7 as uuidv7 }           from 'uuid'
import fp                          from 'fastify-plugin'

// R146.67 — trace ID shape validator. Without it, an attacker could:
//  - Plant markers in logs by setting x-trace-id to any string
//  - Bloat logs with 10KB+ x-trace-id values (req.log.child copies it
//    into every log line for the request)
//  - Cause 500 errors if Node http rejects CRLF in a response header
//    (the existing code reflected the raw value back via reply.header)
const TRACE_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/

const requestContextImpl: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (req, reply) => {
    const supplied = req.headers['x-trace-id']
    const traceId = (typeof supplied === 'string' && TRACE_ID_RE.test(supplied))
      ? supplied
      : uuidv7()
    req.log = req.log.child({ traceId })
    reply.header('x-trace-id',   traceId)
    reply.header('x-request-id', req.id)
  })
}

export const requestContextPlugin = fp(requestContextImpl, { name: 'request-context' })
