/**
 * Error handler plugin — normalizes all errors to ApiError shape.
 * Prevents stack traces leaking in production.
 * Handles ZodError (user-land validation) as 400, not 500.
 */
import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { ZodError } from 'zod'

type FastifyErr = Error & { statusCode?: number; code?: string }

/** Strip the query string and any embedded credentials before logging.
 *  URLs like `/api/v1/x?token=secret` are common in OAuth redirects and
 *  would otherwise leak the token into every error log line. */
function safeUrl(url: string): string {
  const q = url.indexOf('?')
  return q >= 0 ? url.slice(0, q) : url
}

const errorHandlerImpl: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error: FastifyErr, req, reply) => {
    const isProd = process.env['NODE_ENV'] === 'production'

    // ZodError thrown from route handlers (z.parse / z.object.parse) has no
    // statusCode and would default to 500 — return 400 with structured issues instead.
    if (error instanceof ZodError) {
      // Log only the issue summary — the full ZodError carries the raw
      // input value, which may contain user-submitted secrets.
      app.log.warn({
        issues: error.issues.map(i => ({ path: i.path.join('.'), code: i.code, message: i.message })),
        requestId: req.id,
      }, 'Validation error')
      return reply.status(400).send({
        success:   false,
        error:     'Validation error',
        code:      'VALIDATION_ERROR',
        requestId: req.id,
        issues:    error.issues,
      })
    }

    app.log.error({
      err: error.message,
      name: error.name,
      stack: error.stack,
      requestId: req.id,
    }, 'Request error')

    const statusCode = error.statusCode ?? 500

    // Forward 5xx server errors to the brain ingest so it can diagnose
    // + auto-fix patterns we've seen before. Fire-and-forget; never
    // block the response.
    if (statusCode >= 500) {
      void (async () => {
        try {
          const { reportError } = await import('../services/brain-error-ingest.js')
          const ws = (req as { workspaceId?: string }).workspaceId
                  ?? ((req.query as { workspace_id?: string } | undefined)?.workspace_id)
                  ?? ((req.body as { workspace_id?: string } | null | undefined)?.workspace_id)
                  ?? 'default'
          await reportError({
            workspaceId:  ws,
            source:       'api',
            errorMessage: error.message,
            errorName:    error.name,
            ...(error.stack ? { stack: error.stack } : {}),
            // Strip the query string before persisting — OAuth callbacks
            // and similar carry tokens/codes there that must not land in
            // long-lived issue records.
            url:          safeUrl(req.url),
            method:       req.method,
            statusCode,
          })
        } catch { /* tolerated */ }
      })()
    }

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
