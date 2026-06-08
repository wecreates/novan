/**
 * R146.338 — Per-Op Confidence Scoring (closes meta.self_assessment 4→8)
 *
 * Before any non-trivial op executes, score Novan's confidence to succeed
 * given:
 *   - capability parity score for the relevant capability
 *   - recent failure rate for this op
 *   - provider health for any required upstream
 *   - applicable lessons from memory
 *
 * Auto-decline ops below threshold + escalate to operator with reasoning.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

export interface ConfidenceScore {
  op:                string
  score:             number                  // 0-1
  threshold:         number                  // op-specific threshold
  recommendation:    'proceed' | 'proceed_with_caution' | 'escalate' | 'decline'
  factors:           Array<{ name: string; delta: number; reason: string }>
  blockingFactors:   string[]                // hard reasons to decline
}

const OP_THRESHOLDS: Record<string, number> = {
  default:                  0.4,
  'brand.dba_propagation_plan': 0.7,
  'art.public_domain_fetch':    0.5,
  'image.generate':             0.6,
  'channel.save':               0.8,
  'connector.delete':           0.9,   // destructive
}

/** Map op name to the parity capability that gates it. */
const OP_CAPABILITY_MAP: Record<string, string> = {
  'image.generate':             'tool_use.browser_drive',          // proxy
  'brand.dba_propagation_plan': 'brand.dba_propagation',
  'art.public_domain_fetch':    'web.fetch',
  'capability.parity_report':   'meta.honest_reporting',
  'lesson.applicable_for':      'memory.lesson_auto_capture',
  'privacy.check_submit':       'safety.privacy_runtime_gate',
  'decide.image_gen_fallback':  'reasoning.strategy_selection',
}

export async function scoreConfidence(input: {
  workspaceId: string
  op:          string
  context?:    Record<string, unknown>
}): Promise<ConfidenceScore> {
  const factors: ConfidenceScore['factors'] = []
  const blocking: string[] = []
  let score = 0.5

  // Factor 1: parity score for capability gating this op
  const capId = OP_CAPABILITY_MAP[input.op]
  if (capId) {
    try {
      const { CLAUDE_PARITY } = await import('./r334-claude-parity-registry.js')
      const cap = CLAUDE_PARITY.find(c => c.id === capId)
      if (cap) {
        const parityDelta = (cap.novanScore - 5) * 0.05    // -0.25 to +0.25
        factors.push({
          name: 'parity_score',
          delta: parityDelta,
          reason: `${capId} scores ${cap.novanScore}/10`,
        })
        score += parityDelta
      }
    } catch { /* ignore */ }
  }

  // Factor 2: recent failure rate for this op
  try {
    const sinceMs = Date.now() - 24 * 3600 * 1000
    const rows = await db.execute(sql`
      SELECT COUNT(*) FILTER (WHERE type LIKE '%error%' OR type LIKE '%fail%') AS fails,
             COUNT(*) AS total
      FROM events
      WHERE workspace_id = ${input.workspaceId}
        AND created_at >= ${sinceMs}
        AND payload::text ILIKE ${'%' + input.op + '%'}
    `) as unknown as Array<{ fails: number; total: number }>
    const r = rows[0]
    if (r && Number(r.total) > 0) {
      const failRate = Number(r.fails) / Number(r.total)
      const delta = -failRate * 0.3
      factors.push({
        name:  'recent_failure_rate',
        delta,
        reason: `${r.fails}/${r.total} failures in last 24h`,
      })
      score += delta
      if (failRate > 0.5) blocking.push('Failure rate > 50% in last 24h')
    }
  } catch { /* ignore */ }

  // Factor 3: provider health for ops that need image gen
  if (input.op === 'image.generate' || input.op === 'art.public_domain_fetch') {
    try {
      const { canGenerateImagesNow } = await import('./r333-provider-health-monitor.js')
      const status = await canGenerateImagesNow()
      const delta = status.ok ? +0.15 : -0.30
      factors.push({
        name:  'provider_health',
        delta,
        reason: status.reason,
      })
      score += delta
      if (!status.ok && input.op === 'image.generate') {
        blocking.push('All image providers currently unhealthy')
      }
    } catch { /* ignore */ }
  }

  // Factor 4: applicable lessons for the op
  try {
    const { applicableLessonsFor } = await import('./r335-lesson-auto-capture.js')
    const lessons = await applicableLessonsFor(input.workspaceId, input.op)
    if (lessons.length > 0) {
      const delta = +0.05 * Math.min(lessons.length, 3)
      factors.push({
        name:  'applicable_lessons',
        delta,
        reason: `${lessons.length} lesson(s) apply — pre-flight guidance available`,
      })
      score += delta
    }
  } catch { /* ignore */ }

  // Clamp + classify
  score = Math.max(0, Math.min(1, score))
  const threshold = OP_THRESHOLDS[input.op] ?? OP_THRESHOLDS['default']!
  let recommendation: ConfidenceScore['recommendation']
  if (blocking.length > 0)      recommendation = 'decline'
  else if (score >= threshold + 0.2) recommendation = 'proceed'
  else if (score >= threshold)       recommendation = 'proceed_with_caution'
  else                                recommendation = 'escalate'

  return {
    op:               input.op,
    score:            Number(score.toFixed(3)),
    threshold,
    recommendation,
    factors,
    blockingFactors:  blocking,
  }
}
