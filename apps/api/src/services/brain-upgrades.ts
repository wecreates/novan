/**
 * brain-upgrades.ts — R146.88 — brain decision-layer gaps closed:
 *  showYourWork, classifySituation, bridgeMemory, detectStuckLoop, captureCorrection
 */
import { db } from '../db/client.js'
import { events, memories, reasoningChains } from '../db/schema.js'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

export type Situation = 'research' | 'execution' | 'diagnostic' | 'planning' | 'conversation'

/** Classify a task into a situation type. Cheap heuristic — first-pass guide
 *  for prompt selection. The brain can override via explicit situation hint. */
export function classifySituation(task: string): { situation: Situation; confidence: number; signals: string[] } {
  const t = task.toLowerCase()
  const signals: string[] = []
  let scores: Record<Situation, number> = { research: 0, execution: 0, diagnostic: 0, planning: 0, conversation: 0 }
  const tally = (s: Situation, w: number, sig: string) => { scores[s] += w; signals.push(sig) }
  if (/\b(why|how|what is|explain|research|investigate|learn about)\b/.test(t)) tally('research', 2, 'has research verb')
  if (/\b(do|run|execute|publish|deploy|send|post|generate|create|build)\b/.test(t)) tally('execution', 2, 'has execute verb')
  if (/\b(error|broken|fail|crash|stuck|not working|debug|fix)\b/.test(t)) tally('diagnostic', 3, 'has problem signal')
  if (/\b(plan|strategy|propose|design|outline|roadmap|next steps?)\b/.test(t)) tally('planning', 2, 'has planning verb')
  if (/\?/.test(t) && t.length < 80) tally('conversation', 1, 'short question')
  if (/\bbusiness\.|portfolio\.|connector\./.test(t)) tally('execution', 1, 'invokes operational op')
  const sorted = (Object.entries(scores) as Array<[Situation, number]>).sort((a, b) => b[1] - a[1])
  const top = sorted[0]!
  const total = sorted.reduce((s, [, v]) => s + v, 0) || 1
  return { situation: top[0], confidence: top[1] / total, signals }
}

/** Show-your-work: surface the reasoning chain for a plan so operator can
 *  inspect *why* the brain chose each step before approving execution. */
export async function explainPlan(input: {
  workspaceId: string
  task: string
  plan: Array<{ op: string; params: Record<string, unknown> }>
}): Promise<{ task: string; situation: Situation; rationale: string; perStep: Array<{ op: string; why: string }> }> {
  const { situation } = classifySituation(input.task)
  const perStep = input.plan.map(s => ({
    op: s.op,
    why: heuristicWhy(s.op, input.task, situation),
  }))
  const rationale = `Task classified as ${situation}. Plan emits ${input.plan.length} step(s): ${input.plan.map(s => s.op).join(' → ')}. Each step links back to a playbook section where applicable; high-risk ops gated on OPERATOR_APPROVED.`
  await db.insert(events).values({
    id: uuidv7(), type: 'brain.show_your_work', workspaceId: input.workspaceId,
    payload: { task: input.task.slice(0, 200), situation, perStep },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'brain-upgrades', version: 1, createdAt: Date.now(),
  }).catch(() => null)
  return { task: input.task, situation, rationale, perStep }
}

function heuristicWhy(op: string, task: string, situation: Situation): string {
  if (op.startsWith('db.')) return `read-only diagnostic — gathering signal for ${situation}`
  if (op.startsWith('web.fetch') || op.startsWith('browser.')) return 'fetch external evidence before planning'
  if (op.startsWith('experiment.')) return 'log claim as falsifiable so we can measure outcome later'
  if (op.startsWith('hypothesis.')) return 'capture belief for calibration tracking'
  if (op.startsWith('ceo.')) return 'strategic-layer decision needs cross-business view'
  if (op.startsWith('playbook.')) return 'consult curated operator knowledge before committing'
  if (op.startsWith('business.')) return `business-lifecycle op aligned to task: ${task.slice(0, 60)}`
  if (op.startsWith('connector.')) return 'connector setup or scope query'
  return `step required by ${situation} cadence`
}

/** Cross-business memory bridge: surface memories from OTHER businesses
 *  that match the current business's industry/stage. Lessons from biz A
 *  shouldn't die in biz A's memory silo. */
