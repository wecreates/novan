/**
 * useApiLiveness — auto-refresh the UI when the API comes back online.
 *
 * `tsx watch` restarts the dev API on every server-side file save.
 * Before this hook, the operator had to manually refresh the browser
 * after each restart to see updated data. Now:
 *
 *   1. Ping /health every 5 s
 *   2. Track previous state (up / down)
 *   3. On transition DOWN → UP, invalidate all TanStack queries —
 *      every component re-fetches and the UI feels "live" again.
 *
 * Honest scope: this doesn't hot-swap component code (Vite HMR
 * handles that). It only catches the data-staleness gap caused by
 * API restarts.
 */
import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'

const PROBE_INTERVAL_MS = 5_000

export function useApiLiveness(): void {
  const qc = useQueryClient()
  const prevUp = useRef<boolean | null>(null)

  useEffect(() => {
    let cancelled = false

    const probe = async () => {
      if (cancelled) return
      let up = false
      try {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), 2_000)
        const res = await fetch('/api/v1/health', { signal: ctrl.signal })
        clearTimeout(t)
        up = res.ok
      } catch {
        up = false
      }
      // Transition: down → up means the API just came back (probably
      // from a `tsx watch` restart). Invalidate every active query so
      // the UI immediately reflects fresh data.
      if (prevUp.current === false && up) {
        qc.invalidateQueries()
      }
      prevUp.current = up
    }

    void probe()
    const id = setInterval(probe, PROBE_INTERVAL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [qc])
}
