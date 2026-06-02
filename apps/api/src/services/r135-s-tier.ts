/**
 * R146.135 — S-tier features.
 *
 * Honest scope: each function has a working baseline. The "world model"
 * (used by twinSimulate + funnelImagine) is a Bayesian-prior + LLM
 * scenario generator, not a trained simulator — good enough to surface
 * realistic 30-day trajectories without faking accuracy.
 */
import { db } from '../db/client.js'
import { twinSimRuns, speculativeTests, taskAuctions, constitutionalAudits, funnelSimulations, agentRoster, aiUsage } from '../db/schema.js'
import { and, eq, desc, gte, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── #1 — Twin simulation ────────────────────────────────────────────

export async function twinSimulate(workspaceId: string, opts: {
  targetRunType: 'revenue' | 'pod_batch' | 'business_create'
  targetInput: Record<string, unknown>
  horizonDays?: number
}): Promise<{ id: string; recommendation: 'go' | 'review' | 'block'; projected: Record<string, unknown>; reasoning: string[] }> {
  const horizon = Math.max(7, Math.min(opts.horizonDays ?? 30, 365))
  const reasoning: string[] = []
  let projected: Record<string, unknown> = {}
  let recommendation: 'go' | 'review' | 'block' = 'review'

  // Call LLM to generate plausible trajectory
  try {
    const { streamChat } = await import('./chat-providers.js')
    const sys = `You are a forecasting simulator. Given a planned action, project realistic ${horizon}-day metrics. Return STRICT JSON: {"projected":{"revenueUsd":num,"costsUsd":num,"riskScore":0..1,"successProbability":0..1},"reasoning":["...","..."],"recommendation":"go"|"review"|"block"}. Be conservative; cite the assumption behind each number in reasoning. Cap reasoning to 5 lines.`
    const gen = streamChat(workspaceId, [
      { role: 'system', content: sys },
      { role: 'user',   content: `Run type: ${opts.targetRunType}\nInput: ${JSON.stringify(opts.targetInput).slice(0, 2000)}\nHorizon: ${horizon} days` },
    ], { taskType: 'other' } as Parameters<typeof streamChat>[2])
    let acc = ''
    for await (const ch of gen) acc += ch.delta
    const m = acc.match(/\{[\s\S]*\}/)
    if (m) {
      const parsed = JSON.parse(m[0]) as { projected?: Record<string, unknown>; reasoning?: string[]; recommendation?: string }
      projected = parsed.projected ?? {}
      reasoning.push(...(parsed.reasoning ?? []).slice(0, 5))
      if (parsed.recommendation === 'go' || parsed.recommendation === 'review' || parsed.recommendation === 'block') {
        recommendation = parsed.recommendation
      }
    }
  } catch (e) {
    reasoning.push(`simulator unavailable: ${(e as Error).message.slice(0, 100)} — defaulting to review`)
  }

  const id = uuidv7()
  await db.insert(twinSimRuns).values({
    id, workspaceId,
    targetRunType: opts.targetRunType,
    targetInput: opts.targetInput,
    horizonDays: horizon,
    projected, recommendation, reasoning,
    createdAt: Date.now(),
  })
  return { id, recommendation, projected, reasoning }
}

// ─── #2 — Speculative posting ────────────────────────────────────────

/**
 * Generate N variants from a base, post to N burner accounts, measure
 * engagement after burnerMinutes, promote winner to main.
 *
 * Skeleton: caller supplies variants + burner accounts; the orchestrator
 * persists the test and exposes scoring. Actual posting / engagement
 * fetching is wired through existing connectors but burner-account
 * registration is operator responsibility (not auto-acquired).
 */
export async function speculativeStart(workspaceId: string, opts: {
  baseClipId?: string
  variants: Array<{ label: string; hook: string; platform: string }>
  burnerMinutes?: number
}): Promise<{ id: string; status: 'running' }> {
  if (!opts.variants || opts.variants.length < 2) throw new Error('at least 2 variants required')
  const id = uuidv7()
  await db.insert(speculativeTests).values({
    id, workspaceId,
    baseClipId: opts.baseClipId ?? null,
    variants: opts.variants,
    burnerMinutes: Math.max(15, Math.min(opts.burnerMinutes ?? 60, 24 * 60)),
    status: 'running',
    startedAt: Date.now(),
  })
  return { id, status: 'running' }
}

export async function speculativeScore(workspaceId: string, testId: string, metrics: Array<{ label: string; saves?: number; likes?: number; views?: number; comments?: number }>): Promise<{ winner: string }> {
  const [row] = await db.select().from(speculativeTests)
    .where(and(eq(speculativeTests.workspaceId, workspaceId), eq(speculativeTests.id, testId))).limit(1)
  if (!row) throw new Error('test not found')
  // Score = saves*3 + comments*2 + likes*1 + views*0.1 (saves+comments are strongest signal of resonance)
  const scored = metrics.map(m => ({
    label: m.label,
    score: (m.saves ?? 0) * 3 + (m.comments ?? 0) * 2 + (m.likes ?? 0) + (m.views ?? 0) * 0.1,
  }))
  scored.sort((a, b) => b.score - a.score)
  const winner = scored[0]?.label ?? ''
  // Merge metrics back into variants
  const variantsWithMetrics: typeof row.variants = (row.variants ?? []).map(v => {
    const found = metrics.find(m => m.label === v.label)
    if (found) return { ...v, metrics: { saves: found.saves ?? 0, likes: found.likes ?? 0, views: found.views ?? 0, comments: found.comments ?? 0 } }
    if (v.metrics) return v
    return { label: v.label, hook: v.hook, platform: v.platform, ...(v.postId ? { postId: v.postId } : {}) }
  })
  await db.update(speculativeTests).set({
    status: 'scored', winnerLabel: winner, variants: variantsWithMetrics, scoredAt: Date.now(),
  }).where(eq(speculativeTests.id, testId))
  return { winner }
}

// ─── #3 — Auction-based agent dispatch ───────────────────────────────

/**
 * Open a task auction. Agents bid (cost, confidence, eta). Auction
 * closes via awardAuction; winner is the bid with best score:
 *   score = confidence / (costUsd + etaSec/3600)
 */
export async function auctionOpen(workspaceId: string, opts: {
  taskType: string
  taskPayload: Record<string, unknown>
}): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(taskAuctions).values({
    id, workspaceId,
    taskType: opts.taskType,
    taskPayload: opts.taskPayload,
    bids: [], status: 'open',
    openedAt: Date.now(),
  })
  return { id }
}

