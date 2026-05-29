/**
 * Runtime Kernel — in-process event bus, state machine utilities, checkpoint helpers.
 *
 * Provides the coordination primitives used by workers and API.
 * Intentionally zero external runtime dependencies (no Redis, no DB).
 */
import type { WorkflowStatus } from '@ops/shared-types'

// ─── Types ────────────────────────────────────────────────────────────────────

export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>

export interface KernelEvent<T = unknown> {
  type:      string
  payload:   T
  traceId:   string
  timestamp: number
}

export interface Checkpoint {
  runId:     string
  stepIndex: number
  state:     Record<string, unknown>
  savedAt:   number
}

export interface TransitionResult {
  ok:    boolean
  error?: string
}

// ─── State machine ────────────────────────────────────────────────────────────

const VALID_TRANSITIONS: Record<WorkflowStatus, WorkflowStatus[]> = {
  pending:            ['running', 'cancelled'],
  running:            ['completed', 'failed', 'paused', 'awaiting_approval', 'cancelled'],
  paused:             ['running', 'cancelled'],
  awaiting_approval:  ['running', 'failed', 'cancelled'],
  completed:          [],
  failed:             ['running'],   // retry
  cancelled:          [],
}

export function validateTransition(
  from: WorkflowStatus,
  to:   WorkflowStatus,
): TransitionResult {
  const allowed = VALID_TRANSITIONS[from]
  if (!allowed) return { ok: false, error: `Unknown status: ${from}` }
  if (!allowed.includes(to)) {
    return { ok: false, error: `Invalid transition ${from} → ${to}` }
  }
  return { ok: true }
}

export function canTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return validateTransition(from, to).ok
}

// ─── In-process event bus ─────────────────────────────────────────────────────

class EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>()
  private readonly wildcardHandlers = new Set<EventHandler<KernelEvent>>()

  /** Subscribe to a specific event type. Returns unsubscribe fn. */
  on<T = unknown>(type: string, handler: EventHandler<T>): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set())
this.handlers.get(type)!.add(handler as EventHandler)
    return () => this.handlers.get(type)?.delete(handler as EventHandler)
  }

  /** Subscribe to ALL events (for logging / tracing). Returns unsubscribe fn. */
  onAny(handler: EventHandler<KernelEvent>): () => void {
    this.wildcardHandlers.add(handler as EventHandler<KernelEvent>)
    return () => this.wildcardHandlers.delete(handler as EventHandler<KernelEvent>)
  }

  /** Emit an event. Handlers run concurrently; individual failures are logged, not thrown. */
  async emit<T = unknown>(type: string, payload: T, traceId?: string): Promise<void> {
    const event: KernelEvent<T> = {
      type,
      payload,
      traceId:   traceId ?? crypto.randomUUID(),
      timestamp: Date.now(),
    }

    const typed    = this.handlers.get(type) ?? new Set()
    const onError  = (err: unknown) => console.error(`[EventBus] Handler error for "${type}":`, err)

    const typedResults    = [...typed].map((h) =>
      Promise.resolve().then(() => h(payload)).catch(onError))
    const wildcardResults = [...this.wildcardHandlers].map((h) =>
      Promise.resolve().then(() => (h as EventHandler<unknown>)(event)).catch(onError))

    await Promise.allSettled([...typedResults, ...wildcardResults])
  }

  /** Fire-and-forget emit (non-blocking). */
  fire<T = unknown>(type: string, payload: T, traceId?: string): void {
    void this.emit(type, payload, traceId)
  }

  /** Remove all handlers for a type. */
  off(type: string): void {
    this.handlers.delete(type)
  }

  /** Count of registered handlers (useful for tests/diagnostics). */
  handlerCount(type?: string): number {
    if (type) return this.handlers.get(type)?.size ?? 0
    let total = this.wildcardHandlers.size
    for (const s of this.handlers.values()) total += s.size
    return total
  }
}

/** Singleton kernel event bus — import and use directly. */
export const bus = new EventBus()

// ─── Checkpoint utilities ─────────────────────────────────────────────────────

export function createCheckpoint(
  runId:     string,
  stepIndex: number,
  state:     Record<string, unknown>,
): Checkpoint {
  return { runId, stepIndex, state, savedAt: Date.now() }
}

export function serializeCheckpoint(cp: Checkpoint): string {
  return JSON.stringify(cp)
}

export function deserializeCheckpoint(raw: string): Checkpoint {
  return JSON.parse(raw) as Checkpoint
}

// ─── Retry utilities ──────────────────────────────────────────────────────────

