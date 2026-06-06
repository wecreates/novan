/**
 * R146.325 (#9) — provider invoice reconciliation.
 *
 * The platform tracks `cost.spent` via `recordAiUsage` (per-call estimates).
 * Those estimates drift from actual provider invoices (model-version
 * deltas, hidden cache discounts, tokenizer rounding). Without periodic
 * reconciliation the cost cap loses meaning.
 *
 * Approach: monthly cron pulls the prior period's usage from each
 * provider's billing API (where available — currently Anthropic exposes
 * /v1/messages/usage; OpenAI requires manual export) and writes a single
 * `cost.reconciled` event with the delta. Operator dashboard surfaces
 * the running drift.
 *
 * This file is the scaffold: it defines the interface + a stub fetch.
 * Wire `runCostReconciliation()` from the monthly cron once the operator
 * provides ANTHROPIC_USAGE_API_KEY (different scope than the inference
 * key — billing read-only).
 */
import { db } from '../db/client.js'
import { events } from '../db/schema.js'
import { v7 as uuidv7 } from 'uuid'
import { EVENT_SCHEMA_VERSION } from '@ops/event-contracts'

export interface ReconciliationResult {
  provider:   string
  periodStart: number
  periodEnd:   number
  estimatedUsd: number
  invoicedUsd:  number | null   // null if API unavailable
  driftUsd:     number | null
  notes:        string[]
}

async function fetchAnthropicInvoiced(_start: number, _end: number): Promise<number | null> {
  // R146.325 (#9) — Anthropic billing endpoint scaffold.
  // Operator must set ANTHROPIC_USAGE_API_KEY (billing-read scope).
  const key = process.env['ANTHROPIC_USAGE_API_KEY']
  if (!key) return null
  // Endpoint shape pending; this is intentionally a stub that returns null
  // until the API contract is confirmed. Wiring this end-to-end is a
  // multi-step task that wants its own session.
  return null
}

export async function runCostReconciliation(workspaceId: string, periodStart: number, periodEnd: number): Promise<ReconciliationResult[]> {
  const results: ReconciliationResult[] = []
  // Estimated spend from our internal counter — placeholder, wire to real query
  // against the aiUsage table when this graduates from scaffold.
  const estimatedUsd = 0
  const invoicedUsd = await fetchAnthropicInvoiced(periodStart, periodEnd)
  const driftUsd = invoicedUsd === null ? null : invoicedUsd - estimatedUsd
  results.push({
    provider: 'anthropic', periodStart, periodEnd,
    estimatedUsd, invoicedUsd, driftUsd,
    notes: invoicedUsd === null ? ['ANTHROPIC_USAGE_API_KEY not configured'] : [],
  })
  // Persist for dashboard
  await db.insert(events).values({
    id: uuidv7(), type: 'cost.reconciled', workspaceId,
    payload: { results },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'r325-cost-reconciliation', version: EVENT_SCHEMA_VERSION,
    createdAt: Date.now(),
  }).catch(() => null)
  return results
}