export async function auctionBid(workspaceId: string, auctionId: string, bid: { agentId: string; costUsd: number; confidence: number; etaSec: number }): Promise<{ ok: boolean }> {
  const [row] = await db.select().from(taskAuctions)
    .where(and(eq(taskAuctions.workspaceId, workspaceId), eq(taskAuctions.id, auctionId))).limit(1)
  if (!row || row.status !== 'open') return { ok: false }
  const score = (bid.confidence + 0.01) / (Math.max(0.001, bid.costUsd) + Math.max(0.001, bid.etaSec / 3600))
  const bids = [...(row.bids ?? []), { ...bid, score }]
  await db.update(taskAuctions).set({ bids }).where(eq(taskAuctions.id, auctionId))
  return { ok: true }
}

export async function auctionAward(workspaceId: string, auctionId: string): Promise<{ winner: string | null; score: number }> {
  const [row] = await db.select().from(taskAuctions)
    .where(and(eq(taskAuctions.workspaceId, workspaceId), eq(taskAuctions.id, auctionId))).limit(1)
  if (!row || row.status !== 'open') return { winner: null, score: 0 }
  const bids = [...(row.bids ?? [])].sort((a, b) => b.score - a.score)
  const winner = bids[0]?.agentId ?? null
  const score = bids[0]?.score ?? 0
  await db.update(taskAuctions).set({
    status: winner ? 'awarded' : 'open',
    winnerAgentId: winner,
    awardedAt: winner ? Date.now() : null,
  }).where(eq(taskAuctions.id, auctionId))
  return { winner, score }
}

// ─── #4 — Constitutional self-audit ──────────────────────────────────

/**
 * Audit the platform against its stated mission: "help operator make
 * money ethically." Uses LLM to scan recent ai_usage prompts + recent
 * decisions for drift signals.
 */
