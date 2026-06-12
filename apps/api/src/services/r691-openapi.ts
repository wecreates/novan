/**
 * R691 — Auto-generated OpenAPI 3.1 spec + Swagger UI for the brain registry.
 *
 * /openapi.json — built once at boot (cached) from OPERATIONS.
 * /novan-docs   — Stoplight Elements (single CDN script, no build).
 *                 (The pre-existing fastify-swagger lives at /api-docs.)
 *
 * Each brain op becomes a POST /brain/:op endpoint in the spec, with the
 * op's risk + description surfaced. Operator can hand this URL to anyone
 * wanting to build against Novan.
 */

let cached: string | null = null

export async function buildOpenApiSpec(): Promise<string> {
  if (cached) return cached
  let OPERATIONS: Record<string, { description?: string; risk?: string }> = {}
  try {
    const mod = await import('./brain-task.js') as unknown as { OPERATIONS?: Record<string, { description?: string; risk?: string }> }
    OPERATIONS = mod.OPERATIONS ?? {}
  } catch { /* tolerated */ }

  const paths: Record<string, unknown> = {}
  for (const [op, def] of Object.entries(OPERATIONS)) {
    const tag = op.split('.')[0] ?? 'misc'
    paths[`/brain/${op}`] = {
      post: {
        operationId: `brain_${op.replace(/[^a-zA-Z0-9_]/g, '_')}`,
        summary: (def.description ?? op).slice(0, 100),
        description: def.description ?? '',
        tags: [tag],
        'x-risk': def.risk ?? 'unknown',
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  workspaceId: { type: 'string', default: 'default' },
                  params: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'success', content: { 'application/json': { schema: { type: 'object' } } } },
          '400': { description: 'bad request' },
          '401': { description: 'unauthorized' },
        },
        security: [{ adminToken: [] }, { bearerAuth: [] }],
      },
    }
  }

  paths['/admin/brain'] = {
    post: {
      operationId: 'admin_brain_dispatch',
      summary: 'Dispatch any brain op (admin token, localhost-only)',
      tags: ['admin'],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['op'],
              properties: {
                op: { type: 'string' },
                workspaceId: { type: 'string' },
                params: { type: 'object', additionalProperties: true },
              },
            },
          },
        },
      },
      responses: { '200': { description: 'success' }, '404': { description: 'admin bridge disabled' } },
      security: [{ adminToken: [] }],
    },
  }
  paths['/auth/signup']  = { post: { tags: ['auth'], summary: 'R689 — create user', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email','password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', minLength: 8 }, displayName: { type: 'string' } } } } } }, responses: { '200': { description: 'created' }, '400': { description: 'error' } } } }
  paths['/auth/login']   = { post: { tags: ['auth'], summary: 'R689 — login', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email','password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string' } } } } } }, responses: { '200': { description: 'session' }, '401': { description: 'invalid' } } } }
  paths['/auth/me']      = { get:  { tags: ['auth'], summary: 'R689 — current user', security: [{ bearerAuth: [] }], responses: { '200': { description: 'user' }, '401': { description: 'unauthorized' } } } }
  paths['/auth/logout']  = { post: { tags: ['auth'], summary: 'R689 — invalidate session', security: [{ bearerAuth: [] }], responses: { '200': { description: 'ok' } } } }

  const tags = [...new Set(Object.keys(OPERATIONS).map(op => op.split('.')[0] ?? 'misc'))].sort().map(t => ({ name: t }))
  tags.push({ name: 'auth' }, { name: 'admin' })

  const spec = {
    openapi: '3.1.0',
    info: {
      title: 'Novan API',
      description: `Auto-generated from the brain-op registry (${Object.keys(OPERATIONS).length} ops) + the auth + admin surfaces. Spec rebuilt at server boot.`,
      version: '1.0.0',
    },
    servers: [{ url: '/' }],
    tags,
    paths,
    components: {
      securitySchemes: {
        adminToken: { type: 'apiKey', in: 'header', name: 'X-Admin-Token' },
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
    },
  }
  cached = JSON.stringify(spec)
  return cached
}

export function renderSwaggerHtml(): string {
  return `<!doctype html><html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Novan API · /docs</title>
<script src="https://unpkg.com/@stoplight/elements/web-components.min.js"></script>
<link rel="stylesheet" href="https://unpkg.com/@stoplight/elements/styles.min.css">
<style>html,body,elements-api{height:100%;margin:0;padding:0}</style>
</head><body>
<elements-api apiDescriptionUrl="/openapi.json" router="hash" layout="sidebar"></elements-api>
</body></html>`
}
