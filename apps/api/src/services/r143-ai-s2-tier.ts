/**
 * R146.143 — S-tier round 2 (features 21-25):
 * RAG pipeline, workflow checkpointing, self-supervised finetune,
 * voice agent, MCP server registration.
 */
import { db } from '../db/client.js'
import { workflows, agentWorkflowRuns, finetuneCycles, voiceChatSessions, mcpClients } from '../db/schema.js'
import { and, eq, desc } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { createHash } from 'crypto'

// ─── #21 — RAG pipeline ──────────────────────────────────────────────

/**
 * Streams chat with auto-RAG: pulls top-k memory chunks relevant to
 * last user message, prepends them as system context. Caller passes a
 * topic hint to scope retrieval; if omitted, last user message is used.
 */
export async function ragChat(workspaceId: string, opts: {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  topic?: string
  k?: number
}): Promise<{ text: string; chunksUsed: number }> {
  const lastUser = [...opts.messages].reverse().find(m => m.role === 'user')
  const query = opts.topic ?? lastUser?.content ?? ''
  const k = Math.max(1, Math.min(opts.k ?? 5, 20))
  let chunksUsed = 0
  let injected: typeof opts.messages = [...opts.messages]
  if (query) {
    try {
      const { memoryRecall } = await import('./r139-ai-foundation.js')
      const hits = await memoryRecall(workspaceId, { query, k })
      if (hits.length > 0) {
        const ctx = hits.map((h, i) => `[${i+1}] (${h.sourceType}) ${h.content.slice(0, 400)}`).join('\n\n')
        injected = [{ role: 'system' as const, content: `[RAG CONTEXT — top ${hits.length} relevant memory chunks for this query]\n\n${ctx}\n\n[END RAG CONTEXT]` }, ...opts.messages]
        chunksUsed = hits.length
      }
    } catch { /* memory unavailable */ }
  }
  const { streamChat } = await import('./chat-providers.js')
  const gen = streamChat(workspaceId, injected, { taskType: 'chat' } as Parameters<typeof streamChat>[2])
  let text = ''
  for await (const ch of gen) text += ch.delta
  return { text, chunksUsed }
}

// ─── #22 — Workflow checkpointing ────────────────────────────────────

export async function workflowDefine(workspaceId: string, opts: {
  name: string
  steps: Array<{ name: string; opName: string; params: Record<string, unknown>; retryOn?: string }>
}): Promise<{ id: string }> {
  if (!opts.steps || opts.steps.length === 0) throw new Error('at least 1 step required')
  const id = uuidv7()
  await db.insert(workflows).values({
    id, workspaceId,
    name: opts.name.slice(0, 240),
    steps: opts.steps.slice(0, 50),
    createdAt: Date.now(),
  })
  return { id }
}

export async function workflowStart(workspaceId: string, workflowId: string): Promise<{ runId: string; status: string }> {
  const runId = uuidv7()
  const now = Date.now()
  await db.insert(agentWorkflowRuns).values({
    id: runId, workspaceId, workflowId,
    currentStep: 0, stepOutputs: [],
    status: 'running',
    startedAt: now, updatedAt: now,
  })
  // Fire async runner
  void workflowAdvance(workspaceId, runId).catch(() => null)
  return { runId, status: 'running' }
}

/**
 * Advance a workflow run one step (idempotent). Used by both the
 * initial fire-and-forget and external resume calls.
 */
