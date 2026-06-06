/**
 * R146.215 — Brain agentic loop. The chatbot stops being one-shot
 * streamChat and becomes an iterative reasoner that can:
 *
 *   1. Auto-select a relevant skill (R206) before generating
 *   2. Auto-call low-risk brain ops INLINE during the response
 *      (high/critical risk ops are queued for operator approval as
 *      before via the brain-task code-block convention)
 *   3. Write salient facts to workspace_memory (R211) per turn
 *   4. Auto-mark a chapter when topic shifts hard
 *   5. Surface tool-use stream events so the operator sees the
 *      reasoning trace in real time
 *
 * Each turn = N tool steps + 1 final message. MAX_STEPS caps runaway.
 */
import { db } from '../db/client.js'
import { streamChat, type ChatMsg } from './chat-providers.js'
import { OPERATIONS } from './brain-task.js'
import { spawnSubagent } from './r208-subagent.js'
import { operatorSkillsAdvertisement, skillLoad, skillScore } from './r206-skills.js'
import { memoryRemember, memoryDigest, chapterMark } from './r211-workplace.js'
import { pickSkillSmart } from './r216-routing.js'
import { checkDailyCostCap } from './r248-cost-cap.js'
import { skillOutcomes } from '../db/schema.js'
import { v7 as uuidv7 } from 'uuid'

export interface BrainLoopOpts {
  conversationId?: string
  maxSteps?:       number
  autoSkill?:      boolean
  autoMemory?:     boolean
  autoChapter?:    boolean
}

export type BrainEvent =
  | { kind: 'delta';     text: string }
  | { kind: 'skill';     name: string; loaded: boolean }
  | { kind: 'tool_call'; op: string; params: unknown; queued?: boolean }
  | { kind: 'tool_done'; op: string; result?: unknown; error?: string }
  | { kind: 'chapter';   title: string }
  | { kind: 'memory';    key: string; value: string }
  | { kind: 'final';     content: string; steps: number; costUsd: number }

const TOOL_RE = /```brain-task\s+(\{[\s\S]*?\})\s+```/

const SKILL_PICKER_SCHEMA = {
  type: 'object',
  properties: {
    name:   { type: ['string', 'null'] },
    reason: { type: 'string' },
  },
  required: ['name', 'reason'],
}

const CHAPTER_SCHEMA = {
  type: 'object',
  properties: {
    shift:  { type: 'boolean' },
    title:  { type: 'string' },
  },
  required: ['shift', 'title'],
}

const MEMORY_SCHEMA = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key:        { type: 'string' },
          value:      { type: 'string' },
          scope:      { type: 'string' },
          importance: { type: 'integer', minimum: 0, maximum: 100 },
        },
        required: ['key', 'value'],
      },
    },
  },
  required: ['facts'],
}

/**
 * R216 — Smart skill pick: Thompson sampling first (exploits scored
 * history), LLM picker as cold-start fallback. Returns provenance so
 * caller can record outcome against the right picker.
 */
async function pickSkill(workspaceId: string, userMessage: string): Promise<{ name: string; instructions: string; via: 'thompson' | 'llm' } | null> {
  const ad = await operatorSkillsAdvertisement(workspaceId, 1500)
  if (!ad) return null
  const llmFallback = async (): Promise<string | null> => {
    const r = await spawnSubagent(workspaceId, {
      parentOp: 'brain.loop.skill_pick',
      task: 'skill_pick',
      maxOutputTokens: 300,
      prompt: `${ad}\n\nUser said: "${userMessage.slice(0, 1000)}"\n\n` +
              `Which single skill name (from the list above) BEST applies? Return ` +
              `{name, reason}. name=null if none clearly applies.`,
      schema: SKILL_PICKER_SCHEMA,
    })
    const picked = r.parsed as { name: string | null } | undefined
    return picked?.name ?? null
  }
  const r = await pickSkillSmart(workspaceId, llmFallback)
  if (!r.name || r.via === 'none') return null
  const skill = await skillLoad(workspaceId, r.name)
  if (!skill) return null
  return { name: r.name, instructions: skill.instructions, via: r.via as 'thompson' | 'llm' }
}

