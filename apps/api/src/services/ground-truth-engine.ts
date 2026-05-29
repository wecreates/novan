/**
 * ground-truth-engine.ts — Evidence requirement gate for critical decisions.
 *
 * Wraps the recommendation/forecast/decision output and enforces:
 *   - For 'critical' classification: at least 2 distinct evidence sources
 *   - For 'high':                    at least 1 distinct evidence source
 *   - For 'normal':                  no requirement (pass-through)
 *
 * The 'distinct evidence source' check looks for evidence rows from
 * multiple categories: runtime / verification / provider / operator /
 * telemetry / test. Two evidence rows from the same category count as 1.
 *
 * Honest: this doesn't validate that the evidence is CORRECT — only
 * that distinct sources EXIST. Validity comes from outcome tracking.
 */
import { db }                          from '../db/client.js'
import { events }                      from '../db/schema.js'
import { v7 as uuidv7 }                from 'uuid'

export type EvidenceCategory =
  | 'runtime' | 'verification' | 'provider' | 'operator' | 'telemetry' | 'test'

export interface Evidence {
  category:  EvidenceCategory
  table:     string
  id:        string
  extract:   string
}

export type Criticality = 'normal' | 'high' | 'critical'

export interface GroundTruthResult {
  passed:           boolean
  criticality:      Criticality
  requiredSources:  number
  distinctSources:  number
  evidenceProvided: Evidence[]
  missingCategories?: EvidenceCategory[]
  reason:           string
}

export async function check(opts: {
  workspaceId: string
  decisionId:  string
  criticality: Criticality
  evidence:    Evidence[]
}): Promise<GroundTruthResult> {
  const requiredSources = opts.criticality === 'critical' ? 2 : opts.criticality === 'high' ? 1 : 0
  const distinctCategories = new Set(opts.evidence.map(e => e.category))
  const distinct = distinctCategories.size

  const passed = distinct >= requiredSources

  const result: GroundTruthResult = {
    passed,
    criticality: opts.criticality,
    requiredSources,
    distinctSources: distinct,
    evidenceProvided: opts.evidence,
    reason: passed
      ? `evidence threshold met (${distinct}/${requiredSources})`
      : `evidence threshold NOT met (${distinct}/${requiredSources}) — needs more distinct source categories`,
  }
  if (!passed) {
    const all: EvidenceCategory[] = ['runtime', 'verification', 'provider', 'operator', 'telemetry', 'test']
    result.missingCategories = all.filter(c => !distinctCategories.has(c))
  }

  await db.insert(events).values({
    id: uuidv7(), type: passed ? 'ground_truth.passed' : 'ground_truth.failed',
    workspaceId: opts.workspaceId,
    payload: { decisionId: opts.decisionId, criticality: opts.criticality, requiredSources, distinctSources: distinct, reason: result.reason },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'ground-truth-engine', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[ground-truth-engine]', e.message); return null })

  return result
}

/** Classify fact vs prediction vs assumption — explicit separation. */
export type EpistemicLabel = 'verified_fact' | 'probable_conclusion' | 'uncertain_assumption' | 'speculative_forecast'

export function classifyEpistemic(opts: {
  confidence:           number
  hasVerifiedEvidence:  boolean
  hasModelGeneration:   boolean
  isForecast:           boolean
}): { label: EpistemicLabel; rationale: string } {
  if (opts.isForecast)              return { label: 'speculative_forecast', rationale: 'forecast — extrapolation from trends, not observed reality' }
  if (opts.hasVerifiedEvidence && opts.confidence >= 0.85) {
    return { label: 'verified_fact', rationale: `evidence-backed, confidence ${opts.confidence.toFixed(2)} ≥ 0.85` }
  }
  if (opts.confidence >= 0.6) {
    return { label: 'probable_conclusion', rationale: `confidence ${opts.confidence.toFixed(2)} ≥ 0.6; ${opts.hasModelGeneration ? 'model-derived' : 'heuristic-derived'}` }
  }
  return { label: 'uncertain_assumption', rationale: `confidence ${opts.confidence.toFixed(2)} < 0.6 — treat as working assumption` }
}
