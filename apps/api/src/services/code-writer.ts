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
import { codeProposals } from '../db/schema.js'
import { and, desc, eq } from 'drizzle-orm'
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
  const id = uuidv7(), now = Date.now()
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
  }).catch(() => null)

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

