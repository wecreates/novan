/**
 * research-engine.ts — Research Learning Engine.
 *
 * Pipeline per topic-run:
 *   1. Gate (kill-switch, unsafe-task, robots.txt, SSRF)
 *   2. For each approved source URL: webFetch → external_knowledge cache
 *   3. Summarize + extract facts via Groq through token-stretcher
 *   4. Dedupe by sha256(content) against research_findings
 *   5. Persist finding with citations + confidence + fact_type
 *   6. Emit runtime events at every stage
 *
 * Visibility: every action emits a 'research.*' event.
 * Safety: separates fact/opinion/guess; never asserts unverified claims.
 */
import crypto                          from 'node:crypto'
import { db }                          from '../db/client.js'
import { researchTopics, researchFindings, events, agents } from '../db/schema.js'
import { and, eq, sql as sqlOp }       from 'drizzle-orm'
import { v7 as uuidv7 }                from 'uuid'
import { webFetch }                    from './web-fetch.js'
import { gateResearch, emitLearningEvent } from './research-safety.js'
import { stretch }                     from './token-stretcher.js'
import { isResearchEnabled }           from './provider-validation.js'
import { webSearch }                   from './search-providers.js'
import { checkBeforeAction, acquireAgentSlot, releaseAgentSlot, emitGovernorBlock } from './resource-governor.js'
import { claimTask, releaseTask, shouldEmit } from './agent-coordinator.js'
import crypto2                         from 'node:crypto'
import { embed }                       from './embeddings.js'

const FRESHNESS_MS = 7 * 24 * 60 * 60_000   // findings stay 'fresh' for 7 days

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'research-engine', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

// ─── Topic CRUD ───────────────────────────────────────────────────────────────

export interface CreateTopicInput {
  workspaceId:      string
  topic:            string
  description?:     string
  approvedSources?: string[]
  approvedAgents?:  string[]
  pollIntervalSec?: number
  createdBy?:       string
}

export async function createTopic(i: CreateTopicInput): Promise<string> {
  const now = Date.now()
  const id  = uuidv7()
  await db.insert(researchTopics).values({
    id, workspaceId: i.workspaceId, topic: i.topic,
    description:     i.description     ?? null,
    approvedSources: i.approvedSources ?? [],
    approvedAgents:  i.approvedAgents  ?? ['web-research-agent'],
    status:          'active',
    pollIntervalSec: i.pollIntervalSec ?? 21600,
    createdBy:       i.createdBy       ?? null,
    createdAt:       now, updatedAt: now,
  })
  await emit(i.workspaceId, 'research.topic_created', { id, topic: i.topic })
  return id
}

export async function listTopics(workspaceId: string) {
  return db.select().from(researchTopics)
    .where(eq(researchTopics.workspaceId, workspaceId))
    .orderBy(researchTopics.createdAt)
}

export async function setTopicStatus(id: string, status: 'active' | 'paused' | 'killed') {
  const now = Date.now()
  await db.update(researchTopics).set({ status, updatedAt: now }).where(eq(researchTopics.id, id))
}

export async function deleteFinding(id: string, workspaceId: string) {
  await db.delete(researchFindings)
    .where(and(eq(researchFindings.id, id), eq(researchFindings.workspaceId, workspaceId)))
}

// ─── Summarization + extraction ──────────────────────────────────────────────

interface ExtractResult {
  summary:    string
  facts:      Array<{ text: string; kind: 'fact' | 'opinion' | 'guess' }>
  confidence: number
}