/**
 * After the turn, extract 0-3 facts worth remembering across sessions.
 * Returns the facts written.
 */
async function extractFacts(workspaceId: string, userMessage: string, assistantMessage: string): Promise<Array<{ key: string; value: string }>> {
  const r = await spawnSubagent(workspaceId, {
    parentOp: 'brain.loop.memory',
    prompt: `User: "${userMessage.slice(0, 800)}"\nAssistant: "${assistantMessage.slice(0, 1500)}"\n\n` +
            `Extract 0-3 SALIENT facts worth remembering across sessions (operator preferences, decisions, ` +
            `target numbers, named entities). Skip casual chitchat. Return {facts: [{key, value, scope?, importance?}]} ` +
            `where importance is 0-100 (default 50, decisions=80, preferences=60).`,
    schema: MEMORY_SCHEMA,
  })
  const out = r.parsed as { facts?: Array<{ key: string; value: string; scope?: string; importance?: number }> } | undefined
  const facts = out?.facts ?? []
  const written: Array<{ key: string; value: string }> = []
  for (const f of facts.slice(0, 3)) {
    if (!f.key || !f.value) continue
    await memoryRemember(workspaceId, { key: f.key.slice(0, 100), value: f.value.slice(0, 500), ...(f.scope ? { scope: f.scope } : {}), ...(f.importance !== undefined ? { importance: f.importance } : {}) })
    written.push({ key: f.key, value: f.value })
  }
  return written
}

/**
 * Detect a topic shift across the recent conversation; mark a chapter
 * if so. Returns the chapter title or null.
 */
async function detectChapterShift(workspaceId: string, recentMessages: ChatMsg[], conversationId?: string): Promise<string | null> {
  if (recentMessages.length < 4) return null
  const transcript = recentMessages.slice(-6).map(m => `${m.role}: ${m.content.slice(0, 200)}`).join('\n')
  const r = await spawnSubagent(workspaceId, {
    parentOp: 'brain.loop.chapter',
    prompt: `Recent conversation:\n${transcript}\n\nIs the topic in the LATEST messages substantially different from the earlier ones? ` +
            `If YES return {shift:true, title:"<3-5 word noun phrase>"}. Else {shift:false, title:""}.`,
    schema: CHAPTER_SCHEMA,
  })
  const v = r.parsed as { shift?: boolean; title?: string } | undefined
  if (!v?.shift || !v.title) return null
  await chapterMark(workspaceId, { title: v.title, ...(conversationId ? { conversationId } : {}) })
  return v.title
}

/** Pull the first brain-task code block out of a partial response. */
function extractToolCall(buffered: string): { op: string; params: Record<string, unknown>; rawBlockEnd: number } | null {
  const m = buffered.match(TOOL_RE)
  if (!m || m.index === undefined) return null
  try {
    const obj = JSON.parse(m[1]!) as { op?: string; params?: Record<string, unknown> }
    if (!obj.op) return null
    return { op: obj.op, params: obj.params ?? {}, rawBlockEnd: m.index + m[0]!.length }
  } catch {
    return null
  }
}

const SAFE_INLINE_RISK = new Set(['low'])  // only auto-run low-risk ops

/** Run a brain op safely + return result envelope. R238 — when the op
 *  is unknown, run op.search on its name and include the top 3 matches
 *  in the error so the model can self-correct in the next step. */
async function runOp(workspaceId: string, op: string, params: Record<string, unknown>): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const spec = OPERATIONS[op]
  if (!spec) {
    try {
      const { opSearch } = await import('./r207-op-search.js')
      const matches = opSearch(op, 3)
      const hint = matches.length > 0
        ? ` — did you mean: ${matches.map(m => m.op).join(', ')}?`
        : ''
      return { ok: false, error: `unknown op: ${op}${hint}` }
    } catch {
      return { ok: false, error: `unknown op: ${op}` }
    }
  }
  if (!SAFE_INLINE_RISK.has(spec.risk)) {
    return { ok: false, error: `op ${op} is risk=${spec.risk}; queued for operator approval` }
  }
  try {
    const result = await spec.handler(workspaceId, params)
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 500) }
  }
}

