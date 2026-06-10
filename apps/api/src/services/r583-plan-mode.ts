/**
 * R583 — Multi-hypothesis plan mode (Claude Code Plan Mode parity + more).
 *
 * When the brain is asked to execute a multi-step ambition ("set up the
 * Etsy shop end-to-end"), it should:
 *   1. Generate 2-3 alternative PLANS with trade-offs
 *   2. Score each (effort, reversibility, risk, expected value)
 *   3. Present to operator for confirm/edit/reject
 *   4. Only execute after explicit confirmation
 *
 * Storage: plan_proposals table holds the proposals; operator approves
 * via `plan.approve` brain op which then enqueues each step.
 */
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS plan_proposals (
      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL,
      business_id     TEXT,
      ambition        TEXT NOT NULL,         -- "what the operator asked for"
      alternatives    JSONB NOT NULL,        -- Array<{ name, steps[], score, rationale }>
      chosen_idx      INT,
      status          TEXT NOT NULL DEFAULT 'proposed', -- proposed|approved|executing|completed|rejected
      proposed_at     BIGINT NOT NULL,
      decided_at      BIGINT,
      executed_at     BIGINT,
      result_summary  TEXT
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS plan_proposals_ws_status_idx ON plan_proposals (workspace_id, status, proposed_at DESC)`).catch(() => {})
}

export interface PlanStep {
  op:        string
  params?:   Record<string, unknown>
  rationale: string
}
export interface PlanAlternative {
  name:        string                 // e.g. "minimal", "comprehensive", "experimental"
  steps:       PlanStep[]
  scores:      { effort: number; reversibility: number; risk: number; expectedValue: number }
  rationale:   string
}

export interface PlanProposal {
  id:           string
  workspaceId:  string
  businessId:   string | null
  ambition:     string
  alternatives: PlanAlternative[]
  chosenIdx:    number | null
  status:       string
  proposedAt:   number
  decidedAt:    number | null
  executedAt:   number | null
}

export async function proposePlan(
  workspaceId: string, businessId: string | null, ambition: string,
  alternatives: PlanAlternative[],
): Promise<PlanProposal> {
  await ensureTable()
  if (alternatives.length === 0) throw new Error('proposePlan: at least one alternative required')
  const id = uuidv7()
  const now = Date.now()
  await db.execute(sql`
    INSERT INTO plan_proposals (id, workspace_id, business_id, ambition, alternatives, status, proposed_at)
    VALUES (${id}, ${workspaceId}, ${businessId}, ${ambition}, ${JSON.stringify(alternatives)}::jsonb, 'proposed', ${now})
  `)
  return {
    id, workspaceId, businessId, ambition, alternatives,
    chosenIdx: null, status: 'proposed', proposedAt: now, decidedAt: null, executedAt: null,
  }
}

export async function listProposals(workspaceId: string, statusFilter?: string): Promise<PlanProposal[]> {
  await ensureTable()
  try {
    const r = statusFilter
      ? await db.execute(sql`SELECT * FROM plan_proposals WHERE workspace_id = ${workspaceId} AND status = ${statusFilter} ORDER BY proposed_at DESC LIMIT 50`)
      : await db.execute(sql`SELECT * FROM plan_proposals WHERE workspace_id = ${workspaceId} ORDER BY proposed_at DESC LIMIT 50`)
    return (r as unknown as Array<{
      id: string; workspace_id: string; business_id: string | null; ambition: string;
      alternatives: PlanAlternative[]; chosen_idx: number | null; status: string;
      proposed_at: number; decided_at: number | null; executed_at: number | null;
    }>).map(x => ({
      id: x.id, workspaceId: x.workspace_id, businessId: x.business_id, ambition: x.ambition,
      alternatives: x.alternatives, chosenIdx: x.chosen_idx === null ? null : Number(x.chosen_idx),
      status: x.status, proposedAt: Number(x.proposed_at),
      decidedAt: x.decided_at === null ? null : Number(x.decided_at),
      executedAt: x.executed_at === null ? null : Number(x.executed_at),
    }))
  } catch { return [] }
}

export async function approvePlan(workspaceId: string, planId: string, chosenIdx: number): Promise<{ ok: boolean; reason?: string }> {
  await ensureTable()
  try {
    const r = await db.execute(sql`
      UPDATE plan_proposals
      SET chosen_idx = ${chosenIdx}, status = 'approved', decided_at = ${Date.now()}
      WHERE id = ${planId} AND workspace_id = ${workspaceId} AND status = 'proposed'
      RETURNING id
    `)
    const a = r as unknown as Array<unknown>
    if (Array.isArray(a) && a.length > 0) return { ok: true }
    return { ok: false, reason: 'plan not found or not in proposed state' }
  } catch (e) { return { ok: false, reason: (e as Error).message.slice(0, 80) } }
}

export async function rejectPlan(workspaceId: string, planId: string): Promise<{ ok: boolean }> {
  await ensureTable()
  try {
    await db.execute(sql`
      UPDATE plan_proposals SET status = 'rejected', decided_at = ${Date.now()}
      WHERE id = ${planId} AND workspace_id = ${workspaceId}
    `)
    return { ok: true }
  } catch { return { ok: false } }
}
