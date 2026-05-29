/**
 * code-writer.ts — Tier-1: build plan → structured code proposal.
 *
 * Honest scope:
 *   - Takes a buildPlan from self-build-planner
 *   - Generates a structured proposal: files to create, modify, tests
 *   - Estimates LOC + risk
 *   - Persists as code_proposals row in status='proposed'
 *   - Stops short of LLM code generation — that's the operator's call
 *     (or a separate paid agent). Proposal contains enough scaffold for
 *     an LLM/operator to implement without re-deriving the design.
 *
 * Why not auto-generate code? Code-writing on a 500k-line codebase
 * without operator review = production hazard. The proposal IS the
 * autonomous output; execution is gated.
 */
import { db } from '../db/client.js'
import { codeProposals, skillLibrary } from '../db/schema.js'
import { and, desc, eq, sql, inArray } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { record as recordChain } from './reasoning-chains.js'
import type { BuildPlan } from './self-build-planner.js'

export interface CodeProposal {
  id:            string
  workspaceId:   string
  buildPlanId?:  string
  capabilityId?: string
  title:         string
  summary:       string
  filesToCreate: Array<{ path: string; purpose: string; estLoc: number }>
  filesToModify: Array<{ path: string; purpose: string; estLoc: number }>
  testsRequired: Array<{ description: string; covers: string }>
  riskLevel:     'low' | 'medium' | 'high' | 'critical'
  estimatedLoc:  number
  status:        'proposed' | 'approved' | 'rejected' | 'executing' | 'shipped'
  reasoning:     string[]
}

/**
 * Look up relevant skills from the imported skill_library for a build plan.
 * Matches by keyword overlap against name/description/tags. Bumps use_count
 * for picked rows so the library learns which skills get reused.
 */
async function retrieveRelevantSkills(workspaceId: string, plan: BuildPlan): Promise<Array<{ id: string; name: string; category: string | null; tags: string[] }>> {
  // Build keyword set from plan title + task titles + service paths.
  const tokens = new Set<string>()
  const push = (s: string | undefined) => {
    if (!s) return
    s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 4).forEach(t => tokens.add(t))
  }
  push(plan.capabilityTitle)
  plan.tasks.forEach(t => push(t.title))
  plan.architecture.services.forEach(push)
  plan.architecture.routes.forEach(push)
  if (tokens.size === 0) return []

  // Score skills by token overlap. Cheap LIKE-based prefilter then in-memory rank.
  const candidateRows = await db.select({
    id: skillLibrary.id, name: skillLibrary.name, description: skillLibrary.description,
    category: skillLibrary.category, tags: skillLibrary.tags,
  }).from(skillLibrary)
    // Include 'global' workspace so the shared skill library (338 skills imported from
    // awesome-copilot) is searchable from every workspace, not only the one that imported it.
    .where(inArray(skillLibrary.workspaceId, [workspaceId, 'global']))
    .limit(500).catch(() => [])

  const tokenArr = [...tokens]
  const scored = candidateRows.map(r => {
    const hay = `${r.name} ${r.description ?? ''} ${(r.tags ?? []).join(' ')}`.toLowerCase()
    const score = tokenArr.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0)
    return { ...r, score }
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 5)

  // Increment use_count for picks — feedback signal for which skills matter.
  if (scored.length > 0) {
    await db.update(skillLibrary)
      .set({ useCount: sql`${skillLibrary.useCount} + 1`, lastUsedAt: Date.now() })
      .where(and(inArray(skillLibrary.workspaceId, [workspaceId, 'global']), inArray(skillLibrary.id, scored.map(s => s.id))))
      .catch(() => null)
  }
  return scored.map(s => ({ id: s.id, name: s.name, category: s.category, tags: s.tags ?? [] }))
}

/**
 * Synthesize a structured proposal from a build plan.
 * Pulls relevant skills from the imported library to ground reasoning.
 */
export async function proposeFromPlanWithSkills(workspaceId: string, plan: BuildPlan): Promise<Omit<CodeProposal, 'id' | 'status'>> {
  const base = proposeFromPlan(workspaceId, plan)
  const skills = await retrieveRelevantSkills(workspaceId, plan)
  if (skills.length === 0) return base
  return {
    ...base,
    reasoning: [
      ...base.reasoning,
      `Skill library matches (${skills.length}): ${skills.map(s => s.name).join(', ')}`,
    ],
  }
}