export async function workflowAdvance(workspaceId: string, runId: string): Promise<{ status: string; currentStep: number; error?: string }> {
  const [run] = await db.select().from(agentWorkflowRuns)
    .where(and(eq(agentWorkflowRuns.workspaceId, workspaceId), eq(agentWorkflowRuns.id, runId))).limit(1)
  if (!run) throw new Error('run not found')
  if (run.status !== 'running' && run.status !== 'paused') return { status: run.status, currentStep: run.currentStep }
  const [wf] = await db.select().from(workflows).where(eq(workflows.id, run.workflowId)).limit(1)
  if (!wf) {
    await db.update(agentWorkflowRuns).set({ status: 'failed', error: 'workflow not found', updatedAt: Date.now() }).where(eq(agentWorkflowRuns.id, runId))
    return { status: 'failed', currentStep: run.currentStep, error: 'workflow not found' }
  }
  const steps = wf.steps ?? []
  let { currentStep, stepOutputs } = run
  while (currentStep < steps.length) {
    const step = steps[currentStep]!
    const { OPERATIONS } = await import('./brain-task.js')
    const opDef = (OPERATIONS as Record<string, { handler: (ws: string, p: Record<string, unknown>) => Promise<unknown> } | undefined>)[step.opName]
    if (!opDef) {
      const err = `op ${step.opName} not found`
      stepOutputs.push({ stepName: step.name, ok: false, error: err })
      await db.update(agentWorkflowRuns).set({ status: 'failed', error: err, stepOutputs, currentStep, updatedAt: Date.now() }).where(eq(agentWorkflowRuns.id, runId))
      return { status: 'failed', currentStep, error: err }
    }
    try {
      const result = await opDef.handler(workspaceId, step.params)
      stepOutputs.push({ stepName: step.name, ok: true, result })
      currentStep++
      await db.update(agentWorkflowRuns).set({ stepOutputs, currentStep, updatedAt: Date.now() }).where(eq(agentWorkflowRuns.id, runId))
    } catch (e) {
      const err = (e as Error).message.slice(0, 500)
      stepOutputs.push({ stepName: step.name, ok: false, error: err })
      await db.update(agentWorkflowRuns).set({ status: 'failed', error: err, stepOutputs, currentStep, updatedAt: Date.now() }).where(eq(agentWorkflowRuns.id, runId))
      return { status: 'failed', currentStep, error: err }
    }
  }
  await db.update(agentWorkflowRuns).set({ status: 'completed', updatedAt: Date.now() }).where(eq(agentWorkflowRuns.id, runId))
  return { status: 'completed', currentStep }
}

export async function workflowList(workspaceId: string): Promise<Array<typeof workflows.$inferSelect>> {
  return db.select().from(workflows).where(eq(workflows.workspaceId, workspaceId)).orderBy(desc(workflows.createdAt)).limit(100)
}

export async function workflowRunList(workspaceId: string, limit = 30): Promise<Array<typeof agentWorkflowRuns.$inferSelect>> {
  return db.select().from(agentWorkflowRuns).where(eq(agentWorkflowRuns.workspaceId, workspaceId))
    .orderBy(desc(agentWorkflowRuns.startedAt)).limit(Math.min(limit, 100))
}

// ─── #23 — Self-supervised fine-tune cycle ───────────────────────────

/**
 * Kick off the full cycle: distill assemble → finetune submit → register
 * for A/B vs baseline (manual approval before promotion).
 *
 * Honest scope: cycle row tracks state; intermediate steps are existing
 * R136/R142 ops. Cron + auto-promotion based on A/B win is future work.
 */
export async function finetuneCycleStart(workspaceId: string, opts: {
  baseModel: string
  distillKind: 'proposals' | 'decisions' | 'rejections' | 'patches'
}): Promise<{ id: string; status: string; distillDatasetId?: string; finetuneJobId?: string; error?: string }> {
  const id = uuidv7()
  const now = Date.now()
  // Step 1: assemble
  const { distillAssemble } = await import('./r136-a-tier.js')
  const distill = await distillAssemble(workspaceId, opts.distillKind).catch(() => null)
  if (!distill || distill.sampleCount === 0) {
    await db.insert(finetuneCycles).values({
      id, workspaceId, baseModel: opts.baseModel,
      status: 'no_data', createdAt: now, updatedAt: now,
    })
    return { id, status: 'no_data', error: 'distillation yielded zero samples' }
  }
  // Step 2: submit fine-tune
  const { finetuneSubmit } = await import('./r142-ai-c-tier.js')
  const ft = await finetuneSubmit(workspaceId, { provider: 'openai', baseModel: opts.baseModel, datasetPath: distill.jsonlPath })
  await db.insert(finetuneCycles).values({
    id, workspaceId,
    baseModel: opts.baseModel,
    distillDatasetId: distill.id,
    finetuneJobId: ft.id,
    status: ft.status,
    createdAt: now, updatedAt: now,
  })
  return { id, status: ft.status, distillDatasetId: distill.id, finetuneJobId: ft.id }
}