const SYS_BRAIN_LOOP = `You are Novan, an agentic platform with brain ops at your disposal.

When you need data, emit a brain-task block inline. Low-risk ops will be
EXECUTED IMMEDIATELY by the platform and the result injected into your
context — keep talking, observe the result, and continue reasoning.
Medium/high risk ops are QUEUED for operator approval and the operator
will run them; do not assume they ran.

Syntax (must match exactly):
\`\`\`brain-task
{"op":"<name>","params":{...}}
\`\`\`

Use op.search{query} to find ops without loading the full registry.
Use skill.load{name} if you need the full text of an advertised skill.
Use memory.kv.recall to pull stored workspace memories.

After every observed result, decide: another tool call, or final answer.
Max 5 tool calls per turn.`

/**
 * Main entry. Yields BrainEvent objects in order. Caller renders them
 * as SSE / WebSocket / log lines.
 */
export async function* runBrainLoop(
  workspaceId: string,
  messages:    ChatMsg[],
  opts:        BrainLoopOpts = {},
): AsyncGenerator<BrainEvent, void> {
  const maxSteps    = Math.max(1, Math.min(10, opts.maxSteps ?? 5))
  const autoSkill   = opts.autoSkill   !== false
  const autoMemory  = opts.autoMemory  !== false
  const autoChapter = opts.autoChapter !== false

  const userMessage = [...messages].reverse().find(m => m.role === 'user')?.content ?? ''

  // R146.250 — Cost cap gate. Hard short-circuit so autonomous loops
  // can't keep spawning sub-agents past the daily budget.
  const cap = await checkDailyCostCap(workspaceId).catch(() => null)
  if (cap?.over) {
    const msg = `_(daily AI budget exhausted: $${cap.spent.toFixed(2)} / $${cap.cap.toFixed(2)}. ` +
                `Raise DAILY_AI_COST_CAP_USD or wait for UTC day rollover.)_`
    yield { kind: 'delta', text: msg }
    yield { kind: 'final', content: msg, steps: 0, costUsd: 0 }
    return
  }

  // 1. Skill auto-pick (Thompson sampling → LLM fallback per R216)
  let extraSys = ''
  let pickedSkillName: string | undefined
  let pickedVia: 'thompson' | 'llm' | undefined
  if (autoSkill && userMessage) {
    const picked = await pickSkill(workspaceId, userMessage).catch(() => null)
    if (picked) {
      extraSys += `\n\nActivated skill «${picked.name}» — follow its instructions:\n${picked.instructions}`
      pickedSkillName = picked.name
      pickedVia = picked.via
      yield { kind: 'skill', name: picked.name, loaded: true }
    }
  }

  // 2. Memory digest (already injected by novan-chat.ts but loop callers may
  //    not go through that path — include defensively)
  const md = await memoryDigest(workspaceId, 1000).catch(() => '')
  if (md) extraSys += `\n\n${md}`

  // 3. Compose loop messages with brain-loop system prompt
  const loopMessages: ChatMsg[] = [
    { role: 'system', content: SYS_BRAIN_LOOP + extraSys },
    ...messages,
  ]

  let totalCost = 0
  let assistantFinal = ''

  for (let step = 0; step < maxSteps; step++) {
    let buffered = ''
    const gen = streamChat(workspaceId, loopMessages, { taskType: 'chat' })
    let resultEnvelope: { content: string; costUsd: number } | null = null
    while (true) {
      const next = await gen.next()
      if (next.done) {
        resultEnvelope = { content: next.value.content, costUsd: next.value.costUsd }
        totalCost += next.value.costUsd
        break
      }
      if (next.value.delta) {
        buffered += next.value.delta
        yield { kind: 'delta', text: next.value.delta }
      }
    }

    const content = resultEnvelope?.content ?? buffered
    const tool = extractToolCall(content)
    if (!tool) {
      // No tool call → this is the final answer.
      assistantFinal = content
      break
    }

    // Tool call detected
    const spec = OPERATIONS[tool.op]
    const queued = !spec || !SAFE_INLINE_RISK.has(spec.risk)
    yield { kind: 'tool_call', op: tool.op, params: tool.params, queued }

    if (queued) {
      // Don't execute. Final answer is whatever the assistant already produced,
      // including the brain-task code block — operator will confirm.
      assistantFinal = content
      break
    }

    // Execute and inject result for next step.
    const r = await runOp(workspaceId, tool.op, tool.params)
    yield { kind: 'tool_done', op: tool.op, ...(r.ok ? { result: r.result } : { error: r.error }) }

    const observation = r.ok
      ? `Observation from ${tool.op}: ${JSON.stringify(r.result).slice(0, 4000)}`
      : `Observation from ${tool.op}: ERROR ${r.error}`
    // Append assistant turn + tool-observation as a new user turn so the
    // next streamChat call sees both.
    loopMessages.push({ role: 'assistant', content })
    loopMessages.push({ role: 'user',      content: observation + '\n\nContinue.' })
  }

  // 4. Post-turn: memory write-back + chapter detection
  if (autoMemory && userMessage && assistantFinal) {
    const written = await extractFacts(workspaceId, userMessage, assistantFinal).catch(() => [])
    for (const f of written) yield { kind: 'memory', key: f.key, value: f.value }
  }
  if (autoChapter) {
    const title = await detectChapterShift(workspaceId, messages, opts.conversationId).catch(() => null)
    if (title) yield { kind: 'chapter', title }
  }

  // 5. R216 — skill outcome scoring. A turn that produced a final answer
  // without erroring out is treated as a win. A future enhancement can
  // accept explicit operator feedback to override.
  if (pickedSkillName) {
    const won = assistantFinal.length > 0 && !assistantFinal.startsWith('_(no provider')
    await skillScore(workspaceId, pickedSkillName, won).catch(() => null)
    await db.insert(skillOutcomes).values({
      id: uuidv7(), workspaceId, skillName: pickedSkillName,
      picker: pickedVia ?? 'unknown', won,
      costUsd: totalCost,
      stepsUsed: maxSteps,
      context: userMessage.slice(0, 500),
      createdAt: Date.now(),
    }).catch(() => null)
  }

  // Step count = number of (delta+tool_call) groups before final
  yield { kind: 'final', content: assistantFinal, steps: maxSteps, costUsd: totalCost }
}

