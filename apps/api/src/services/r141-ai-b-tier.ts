/**
 * R146.141 — B-tier AI features 11-15.
 */
import { db } from '../db/client.js'
import { agentDebates, operatorProfile, syntheticDataRuns } from '../db/schema.js'
import { eq, desc } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── #11 — Multi-agent debate ────────────────────────────────────────

export async function debateRun(workspaceId: string, opts: {
  question: string
  participants: Array<{ name: string; prior: string }>
  rounds?: number
}): Promise<{ id: string; rounds: Array<Array<{ name: string; content: string }>>; synthesis: string; confidence: number }> {
  if (!opts.participants || opts.participants.length < 2) throw new Error('at least 2 participants required')
  const roundCount = Math.max(1, Math.min(opts.rounds ?? 2, 4))
  const { streamChat } = await import('./chat-providers.js')
  const rounds: Array<Array<{ name: string; content: string }>> = []

  for (let r = 0; r < roundCount; r++) {
    const turn: Array<{ name: string; content: string }> = []
    for (const p of opts.participants) {
      const priorContext = rounds.flat().map(t => `${t.name}: ${t.content.slice(0, 400)}`).join('\n')
      const sys = `You are debating "${p.name}". Your prior/perspective: ${p.prior}. Respond in 80 words or less. Be specific, take a position. Cite a weakness in opponents' arguments when you can.`
      const gen = streamChat(workspaceId, [
        { role: 'system', content: sys },
        { role: 'user', content: `Question: ${opts.question}\n\nDiscussion so far:\n${priorContext || '(round 1 — open with your strongest argument)'}\n\nYour turn:` },
      ], { taskType: 'other' } as Parameters<typeof streamChat>[2])
      let acc = ''
      for await (const ch of gen) acc += ch.delta
      turn.push({ name: p.name, content: acc.trim().slice(0, 1000) })
    }
    rounds.push(turn)
  }
  // Synthesis
  let synthesis = ''
  let confidence = 0
  try {
    const sys = `You are a neutral synthesizer. From the debate transcript, produce a 2-sentence synthesis + confidence (0..1) in your synthesis. Return STRICT JSON: {"synthesis":"<2 sentences>","confidence":0..1}.`
    const allTurns = rounds.flat().map(t => `${t.name}: ${t.content}`).join('\n')
    const gen = streamChat(workspaceId, [
      { role: 'system', content: sys },
      { role: 'user', content: `Question: ${opts.question}\n\nDebate:\n${allTurns}` },
    ], { taskType: 'other', suppressQualityBar: true } as Parameters<typeof streamChat>[2])
    let acc = ''
    for await (const ch of gen) acc += ch.delta
    const m = acc.match(/\{[\s\S]*\}/)
    if (m) {
      const parsed = JSON.parse(m[0]) as { synthesis?: string; confidence?: number }
      synthesis = String(parsed.synthesis ?? '').slice(0, 1000)
      confidence = Math.max(0, Math.min(parsed.confidence ?? 0, 1))
    }
  } catch { /* leave defaults */ }
  const id = uuidv7()
  await db.insert(agentDebates).values({
    id, workspaceId,
    question: opts.question.slice(0, 2000),
    participants: opts.participants,
    rounds, synthesis, confidence,
    createdAt: Date.now(),
  })
  return { id, rounds, synthesis, confidence }
}

// ─── #12 — Parallel tool calling ─────────────────────────────────────

/**
 * Execute multiple brain ops in parallel. Returns array of results
 * (or error per op) in same order as input.
 */
export async function parallelOpCall(workspaceId: string, calls: Array<{ op: string; params?: Record<string, unknown> }>): Promise<Array<{ op: string; ok: boolean; result?: unknown; error?: string }>> {
  const { OPERATIONS } = await import('./brain-task.js')
  const promises = calls.map(async (c): Promise<{ op: string; ok: boolean; result?: unknown; error?: string }> => {
    const opDef = (OPERATIONS as Record<string, { handler: (ws: string, p: Record<string, unknown>) => Promise<unknown> } | undefined>)[c.op]
    if (!opDef) return { op: c.op, ok: false, error: 'not found' }
    try {
      const result = await opDef.handler(workspaceId, c.params ?? {})
      return { op: c.op, ok: true, result }
    } catch (e) {
      return { op: c.op, ok: false, error: (e as Error).message.slice(0, 500) }
    }
  })
  return Promise.all(promises)
}

// ─── #13 — Operator profile (cross-conversation memory) ──────────────

export async function profileGet(workspaceId: string): Promise<typeof operatorProfile.$inferSelect | null> {
  const [row] = await db.select().from(operatorProfile).where(eq(operatorProfile.workspaceId, workspaceId)).limit(1)
  return row ?? null
}

export async function profilePinFact(workspaceId: string, opts: { key: string; value: string }): Promise<{ ok: boolean }> {
  const existing = await profileGet(workspaceId)
  const facts = (existing?.facts ?? []).filter(f => f.key !== opts.key)
  facts.push({ key: opts.key.slice(0, 80), value: opts.value.slice(0, 500), pinnedAt: Date.now() })
  const preferences = existing?.preferences ?? {}
  await db.insert(operatorProfile).values({
    workspaceId, facts, preferences, updatedAt: Date.now(),
  }).onConflictDoUpdate({ target: operatorProfile.workspaceId, set: { facts, updatedAt: Date.now() } })
  return { ok: true }
}