/**
 * Synthesize a structured proposal from a build plan.
 * Pure heuristic — no LLM call.
 */
export function proposeFromPlan(workspaceId: string, plan: BuildPlan): Omit<CodeProposal, 'id' | 'status'> {
  const filesToCreate = projectFiles(plan, 'create')
  const filesToModify = projectFiles(plan, 'modify')
  const testsRequired = projectTests(plan)
  const estimatedLoc =
    filesToCreate.reduce((s, f) => s + f.estLoc, 0) +
    filesToModify.reduce((s, f) => s + f.estLoc, 0)
  const riskLevel = estimatedLoc > 800 ? 'high'
    : estimatedLoc > 300 ? 'medium' : 'low'
  const result: Omit<CodeProposal, 'id' | 'status'> = {
    workspaceId,
    capabilityId: plan.capabilityId,
    title:   `Code proposal: ${plan.capabilityTitle}`,
    summary: `Implement ${plan.capabilityId} (${plan.tasks.length} tasks, ~${estimatedLoc} LOC, ${riskLevel} risk).`,
    filesToCreate, filesToModify, testsRequired,
    riskLevel, estimatedLoc,
    reasoning: [
      `Plan has ${plan.tasks.length} tasks; ${plan.architecture.services.length} services + ${plan.architecture.routes.length} routes expected.`,
      filesToCreate.length > 0 ? `${filesToCreate.length} new files proposed` : 'No new files',
      filesToModify.length > 0 ? `${filesToModify.length} existing files to modify` : 'No modifications',
      `${testsRequired.length} test specifications`,
      `Rollback plan: ${plan.rollbackPlan.slice(0, 2).join('; ')}`,
    ],
  }
  return result
}

function projectFiles(plan: BuildPlan, kind: 'create' | 'modify'): Array<{ path: string; purpose: string; estLoc: number }> {
  if (kind === 'create') {
    const files: Array<{ path: string; purpose: string; estLoc: number }> = []
    for (const f of plan.architecture.services) files.push({ path: f, purpose: 'core service', estLoc: 150 })
    for (const f of plan.architecture.routes)   files.push({ path: f, purpose: 'HTTP routes',  estLoc: 80 })
    for (const f of plan.architecture.ui)       files.push({ path: f, purpose: 'UI page',      estLoc: 200 })
    for (const f of plan.architecture.workers)  files.push({ path: f, purpose: 'queue worker', estLoc: 100 })
    return files
  }
  // modify
  const files: Array<{ path: string; purpose: string; estLoc: number }> = []
  if (plan.architecture.routes.length   > 0) files.push({ path: 'apps/api/src/server.ts',     purpose: 'register new routes', estLoc: 4 })
  if (plan.architecture.tables.length   > 0) files.push({ path: 'packages/db/src/schema.ts', purpose: 'add table definitions', estLoc: 30 })
  if (plan.architecture.ui.length       > 0) files.push({ path: 'apps/web/src/App.tsx',       purpose: 'register route + nav', estLoc: 4 })
  return files
}

function projectTests(plan: BuildPlan): Array<{ description: string; covers: string }> {
  const out: Array<{ description: string; covers: string }> = []
  for (const t of plan.tasks.slice(0, 6)) {
    out.push({
      description: `Tests for: ${t.title}`,
      covers: t.title,
    })
  }
  return out
}