async function summarizeAndExtract(
  workspaceId: string, sourceTitle: string, sourceUrl: string, body: string,
): Promise<ExtractResult> {
  const groqKey = process.env['GROQ_API_KEY']
  if (!groqKey) {
    // Degrade: store raw excerpt with low confidence, no extraction
    return {
      summary:    body.slice(0, 400),
      facts:      [],
      confidence: 0.2,
    }
  }

  const prompt = `You are extracting structured knowledge from a single article.

URL: ${sourceUrl}
Title: ${sourceTitle}

ARTICLE (truncated):
${body.slice(0, 6000)}

Return strict JSON:
{
  "summary": "2-3 sentence neutral summary",
  "facts": [
    { "text": "...", "kind": "fact|opinion|guess" }
  ],
  "confidence": 0.0-1.0
}

Rules:
- fact = stated as verifiable, with concrete numbers/names/dates
- opinion = author's subjective judgment
- guess = speculation or prediction
- confidence = how trustworthy the source appears (recency, citations, author auth)
- Max 6 facts. Each fact <= 200 chars.`

  const result = await stretch({
    workspaceId,
    model:       'llama-3.1-8b-instant',
    taskType:    'research-extract',
    messages:    [{ role: 'user', content: prompt }],
    maxTokens:   1024,
    temperature: 0.1,
    cacheTtlMs:  24 * 60 * 60_000,
    call: async ({ model, messages, maxTokens, temperature }) => {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:  'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${groqKey}` },
        body:    JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
        signal:  AbortSignal.timeout(30_000),
      })
      const body = await res.json().catch(() => ({})) as Record<string, unknown>
      if (!res.ok) throw new Error(`Groq ${res.status}`)
      const choices = body['choices'] as Array<{ message?: { content?: string } }> | undefined
      return { content: choices?.[0]?.message?.content ?? '' }
    },
  }).catch(() => null)

  if (!result) return { summary: body.slice(0, 400), facts: [], confidence: 0.2 }

  // Strict parse first — greedy {…} extract was over-matching when the
  // LLM's prose preamble contained brace literals (e.g. when describing
  // its own output schema), producing a parse failure that downgraded
  // to a 0.3-confidence stub. Now: pure-JSON output succeeds cleanly,
  // wrapped JSON falls back to greedy extract.
  const trimmed = result.content.trim()
  let parsed: ExtractResult | null = null
  try { parsed = JSON.parse(trimmed) as ExtractResult }
  catch {
    const match = trimmed.match(/\{[\s\S]*\}/)
    if (match) { try { parsed = JSON.parse(match[0]) as ExtractResult } catch { /* */ } }
  }
  if (!parsed) return { summary: result.content.slice(0, 400), facts: [], confidence: 0.3 }

  try {
    return {
      summary:    String(parsed.summary ?? '').slice(0, 1000),
      facts:      Array.isArray(parsed.facts) ? parsed.facts.slice(0, 6) : [],
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
    }
  } catch {
    return { summary: result.content.slice(0, 400), facts: [], confidence: 0.3 }
  }
}

// ─── Topic execution ──────────────────────────────────────────────────────────

export interface RunResult {
  topicId:     string
  sourcesTried: number
  findingsAdded: number
  duplicates:    number
  blocked:       number
  errors:        string[]
}

