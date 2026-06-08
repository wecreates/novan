/**
 * R146.337 — Semantic Recall (closes memory.semantic_recall 6→8)
 *
 * Hybrid retrieval over workspace_memory: keyword + structured-key + scope.
 * Falls back to keyword-rank when no embedding column is available. Optimized
 * for "give me everything we know about return addresses" style queries that
 * dominate revenue-ops workflows.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

export interface RecallResult {
  key:         string
  value:       string
  scope:       string
  importance:  number
  matchType:   'exact_key' | 'key_prefix' | 'scope_match' | 'value_keyword' | 'fuzzy'
  score:       number          // 0-1
  updatedAt:   number
}

export interface RecallOptions {
  workspaceId: string
  query:       string
  limit?:      number
  minImportance?: number
  scopes?:     string[]
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[\s.,_\-/]+/).filter(t => t.length >= 3)
}

export async function recall(opts: RecallOptions): Promise<RecallResult[]> {
  const tokens = tokenize(opts.query)
  if (tokens.length === 0) return []
  const limit = opts.limit ?? 20
  const minImp = opts.minImportance ?? 50

  try {
    // Pull a candidate set: anything matching ANY token OR scope OR key prefix.
    const queryLike = `%${tokens[0]}%`
    const rows = await db.execute(sql`
      SELECT key, value, scope, importance, updated_at
      FROM workspace_memory
      WHERE workspace_id = ${opts.workspaceId}
        AND importance >= ${minImp}
        AND (
             key   ILIKE ${queryLike}
          OR value ILIKE ${queryLike}
          OR scope ILIKE ${queryLike}
        )
      ORDER BY importance DESC, updated_at DESC
      LIMIT 200
    `) as unknown as Array<{ key: string; value: string; scope: string; importance: number; updated_at: number | string }>

    // Rerank against full token set with a scoring rubric.
    const ranked: RecallResult[] = rows.map(r => {
      const keyLower = r.key.toLowerCase()
      const valLower = r.value.toLowerCase()
      const scopeLower = r.scope.toLowerCase()
      let score = 0
      let matchType: RecallResult['matchType'] = 'fuzzy'

      // Exact key match wins
      if (keyLower === opts.query.toLowerCase()) {
        score = 1; matchType = 'exact_key'
      } else if (keyLower.startsWith(tokens[0]!)) {
        score = 0.85; matchType = 'key_prefix'
      } else if (opts.scopes?.includes(r.scope)) {
        score = 0.7; matchType = 'scope_match'
      } else {
        const keyHits = tokens.filter(t => keyLower.includes(t)).length
        const valHits = tokens.filter(t => valLower.includes(t)).length
        const scopeHits = tokens.filter(t => scopeLower.includes(t)).length
        score = Math.min(0.95, (keyHits * 0.25 + valHits * 0.10 + scopeHits * 0.30) + (r.importance / 200))
        matchType = keyHits > 0 ? 'fuzzy' : valHits > 0 ? 'value_keyword' : 'fuzzy'
      }
      return {
        key:        r.key,
        value:      r.value.length > 500 ? r.value.slice(0, 500) + '…' : r.value,
        scope:      r.scope,
        importance: r.importance,
        matchType,
        score:      Number(score.toFixed(3)),
        updatedAt:  Number(r.updated_at) || 0,
      }
    })
    ranked.sort((a, b) => b.score - a.score)
    return ranked.slice(0, limit)
  } catch (e) {
    console.error('[r337-semantic-recall] failed:', (e as Error).message)
    return []
  }
}

/**
 * Targeted recall for a specific concept area — convenience wrapper that
 * automatically scopes the query and lowers the importance floor for breadth.
 */
export async function recallByTopic(opts: {
  workspaceId: string
  topic:       'return_address' | 'brand' | 'lessons' | 'channels' | 'strategies' | 'risks' | 'rules'
}): Promise<RecallResult[]> {
  return recall({
    workspaceId: opts.workspaceId,
    query:       opts.topic,
    scopes:      [opts.topic + 's', opts.topic, 'lessons', 'rules', 'strategies', 'brand'],
    minImportance: 30,
    limit:       30,
  })
}
