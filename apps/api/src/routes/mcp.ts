/**
 * MCP (Model Context Protocol) — HTTP/JSON-RPC manifest endpoint.
 *
 * Exposes Novan's brain-task operations as callable tools that frontier
 * agents (Claude Desktop, Cursor, Cline, custom GPTs, MCP-aware clients)
 * can discover and invoke. This turns Novan from an isolated platform
 * into network infrastructure: another agent can ask Novan to
 * `portfolio.list` or `business.feasibility` and chain the results into
 * its own reasoning.
 *
 * Safety scope:
 *   - Only LOW-risk read operations are exposed without operator approval.
 *   - MEDIUM+ ops are listed in the manifest but `call` returns a
 *     "requires_approval" sentinel rather than executing — the operator
 *     must approve via the regular brain-task approval flow.
 *   - The money-guard still hard-blocks any financial-pattern op.
 *   - Authentication: requires a valid workspace bearer token, identical
 *     to the standard /api/v1 routes.
 *
 * Transport: HTTP+JSON, not stdio. Matches the modern HTTP MCP variant
 * that clients like Cursor and Claude Desktop can register as a remote
 * tool server. A separate stdio shim package can wrap this for clients
 * that only speak local-process MCP.
 */
import type { FastifyPluginAsync } from 'fastify'
import { executePlan, listAvailableOperations } from '../services/brain-task.js'

interface McpTool {
  name:        string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  /** Novan-specific extension: surfaces the risk tier so clients can
   *  warn the operator before invoking write/destructive ops. Stripped
   *  on strict-MCP-compatibility mode (?strict=1). */
  _novan_risk?: 'low' | 'medium' | 'high' | 'critical'
}

/** Convert an internal op name (`portfolio.list`) into an MCP tool name.
 *  MCP tool names must match `[A-Za-z][A-Za-z0-9_-]*`; we replace `.`
 *  with `_` and prepend `novan_` so the namespace is obvious in the
 *  client's tool picker. */
function opToToolName(op: string): string {
  return `novan_${op.replace(/\./g, '_')}`
}
function toolNameToOp(name: string): string | null {
  if (!name.startsWith('novan_')) return null
  return name.slice('novan_'.length).replace(/_/g, '.')
}

/** Domain-split per SPEC §5.4 ("One MCP server per integration domain").
 *  Novan ships a single HTTP MCP endpoint but exposes per-domain
 *  manifest filtering so calling agents (Claude Desktop / Cursor /
 *  Cline) can pick a focused tool subset rather than the full ~150 op
 *  surface.
 *
 *  Each domain is a list of op-name prefixes. An op belongs to a domain
 *  iff its name starts with any prefix in that domain's list. */
const DOMAIN_PREFIX_MAP: Record<string, string[]> = {
  finance:    ['financial.', 'business.budget.', 'cron-budget.', 'compliance.compute_tax', 'compliance.check_international_tax'],
  crm:        ['business.feasibility', 'business.realityCheck', 'portfolio.', 'holding.'],
  marketing:  ['shortform.', 'agent.dispatch', 'agent.list_personas', 'content.', 'pod.pricing.', 'business.create'],
  support:    ['knowledge.', 'coord.adversarial_review'],
  ops:        ['scheduled.', 'workflow.', 'cron.', 'platform.', 'desktop.', 'browser.'],
  eng:        ['coding.', 'cartographer.', 'pipeline.', 'sim.', 'improve.', 'eval.'],
  comms:      ['etsy.', 'youtube.', 'tiktok.', 'instagram.', 'shopify.'],
  governance: ['policy.', 'coord.', 'compliance.recommend_entity', 'compliance.check_ftc_disclosure', 'compliance.audit_rights', 'compliance.recommend_ip_actions', 'maturity.', 'staffing.'],
  hil:        ['hil.'],
  ai_product: ['ai_product.'],
}

function opMatchesDomain(op: string, domain: string): boolean {
  const prefixes = DOMAIN_PREFIX_MAP[domain]
  if (!prefixes) return false
  return prefixes.some(p => op.startsWith(p))
}

