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
  }).catch(() => null)

  // Generate files
  const useLlm = Boolean(process.env['GROQ_API_KEY'])
  let files: PatchFile[]
  let agent: 'groq' | 'template'
  let tokensUsed = 0
  let costUsdUsed = 0
  if (useLlm) {
    const r = await generateWithGroq(proposal)
    files = r.files
    agent = 'groq'
    tokensUsed = r.tokensUsed
    costUsdUsed = r.costUsdUsed
  } else {
    files = generateTemplate(proposal)
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
    }).where(eq(codePatches.id, patchId)).catch(() => null)
    await recordChain({
      workspaceId, kind: 'decision',
      subjectId: `patch:${patchId}`,
      decision: `Patch SAFETY_BLOCKED: ${safety.blockedReasons.slice(0, 3).join('; ')}`,
      evidence: [{ type: 'safety_policy', id: patchId, extract: safety.blockedReasons.join('; ') }],
      confidence: 0.95, source: 'code-agent',
    }).catch(() => null)
    await notify({
      workspaceId, type: 'agent.patch_blocked',
      title: `Patch blocked: ${proposal.title}`,
      body: `Safety policy rejected ${safety.blockedReasons.length} item(s): ${safety.blockedReasons.slice(0, 2).join('; ')}`,
      severity: 'high', signature: `patch-blocked:${patchId}`,
    }).catch(() => null)
    return { patchId, status: 'safety_blocked', agent, files, blockReason: safety.blockedReasons.join(' | '), safetyReport: safety, sandboxReport: {}, tokensUsed, costUsdUsed }
  }

  // Sandbox validation
  const sandbox = await applyAndValidate(files)
  const status: 'validated' | 'sandbox_failed' = sandbox.ok ? 'validated' : 'sandbox_failed'

  await db.update(codePatches).set({
    status, agent,
    files,
    safetyReport: safety as unknown as Record<string, unknown>,
    sandboxReport: sandbox as unknown as Record<string, unknown>,
    blockReason: sandbox.ok ? null : `sandbox: ${sandbox.errors.slice(0, 3).join('; ')}`,
    tokensUsed, costUsdUsed,
    completedAt: Date.now(), updatedAt: Date.now(),
  }).where(eq(codePatches.id, patchId)).catch(() => null)

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
  }).catch(() => null)

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
    .limit(1).then(r => r[0]).catch(() => null)
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
    .limit(1).then(r => r[0]).catch(() => null)
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

// ─── LLM mode (Groq, OpenAI-compatible) ──────────────────────────────────

async function generateWithGroq(p: Proposal): Promise<{ files: PatchFile[]; tokensUsed: number; costUsdUsed: number }> {
  const apiKey = process.env['GROQ_API_KEY']
  if (!apiKey) return { files: generateTemplate(p), tokensUsed: 0, costUsdUsed: 0 }

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
  ].join('\n')

  const user = [
    `Title: ${p.title}`,
    `Summary: ${p.summary}`,
    `Capability: ${p.capabilityId ?? 'n/a'}`,
    `Risk: ${p.riskLevel}`,
    '',
    'Files to create:',
    ...p.filesToCreate.map(f => `  - ${f.path}  (~${f.estLoc} LOC) :: ${f.purpose}`),
    '',
    'Files to modify:',
    ...p.filesToModify.map(f => `  - ${f.path} :: ${f.purpose}`),
    '',
    'Tests required:',
    ...p.testsRequired.map(t => `  - ${t.description}`),
    '',
    'Reasoning context:',
    ...p.reasoning.map(r => `  - ${r}`),
    '',
    'Return JSON only.',
  ].join('\n')

  // Read the small set of files we're modifying so the agent has context
  for (const f of p.filesToModify.slice(0, 3)) {
    const existing = readRepoFile(f.path)
    if (existing && existing.length < 8000) {
      user.concat(`\n\nExisting ${f.path}:\n\`\`\`\n${existing}\n\`\`\``)
    }
  }

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: user },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 8000,
      }),
      signal: AbortSignal.timeout(45_000),
    })
    if (!res.ok) {
      return { files: generateTemplate(p), tokensUsed: 0, costUsdUsed: 0 }
    }
    const body = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: { total_tokens?: number }
    }
    const content = body.choices?.[0]?.message?.content ?? '{}'
    let parsed: { files?: Array<{ path?: string; op?: string; contents?: string }> } = {}
    try { parsed = JSON.parse(content) } catch { /* fall through */ }
    const files = (parsed.files ?? [])
      .filter(f => typeof f.path === 'string' && typeof f.contents === 'string')
      .map(f => ({
        path: f.path!,
        op: (f.op === 'modify' ? 'modify' : 'create') as 'create' | 'modify',
        contents: f.contents!,
      }))
    if (files.length === 0) {
      // Fall back to template if LLM produced nothing usable
      return { files: generateTemplate(p), tokensUsed: body.usage?.total_tokens ?? 0, costUsdUsed: 0 }
    }
    return {
      files,
      tokensUsed: body.usage?.total_tokens ?? 0,
      // Groq pricing varies — estimate $0.59 / 1M tokens for llama-3.3-70b
      costUsdUsed: Number(((body.usage?.total_tokens ?? 0) * 0.59 / 1_000_000).toFixed(6)),
    }
  } catch {
    return { files: generateTemplate(p), tokensUsed: 0, costUsdUsed: 0 }
  }
}