export async function bridgeMemories(input: {
  workspaceId: string
  fromBusinessId: string
  topic: string
  limit?: number
}): Promise<Array<{ id: string; sourceBusinessId: string | null; summary: string; tags: string[] }>> {
  const lim = Math.min(20, Math.max(1, input.limit ?? 5))
  // Naive but useful: read recent memories tagged with the topic and not
  // from the current business; cap.
  const rows = await db.select().from(memories)
    .where(and(
      eq(memories.workspaceId, input.workspaceId),
      sql`array_to_string(tags, ',') ilike ${'%' + input.topic.toLowerCase() + '%'}`,
    ))
    .orderBy(desc(memories.updatedAt))
    .limit(lim * 3)
  return rows
    .filter(r => r.sourceRef !== input.fromBusinessId)
    .slice(0, lim)
    .map(r => ({
      id:               r.id,
      sourceBusinessId: r.sourceRef ?? null,
      summary:          (r.summary ?? r.content ?? '').slice(0, 400),
      tags:             (r.tags as string[] | null) ?? [],
    }))
}

/** Stuck-loop detector: scan recent reasoning chains for the same op+args
 *  loop OR repeated failures in the same subsystem. */
export async function detectStuckLoop(workspaceId: string, opts: { windowMinutes?: number } = {}): Promise<{
  inLoop: boolean
  loopType: 'none' | 'identical-op' | 'repeated-failure' | 'no-progress'
  evidence: string[]
  recommendedEscalation: string | null
}> {
  const winMs = (opts.windowMinutes ?? 60) * 60_000
  const since = Date.now() - winMs
  const recent = await db.select().from(events)
    .where(and(eq(events.workspaceId, workspaceId), gte(events.createdAt, since)))
    .orderBy(desc(events.createdAt))
    .limit(200)
  const ops = recent
    .filter(r => r.type === 'brain_task.op_completed' || r.type === 'brain_task.op_failed')
    .map(r => ({ type: r.type, op: ((r.payload as Record<string, unknown>)?.['op'] as string) ?? '' }))
  const counts: Record<string, number> = {}
  for (const o of ops) counts[o.op] = (counts[o.op] ?? 0) + 1
  const topOp = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  if (topOp && topOp[1] >= 5) {
    return {
      inLoop: true, loopType: 'identical-op',
      evidence: [`op '${topOp[0]}' executed ${topOp[1]} times in the last ${opts.windowMinutes ?? 60}m`],
      recommendedEscalation: `surface to operator: brain is repeatedly trying '${topOp[0]}' — likely missing precondition or wrong tool`,
    }
  }
  const failures = ops.filter(o => o.type === 'brain_task.op_failed')
  const failRate = ops.length > 0 ? failures.length / ops.length : 0
  if (ops.length >= 10 && failRate >= 0.5) {
    return {
      inLoop: true, loopType: 'repeated-failure',
      evidence: [`${failures.length}/${ops.length} ops failed in last ${opts.windowMinutes ?? 60}m (rate=${failRate.toFixed(2)})`],
      recommendedEscalation: 'pause autonomous loop; surface failure cluster for operator review',
    }
  }
  return { inLoop: false, loopType: 'none', evidence: [], recommendedEscalation: null }
}

/** Capture operator correction as high-priority training signal —
 *  written to reasoning_chains + memories so it persists. */
export async function captureCorrection(input: {
  workspaceId: string
  originalClaim: string
  operatorCorrection: string
  context?: string
}): Promise<{ id: string }> {
  const id = uuidv7()
  const now = Date.now()
  await db.insert(reasoningChains).values({
    id, workspaceId: input.workspaceId,
    kind: 'decision',
    subjectId: 'operator-correction',
    decision: `OPERATOR CORRECTED: "${input.originalClaim.slice(0, 200)}" → "${input.operatorCorrection.slice(0, 400)}"`,
    evidence: [{ type: 'operator-feedback', extract: (input.context ?? '').slice(0, 300) }],
    confidence: 0.99,
    source: 'operator',
    createdAt: now,
  }).catch(() => null)
  await db.insert(memories).values({
    workspaceId: input.workspaceId,
    type: 'lesson' as const,
    content: `${input.originalClaim} | corrected to: ${input.operatorCorrection}`,
    summary: input.operatorCorrection.slice(0, 200),
    confidence: 0.99,
    tags: ['operator-correction', 'high-priority'],
    source: 'operator',
    sourceRef: (input.context ?? '').slice(0, 200),
    createdAt: now, updatedAt: now,
  }).catch(() => null)
  await db.insert(events).values({
    id: uuidv7(), type: 'brain.operator_correction', workspaceId: input.workspaceId,
    payload: { original: input.originalClaim.slice(0, 200), correction: input.operatorCorrection.slice(0, 200) },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'brain-upgrades', version: 1, createdAt: now,
  }).catch(() => null)
  return { id }
}
