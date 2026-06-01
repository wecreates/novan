/**
 * ceo-strategic.ts — R146.87 — CEO strategic-layer upgrades.
 *
 * Fills six gaps:
 *  1. prioritize() — rank businesses by ROI-per-attention-unit so CEO cycles
 *     allocate brain attention where return is highest
 *  2. proposeReallocation() — capital allocation moves between businesses
 *  3. diversificationCheck() — flag concentration risk in the portfolio
 *  4. setOkrs() / readOkrs() — quarterly horizons; default cadence shifts
 *     from "next briefing" to "quarter-aligned"
 *  5. retireAgent() — fire underperforming agents based on trust + outcome
 *     ratios
 *  6. adversarialReview() — second-LLM critique of a CEO plan before
 *     execution (uses tool-call-classifier pattern, disjoint inputs)
 *  7. operatorUnavailable() — what the CEO does when operator hasn't
 *     approved anything in N days
 */
import { db } from '../db/client.js'
import { businesses, businessRevenue, agents, events } from '../db/schema.js'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── 1. Prioritize businesses by ROI-per-attention ───────────────────────────

interface BusinessScore {
  id: string
  name: string
  stage: string
  health: string
  revenueMonthUsd: number
  attentionUnits: number     // events emitted for this business in last 30d
  scoreRoi: number           // revenueMonth / attention
  scorePriority: number      // composite — adds stage weight + health
  recommendedAction: 'expand' | 'hold' | 'sunset-consider' | 'investigate'
}

export async function prioritizeBusinesses(workspaceId: string): Promise<BusinessScore[]> {
  const bizRows = await db.select().from(businesses).where(eq(businesses.workspaceId, workspaceId))
  const since   = Date.now() - 30 * 86_400_000
  const out: BusinessScore[] = []
  for (const b of bizRows) {
    const rev = await db.select({ total: sql<number>`coalesce(sum(amount_usd_cents), 0)::bigint` })
      .from(businessRevenue)
      .where(and(eq(businessRevenue.workspaceId, workspaceId),
                 eq(businessRevenue.businessId, b.id),
                 gte(businessRevenue.recordedAt, since)))
    const revenueMonthUsd = Number(rev[0]?.total ?? 0) / 100
    // Attention proxy: events tagged to this business in the last 30d
    const attn = await db.select({ n: sql<number>`count(*)::int` })
      .from(events)
      .where(and(eq(events.workspaceId, workspaceId),
                 gte(events.createdAt, since),
                 sql`payload->>'businessId' = ${b.id}`))
    const attentionUnits = Math.max(1, Number(attn[0]?.n ?? 1))
    const scoreRoi      = revenueMonthUsd / attentionUnits
    const stageWeight   = b.stage === 'growth' ? 1.3 : b.stage === 'early' ? 1.0 : 0.7
    const healthWeight  = b.health === 'green' ? 1.2 : b.health === 'amber' ? 1.0 : 0.5
    const scorePriority = scoreRoi * stageWeight * healthWeight
    let action: BusinessScore['recommendedAction']
    if (revenueMonthUsd === 0 && attentionUnits > 50) action = 'investigate'
    else if (revenueMonthUsd > 10_000 && scoreRoi > 5)  action = 'expand'
    else if (revenueMonthUsd < 100 && attentionUnits > 200) action = 'sunset-consider'
    else action = 'hold'
    out.push({
      id:               b.id,
      name:             b.name,
      stage:            b.stage,
      health:           b.health,
      revenueMonthUsd,
      attentionUnits,
      scoreRoi,
      scorePriority,
      recommendedAction: action,
    })
  }
  return out.sort((a, b) => b.scorePriority - a.scorePriority)
}

// ─── 2. Capital allocation proposals ─────────────────────────────────────────