export interface RetryPolicy {
  maxAttempts:       number
  backoffMs:         number
  backoffMultiplier: number
  maxBackoffMs:      number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts:       3,
  backoffMs:         1_000,
  backoffMultiplier: 2,
  maxBackoffMs:      30_000,
}

export function nextBackoffMs(policy: RetryPolicy, attempt: number): number {
  const raw = policy.backoffMs * Math.pow(policy.backoffMultiplier, attempt - 1)
  return Math.min(raw, policy.maxBackoffMs)
}

export function shouldRetry(policy: RetryPolicy, attempt: number): boolean {
  return attempt < policy.maxAttempts
}

// ─── Topological sort ─────────────────────────────────────────────────────────

export interface Node {
  id:   string
  deps: string[]
}

/** Kahn's algorithm. Returns sorted IDs or throws on cycle. */
export function topologicalSort(nodes: Node[]): string[] {
  const inDegree  = new Map<string, number>()
  const adjacency = new Map<string, string[]>()

  for (const n of nodes) {
    if (!inDegree.has(n.id)) inDegree.set(n.id, 0)
    if (!adjacency.has(n.id)) adjacency.set(n.id, [])
    for (const dep of n.deps) {
      const adj = adjacency.get(dep) ?? []
      adj.push(n.id)
      adjacency.set(dep, adj)
      inDegree.set(n.id, (inDegree.get(n.id) ?? 0) + 1)
    }
  }

  const queue  = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id)
  const result: string[] = []

  while (queue.length > 0) {
const id = queue.shift()!
    result.push(id)
    for (const neighbor of adjacency.get(id) ?? []) {
      const deg = (inDegree.get(neighbor) ?? 0) - 1
      inDegree.set(neighbor, deg)
      if (deg === 0) queue.push(neighbor)
    }
  }

  if (result.length !== nodes.length) {
    throw new Error('Cycle detected in dependency graph')
  }
  return result
}

/** Returns all node IDs that have no pending dependencies given a completed set. */
export function readyNodes(nodes: Node[], completed: Set<string>): string[] {
  return nodes
    .filter((n) => !completed.has(n.id) && n.deps.every((d) => completed.has(d)))
    .map((n) => n.id)
}

// ─── Queue contracts ──────────────────────────────────────────────────────────
export {
  QUEUE_NAMES, QUEUE_CONFIG, QUEUE_LOCK_OVERRIDES,
  type QueueName,
  type ExecuteWorkflowJobData, type ResumeWorkflowJobData, type CancelWorkflowJobData,
  type WorkflowQueueJobData,
  type RecoverRunJobData, type ScanApprovalsJobData, type ReplayRunJobData,
  type RecoveryQueueJobData,
  type IndexMemoryJobData, type SearchMemoryJobData, type MemoryQueueJobData,
  type RunAutomationJobData, type VerifyPageJobData, type HealthCheckJobData,
  type BrowserQueueJobData,
  type TrackEventJobData, type GenerateReportJobData, type AnalyticsQueueJobData,
  type QueueJobMeta,
} from './queues.js'

// ─── Redis factory ────────────────────────────────────────────────────────────
export {
  createRedisConnection, createRedisFromEnv,
  type RedisConnectionConfig,
} from './redis.js'

// ─── Dead-letter queue ────────────────────────────────────────────────────────
export {
  buildDeadLetterRecord, isJobExhausted,
  type DeadLetterRecord, type IJobSnapshot,
} from './dead-letter.js'

// ─── Worker lifecycle ─────────────────────────────────────────────────────────
export {
  attachWorkerLifecycle,
  type WorkerLifecycleOptions,
} from './worker-lifecycle.js'

// ─── Process safety ───────────────────────────────────────────────────────────
export {
  installProcessSafetyNet,
  type ProcessSafetyOptions,
} from './process-safety.js'

// ─── Trace IDs ────────────────────────────────────────────────────────────────
export {
  generateTraceId, generateCorrelationId, generateCausationId,
  createTraceContext, extractTraceContext,
  type TraceContext,
} from './trace-id.js'

// ─── Health signals ───────────────────────────────────────────────────────────
export {
  deriveOverallStatus, classifyQueueHealth, classifyWorkerHealth,
  HEALTH_THRESHOLDS,
  type HealthStatus, type HealthSignal,
  type QueueHealthReport, type WorkerHealthReport, type SystemHealthSnapshot,
} from './health.js'

// ─── AI execution ─────────────────────────────────────────────────────────────
export {
  executeAi,
  type AiExecutionRequest, type AiExecutionResult,
} from './ai-executor.js'

// ─── Context builder ──────────────────────────────────────────────────────────
export {
  buildSystemPrompt,
  type WorkflowContext,
} from './context-builder.js'
