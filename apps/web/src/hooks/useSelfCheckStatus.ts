/**
 * useSelfCheckStatus — polls the latest platform-smoke run for a
 * compact sidebar dot. Returns:
 *   'healthy'   no fails, no slow probes
 *   'slow'      some probes slow but no failures
 *   'degraded'  failures or regressions present
 *   'unknown'   no smoke runs yet
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '../api.js'

export type SelfCheckTone = 'healthy' | 'slow' | 'degraded' | 'unknown'

interface SmokeSummary {
  okCount:     number
  failCount:   number
  slowCount:   number
  regressions: Array<unknown>
  ranAt:       number
}

export function useSelfCheckStatus(workspaceId: string): { tone: SelfCheckTone; ranAt: number | null; failCount: number } {
  const q = useQuery({
    queryKey: ['self-check-status', workspaceId],
    queryFn:  () => api.get<{ data: SmokeSummary | null }>(`/api/v1/self/platform-smoke?workspace_id=${workspaceId}`)
                       .then(r => r.data),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  })

  const r = q.data
  if (!r) return { tone: 'unknown', ranAt: null, failCount: 0 }
  if (r.failCount > 0 || (r.regressions?.length ?? 0) > 0) return { tone: 'degraded', ranAt: r.ranAt, failCount: r.failCount }
  if (r.slowCount > 0) return { tone: 'slow', ranAt: r.ranAt, failCount: 0 }
  return { tone: 'healthy', ranAt: r.ranAt, failCount: 0 }
}
