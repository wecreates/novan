/**
 * R146.209 — Adversarial verification before commit. Given a claim +
 * supporting evidence, spawn N sub-agents prompted to REFUTE. Each
 * defaults to refuted=true when uncertain. If a majority refute, the
 * caller should kill the action.
 *
 * Used by the action-dispatcher / publish_post / kill-switch paths to
 * prevent "plausible but wrong" failure mode in autonomous mode.
 */
import { db } from '../db/client.js'
import { adversarialVerdicts } from '../db/schema.js'
import { v7 as uuidv7 } from 'uuid'
import { parallelSubagents } from './r208-subagent.js'
import { diverseProviders } from './r216-routing.js'
import { checkDailyCostCap } from './r248-cost-cap.js'

export interface VerifyRequest {
  subject:    string
  claim:      string
  evidence?:  string
  voters?:    number
  threshold?: number  // majority by default
}

export interface VerifyResult {
  id:            string
  decision:      'approve' | 'block'
  voters:        number
  refutedCount:  number
  reasons:       string[]
  votes:         Array<{ refuted: boolean; reason: string }>
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    reason:  { type: 'string' },
  },
  required: ['refuted', 'reason'],
}

export async function adversarialVerify(workspaceId: string, req: VerifyRequest): Promise<VerifyResult> {
  const voters = Math.max(2, Math.min(7, req.voters ?? 3))
  const threshold = req.threshold ?? Math.ceil(voters / 2)

  // R146.251 — Cap gate. Adversarial verify costs voters × LLM call; if
  // we're already over budget, fail closed (block) without spending more.
  const cap = await checkDailyCostCap(workspaceId).catch(() => null)
  if (cap?.over) {
    const id = uuidv7()
    const reason = `daily AI budget exhausted ($${cap.spent.toFixed(2)}/$${cap.cap.toFixed(2)}); blocked fail-closed`
    await db.insert(adversarialVerdicts).values({
      id, workspaceId,
      subject: req.subject.slice(0, 500),
      claim:   req.claim.slice(0, 1000),
      voters: 0, refutedCount: voters, votes: [],
      decision: 'block',
      createdAt: Date.now(),
    }).catch(() => null)
    return { id, decision: 'block', voters: 0, refutedCount: voters, reasons: [reason], votes: [] }
  }

  const lenses = ['correctness', 'safety', 'completeness', 'user-impact', 'side-effects', 'security', 'cost'].slice(0, voters)
  // R216 — each voter routed to a DIFFERENT provider so single-model bias
  // can't dominate the verdict. Diversity falls back gracefully if fewer
  // healthy providers are available.
  const providers = await diverseProviders(voters, 'adversarial').catch(() => [])
  const requests = lenses.map((lens, i) => ({
    parentOp: 'adversarial.verify',
    task: 'adversarial',
    ...(providers[i] ? { preferProvider: providers[i] } : {}),
    prompt: `You are a skeptic reviewing this action via the ${lens} lens.\n\n` +
            `Subject: ${req.subject}\nClaim: ${req.claim}\n` +
            (req.evidence ? `Evidence: ${req.evidence}\n` : '') +
            `\nTask: try to REFUTE the claim. Default to refuted=true if you are uncertain ` +
            `or if the evidence is weak/incomplete. Return {refuted, reason} as JSON. Reason ≤ 200 chars.`,
    schema: VERDICT_SCHEMA,
  }))

  const results = await parallelSubagents(workspaceId, requests)
  const votes: Array<{ refuted: boolean; reason: string }> = results.map(r => {
    const parsed = r.parsed as { refuted?: boolean; reason?: string } | undefined
    return {
      refuted: parsed?.refuted ?? true,  // fail closed
      reason:  parsed?.reason  ?? (r.error ? `voter error: ${r.error}` : 'no reason'),
    }
  })

  const refutedCount = votes.filter(v => v.refuted).length
  const decision: 'approve' | 'block' = refutedCount >= threshold ? 'block' : 'approve'
  const id = uuidv7()
  await db.insert(adversarialVerdicts).values({
    id, workspaceId,
    subject: req.subject.slice(0, 500),
    claim:   req.claim.slice(0, 1000),
    voters, refutedCount, votes, decision,
    createdAt: Date.now(),
  }).catch(() => null)

  return {
    id, decision, voters, refutedCount,
    reasons: votes.filter(v => v.refuted).map(v => v.reason),
    votes,
  }
}
