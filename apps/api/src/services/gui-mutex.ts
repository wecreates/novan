/**
 * gui-mutex.ts — process-wide mutex for single-instance GUI apps.
 *
 * CapCut, Mixcraft, and other DAWs/NLEs are single-process GUI tools.
 * If mass-produce or a schedule fires two CapCut assemblies in parallel,
 * SendKeys + clipboard race conditions produce silently corrupted edits.
 *
 * Usage:
 *   await withGuiLock('capcut', async () => { ...assembly... })
 *
 * Locks are in-process only (Node single instance). Multi-instance API
 * deployments would need a Redis lock, but for the brain's local-only
 * GUI driving the in-process lock is correct.
 */

interface QueueEntry { resolve: () => void; reject: (e: Error) => void; cancelled: boolean; enqueuedAt: number; timer: ReturnType<typeof setTimeout> | null }

const queues: Record<string, QueueEntry[]> = {}
const held:   Record<string, boolean>      = {}

/** Hard cap so a hung GUI task can't accumulate unbounded callers
 *  behind it — the brain backs off rather than queueing forever. */
const MAX_QUEUE_PER_LOCK = 20
/** Max time a waiter sits in the queue before timing out. Without
 *  this, an indefinitely-hung CapCut/Mixcraft instance would keep
 *  every subsequent call blocked until the API process restarted. */
const ACQUIRE_TIMEOUT_MS = 5 * 60_000

function acquire(name: string, timeoutMs = ACQUIRE_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!held[name]) {
      held[name] = true
      resolve()
      return
    }
    if (!queues[name]) queues[name] = []
    const q = queues[name]!
    if (q.length >= MAX_QUEUE_PER_LOCK) {
      reject(new Error(`gui-mutex: queue for "${name}" is full (${MAX_QUEUE_PER_LOCK} waiting). Refuse rather than pile up.`))
      return
    }
    const entry: QueueEntry = { resolve, reject, cancelled: false, enqueuedAt: Date.now(), timer: null }
    q.push(entry)
    // Timeout — mark the entry cancelled so release() skips it when
    // the head of queue is reached, and reject the awaiting caller now.
    // Timer is also cleared from release() on the normal-grant path so the
    // closure doesn't keep the entry alive for the full timeoutMs window.
    entry.timer = setTimeout(() => {
      entry.timer = null
      if (!entry.cancelled) {
        entry.cancelled = true
        reject(new Error(`gui-mutex: timed out after ${timeoutMs}ms waiting for "${name}"`))
      }
    }, timeoutMs)
    if (typeof (entry.timer as { unref?: () => void }).unref === 'function') (entry.timer as { unref: () => void }).unref()
  })
}

function release(name: string): void {
  const q = queues[name]
  // Skip cancelled waiters — they already rejected via timeout and
  // shouldn't get the lock. Loop because there may be multiple
  // cancelled entries in a row.
  while (q && q.length > 0) {
    const next = q.shift()!
    if (next.timer) { clearTimeout(next.timer); next.timer = null }
    if (next.cancelled) continue
    next.resolve()
    return
  }
  held[name] = false
}

export async function withGuiLock<T>(name: 'capcut' | 'mixcraft', fn: () => Promise<T>): Promise<T> {
  await acquire(name)
  try { return await fn() }
  finally { release(name) }
}

export function guiLockStatus(): Record<string, { held: boolean; waiting: number }> {
  const out: Record<string, { held: boolean; waiting: number }> = {}
  for (const name of new Set([...Object.keys(held), ...Object.keys(queues)])) {
    out[name] = { held: !!held[name], waiting: (queues[name] ?? []).length }
  }
  return out
}
