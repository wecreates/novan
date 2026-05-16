// Redirect / to /docs
import type { FastifyPluginAsync } from 'fastify'

export const docsRedirectRoute: FastifyPluginAsync = async (app) => {
  app.get('/', { schema: { hide: true } }, async (_req, reply) => {
    return reply.redirect('/docs')
  })
}
