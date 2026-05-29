/**
 * recovery-playbook.ts — Layer 2 recovery-playbook registry.
 *
 * Codifies the failure-mode → recovery-procedure mapping that today
 * lives only as markdown in `docs/runbooks/`. The registry lets the
 * self-healing engine answer "I see failure X, what's the procedure?"
 * programmatically, while keeping the human-readable runbook as the
 * source of truth for the actual steps.
 *
 * Honest scope:
 *   - This module is a **registry + matcher**, not an executor.
 *     Recovery steps remain human-authored markdown. The system
 *     matches a detected failure to a playbook, surfaces it, and
 *     (where confidence is high) emits a `recovery.playbook_suggested`
 *     event with a link to the runbook.
 *   - Auto-execution is gated. Today only `service_restart` is
 *     auto-runnable — the other playbooks must be human-confirmed.
 *     This matches the spec: "high-confidence matches act automatically;
 *     lower-confidence matches surface to humans."
 */

export type FailureMode =
  | 'service_crashed'
  | 'cron_error_spike'
  | 'provider_outage'
  | 'db_replication_lag'
  | 'deployment_regression'
  | 'lock_integrity_tamper'
  | 'kill_switch_tripped'
  | 'budget_exhausted'

export interface Playbook {
  failureMode:        FailureMode
  title:              string
  description:        string
  runbook:            string         // path to human-readable doc
  detectionEventType: string         // event type that triggers a match
  autoRecoverable:    boolean        // true → auto-executor may proceed
  escalateAfterFails: number         // retries before paging operator
  recoverySteps:      string[]       // summarized for programmatic surface
}

export const PLAYBOOKS: Playbook[] = [
  {
    failureMode: 'service_crashed',
    title: 'Restart crashed worker',
    description: 'Worker process exited unexpectedly. Restart with exponential backoff.',
    runbook: 'docs/runbooks/snapshot-rollback.md',
    detectionEventType: 'cron.error',
    autoRecoverable: true,
    escalateAfterFails: 3,
    recoverySteps: [
      'Capture exit code + last 100 log lines',
      'Restart worker via BullMQ supervisor',
      'Verify worker reports ready within 30s',
      'If 3 consecutive crashes within 5min, escalate',
    ],
  },
  {
    failureMode: 'cron_error_spike',
    title: 'Cron error rate spike',
    description: 'cron.error events exceeding baseline; specific task likely degraded.',
    runbook: 'docs/runbooks/observability.md',
    detectionEventType: 'cron.error_spike',
    autoRecoverable: false,
    escalateAfterFails: 0,
    recoverySteps: [
      'Identify which task is failing (group events by payload.task)',
      'Check cron-budget gating (may be paused intentionally)',
      'Check provider health if task calls external API',
      'Disable specific task via DISABLE_LEARNING_CRON if needed',
    ],
  },
  {
    failureMode: 'provider_outage',
    title: 'LLM provider degraded',
    description: 'Anthropic/OpenAI/Gemini circuit open; chat fallback chain engaged.',
    runbook: 'docs/runbooks/observability.md',
    detectionEventType: 'provider.circuit_opened',
    autoRecoverable: true,
    escalateAfterFails: 2,
    recoverySteps: [
      'Fallback chain auto-engaged via chat-providers',
      'Verify alternate providers responding',
      'If all providers degraded, kill_switch chat capability',
      'Operator alerted via brain-broadcast',
    ],
  },
  {
    failureMode: 'db_replication_lag',
    title: 'Database replication lag',
    description: 'Replica lag exceeds threshold; read consistency degraded.',
    runbook: 'docs/MULTI_REGION_FAILOVER_RUNBOOK.md',
    detectionEventType: 'db.replication_lag_alert',
    autoRecoverable: false,
    escalateAfterFails: 0,
    recoverySteps: [
      'Identify lagging replica via pg_stat_replication',
      'Route reads to primary temporarily',
      'Investigate root cause: long transaction, network, vacuum',
      'Escalate to operator before failover',
    ],
  },
  {
    failureMode: 'deployment_regression',
    title: 'Deployment regression detected',
    description: 'Metrics degraded within deploy window; consider rollback.',
    runbook: 'docs/runbooks/snapshot-rollback.md',
    detectionEventType: 'deployment.regression_suspected',
    autoRecoverable: false,
    escalateAfterFails: 0,
    recoverySteps: [
      'Confirm regression with eval-set rerun',
      'Quarantine bad artifact',
      'Roll back via snapshot-rollback procedure',
      'Open postmortem',
    ],
  },
  {
    failureMode: 'lock_integrity_tamper',
    title: 'Locked-core file tampering detected',
    description: 'Content hash of a LOCKED_PATHS file no longer matches baseline.',
    runbook: 'docs/SPEC.md#§10.5',
    detectionEventType: 'lock_integrity.tamper_detected',
    autoRecoverable: false,
    escalateAfterFails: 0,
    recoverySteps: [
      'HALT — do NOT auto-revert. Operator investigates first.',
      'Capture git diff of the affected path',
      'Compare against most recent acknowledged baseline',
      'If legitimate change, acknowledgeLockChange() with reason',
      'If unauthorized, treat as security incident',
    ],
  },
  {
    failureMode: 'kill_switch_tripped',
    title: 'Kill switch activated',
    description: 'A kill_switch.* op was invoked; affected capability halted.',
    runbook: 'docs/runbooks/policy-engine.md',
    detectionEventType: 'kill_switch.tripped',
    autoRecoverable: false,
    escalateAfterFails: 0,
    recoverySteps: [
      'Identify which switch + which capability',
      'Confirm intentional vs accidental',
      'Investigate root cause that caused trip',
      'Operator manually clears switch when safe',
    ],
  },
  {
    failureMode: 'budget_exhausted',
    title: 'Cron / agent budget exhausted',
    description: 'cron-budget gating blocked execution; sustained budget pressure.',
    runbook: 'docs/runbooks/policy-engine.md',
    detectionEventType: 'cron.budget_blocked',
    autoRecoverable: false,
    escalateAfterFails: 0,
    recoverySteps: [
      'Identify which budget category exhausted',
      'Review ai_usage for spend anomalies',
      'Either raise budget (operator decision) or reduce traffic',
      'Do NOT auto-raise budget',
    ],
  },
]

