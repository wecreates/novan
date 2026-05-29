/**
 * useBrainKeepWarm — keep the brain graph cache warm 24/7.
 *
 * The /brain page already polls every 15 s while mounted. From other
 * pages we silently prefetch the same graph every 60 s so opening
 * Brain feels instant + the local cache reflects reality even when the
 * operator hasn't visited Brain in hours.
 *
 * Honest scope: this is opportunistic prefetch only. It uses TanStack
 * Query's prefetch API and respects the global staleTime. If the API
 * is unreachable, the failed fetch is silently swallowed.
 */
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useWorkspace } from '../contexts/WorkspaceContext.js'
import { api } from '../api.js'

const KEEP_WARM_INTERVAL_MS = 60_000   // 60 s — gentle, not load-bearing
const STALE_FLOOR_MS        = 30_000

export function useBrainKeepWarm(): void {
  const qc = useQueryClient()
  const { workspaceId } = useWorkspace()

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false

    const tick = async () => {
      if (cancelled) return
      // Default template = whatever the operator picked on /account.
      let template = 'neural'
      try { template = localStorage.getItem('novan:brain-template') ?? 'neural' } catch {}

      // Prefetch — TanStack Query stores the result under the same key
      // the BrainPage uses, so opening Brain shows fresh data instantly.
      await qc.prefetchQuery({
        queryKey: ['brain-graph', workspaceId, template, 'systems', null],
        queryFn:  () => api.get(`/api/v1/brain/graph?workspace_id=${workspaceId}&template=${template}&lod=systems`),
        staleTime: STALE_FLOOR_MS,
      }).catch(() => {})
    }

    // Kick once on mount, then on a soft interval.
    void tick()
    const id = setInterval(tick, KEEP_WARM_INTERVAL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [qc, workspaceId])
}
