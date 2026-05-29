/**
 * process-safety.ts — Install crash-safety handlers on a worker / API process.
 *
 * Without these, an unhandled promise rejection or synchronous throw in any
 * background path (job handler, cron callback, listener) crashes the process
 * silently — pino has no chance to flush the failing frame. With these:
 *   • unhandledRejection → log + best-effort emit, keep running
 *   • uncaughtException  → log fatal + exit(1) after a 250 ms flush window
 *
 * Pure helper — does not require pino, does not require DB. Caller passes
 * any logger that exposes `.error` and `.fatal` (the pino API is compatible
 * by accident; falls back to console).
 */

export interface ProcessSafetyOptions {
  /** Human-readable name for the running process. Goes into log lines. */
  workerName: string
  /** Optional pino-compatible logger. Defaults to console. */
  log?: {
    error: (obj: Record<string, unknown>, msg?: string) => void
    fatal: (obj: Record<string, unknown>, msg?: string) => void
  }
  /** Optional best-effort callback invoked on unhandledRejection only. */
  onRejection?: (reason: unknown, promise: Promise<unknown>) => void | Promise<void>
}

export function installProcessSafetyNet(opts: ProcessSafetyOptions): void {
  const { workerName, onRejection } = opts
  const log = opts.log ?? {
    error: (o: Record<string, unknown>, m?: string) => console.error(`[${workerName}]`, m ?? '', o),
    fatal: (o: Record<string, unknown>, m?: string) => console.error(`[${workerName}][fatal]`, m ?? '', o),
  }

  process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    const msg = (reason as Error)?.message ?? String(reason)
    log.error(
      { err: msg, stack: (reason as Error)?.stack, promise: String(promise) },
      `[${workerName}] unhandledRejection`,
    )
    if (onRejection) {
      try {
        const r = onRejection(reason, promise)
        if (r && typeof (r as Promise<unknown>).catch === 'function') {
          (r as Promise<unknown>).catch(() => null)
        }
      } catch { /* swallow — handler itself failed */ }
    }
  })

  process.on('uncaughtException', (err: Error) => {
    log.fatal(
      { err: err.message, stack: err.stack },
      `[${workerName}] uncaughtException — exiting in 250ms`,
    )
    setTimeout(() => process.exit(1), 250).unref()
  })
}