export async function proposeReallocation(workspaceId: string, monthlyBudgetUsd: number): Promise<{
  current:  Array<{ businessId: string; name: string; allocated: number }>
  proposed: Array<{ businessId: string; name: string; proposed: number; delta: number; reason: string }>
  rationale: string
}> {
  const scored = await prioritizeBusinesses(workspaceId)
  // Read current allocations from business metadata (operator-set) or default-equal
  const totalScore = scored.reduce((s, b) => s + Math.max(0, b.scorePriority), 0)
  const current = scored.map(b => ({
    businessId: b.id,
    name:       b.name,
    allocated:  Math.round(monthlyBudgetUsd / Math.max(1, scored.length)),
  }))
  const proposed = scored.map(b => {
    const share = totalScore > 0 ? Math.max(0, b.scorePriority) / totalScore : 1 / scored.length
    const propAmt = Math.round(monthlyBudgetUsd * share)
    const cur     = Math.round(monthlyBudgetUsd / Math.max(1, scored.length))
    const reasonParts: string[] = []
    if (b.recommendedAction === 'expand')          reasonParts.push('strong ROI — expand')
    if (b.recommendedAction === 'sunset-consider') reasonParts.push('high attention, no revenue — consider sunset')
    if (b.recommendedAction === 'investigate')     reasonParts.push('inactive — investigate before more spend')
    if (b.health === 'red')                        reasonParts.push('health red')
    return {
      businessId: b.id,
      name:       b.name,
      proposed:   propAmt,
      delta:      propAmt - cur,
      reason:     reasonParts.join('; ') || 'baseline proportional to priority score',
    }
  })
  const rationale = `Allocation rebalances $${monthlyBudgetUsd}/mo across ${scored.length} businesses by priority score (ROI × stage-weight × health-weight). Top mover: ${proposed.sort((a,b) => Math.abs(b.delta) - Math.abs(a.delta))[0]?.name ?? 'n/a'}.`
  return { current, proposed, rationale }
}

// ─── 3. Diversification check ────────────────────────────────────────────────

export async function diversificationCheck(workspaceId: string): Promise<{
  byIndustry: Record<string, number>
  byStage:    Record<string, number>
  concentrationRisk: 'low' | 'medium' | 'high'
  recommendations: string[]
}> {
  const rows = await db.select().from(businesses).where(eq(businesses.workspaceId, workspaceId))
  const byIndustry: Record<string, number> = {}
  const byStage:    Record<string, number> = {}
  for (const b of rows) {
    const ind = b.industry ?? 'unknown'
    byIndustry[ind] = (byIndustry[ind] ?? 0) + 1
    byStage[b.stage] = (byStage[b.stage] ?? 0) + 1
  }
  const total = rows.length || 1
  const maxIndShare   = Math.max(0, ...Object.values(byIndustry)) / total
  const maxStageShare = Math.max(0, ...Object.values(byStage)) / total
  const recommendations: string[] = []
  let concentrationRisk: 'low' | 'medium' | 'high' = 'low'
  if (maxIndShare > 0.6 && rows.length >= 3) {
    concentrationRisk = 'high'
    const dominant = Object.entries(byIndustry).sort((a,b) => b[1]-a[1])[0]?.[0]
    recommendations.push(`Industry concentration: ${Math.round(maxIndShare * 100)}% of businesses are in "${dominant}". One industry-wide event would hit the portfolio hard. Consider diversifying.`)
  } else if (maxIndShare > 0.4) {
    concentrationRisk = 'medium'
  }
  if (maxStageShare > 0.7 && rows.length >= 3) {
    if (concentrationRisk !== 'high') concentrationRisk = 'medium'
    const dominantStage = Object.entries(byStage).sort((a,b) => b[1]-a[1])[0]?.[0]
    recommendations.push(`Stage concentration: ${Math.round(maxStageShare * 100)}% of businesses are at "${dominantStage}". Portfolio cash-flow timing will be lumpy.`)
  }
  if (rows.length < 2) recommendations.push('Single-business portfolio. Diversification not applicable until 2nd business.')
  return { byIndustry, byStage, concentrationRisk, recommendations }
}

// ─── 4. OKRs (quarterly horizons stored in events ledger) ────────────────────

export interface Okr {
  id:         string
  quarter:    string    // e.g. "2026Q2"
  objective:  string
  keyResults: Array<{ description: string; target: number; current: number; unit: string }>
  status:     'planned' | 'active' | 'achieved' | 'missed'
  createdAt:  number
}

export async function setOkrs(workspaceId: string, okr: Omit<Okr, 'id' | 'createdAt' | 'status'> & { status?: Okr['status'] }): Promise<{ id: string }> {
  const id  = uuidv7()
  const now = Date.now()
  await db.insert(events).values({
    id:            uuidv7(),
    type:          'okr.set',
    workspaceId,
    payload:       { id, ...okr, status: okr.status ?? 'active', createdAt: now },
    traceId:       uuidv7(),
    correlationId: uuidv7(),
    causationId:   null,
    source:        'ceo-strategic',
    version:       1,
    createdAt:     now,
  })
  return { id }
}