/** Convenience: run the loop, collect events, return summary. Useful for
 *  brain-task `brain.loop.run` op invocation. */
export async function runBrainLoopCollect(workspaceId: string, messages: ChatMsg[], opts: BrainLoopOpts = {}): Promise<{
  content:   string
  toolCalls: Array<{ op: string; params: unknown; result?: unknown; error?: string; queued?: boolean }>
  skill?:    string
  chapter?:  string
  memories:  Array<{ key: string; value: string }>
  costUsd:   number
}> {
  const tools: Array<{ op: string; params: unknown; result?: unknown; error?: string; queued?: boolean }> = []
  const memories: Array<{ key: string; value: string }> = []
  let content = '', costUsd = 0, skill: string | undefined, chapter: string | undefined
  let pendingCall: { op: string; params: unknown; queued?: boolean } | null = null
  for await (const ev of runBrainLoop(workspaceId, messages, opts)) {
    if (ev.kind === 'final') { content = ev.content; costUsd = ev.costUsd }
    else if (ev.kind === 'tool_call') { pendingCall = { op: ev.op, params: ev.params, ...(ev.queued ? { queued: true } : {}) } }
    else if (ev.kind === 'tool_done') {
      if (pendingCall) tools.push({ ...pendingCall, ...(ev.result !== undefined ? { result: ev.result } : {}), ...(ev.error ? { error: ev.error } : {}) })
      pendingCall = null
    }
    else if (ev.kind === 'skill') { skill = ev.name }
    else if (ev.kind === 'chapter') { chapter = ev.title }
    else if (ev.kind === 'memory') { memories.push({ key: ev.key, value: ev.value }) }
  }
  if (pendingCall) tools.push(pendingCall)
  const out: { content: string; toolCalls: typeof tools; memories: typeof memories; costUsd: number; skill?: string; chapter?: string } = { content, toolCalls: tools, memories, costUsd }
  if (skill)   out.skill   = skill
  if (chapter) out.chapter = chapter
  return out
}