const mcpRoutes: FastifyPluginAsync = async (fastify) => {

  /** Server info — clients fetch this first to discover capability. */
  fastify.get('/', async () => ({
    name:        'novan-mcp',
    version:     '1.1.0',
    protocol:    '2024-11-05',
    description: 'Novan operator brain — portfolio, business, content, and research ops as MCP tools. Domain-split: /mcp/<domain>/tools where domain ∈ ' + Object.keys(DOMAIN_PREFIX_MAP).join(','),
    capabilities: { tools: { listChanged: false } },
    domains: Object.keys(DOMAIN_PREFIX_MAP),
  }))

  /** tools/list — return the manifest. Low-risk ops always callable;
   *  higher-risk ops listed so the client knows they exist, but invoking
   *  them via /call returns the approval-required sentinel.
   *
   *  Per SPEC §5.4 domain-split, `/mcp/<domain>/tools` filters to the
   *  domain's prefix set. Plain `/mcp/tools` returns the full surface. */
  fastify.get<{ Querystring: { strict?: string; risk?: string; domain?: string } }>('/tools', async (req) => {
    const ops = listAvailableOperations()
    const riskFilter = (req.query.risk ?? 'low,medium').split(',').map(s => s.trim()).filter(Boolean)
    const strict = req.query.strict === '1' || req.query.strict === 'true'
    const domain = req.query.domain
    const tools: McpTool[] = ops
      .filter(o => riskFilter.includes(o.risk))
      .filter(o => !domain || opMatchesDomain(o.op, domain))
      .map(o => {
        const t: McpTool = {
          name:        opToToolName(o.op),
          description: o.description,
          inputSchema: {
            type:        'object',
            properties:  {
              params: {
                type:        'object',
                description: 'Op-specific params. See description for shape.',
                additionalProperties: true,
              },
              workspace_id: { type: 'string', description: 'Target workspace UUID.' },
            },
            required: ['workspace_id'],
          },
        }
        if (!strict) t._novan_risk = o.risk
        return t
      })
    return { tools }
  })

  /** tools/call — invoke one op. Low-risk runs immediately; medium-risk
   *  returns a "requires_approval" payload so the calling agent can route
   *  the operator through Novan's normal approval flow. */
  fastify.post<{
    Body: {
      name?:      string
      arguments?: { workspace_id?: string; params?: Record<string, unknown>; approval_token?: string }
    }
  }>('/call', async (req, reply) => {
    const b = req.body ?? {}
    if (!b.name) return reply.code(400).send({ error: { code: -32602, message: 'name required' } })
    const op = toolNameToOp(b.name)
    if (!op) return reply.code(404).send({ error: { code: -32601, message: `unknown tool: ${b.name}` } })
    const ws = b.arguments?.workspace_id
    if (!ws) return reply.code(400).send({ error: { code: -32602, message: 'arguments.workspace_id required' } })

    // Look up the op spec to gate on risk tier.
    const spec = listAvailableOperations().find(o => o.op === op)
    if (!spec) return reply.code(404).send({ error: { code: -32601, message: `op not registered: ${op}` } })

    // Medium / high / critical require an explicit approval_token,
    // identical to the brain-task contract. Without one we refuse to
    // execute and tell the client what to ask the operator for.
    if (spec.risk !== 'low' && !b.arguments?.approval_token) {
      return reply.code(403).send({
        isError: true,
        content: [{
          type: 'text',
          text: `This op is risk=${spec.risk}. Pass arguments.approval_token="OPERATOR_APPROVED" only after the human operator confirms in the Novan UI.`,
        }],
        _novan: { requires_approval: true, risk: spec.risk, op },
      })
    }

    try {
      const result = await executePlan(
        ws,
        `mcp:${op}`,
        [{ op, params: b.arguments?.params ?? {} }],
        b.arguments?.approval_token,
        'invoked via MCP',
      )
      const first = result.results[0]
      if (!first?.ok) {
        return {
          isError: true,
          content: [{ type: 'text', text: first?.error ?? 'op failed' }],
        }
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(first.data, null, 2) }],
        _novan: { taskId: result.taskId, durationMs: first.durationMs },
      }
    } catch (e) {
      return reply.code(500).send({
        isError: true,
        content: [{ type: 'text', text: (e as Error).message }],
      })
    }
  })
}

// ── Domain-specific subroute handler ──────────────────────────────
// Per SPEC §5.4, mounts /<domain>/tools + /<domain>/call as
// convenience routes that auto-set the domain filter. Calling agents
// register the specific domain's URL (e.g. `/mcp/finance`) rather
// than the full surface, so their tool picker stays focused.
const mcpDomainRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { domain: string }; Querystring: { strict?: string; risk?: string } }>('/:domain/tools', async (req, reply) => {
    const domain = req.params.domain
    if (!DOMAIN_PREFIX_MAP[domain]) return reply.code(404).send({ error: { code: -32601, message: `unknown domain: ${domain}` } })
    const ops = listAvailableOperations()
    const riskFilter = (req.query.risk ?? 'low,medium').split(',').map(s => s.trim()).filter(Boolean)
    const strict = req.query.strict === '1' || req.query.strict === 'true'
    const tools: McpTool[] = ops
      .filter(o => riskFilter.includes(o.risk))
      .filter(o => opMatchesDomain(o.op, domain))
      .map(o => {
        const t: McpTool = {
          name:        opToToolName(o.op),
          description: o.description,
          inputSchema: {
            type:        'object',
            properties:  {
              params: { type: 'object', description: 'Op-specific params. See description.', additionalProperties: true },
              workspace_id: { type: 'string', description: 'Target workspace UUID.' },
            },
            required: ['workspace_id'],
          },
        }
        if (!strict) t._novan_risk = o.risk
        return t
      })
    return { tools, domain, count: tools.length }
  })

  fastify.get<{ Params: { domain: string } }>('/:domain', async (req, reply) => {
    const domain = req.params.domain
    if (!DOMAIN_PREFIX_MAP[domain]) return reply.code(404).send({ error: { code: -32601, message: `unknown domain: ${domain}` } })
    return {
      name:        `novan-mcp-${domain}`,
      version:     '1.1.0',
      protocol:    '2024-11-05',
      description: `Novan ${domain} domain tools — subset of the full Novan MCP surface filtered by op-name prefix.`,
      domain,
      prefixes:    DOMAIN_PREFIX_MAP[domain],
      capabilities: { tools: { listChanged: false } },
    }
  })
}

export default async function combined(fastify: Parameters<FastifyPluginAsync>[0]): Promise<void> {
  await fastify.register(mcpRoutes)
  await fastify.register(mcpDomainRoutes)
}