export async function persistProposal(p: Omit<CodeProposal, 'id' | 'status'>): Promise<string> {
  const now = Date.now()
  // Dedup: skip if an open proposal for the same capability already exists.
  // The fast-path SELECT covers the common case; the partial unique index
  // `code_proposals_open_capability_uq` (migration 0044) enforces it under
  // concurrency — two cron runs racing both fall back to the existing row.
  if (p.capabilityId) {
    const existing = await db.select({ id: codeProposals.id })
      .from(codeProposals)
      .where(and(
        eq(codeProposals.workspaceId, p.workspaceId),
        eq(codeProposals.capabilityId, p.capabilityId),
        eq(codeProposals.status, 'proposed'),
      ))
      .limit(1).catch(() => [])
    if (existing.length > 0) return existing[0]!.id
  }
  const id = uuidv7()
  try {
    await db.insert(codeProposals).values({
      id, workspaceId: p.workspaceId,
      buildPlanId:   p.buildPlanId   ?? null,
      capabilityId:  p.capabilityId  ?? null,
      title: p.title, summary: p.summary,
      filesToCreate: p.filesToCreate,
      filesToModify: p.filesToModify,
      testsRequired: p.testsRequired,
      riskLevel: p.riskLevel,
      estimatedLoc: p.estimatedLoc,
      status: 'proposed',
      reasoning: p.reasoning,
      createdAt: now, updatedAt: now,
    })
  } catch (e) {
    // Unique-index collision means a concurrent caller won the race — return
    // the existing row instead of failing.
    if (p.capabilityId) {
      const existing = await db.select({ id: codeProposals.id })
        .from(codeProposals)
        .where(and(
          eq(codeProposals.workspaceId, p.workspaceId),
          eq(codeProposals.capabilityId, p.capabilityId),
          eq(codeProposals.status, 'proposed'),
        ))
        .limit(1).catch(() => [])
      if (existing.length > 0) return existing[0]!.id
    }
    console.error('[code-writer] persistProposal insert failed', (e as Error).message)
  }

  await recordChain({
    workspaceId: p.workspaceId,
    kind: 'decision',
    subjectId: `code-proposal:${p.capabilityId ?? id}`,
    decision: `Code proposal generated: ${p.title} (${p.estimatedLoc} LOC, risk=${p.riskLevel})`,
    evidence: [{ type: 'code_proposal', id, extract: `${p.filesToCreate.length} new + ${p.filesToModify.length} mod files` }],
    confidence: p.riskLevel === 'low' ? 0.75 : p.riskLevel === 'medium' ? 0.6 : 0.5,
    source: 'code-writer',
  }).catch(() => null)

  return id
}

export async function listProposals(workspaceId: string, opts?: { status?: CodeProposal['status']; limit?: number }) {
  const conds = [eq(codeProposals.workspaceId, workspaceId)]
  if (opts?.status) conds.push(eq(codeProposals.status, opts.status))
  return db.select().from(codeProposals)
    .where(and(...conds))
    .orderBy(desc(codeProposals.createdAt))
    .limit(opts?.limit ?? 50).catch(() => [])
}

export async function setProposalStatus(workspaceId: string, id: string, status: CodeProposal['status']): Promise<void> {
  await db.update(codeProposals).set({ status, updatedAt: Date.now() })
    .where(and(eq(codeProposals.workspaceId, workspaceId), eq(codeProposals.id, id)))
    .catch(() => null)
  const { recordStatusChange } = await import('./brain-persistence.js')
  await recordStatusChange({
    workspaceId, entityType: 'proposal', entityId: id,
    status, source: 'code-writer',
  }).catch(() => null)
}

export async function markShipped(workspaceId: string, id: string, commitSha: string, by = 'operator'): Promise<void> {
  await db.update(codeProposals).set({
    status: 'shipped',
    shippedAt: Date.now(),
    shippedCommitSha: commitSha,
    shippedBy: by,
    updatedAt: Date.now(),
  }).where(and(eq(codeProposals.workspaceId, workspaceId), eq(codeProposals.id, id)))
    .catch(() => null)
}

export async function credibilityMetrics(workspaceId: string, windowDays = 90) {
  const since = Date.now() - windowDays * 24 * 60 * 60_000
  const rows = await db.select().from(codeProposals)
    .where(and(eq(codeProposals.workspaceId, workspaceId)))
    .catch(() => [])
  const recent = rows.filter(r => r.createdAt >= since)
  const approved = recent.filter(r => r.status === 'approved' || r.status === 'shipped').length
  const shipped  = recent.filter(r => r.status === 'shipped').length
  const rejected = recent.filter(r => r.status === 'rejected').length
  const open     = recent.filter(r => r.status === 'proposed').length
  return {
    windowDays,
    total: recent.length,
    proposed: open, approved, shipped, rejected,
    approvalRate:  recent.length > 0 ? Number((approved / recent.length).toFixed(3)) : null,
    shippedRate:   approved > 0    ? Number((shipped  / approved).toFixed(3))     : null,
    factType: 'fact' as const,
  }
}