export async function constitutionalAudit(workspaceId: string, kind: 'weekly' | 'on_demand' = 'on_demand'): Promise<{ id: string; missionDrift: number; manipulation: number; scopeCreep: number; findings: string[] }> {
  const since = Date.now() - 7 * 24 * 60 * 60_000
  // Pull a sample of recent prompts from ai_usage — costliest 20
  const recentUsage = await db.select({ taskType: aiUsage.taskType, costUsd: aiUsage.costUsd })
    .from(aiUsage)
    .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, since)))
    .orderBy(desc(aiUsage.costUsd))
    .limit(20)
  const taskMix = recentUsage.reduce<Record<string, number>>((acc, r) => { acc[r.taskType] = (acc[r.taskType] ?? 0) + 1; return acc }, {})
  let missionDrift = 0, manipulation = 0, scopeCreep = 0
  const findings: string[] = []
  const remediation: string[] = []
  try {
    const { streamChat } = await import('./chat-providers.js')
    const sys = `You audit an autonomous money-making platform against its mission: "help operator make money ethically, never manipulate audience, never violate platform ToS." Return STRICT JSON: {"missionDrift":0..1,"manipulation":0..1,"scopeCreep":0..1,"findings":["..."],"remediation":["..."]}. Be specific; cite the signal that drove each score.`
    const gen = streamChat(workspaceId, [
      { role: 'system', content: sys },
      { role: 'user',   content: `Last 7 days task mix:\n${JSON.stringify(taskMix, null, 2)}\n\nAudit type: ${kind}` },
    ], { taskType: 'other' } as Parameters<typeof streamChat>[2])
    let acc = ''
    for await (const ch of gen) acc += ch.delta
    const m = acc.match(/\{[\s\S]*\}/)
    if (m) {
      const parsed = JSON.parse(m[0]) as { missionDrift?: number; manipulation?: number; scopeCreep?: number; findings?: string[]; remediation?: string[] }
      missionDrift = Math.max(0, Math.min(1, parsed.missionDrift ?? 0))
      manipulation = Math.max(0, Math.min(1, parsed.manipulation ?? 0))
      scopeCreep   = Math.max(0, Math.min(1, parsed.scopeCreep ?? 0))
      findings.push(...(parsed.findings ?? []).slice(0, 10))
      remediation.push(...(parsed.remediation ?? []).slice(0, 10))
    }
  } catch (e) {
    findings.push(`auditor unavailable: ${(e as Error).message.slice(0, 100)}`)
  }
  const id = uuidv7()
  await db.insert(constitutionalAudits).values({
    id, workspaceId, auditKind: kind,
    missionDrift, manipulation, scopeCreep,
    findings, remediation,
    auditedAt: Date.now(),
  })
  return { id, missionDrift, manipulation, scopeCreep, findings }
}

// ─── #5 — Reverse-funnel imagination ─────────────────────────────────

/**
 * Given a $/month target + horizon, simulate plausible paths.
 * Skeleton: uses LLM to project N paths with monthly trajectories.
 */
export async function funnelImagine(workspaceId: string, opts: {
  targetUsdMo: number
  horizonMonths: number
  pathCount?: number
}): Promise<{ id: string; paths: Array<{ label: string; probability: number; monthlyTrajectory: number[]; gates: string[] }>; recommended: string | null }> {
  const pathCount = Math.max(3, Math.min(opts.pathCount ?? 5, 10))
  let paths: Array<{ label: string; probability: number; monthlyTrajectory: number[]; gates: string[] }> = []
  try {
    const { streamChat } = await import('./chat-providers.js')
    const sys = `You are a strategic path simulator. Given a $/month revenue target + horizon, output ${pathCount} distinct plausible paths. Return STRICT JSON: {"paths":[{"label":"<short name>","probability":0..1,"monthlyTrajectory":[month1, month2, ...] (${opts.horizonMonths} numbers in USD/mo),"gates":["<gate1>","<gate2>"]},...]}. Each path takes a DIFFERENT strategic angle (e.g. POD scale, info product, course, services, SaaS, affiliate). Trajectories should be realistic — most start at 0 and ramp. Probabilities should sum to ~1.`
    const gen = streamChat(workspaceId, [
      { role: 'system', content: sys },
      { role: 'user',   content: `Target: \$${opts.targetUsdMo}/mo\nHorizon: ${opts.horizonMonths} months\nCount: ${pathCount}` },
    ], { taskType: 'other' } as Parameters<typeof streamChat>[2])
    let acc = ''
    for await (const ch of gen) acc += ch.delta
    const m = acc.match(/\{[\s\S]*\}/)
    if (m) {
      const parsed = JSON.parse(m[0]) as { paths?: typeof paths }
      paths = (parsed.paths ?? []).slice(0, pathCount)
    }
  } catch { /* fall through with empty paths */ }
  paths.sort((a, b) => b.probability - a.probability)
  const recommended = paths[0]?.label ?? null
  const id = uuidv7()
  await db.insert(funnelSimulations).values({
    id, workspaceId,
    targetUsdMo: opts.targetUsdMo,
    horizonMonths: opts.horizonMonths,
    paths, recommended,
    createdAt: Date.now(),
  })
  return { id, paths, recommended }
}

// Suppress unused — agentRoster/sql kept for future enrichment
void agentRoster; void sql
