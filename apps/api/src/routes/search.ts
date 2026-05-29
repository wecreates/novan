/**
 * Global search — searches across all entity types.
 * GET /api/v1/search?q=<query>&types=<comma-separated>&limit=<n>
 */
import type { FastifyPluginAsync } from 'fastify'
import { ilike, eq, and, or, sql } from 'drizzle-orm'
import { db }    from '../db/client.js'
import {
  memories, opportunities, risks, insights,
  strategicGoals, agents, businesses, workflowDefinitions,
} from '../db/schema.js'

type EntityType = 'memory' | 'opportunity' | 'risk' | 'insight' | 'goal' | 'agent' | 'business' | 'workflow'

export interface SearchHit {
  type:      EntityType
  id:        string
  title:     string
  subtitle?: string
  status?:   string
  score?:    number
  createdAt: number
}

/** Build a SearchHit, omitting optional keys when value is null/undefined. */
function hit(
  type: EntityType,
  id: string,
  title: string,
  createdAt: number,
  opts?: { subtitle?: string | null; status?: string | null; score?: number | null },
): SearchHit {
  const h: SearchHit = { type, id, title, createdAt }
  if (opts?.subtitle !== null && opts?.subtitle !== undefined) h.subtitle = opts.subtitle
  if (opts?.status   !== null && opts?.status   !== undefined) h.status   = opts.status
  if (opts?.score    !== null && opts?.score    !== undefined) h.score    = opts.score
  return h
}

export const searchRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req, reply) => {
    const { q, types, limit = '20' } = req.query as { q?: string; types?: string; limit?: string }
    const workspaceId = ((req as { workspaceId?: string }).workspaceId ?? 'default')
    const query = (q ?? '').trim()
    const parsedLimit = Number(limit)
    const maxResults = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 50) : 20

    if (query.length < 2) return reply.send({ success: true, data: [], meta: { count: 0, query } })

    const requestedTypes = types ? types.split(',').map((t) => t.trim()) as EntityType[] : null
    const pattern = `%${query}%`
    const results: SearchHit[] = []

    const want = (type: EntityType) => !requestedTypes || requestedTypes.includes(type)

    // Memories
    if (want('memory')) {
      const rows = await db
        .select({ id: memories.id, content: memories.content, type: memories.type, confidence: memories.confidence, createdAt: memories.createdAt })
        .from(memories)
        .where(and(eq(memories.workspaceId, workspaceId), ilike(memories.content, pattern)))
        .limit(10)
      results.push(...rows.map((r) => hit('memory', r.id, r.content.slice(0, 80), r.createdAt, { subtitle: r.type, score: r.confidence })))
    }

    // Opportunities
    if (want('opportunity')) {
      const rows = await db
        .select({ id: opportunities.id, title: opportunities.title, status: opportunities.status, score: opportunities.score, createdAt: opportunities.createdAt })
        .from(opportunities)
        .where(and(
          eq(opportunities.workspaceId, workspaceId),
          or(
            ilike(opportunities.title, pattern),
            sql`${opportunities.description} ilike ${pattern}`,
          ),
        ))
        .limit(10)
      results.push(...rows.map((r) => hit('opportunity', r.id, r.title, r.createdAt, { status: r.status, score: r.score })))
    }

    // Risks
    if (want('risk')) {
      const rows = await db
        .select({ id: risks.id, title: risks.title, severity: risks.severity, status: risks.status, createdAt: risks.createdAt })
        .from(risks)
        .where(and(
          eq(risks.workspaceId, workspaceId),
          or(
            ilike(risks.title, pattern),
            sql`${risks.description} ilike ${pattern}`,
          ),
        ))
        .limit(10)
      results.push(...rows.map((r) => hit('risk', r.id, r.title, r.createdAt, { subtitle: r.severity, status: r.status })))
    }

    // Insights
    if (want('insight')) {
      const rows = await db
        .select({ id: insights.id, title: insights.title, category: insights.category, confidence: insights.confidence, createdAt: insights.createdAt })
        .from(insights)
        .where(and(
          eq(insights.workspaceId, workspaceId),
          or(
            ilike(insights.title, pattern),
            ilike(insights.body, pattern),
          ),
        ))
        .limit(10)
      results.push(...rows.map((r) => hit('insight', r.id, r.title, r.createdAt, { subtitle: r.category, score: r.confidence })))
    }

    // Goals
    if (want('goal')) {
      const rows = await db
        .select({ id: strategicGoals.id, title: strategicGoals.title, status: strategicGoals.status, horizon: strategicGoals.horizon, createdAt: strategicGoals.createdAt })
        .from(strategicGoals)
        .where(and(
          eq(strategicGoals.workspaceId, workspaceId),
          or(
            ilike(strategicGoals.title, pattern),
            sql`${strategicGoals.description} ilike ${pattern}`,
          ),
        ))
        .limit(10)
      results.push(...rows.map((r) => hit('goal', r.id, r.title, r.createdAt, { subtitle: r.horizon, status: r.status })))
    }

    // Agents
    if (want('agent')) {
      const rows = await db
        .select({ id: agents.id, name: agents.name, type: agents.type, status: agents.status, createdAt: agents.createdAt })
        .from(agents)
        .where(and(
          eq(agents.workspaceId, workspaceId),
          or(
            ilike(agents.name, pattern),
            sql`${agents.description} ilike ${pattern}`,
          ),
        ))
        .limit(5)
      results.push(...rows.map((r) => hit('agent', r.id, r.name, r.createdAt, { subtitle: r.type, status: r.status })))
    }

    // Businesses
    if (want('business')) {
      const rows = await db
        .select({ id: businesses.id, name: businesses.name, industry: businesses.industry, health: businesses.health, createdAt: businesses.createdAt })
        .from(businesses)
        .where(and(
          eq(businesses.workspaceId, workspaceId),
          or(
            ilike(businesses.name, pattern),
            sql`${businesses.domain} ilike ${pattern}`,
          ),
        ))
        .limit(5)
      results.push(...rows.map((r) => hit('business', r.id, r.name, r.createdAt, { subtitle: r.industry, status: r.health })))
    }

    // Workflows
    if (want('workflow')) {
      const rows = await db
        .select({ id: workflowDefinitions.id, name: workflowDefinitions.name, tags: workflowDefinitions.tags, createdAt: workflowDefinitions.createdAt })
        .from(workflowDefinitions)
        .where(and(eq(workflowDefinitions.workspaceId, workspaceId), ilike(workflowDefinitions.name, pattern)))
        .limit(5)
      results.push(...rows.map((r) => hit('workflow', r.id, r.name, r.createdAt, { subtitle: r.tags.join(', ') || null })))
    }

    // Sort: exact-match-in-title first, then by recency
    const q_lower = query.toLowerCase()
    results.sort((a, b) => {
      const aExact = a.title.toLowerCase().includes(q_lower) ? 1 : 0
      const bExact = b.title.toLowerCase().includes(q_lower) ? 1 : 0
      if (aExact !== bExact) return bExact - aExact
      return b.createdAt - a.createdAt
    })

    return reply.send({
      success: true,
      data: results.slice(0, maxResults),
      meta: { count: results.length, query },
    })
  })
}
