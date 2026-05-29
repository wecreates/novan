/**
 * useBrainUptime — polls the API's runtime status for the live uptime
 * indicator. Returns null when the API is unreachable so the sidebar
 * can render a "down" state honestly.
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '../api.js'

interface RuntimeStatus {
  bootedAt:        number
  uptimeMs:        number
  uptimeHuman:     string
  lastHeartbeatAt: number
  lastHeartbeatAgoMs: number
  cyclesRun:       number
  cronStartCount:  number
  nodeVersion:     string
  pid:             number
  memoryMb:        number
}

export function useBrainUptime() {
  const q = useQuery({
    queryKey: ['runtime-status'],
    queryFn:  () => api.get<{ data: RuntimeStatus } | { success: true; data: RuntimeStatus } | RuntimeStatus>(`/api/v1/runtime/status`)
                       .then((r: unknown) => {
                         // Normalize the response shape — the route may
                         // return either { success: true, data: ... }
                         // or the bare object depending on version.
                         const x = r as { data?: RuntimeStatus } & RuntimeStatus
                         return x.data ?? x
                       }),
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    retry: 1,
  })
  return {
    alive:      !q.isError && !!q.data,
    uptimeHuman: q.data?.uptimeHuman ?? null,
    memoryMb:   q.data?.memoryMb ?? null,
    cyclesRun:  q.data?.cyclesRun ?? 0,
    pid:        q.data?.pid ?? null,
  }
}