export async function readOkrs(workspaceId: string, quarter?: string): Promise<Okr[]> {
  const rows = await db.select().from(events)
    .where(and(eq(events.workspaceId, workspaceId), eq(events.type, 'okr.set')))
    .orderBy(desc(events.createdAt))
    .limit(50)
  const okrs: Okr[] = rows.map(r => (r.payload as unknown as Okr))
  return quarter ? okrs.filter(o => o.quarter === quarter) : okrs
}

// ─── 5. Agent retirement ─────────────────────────────────────────────────────

export async function retireUnderperformingAgents(workspaceId: string, opts: { minLifetimeDays?: number; maxFailureRate?: number } = {}): Promise<{
  retired: Array<{ type: string; failureRate: number; reason: string }>
}> {
  const minLifetimeDays = opts.minLifetimeDays ?? 7
  const maxFailureRate  = opts.maxFailureRate  ?? 0.6
  const rows = await db.select().from(agents).where(eq(agents.workspaceId, workspaceId))
  const retired: Array<{ type: string; failureRate: number; reason: string }> = []
  for (const a of rows) {
    const ageMs = Date.now() - Number(a.lastActiveAt ?? Date.now())
    if (ageMs < minLifetimeDays * 86_400_000) continue
    // Failure proxy: events where source matches agent.type and type contains 'fail' or 'error'
    const since = Date.now() - 30 * 86_400_000
    const totalQ = await db.select({ n: sql<number>`count(*)::int` })
      .from(events)
      .where(and(eq(events.workspaceId, workspaceId), eq(events.source, a.type), gte(events.createdAt, since)))
    const failQ = await db.select({ n: sql<number>`count(*)::int` })
      .from(events)
      .where(and(eq(events.workspaceId, workspaceId), eq(events.source, a.type),
                 gte(events.createdAt, since),
                 sql`(type like '%fail%' or type like '%error%' or type like '%blocked%')`))
    const total = Number(totalQ[0]?.n ?? 0)
    const fail  = Number(failQ[0]?.n ?? 0)
    if (total < 10) continue   // not enough signal
    const rate = fail / total
    if (rate >= maxFailureRate) {
      await db.update(agents)
        .set({ status: 'offline' })
        .where(and(eq(agents.workspaceId, workspaceId), eq(agents.type, a.type)))
      retired.push({ type: a.type, failureRate: rate, reason: `${fail}/${total} events failed in last 30d` })
    }
  }
  return { retired }
}

// ─── 6. Adversarial review of CEO plans (second-LLM critique) ────────────────