/** Look up a playbook by failure mode. */
export function getPlaybook(mode: FailureMode): Playbook | undefined {
  return PLAYBOOKS.find(p => p.failureMode === mode)
}

/** Match a detected event-type to its playbook (if any). */
export function matchEventToPlaybook(eventType: string): Playbook | undefined {
  return PLAYBOOKS.find(p => p.detectionEventType === eventType)
}

/** Summary for the Architecture overview tab. */
export function playbookSummary(): {
  total: number
  autoRecoverable: number
  humanGated: number
} {
  let auto = 0, human = 0
  for (const p of PLAYBOOKS) { p.autoRecoverable ? auto++ : human++ }
  return { total: PLAYBOOKS.length, autoRecoverable: auto, humanGated: human }
}

/** Emit a `recovery.playbook_suggested` event when a matching failure
 *  is observed. The actual execution decision lives elsewhere — this
 *  just surfaces the match so operator + self-healing engine see it. */
export async function suggestPlaybook(
  mode: FailureMode,
  context: Record<string, unknown>,
): Promise<{ suggested: boolean; playbook?: Playbook }> {
  const pb = getPlaybook(mode)
  if (!pb) return { suggested: false }
  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    const { v7: uuidv7 } = await import('uuid')
    await db.insert(events).values({
      id: uuidv7(), type: 'recovery.playbook_suggested', workspaceId: null,
      payload: { mode, playbook: pb.title, runbook: pb.runbook, autoRecoverable: pb.autoRecoverable, context },
      traceId: uuidv7(), correlationId: null, causationId: null,
      source: 'recovery-playbook', version: 1, createdAt: Date.now(),
    } as never).catch((e: Error) => { console.error('[recovery-playbook]', e.message); return null })
  } catch { /* tolerated */ }
  return { suggested: true, playbook: pb }
}
