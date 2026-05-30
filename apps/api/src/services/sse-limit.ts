/**
 * sse-limit.ts — Global concurrent-stream cap for SSE routes.
 *
 * Background (R146.38): R146.18 added per-route N/minute rate-limits but
 * SSE connections are long-lived — an attacker riding under the rate-limit
 * can still hold dozens of open streams indefinitely (one connection ≠ one
 * request from the rate-limiter's POV). Live-probed 50 concurrent streams
 * opened cleanly with zero errors and grew server RSS ~20MB.
 *
 * Usage in each SSE handler:
 *
 *   if (!sseSlots.tryAcquire()) {
 *     return reply.code(503).send({ success: false, error: 'too many open streams, retry shortly' })
 *   }
 *   req.raw.on('close', () => sseSlots.release())
 *
 * Cap defaults to 200 process-wide. Env override SSE_MAX_CONCURRENT.
 */

const MAX = (() => {
  const raw = Number(process.env['SSE_MAX_CONCURRENT'] ?? 200)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 200
})()

let open = 0

export const sseSlots = {
  tryAcquire(): boolean {
    if (open >= MAX) return false
    open++
    return true
  },
  release(): void {
    if (open > 0) open--
  },
  /** for observability / metrics */
  stats(): { open: number; max: number } {
    return { open, max: MAX }
  },
}
