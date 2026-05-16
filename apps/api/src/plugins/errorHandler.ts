/**
 * Error handler plugin — normalizes all errors to ApiError shape.
 * Prevents stack traces leaking in production.
 * Handles ZodError (user-land validation) as 400, not 500.
 */
import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { ZodError } from 'zod'

type FastifyErr = Error & { statusCode?: number; code?: string }

const errorHandlerImpl: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error: FastifyErr, req, reply) => {
    const isProd = process.env['NODE_ENV'] === 'production'

    // ZodError thrown from route handlers (z.parse / z.object.parse) has no
    // statusCode and would default to 500 — return 400 with structured issues instead.
    if (error instanceof ZodError) {
      app.log.warn({ err: error, requestId: req.id }, 'Validation error')
      return reply.status(400).send({
        success:   false,
        error:     'Validation error',
        code:      'VALIDATION_ERROR',
        requestId: req.id,
        issues:    error.issues,
      })
    }

    app.log.error({ err: error, requestId: req.id }, 'Request error')

    const statusCode = error.statusCode ?? 500
    return reply.status(statusCode).send({
      success:   false,
      error:     isProd && statusCode >= 500 ? 'Internal server error' : error.message,
      code:      (error as { code?: string }).code ?? 'INTERNAL_ERROR',
      requestId: req.id,
      ...(isProd ? {} : { stack: error.stack }),
    })
  })
}

export const errorHandlerPlugin = fp(errorHandlerImpl, { name: 'error-handler' })