export async function adversarialReview(input: {
  workspaceId:  string
  planSummary:  string
  rationale:    string
  affectedBusinesses?: string[]
  estimatedSpendUsd?: number
}): Promise<{
  verdict:    'approve' | 'concerns' | 'reject'
  concerns:   string[]
  questions:  string[]
  confidence: number
  reviewerProvider: string
}> {
  // Second-LLM judge. Disjoint inputs from the CEO's own planner.
  const SYS = `You are an adversarial reviewer of an autonomous CEO's proposed plan. Your job is to find what's wrong with it. Default to skepticism. Output STRICT JSON: {"verdict": "approve"|"concerns"|"reject", "concerns": ["..."], "questions": ["..."], "confidence": 0..1}. Limit each to 3 items.`
  const USER = JSON.stringify({
    planSummary: input.planSummary.slice(0, 1500),
    rationale:   input.rationale.slice(0, 1000),
    affectedBusinesses: input.affectedBusinesses?.slice(0, 10) ?? [],
    estimatedSpendUsd:  input.estimatedSpendUsd ?? null,
  })
  // Reuse the classifier's provider chain
  const providers = [
    { env: 'ANTHROPIC_API_KEY', url: 'https://api.anthropic.com/v1/messages', family: 'anthropic', model: 'claude-haiku-4-5' },
    { env: 'OPENAI_API_KEY',    url: 'https://api.openai.com/v1/chat/completions', family: 'openai', model: 'gpt-4o-mini' },
    { env: 'GROQ_API_KEY',      url: 'https://api.groq.com/openai/v1/chat/completions', family: 'openai', model: 'llama-3.1-8b-instant' },
    { env: 'GEMINI_API_KEY',    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent', family: 'gemini', model: 'gemini-2.0-flash' },
  ] as const
  for (const p of providers) {
    const key = process.env[p.env]
    if (!key) continue
    try {
      let text = ''
      if (p.family === 'anthropic') {
        const res = await fetch(p.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: p.model, max_tokens: 400, temperature: 0, system: SYS, messages: [{ role: 'user', content: USER }] }),
          signal: AbortSignal.timeout(8000),
        })
        if (!res.ok) throw new Error(`${p.env} ${res.status}`)
        const data = await res.json() as { content?: Array<{ text?: string }> }
        text = data.content?.[0]?.text ?? ''
      } else if (p.family === 'openai') {
        const res = await fetch(p.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: p.model, temperature: 0, max_tokens: 400, messages: [{ role: 'system', content: SYS }, { role: 'user', content: USER }], response_format: { type: 'json_object' } }),
          signal: AbortSignal.timeout(8000),
        })
        if (!res.ok) throw new Error(`${p.env} ${res.status}`)
        const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
        text = data.choices?.[0]?.message?.content ?? ''
      } else {
        const res = await fetch(`${p.url}?key=${key}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ systemInstruction: { parts: [{ text: SYS }] }, contents: [{ role: 'user', parts: [{ text: USER }] }], generationConfig: { temperature: 0, maxOutputTokens: 400, responseMimeType: 'application/json' } }),
          signal: AbortSignal.timeout(8000),
        })
        if (!res.ok) throw new Error(`${p.env} ${res.status}`)
        const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
        text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
      }
      const m = text.match(/\{[\s\S]*\}/)
      if (!m) continue
      const parsed = JSON.parse(m[0]) as { verdict?: string; concerns?: string[]; questions?: string[]; confidence?: number }
      return {
        verdict:    (parsed.verdict === 'approve' || parsed.verdict === 'reject') ? parsed.verdict : 'concerns',
        concerns:   Array.isArray(parsed.concerns)  ? parsed.concerns.slice(0, 3)  : [],
        questions:  Array.isArray(parsed.questions) ? parsed.questions.slice(0, 3) : [],
        confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
        reviewerProvider: p.env,
      }
    } catch { /* try next */ }
  }
  return { verdict: 'concerns', concerns: ['adversarial reviewer unavailable — proceed only with operator approval'], questions: [], confidence: 0, reviewerProvider: 'none' }
}

// ─── 7. Operator-unavailability protocol ─────────────────────────────────────

export async function operatorUnavailabilityState(workspaceId: string): Promise<{
  daysSinceLastApproval: number
  state:                 'normal' | 'cooling' | 'stale' | 'frozen'
  recommendedPosture:    string
  pendingApprovalsCount: number
}> {
  // Last approval = last event of type containing 'approval' or 'OPERATOR_APPROVED' marker
  const rows = await db.select().from(events)
    .where(and(eq(events.workspaceId, workspaceId),
               sql`(type like '%approv%' or payload::text like '%OPERATOR_APPROVED%')`))
    .orderBy(desc(events.createdAt))
    .limit(1)
  const lastAt = rows[0]?.createdAt ? Number(rows[0].createdAt) : 0
  const days = lastAt === 0 ? 999 : (Date.now() - lastAt) / 86_400_000
  let state: 'normal' | 'cooling' | 'stale' | 'frozen'
  let posture: string
  if (days < 2) {
    state = 'normal'; posture = 'continue normal cadence; full approval gates active'
  } else if (days < 5) {
    state = 'cooling'; posture = 'reduce new-proposal volume by 50%; surface only highest-leverage decisions'
  } else if (days < 14) {
    state = 'stale'; posture = 'freeze new spend proposals; continue observation + reporting only'
  } else {
    state = 'frozen'; posture = 'all autonomous activity paused except liveness checks + alert generation'
  }
  // Pending approvals: count of code_proposals in 'proposed' status as a proxy
  const pending = await db.select({ n: sql<number>`count(*)::int` })
    .from(events)
    .where(and(eq(events.workspaceId, workspaceId), eq(events.type, 'proposal.created'),
               gte(events.createdAt, Date.now() - 30 * 86_400_000)))
  return {
    daysSinceLastApproval: Math.round(days * 10) / 10,
    state,
    recommendedPosture:    posture,
    pendingApprovalsCount: Number(pending[0]?.n ?? 0),
  }
}