export async function finetuneCycleList(workspaceId: string): Promise<Array<typeof finetuneCycles.$inferSelect>> {
  return db.select().from(finetuneCycles).where(eq(finetuneCycles.workspaceId, workspaceId))
    .orderBy(desc(finetuneCycles.createdAt)).limit(100)
}

// ─── #24 — Voice agent ───────────────────────────────────────────────

/**
 * Opens a voice session for full-duplex voice chat. Browser-side does
 * STT via Web Speech API + TTS via existing voice service.
 *
 * This op manages the persistent session record; live streaming
 * happens over the existing /api/v1/chat/stream SSE pipe.
 */
export async function voiceSessionOpen(workspaceId: string): Promise<{ sessionId: string }> {
  const id = uuidv7()
  await db.insert(voiceChatSessions).values({
    id, workspaceId,
    transcript: '',
    status: 'open',
    startedAt: Date.now(),
  })
  return { sessionId: id }
}

export async function voiceSessionAppend(workspaceId: string, opts: { sessionId: string; text: string; role: 'user' | 'assistant' }): Promise<{ ok: boolean }> {
  const [row] = await db.select().from(voiceChatSessions)
    .where(and(eq(voiceChatSessions.workspaceId, workspaceId), eq(voiceChatSessions.id, opts.sessionId))).limit(1)
  if (!row) return { ok: false }
  const newTranscript = `${row.transcript}\n${opts.role}: ${opts.text}`.slice(0, 100_000)
  await db.update(voiceChatSessions).set({ transcript: newTranscript }).where(eq(voiceChatSessions.id, opts.sessionId))
  return { ok: true }
}

export async function voiceSessionClose(workspaceId: string, sessionId: string): Promise<{ ok: boolean }> {
  await db.update(voiceChatSessions).set({ status: 'closed', endedAt: Date.now() })
    .where(and(eq(voiceChatSessions.workspaceId, workspaceId), eq(voiceChatSessions.id, sessionId)))
  return { ok: true }
}

// ─── #25 — MCP server registration ───────────────────────────────────

/**
 * Issue an API key for an external MCP client (Claude Desktop, ChatGPT)
 * to drive Novan brain ops. Operator restricts which op prefixes the
 * client can call.
 */
export async function mcpRegisterClient(workspaceId: string, opts: {
  name: string
  allowedOps: string[]      // e.g. ['memory.*', 'autonomy.counts']
}): Promise<{ id: string; apiKey: string }> {
  const id = uuidv7()
  const apiKey = `novan-mcp-${uuidv7().replace(/-/g, '').slice(0, 32)}`
  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex')
  await db.insert(mcpClients).values({
    id, workspaceId,
    name: opts.name.slice(0, 120),
    apiKeyHash,
    allowedOps: opts.allowedOps.slice(0, 30),
    createdAt: Date.now(),
  })
  return { id, apiKey }
}

export async function mcpClientList(workspaceId: string): Promise<Array<{ id: string; name: string; allowedOps: string[]; lastUsedAt: number | null; createdAt: number }>> {
  const rows = await db.select().from(mcpClients).where(eq(mcpClients.workspaceId, workspaceId)).orderBy(desc(mcpClients.createdAt)).limit(100)
  return rows.map(r => ({ id: r.id, name: r.name, allowedOps: r.allowedOps, lastUsedAt: r.lastUsedAt, createdAt: r.createdAt }))
}

export async function mcpClientCheck(apiKey: string, opName: string): Promise<{ allowed: boolean; workspaceId?: string; clientId?: string }> {
  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex')
  const [row] = await db.select().from(mcpClients).where(eq(mcpClients.apiKeyHash, apiKeyHash)).limit(1)
  if (!row) return { allowed: false }
  for (const pat of row.allowedOps ?? []) {
    if (pat === '*' || pat === opName || (pat.endsWith('*') && opName.startsWith(pat.slice(0, -1)))) {
      db.update(mcpClients).set({ lastUsedAt: Date.now() }).where(eq(mcpClients.id, row.id)).catch(() => null)
      return { allowed: true, workspaceId: row.workspaceId, clientId: row.id }
    }
  }
  return { allowed: false, workspaceId: row.workspaceId, clientId: row.id }
}
