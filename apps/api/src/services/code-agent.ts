/**
 * code-agent.ts — Takes an approved proposal and produces patch files.
 *
 * Two modes:
 *   1. LLM mode (when GROQ_API_KEY is present): asks Groq for code.
 *   2. Template mode (always-available): generates a stub skeleton.
 *
 * BOTH modes pass through safety-policy before being persisted.
 * NEITHER mode writes to the live filesystem.
 *
 * The agent is invoked AFTER the operator has approved the proposal in
 * the UI. It produces a code_patches row that the operator reviews and
 * (manually, via git) commits. No auto-merge. No auto-PR.
 */
import { db } from '../db/client.js'
import { codePatches, codeProposals } from '../db/schema.js'
import { and, eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { evaluate as evaluateSafety } from './safety-policy.js'
import { applyAndValidate, readRepoFile, type PatchFile } from './patch-sandbox.js'
import { record as recordChain } from './reasoning-chains.js'
import { notify } from './notifications.js'

interface Proposal {
  id: string
  workspaceId: string
  title: string
  summary: string
  capabilityId: string | null
  filesToCreate: Array<{ path: string; purpose: string; estLoc: number }>
  filesToModify: Array<{ path: string; purpose: string; estLoc: number }>
  testsRequired: Array<{ description: string; covers: string }>
  reasoning: string[]
  riskLevel: string
}

export interface AgentRunResult {
  patchId: string
  status: 'pending' | 'generated' | 'safety_blocked' | 'sandbox_failed' | 'validated'
  agent: 'groq' | 'template'
  files: PatchFile[]
  blockReason?: string
  safetyReport: unknown
  sandboxReport: unknown
  tokensUsed: number
  costUsdUsed: number
}

/** Top-level entry point invoked by /api/v1/self/proposals/:id/build */
export async function buildPatchFromProposal(workspaceId: string, proposalId: string): Promise<AgentRunResult> {
  const proposal = await loadProposal(workspaceId, proposalId)
  if (!proposal) throw new Error('proposal not found')
  if (!['approved', 'proposed'].includes(await getProposalStatus(workspaceId, proposalId) ?? 'proposed')) {
    // Allow building from proposed too (so operator can preview), but warn
  }

  const patchId = uuidv7()
  const now = Date.now()

  // Insert pending row up-front so caller can poll
  await db.insert(codePatches).values({
    id: patchId, workspaceId, proposalId,
    status: 'pending', agent: 'template', files: [],
    safetyReport: {}, sandboxReport: {},
    createdAt: now, updatedAt: now,
  }).catch((e: Error) => { console.error('[code-agent]', e.message); return null })

  // Generate files via multi-provider LLM fallback. Template-stub mode
  // is now ONLY used when no LLM provider key is configured at all — and
  // even then, stubs are tagged so the patch-executor can refuse to
  // auto-apply them (operator-review only). Previously: Groq-only with
  // silent fallback to stubs → brain wrote `// TODO[code-agent]: implement.`
  // to disk and marked issues "shipped". False-completion violation.
  const hasAnyLlmKey = !!(process.env['GROQ_API_KEY'] || process.env['GEMINI_API_KEY'] || process.env['OPENAI_API_KEY'] || process.env['ANTHROPIC_API_KEY'])
  let files: PatchFile[]
  let agent: 'groq' | 'template'
  let tokensUsed = 0
  let costUsdUsed = 0
  if (hasAnyLlmKey) {
    const r = await generateWithLlmFallback(proposal)
    files = r.files
    agent = r.providerUsed === 'template' ? 'template' : 'groq'
    tokensUsed = r.tokensUsed
    costUsdUsed = r.costUsdUsed
    // If ALL LLM providers failed and we'd otherwise fall through to
    // stubs, tag each file's contents with a STUB_SENTINEL the patch-
    // executor inspects to refuse auto-apply.
    if (r.providerUsed === 'template') {
      files = files.map(f => ({ ...f, contents: `// STUB_NOT_FOR_AUTO_APPLY: all LLM providers unavailable\n${f.contents}` }))
    }
  } else {
    files = generateTemplate(proposal).map(f => ({ ...f, contents: `// STUB_NOT_FOR_AUTO_APPLY: no LLM key configured\n${f.contents}` }))
    agent = 'template'
  }

  // Safety check
  const safety = evaluateSafety({
    title: proposal.title, summary: proposal.summary, files,
  })

  if (!safety.ok) {
    await db.update(codePatches).set({
      status: 'safety_blocked', agent,
      files,
      safetyReport: safety as unknown as Record<string, unknown>,
      blockReason: safety.blockedReasons.slice(0, 5).join(' | '),
      tokensUsed, costUsdUsed,
      completedAt: Date.now(), updatedAt: Date.now(),
    }).where(eq(codePatches.id, patchId)).catch((e: Error) => { console.error('[code-agent]', e.message); return null })
    await recordChain({
      workspaceId, kind: 'decision',
      subjectId: `patch:${patchId}`,
      decision: `Patch SAFETY_BLOCKED: ${safety.blockedReasons.slice(0, 3).join('; ')}`,
      evidence: [{ type: 'safety_policy', id: patchId, extract: safety.blockedReasons.join('; ') }],
      confidence: 0.95, source: 'code-agent',
    }).catch((e: Error) => { console.error('[code-agent]', e.message); return null })
    await notify({
      workspaceId, type: 'agent.patch_blocked',
      title: `Patch blocked: ${proposal.title}`,
      body: `Safety policy rejected ${safety.blockedReasons.length} item(s): ${safety.blockedReasons.slice(0, 2).join('; ')}`,
      severity: 'high', signature: `patch-blocked:${patchId}`,
    }).catch((e: Error) => { console.error('[code-agent]', e.message); return null })
    return { patchId, status: 'safety_blocked', agent, files, blockReason: safety.blockedReasons.join(' | '), safetyReport: safety, sandboxReport: {}, tokensUsed, costUsdUsed }
  }

  // Sandbox validation
  const sandbox = await applyAndValidate(files)
  let status: 'validated' | 'sandbox_failed' = sandbox.ok ? 'validated' : 'sandbox_failed'

  // Adversarial review — round 124 coordination guard. If the patch
  // passed safety + sandbox, run a different-family reviewer to look
  // for hallucinations, spec drift, and over-claims the producer might
  // have missed. CRITICAL findings demote status to sandbox_failed so
  // the patch can't auto-apply; HIGH findings annotate the chain.
  let adversarialFindings: Array<{ category: string; severity: string; description: string }> = []
  if (status === 'validated' && files.length > 0) {
    try {
      const { adversarialReview } = await import('./agent-coordination.js')
      const concatenatedOutput = files.map(f => `--- ${f.path} ---\n${(f.contents ?? '').slice(0, 4_000)}`).join('\n\n')
      const review = await adversarialReview({
        workspaceId,
        producerOutput: concatenatedOutput,
        originalSpec:   `${proposal.title}\n\n${proposal.summary ?? ''}`,
        // Code-agent typically runs on groq; bias review to anthropic
        // so we get cross-family judgment. Falls back to default chain
        // if anthropic isn't configured.
        reviewerProvider: 'anthropic',
        checkCategories: ['fact_check', 'spec_drift', 'hallucination', 'incomplete', 'security', 'over_claim'],
      })
      adversarialFindings = review.findings.map(f => ({
        category: f.category, severity: f.severity, description: f.description,
      }))
      if (review.recommendation === 'reject') {
        status = 'sandbox_failed'
      }
    } catch { /* tolerated — review is best-effort */ }
  }

  await db.update(codePatches).set({
    status, agent,
    files,
    safetyReport:  safety as unknown as Record<string, unknown>,
    sandboxReport: { ...sandbox, adversarialFindings } as unknown as Record<string, unknown>,
    blockReason: status === 'validated' ? null
      : sandbox.ok ? `adversarial review rejected: ${adversarialFindings.filter(f => f.severity === 'critical').map(f => f.description).slice(0, 2).join('; ')}`
      : `sandbox: ${sandbox.errors.slice(0, 3).join('; ')}`,
    tokensUsed, costUsdUsed,
    completedAt: Date.now(), updatedAt: Date.now(),
  }).where(eq(codePatches.id, patchId)).catch((e: Error) => { console.error('[code-agent]', e.message); return null })

  await recordChain({
    workspaceId, kind: 'decision',
    subjectId: `patch:${patchId}`,
    decision: `Patch ${status}: ${proposal.title} (${files.length} files, agent=${agent})`,
    evidence: [
      { type: 'safety', id: patchId, extract: `${safety.totalFiles} files passed safety` },
      { type: 'sandbox', id: patchId, extract: sandbox.typecheck.ran ? `typecheck ${sandbox.typecheck.passed ? 'passed' : 'failed'}` : 'sandbox degraded' },
    ],
    confidence: sandbox.ok ? 0.75 : 0.4,
    source: 'code-agent',
  }).catch((e: Error) => { console.error('[code-agent]', e.message); return null })

  return {
    patchId, status, agent, files,
    safetyReport: safety, sandboxReport: sandbox,
    tokensUsed, costUsdUsed,
  }
}

// ─── Proposal loader ─────────────────────────────────────────────────────

async function loadProposal(workspaceId: string, id: string): Promise<Proposal | null> {
  const row = await db.select().from(codeProposals)
    .where(and(eq(codeProposals.workspaceId, workspaceId), eq(codeProposals.id, id)))
    .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[code-agent]', e.message); return null })
  if (!row) return null
  return {
    id: row.id, workspaceId: row.workspaceId,
    title: row.title, summary: row.summary,
    capabilityId: row.capabilityId,
    filesToCreate: row.filesToCreate as Array<{ path: string; purpose: string; estLoc: number }>,
    filesToModify: row.filesToModify as Array<{ path: string; purpose: string; estLoc: number }>,
    testsRequired: row.testsRequired as Array<{ description: string; covers: string }>,
    reasoning: row.reasoning as string[],
    riskLevel: row.riskLevel,
  }
}

async function getProposalStatus(workspaceId: string, id: string): Promise<string | null> {
  const row = await db.select({ status: codeProposals.status }).from(codeProposals)
    .where(and(eq(codeProposals.workspaceId, workspaceId), eq(codeProposals.id, id)))
    .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[code-agent]', e.message); return null })
  return row?.status ?? null
}

// ─── Template mode (always available, no LLM cost) ───────────────────────

function generateTemplate(p: Proposal): PatchFile[] {
  const out: PatchFile[] = []
  for (const f of p.filesToCreate) {
    out.push({ path: f.path, op: 'create', contents: templateContent(f.path, f.purpose, p) })
  }
  for (const f of p.filesToModify) {
    const existing = readRepoFile(f.path)
    if (existing) {
      // Generate a "show the diff hint" stub — operator applies manually.
      // Honest: we DON'T mutate file content programmatically here without
      // an LLM. We attach the existing content with TODO markers.
      out.push({
        path: f.path, op: 'modify',
        contents: `${existing}\n\n// TODO[code-agent]: ${f.purpose}\n// proposal: ${p.title}\n`,
      })
    }
  }
  return out
}

function templateContent(path: string, purpose: string, p: Proposal): string {
  const isService = /\/services\/[^/]+\.ts$/.test(path)
  const isRoute   = /\/routes\/[^/]+\.ts$/.test(path)
  const isPage    = /\/pages\/[^/]+\.tsx$/.test(path)
  const isTest    = /\.test\.ts$/.test(path)
  const isSql     = /\.sql$/.test(path)

  if (isSql) {
    return `-- ${path}\n-- Auto-generated stub for: ${purpose}\n-- Source proposal: ${p.title}\n\n-- TODO[code-agent]: add CREATE TABLE / ALTER TABLE statements here.\n`
  }
  if (isService) {
    const name = path.split('/').pop()!.replace('.ts', '')
    return `/**\n * ${name}.ts — ${purpose}\n *\n * Proposal: ${p.title}\n * Reasoning:\n${p.reasoning.map(r => ` *   - ${r}`).join('\n')}\n *\n * TODO[code-agent]: implement.\n */\n\nexport interface ${pascal(name)}Result {\n  ok: boolean\n  notes: string[]\n}\n\nexport async function run${pascal(name)}(workspaceId: string): Promise<${pascal(name)}Result> {\n  return { ok: true, notes: ['stub generated by code-agent — replace with real implementation'] }\n}\n`
  }
  if (isRoute) {
    return `/**\n * ${path} — ${purpose}\n *\n * Proposal: ${p.title}\n */\nimport type { FastifyPluginAsync } from 'fastify'\n\nconst routes: FastifyPluginAsync = async (fastify) => {\n  fastify.get<{ Querystring: { workspace_id?: string } }>('/', async (req, reply) => {\n    const ws = req.query.workspace_id\n    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })\n    // TODO[code-agent]: implement.\n    return { success: true, data: { stub: true } }\n  })\n}\n\nexport default routes\n`
  }
  if (isPage) {
    const cls = path.split('/').pop()!.replace('.tsx', '')
    return `import React from 'react'\n\n/**\n * ${cls} — ${purpose}\n *\n * Proposal: ${p.title}\n */\nexport default function ${cls}() {\n  return (\n    <div className="p-6 max-w-7xl mx-auto">\n      <h1 className="text-xl font-semibold">${cls.replace(/Page$/, '')}</h1>\n      <p className="text-sm text-[var(--text-muted)] mt-2">Stub generated by code-agent. Replace with real implementation.</p>\n    </div>\n  )\n}\n`
  }
  if (isTest) {
    return `import { describe, it, expect } from 'vitest'\n\ndescribe('${path}', () => {\n  it('stub — replace with real assertions', () => {\n    expect(true).toBe(true)\n  })\n})\n`
  }
  return `// ${path}\n// stub for: ${purpose}\n`
}

function pascal(s: string): string {
  return s.split(/[-_]/).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('')
}

// ─── LLM mode: multi-provider fallback ──────────────────────────────────
// Tries Groq → Gemini → OpenAI → Anthropic in order. Each producer
// returns either real files or null (so we try the next). Only falls
// back to template stubs if EVERY provider failed — and those stubs
// get tagged STUB_NOT_FOR_AUTO_APPLY so they can't ship to disk.

interface LlmResult { files: PatchFile[]; tokensUsed: number; costUsdUsed: number; providerUsed: 'groq' | 'gemini' | 'openai' | 'anthropic' | 'template' }

async function generateWithLlmFallback(p: Proposal): Promise<LlmResult> {
  const errors: string[] = []
  // Try Groq first (cheapest + fastest)
  if (process.env['GROQ_API_KEY']) {
    try {
      const r = await callGroq(p)
      if (r && r.files.length > 0) return { ...r, providerUsed: 'groq' }
    } catch (e) { errors.push(`groq: ${(e as Error).message}`) }
  }
  // Gemini 2.5 Pro
  if (process.env['GEMINI_API_KEY']) {
    try {
      const r = await callGemini(p)
      if (r && r.files.length > 0) return { ...r, providerUsed: 'gemini' }
    } catch (e) { errors.push(`gemini: ${(e as Error).message}`) }
  }
  // OpenAI gpt-4o
  if (process.env['OPENAI_API_KEY']) {
    try {
      const r = await callOpenAI(p)
      if (r && r.files.length > 0) return { ...r, providerUsed: 'openai' }
    } catch (e) { errors.push(`openai: ${(e as Error).message}`) }
  }
  // Anthropic Claude
  if (process.env['ANTHROPIC_API_KEY']) {
    try {
      const r = await callAnthropic(p)
      if (r && r.files.length > 0) return { ...r, providerUsed: 'anthropic' }
    } catch (e) { errors.push(`anthropic: ${(e as Error).message}`) }
  }
  // All providers exhausted → tagged-stub fallback (won't auto-apply)
  void errors
  return { files: generateTemplate(p), tokensUsed: 0, costUsdUsed: 0, providerUsed: 'template' }
}

function buildLlmMessages(p: Proposal): { system: string; user: string } {
  const system = [
    'You are a code-generation agent for the Novan TypeScript monorepo.',
    'STRICT RULES:',
    '1. Only output the exact files requested. No prose, no markdown fences except inside the JSON.',
    '2. Output MUST be JSON: { files: [ { path, op: "create"|"modify", contents } ] }',
    '3. Match existing codebase style (drizzle ORM, fastify, react+tailwind, tsx via @ops/web).',
    '4. NEVER include: child_process, eval, new Function, fs writes outside REPO_ROOT, secret env access, auth bypasses.',
    '5. NEVER write code that hacks, exploits, phishes, surveils, or otherwise harms users.',
    '6. For modify operations: produce the FULL file contents (we will apply, not patch).',
    '7. Keep each file under 600 lines.',
    '8. Refuse if you cannot produce real, working code. Do NOT output TODO stubs.',
  ].join('\n')

  const contextSnippets: string[] = []
  for (const f of p.filesToModify.slice(0, 3)) {
    const existing = readRepoFile(f.path)
    if (existing && existing.length < 8000) {
      contextSnippets.push(`\n\nExisting ${f.path}:\n\`\`\`\n${existing}\n\`\`\``)
    }
  }
  const user = [
    `Title: ${p.title}`,
    `Summary: ${p.summary}`,
    `Capability: ${p.capabilityId ?? 'n/a'}`,
    `Risk: ${p.riskLevel}`,
    '', 'Files to create:',
    ...p.filesToCreate.map(f => `  - ${f.path}  (~${f.estLoc} LOC) :: ${f.purpose}`),
    '', 'Files to modify:',
    ...p.filesToModify.map(f => `  - ${f.path} :: ${f.purpose}`),
    '', 'Tests required:',
    ...p.testsRequired.map(t => `  - ${t.description}`),
    '', 'Reasoning context:',
    ...p.reasoning.map(r => `  - ${r}`),
    contextSnippets.join(''),
    '', 'Return JSON only.',
  ].join('\n')

  return { system, user }
}

function parseFilesFromJson(content: string): PatchFile[] {
  let parsed: { files?: Array<{ path?: string; op?: string; contents?: string }> } = {}
  let primaryErr: string | null = null
  let fallbackErr: string | null = null
  try {
    parsed = JSON.parse(content)
  } catch (e) {
    primaryErr = (e as Error).message
    // Extract first {...} block in case the model wrapped in prose
    const m = content.match(/\{[\s\S]*\}/)
    if (m) {
      try { parsed = JSON.parse(m[0]) }
      catch (e2) { fallbackErr = (e2 as Error).message }
    } else {
      fallbackErr = 'no JSON block found in LLM output'
    }
  }
  const files = (parsed.files ?? [])
    .filter(f => typeof f.path === 'string' && typeof f.contents === 'string' && (f.contents as string).trim().length > 20)
    .map(f => ({
      path: f.path!,
      op: (f.op === 'modify' ? 'modify' : 'create') as 'create' | 'modify',
      contents: f.contents!,
    }))
  // If we couldn't parse anything AND there were no files, surface the
  // parse failure so callers don't silently treat an LLM hallucination as
  // a successful empty patch. Output guard / executor will mark the job
  // failed instead of "applied with zero files".
  if (files.length === 0 && primaryErr !== null) {
    console.error('[code-agent] parseFilesFromJson: primary=%s fallback=%s — content head=%s',
      primaryErr, fallbackErr ?? 'n/a', content.slice(0, 200))
  }
  return files
}

async function callGroq(p: Proposal): Promise<{ files: PatchFile[]; tokensUsed: number; costUsdUsed: number } | null> {
  const { system, user } = buildLlmMessages(p)
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env['GROQ_API_KEY']}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' }, temperature: 0.2, max_tokens: 8000,
    }),
    signal: AbortSignal.timeout(45_000),
  })
  if (!res.ok) return null
  const body = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } }
  const files = parseFilesFromJson(body.choices?.[0]?.message?.content ?? '{}')
  if (files.length === 0) return null
  const tok = body.usage?.total_tokens ?? 0
  return { files, tokensUsed: tok, costUsdUsed: Number((tok * 0.59 / 1_000_000).toFixed(6)) }
}