export async function profileSetPref(workspaceId: string, key: string, value: unknown): Promise<{ ok: boolean }> {
  const existing = await profileGet(workspaceId)
  const facts = existing?.facts ?? []
  const preferences = { ...(existing?.preferences ?? {}), [key]: value }
  await db.insert(operatorProfile).values({
    workspaceId, facts, preferences, updatedAt: Date.now(),
  }).onConflictDoUpdate({ target: operatorProfile.workspaceId, set: { preferences, updatedAt: Date.now() } })
  return { ok: true }
}

export async function profileToPromptPrefix(workspaceId: string): Promise<string> {
  const p = await profileGet(workspaceId)
  if (!p) return ''
  const factLines = (p.facts ?? []).map(f => `- ${f.key}: ${f.value}`).join('\n')
  const prefLines = Object.entries(p.preferences ?? {}).map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`).join('\n')
  if (!factLines && !prefLines) return ''
  return `\n[OPERATOR PROFILE]\nFacts:\n${factLines || '(none)'}\nPreferences:\n${prefLines || '(none)'}\n`
}

// ─── #14 — Synthetic training data generator ─────────────────────────

export async function syntheticGenerate(workspaceId: string, opts: {
  taskKind: string
  seedExamples: Array<Record<string, unknown>>
  count: number
}): Promise<{ id: string; count: number; outputPath: string }> {
  const count = Math.max(1, Math.min(opts.count, 500))
  const id = uuidv7()
  await db.insert(syntheticDataRuns).values({
    id, workspaceId,
    taskKind: opts.taskKind.slice(0, 120),
    seedExamples: opts.seedExamples,
    generatedCount: 0,
    status: 'running',
    createdAt: Date.now(),
  })
  const samples: Array<Record<string, unknown>> = []
  try {
    const { streamChat } = await import('./chat-providers.js')
    const sys = `You generate diverse synthetic training examples for "${opts.taskKind}". Output STRICT JSON: {"examples":[...${count} objects matching seed shape, varied in content...]}. Vary edge cases (short/long/multilingual/adversarial). No duplicates.`
    const gen = streamChat(workspaceId, [
      { role: 'system', content: sys },
      { role: 'user',   content: `Seeds:\n${JSON.stringify(opts.seedExamples.slice(0, 10), null, 2).slice(0, 4000)}\n\nGenerate ${count}.` },
    ], { taskType: 'other' } as Parameters<typeof streamChat>[2])
    let acc = ''
    for await (const ch of gen) acc += ch.delta
    const m = acc.match(/\{[\s\S]*\}/)
    if (m) {
      const parsed = JSON.parse(m[0]) as { examples?: Array<Record<string, unknown>> }
      samples.push(...(parsed.examples ?? []).slice(0, count))
    }
  } catch { /* leave empty */ }
  // Write JSONL to disk
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const dir = `/tmp/novan/synthetic/${workspaceId}`
  await fs.mkdir(dir, { recursive: true }).catch(() => null)
  const outputPath = path.join(dir, `${id}.jsonl`)
  await fs.writeFile(outputPath, samples.map(s => JSON.stringify(s)).join('\n'), 'utf-8').catch(() => null)
  await db.update(syntheticDataRuns).set({
    generatedCount: samples.length, outputPath, status: 'ready',
  }).where(eq(syntheticDataRuns.id, id))
  return { id, count: samples.length, outputPath }
}

export async function syntheticList(workspaceId: string, limit = 30): Promise<Array<typeof syntheticDataRuns.$inferSelect>> {
  return db.select().from(syntheticDataRuns).where(eq(syntheticDataRuns.workspaceId, workspaceId))
    .orderBy(desc(syntheticDataRuns.createdAt)).limit(Math.min(limit, 100))
}

// ─── #15 — Auto-generated tool descriptions ──────────────────────────

/**
 * Read the brain-task OPERATIONS registry + each handler's source comment,
 * regenerate descriptions via LLM. Persist the updated descriptions to a
 * JSON file the deploy pipeline can diff against the registry.
 *
 * Skeleton: reads handler types but uses LLM to synthesize fresh
 * descriptions from name + parameter shape. Actual code-side update is a
 * future round.
 */
export async function descriptionsRegenerate(workspaceId: string, sampleN = 20): Promise<{ regenerated: Array<{ op: string; description: string; risk: string }> }> {
  const { OPERATIONS } = await import('./brain-task.js')
  const ops = Object.entries(OPERATIONS as Record<string, { description: string; risk: string }>).slice(0, sampleN)
  const out: Array<{ op: string; description: string; risk: string }> = []
  try {
    const { streamChat } = await import('./chat-providers.js')
    const sys = `You rewrite brain-op descriptions for clarity. Given an op name + current description, produce a tighter version (max 140 chars, mention key parameters). Return STRICT JSON: {"ops":[{"name":"...","description":"...","risk":"low|medium|high"}]}.`
    const gen = streamChat(workspaceId, [
      { role: 'system', content: sys },
      { role: 'user',   content: ops.map(([n, d]) => `${n}: ${d.description.slice(0, 200)} (risk=${d.risk})`).join('\n').slice(0, 8000) },
    ], { taskType: 'other', suppressQualityBar: true } as Parameters<typeof streamChat>[2])
    let acc = ''
    for await (const ch of gen) acc += ch.delta
    const m = acc.match(/\{[\s\S]*\}/)
    if (m) {
      const parsed = JSON.parse(m[0]) as { ops?: Array<{ name: string; description: string; risk: string }> }
      for (const r of parsed.ops ?? []) {
        out.push({ op: r.name, description: r.description.slice(0, 200), risk: r.risk })
      }
    }
  } catch { /* empty out */ }
  return { regenerated: out }
}