export async function runTopic(topicId: string, agentId?: string): Promise<RunResult> {
  const topic = await db.select().from(researchTopics)
    .where(eq(researchTopics.id, topicId)).limit(1).then(r => r[0])
  if (!topic) throw new Error('topic not found')
  const { recordAgentActivityAsync } = await import('./agent-state-sync.js')
  recordAgentActivityAsync(topic.workspaceId, 'web_research', { status: 'running' })
  if (topic.status !== 'active') {
    return { topicId, sourcesTried: 0, findingsAdded: 0, duplicates: 0, blocked: 1, errors: [`topic status=${topic.status}`] }
  }

  const result: RunResult = {
    topicId, sourcesTried: 0, findingsAdded: 0, duplicates: 0, blocked: 0, errors: [],
  }

  // Feature flag
  if (!isResearchEnabled()) {
    result.blocked++; result.errors.push('RESEARCH_ENABLED=false')
    return result
  }

  // Resource governor + dedup claim
  const gov = await checkBeforeAction({ workspaceId: topic.workspaceId, kind: 'research' })
  if (!gov.ok) {
    await emitGovernorBlock(topic.workspaceId, gov, 'research')
    result.blocked++; result.errors.push(`governor: ${gov.reason}`)
    return result
  }
  const taskSig = crypto2.createHash('sha256').update(`${topicId}|${topic.updatedAt}`).digest('hex').slice(0, 16)
  if (!claimTask(topic.workspaceId, 'web_research', taskSig)) {
    result.blocked++; result.errors.push('duplicate claim — another agent already running this topic')
    return result
  }
  acquireAgentSlot(topic.workspaceId)

  try {

  // Pre-gate the task text once
  const taskGate = await gateResearch({ workspaceId: topic.workspaceId, taskText: `${topic.topic}\n${topic.description ?? ''}` })
  if (!taskGate.ok) {
    result.blocked++; result.errors.push(taskGate.reason ?? 'gate blocked')
    await db.update(researchTopics).set({
      lastRunAt: Date.now(), lastError: taskGate.reason ?? 'blocked', updatedAt: Date.now(),
    }).where(eq(researchTopics.id, topicId))
    return result
  }

  const max = topic.maxFindingsPerRun ?? 10

  // Discover sources via web search if approvedSources is empty
  let sources = [...topic.approvedSources]
  if (sources.length === 0) {
    const search = await webSearch(topic.topic, { max })
    if (search.hits.length > 0) {
      sources = search.hits.map(h => h.url)
      await emit(topic.workspaceId, 'research.sources_discovered', { topicId, provider: search.provider, count: sources.length })
    } else if (search.error) {
      result.errors.push(`search: ${search.error}`)
    }
  }

  await emit(topic.workspaceId, 'research.run_started', { topicId, sources: sources.length, agentId: agentId ?? null })

  for (const url of sources.slice(0, max)) {
    result.sourcesTried++

    const urlGate = await gateResearch({ workspaceId: topic.workspaceId, url })
    if (!urlGate.ok) {
      result.blocked++; result.errors.push(`${url}: ${urlGate.reason}`)
      continue
    }

    const fetched = await webFetch({
      url, workspaceId: topic.workspaceId,
      source: 'llm-research', fetchedBy: agentId ?? 'research-engine',
      ttlMs: 6 * 60 * 60_000,
    }).catch((e: Error) => ({ error: e.message } as const))

    if ('error' in fetched || fetched.error) {
      result.errors.push(`${url}: ${('error' in fetched ? fetched.error : fetched.error) ?? 'fetch failed'}`)
      continue
    }

    const body = fetched.contentRedacted
    const contentHash = crypto.createHash('sha256').update(body).digest('hex')

    // Dedup
    const existing = await db.select({ id: researchFindings.id }).from(researchFindings)
      .where(and(eq(researchFindings.workspaceId, topic.workspaceId), eq(researchFindings.contentHash, contentHash)))
      .limit(1).then(r => r[0])
    if (existing) { result.duplicates++; continue }

    const extracted = await summarizeAndExtract(topic.workspaceId, fetched.title ?? '', url, body)

    const factType = extracted.facts.some(f => f.kind === 'fact')
      ? 'fact'
      : extracted.facts.some(f => f.kind === 'opinion') ? 'opinion' : 'guess'

    const now = Date.now()
    // Compute embedding if a provider is configured — degrades gracefully to null
    const embedText = `${fetched.title ?? ''}\n${extracted.summary}`
    const embedding = await embed(embedText).catch(() => null)

    await db.insert(researchFindings).values({
      id:           uuidv7(),
      workspaceId:  topic.workspaceId,
      topicId:      topic.id,
      agentId:      agentId ?? null,
      sourceUrl:    url,
      sourceTitle:  fetched.title ?? null,
      factType,
      summary:      extracted.summary,
      extractedFacts: extracted.facts,
      citations:    [{ url, title: fetched.title ?? null }],
      confidence:   extracted.confidence,
      contentHash,
      fetchedAt:    now,
      freshAt:      now + FRESHNESS_MS,
      embedding:    embedding ?? null,
      createdAt:    now,
      updatedAt:    now,
    }).onConflictDoNothing()
    result.findingsAdded++

    await emit(topic.workspaceId, 'research.finding_added', {
      topicId, url, factType, confidence: extracted.confidence, facts: extracted.facts.length,
    })
  }

  const now = Date.now()
  await db.update(researchTopics).set({
    lastRunAt:     now,
    lastSuccessAt: result.findingsAdded > 0 ? now : null,
    lastError:     result.errors[0] ?? null,
    runCount:      sqlOp`${researchTopics.runCount} + 1`,
    findingsCount: sqlOp`${researchTopics.findingsCount} + ${result.findingsAdded}`,
    updatedAt:     now,
  }).where(eq(researchTopics.id, topicId))

  if (shouldEmit(topic.workspaceId, 'research.run_completed', `${topicId}:${result.findingsAdded}:${result.errors.length}`)) {
    await emit(topic.workspaceId, 'research.run_completed', result as unknown as Record<string, unknown>)
  }
  return result
  } finally {
    releaseAgentSlot(topic.workspaceId)
    releaseTask(topic.workspaceId, 'web_research', taskSig)
  }
}