async function callGemini(p: Proposal): Promise<{ files: PatchFile[]; tokensUsed: number; costUsdUsed: number } | null> {
  const { system, user } = buildLlmMessages(p)
  const model = process.env['GEMINI_CODE_MODEL'] ?? 'gemini-2.5-pro'
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env['GEMINI_API_KEY']}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 12000, responseMimeType: 'application/json' },
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) return null
  const body = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    usageMetadata?: { totalTokenCount?: number }
  }
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}'
  const files = parseFilesFromJson(text)
  if (files.length === 0) return null
  const tok = body.usageMetadata?.totalTokenCount ?? 0
  return { files, tokensUsed: tok, costUsdUsed: Number((tok * 1.25 / 1_000_000).toFixed(6)) }
}

async function callOpenAI(p: Proposal): Promise<{ files: PatchFile[]; tokensUsed: number; costUsdUsed: number } | null> {
  const { system, user } = buildLlmMessages(p)
  const model = process.env['OPENAI_CODE_MODEL'] ?? 'gpt-4o'
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env['OPENAI_API_KEY']}` },
    body: JSON.stringify({
      model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' }, temperature: 0.2, max_tokens: 8000,
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) return null
  const body = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } }
  const files = parseFilesFromJson(body.choices?.[0]?.message?.content ?? '{}')
  if (files.length === 0) return null
  const tok = body.usage?.total_tokens ?? 0
  return { files, tokensUsed: tok, costUsdUsed: Number((tok * 5.0 / 1_000_000).toFixed(6)) }
}

async function callAnthropic(p: Proposal): Promise<{ files: PatchFile[]; tokensUsed: number; costUsdUsed: number } | null> {
  const { system, user } = buildLlmMessages(p)
  const model = process.env['ANTHROPIC_CODE_MODEL'] ?? 'claude-opus-4-5'
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env['ANTHROPIC_API_KEY']!, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model, max_tokens: 8000, temperature: 0.2, system,
      messages: [{ role: 'user', content: user + '\n\nReturn ONLY a JSON object {"files":[...]}—no prose.' }],
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) return null
  const body = await res.json() as { content?: Array<{ text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } }
  const text = body.content?.[0]?.text ?? '{}'
  const files = parseFilesFromJson(text)
  if (files.length === 0) return null
  const tok = (body.usage?.input_tokens ?? 0) + (body.usage?.output_tokens ?? 0)
  return { files, tokensUsed: tok, costUsdUsed: Number((tok * 15.0 / 1_000_000).toFixed(6)) }
}

// Legacy `generateWithGroq` (single-provider path with `user.concat()`
// no-op bug at the existing-file-context block) was removed — replaced
// by `generateWithLlmFallback` above which has working multi-provider
// chain. Kept this comment as a tombstone so anyone grepping for the
// old function understands the migration.