/** Cron entry — run every topic whose interval has elapsed. */
export async function runDueTopics(workspaceId: string): Promise<{ ran: number; results: RunResult[] }> {
  const now = Date.now()
  const due = await db.select().from(researchTopics)
    .where(and(eq(researchTopics.workspaceId, workspaceId), eq(researchTopics.status, 'active')))
  const results: RunResult[] = []
  for (const t of due) {
    if (t.lastRunAt && now - t.lastRunAt < t.pollIntervalSec * 1000) continue
    const r = await runTopic(t.id).catch((e: Error) => ({
      topicId: t.id, sourcesTried: 0, findingsAdded: 0, duplicates: 0, blocked: 0, errors: [e.message],
    } as RunResult))
    results.push(r)
  }
  return { ran: results.length, results }
}

// ─── Listing + querying findings ──────────────────────────────────────────────

export async function listFindings(workspaceId: string, opts?: { topicId?: string; limit?: number }) {
  const limit = opts?.limit ?? 50
  if (opts?.topicId) {
    return db.select().from(researchFindings)
      .where(and(eq(researchFindings.workspaceId, workspaceId), eq(researchFindings.topicId, opts.topicId)))
      .orderBy(researchFindings.createdAt).limit(limit)
  }
  return db.select().from(researchFindings)
    .where(eq(researchFindings.workspaceId, workspaceId))
    .orderBy(researchFindings.createdAt).limit(limit)
}

// ─── Research agent registry ─────────────────────────────────────────────────

export const RESEARCH_AGENT_DEFS = [
  { name: 'Research Planner',        type: 'research_planner',        capabilities: ['topic.decompose', 'plan.queue'] },
  { name: 'Web Research Agent',      type: 'web_research',            capabilities: ['web.fetch', 'extract.facts'] },
  { name: 'Source Quality Agent',    type: 'source_quality',          capabilities: ['source.score', 'source.dedupe'] },
  { name: 'Fact Checker Agent',      type: 'fact_checker',            capabilities: ['fact.verify', 'cross.reference'] },
  { name: 'Memory Curator Agent',    type: 'memory_curator',          capabilities: ['memory.cluster', 'memory.expire'] },
  { name: 'Trend Detection Agent',   type: 'trend_detection',         capabilities: ['trend.detect', 'signal.rank'] },
  { name: 'Competitive Intel Agent', type: 'competitive_intelligence',capabilities: ['competitor.track', 'market.signal'] },
  { name: 'Product Research Agent',  type: 'product_research',        capabilities: ['feature.compare', 'pricing.track'] },
  { name: 'Security Research Agent', type: 'security_research',       capabilities: ['cve.track', 'advisory.parse'] },
  { name: 'Market Research Agent',   type: 'market_research',         capabilities: ['market.size', 'audience.profile'] },
  // Operator-success insight agents — read-side analysts of real usage
  { name: 'UX Insight Agent',        type: 'ux_insight',              capabilities: ['ux.friction.detect', 'flow.simplify.suggest'] },
  { name: 'Workflow Friction Agent', type: 'workflow_friction',       capabilities: ['workflow.failure.rank', 'approval.friction.score'] },
  { name: 'Reliability Trend Agent', type: 'reliability_trend',       capabilities: ['reliability.trend', 'rollback.signal'] },
  { name: 'Adoption Agent',          type: 'adoption',                capabilities: ['feature.adoption', 'retention.score'] },
] as const

export async function seedResearchAgents(workspaceId: string): Promise<{ created: number }> {
  let created = 0
  const now = Date.now()
  for (const def of RESEARCH_AGENT_DEFS) {
    const existing = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.type, def.type)))
      .limit(1).then(r => r[0])
    if (existing) continue
    await db.insert(agents).values({
      id: uuidv7(), workspaceId, name: def.name, type: def.type,
      description: `Research agent: ${def.name}`,
      capabilities: [...def.capabilities],
      config: {}, status: 'idle',
      createdAt: now, updatedAt: now,
    }).catch(() => null)
    created++
  }
  if (created > 0) await emitLearningEvent(workspaceId, 'research.agents_seeded', { count: created })
  return { created }
}
