/**
 * Provider Health — real-time health status, latency, and error rates
 * across all in-memory providers and registered remote endpoints.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow }  from 'date-fns'
import { RefreshCw, CheckCircle, AlertCircle, XCircle, Server, Zap } from 'lucide-react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

const API = '/api/v1/ai-router'

interface MemProvider {
  provider: string
  status: 'healthy' | 'degraded' | 'down'
  latencyMs: number | null
  lastCheck: number
  errorRate: number
}

interface RemoteEndpoint {
  id: string; name: string; type: string; baseUrl: string
  healthStatus: string; latencyMs: number | null; lastHealthCheck: number | null
  enabled: boolean; priority: number; modelIds: string[]
}

function useHealthOverview() {
  const { workspaceId } = useWorkspace()
  return useQuery<{ success: true; data: { providers: MemProvider[]; endpoints: RemoteEndpoint[] } }>({
    queryKey: ['rc-health-page', workspaceId],
    queryFn:  () => fetch(`${API}/health?workspace_id=${workspaceId}`).then((r) => r.json()),
    refetchInterval: 15_000,
  })
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'healthy') return <CheckCircle style={{ width: 15, height: 15, color: '#10b981' }} />
  if (status === 'degraded') return <AlertCircle style={{ width: 15, height: 15, color: '#f59e0b' }} />
  return <XCircle style={{ width: 15, height: 15, color: '#f43f5e' }} />
}

function statusColor(s: string) {
  return s === 'healthy' ? '#10b981' : s === 'degraded' ? '#f59e0b' : s === 'down' ? '#f43f5e' : '#64748b'
}

function LatencyBar({ ms }: { ms: number | null }) {
  if (ms === null) return <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>—</span>
  const color = ms < 300 ? '#10b981' : ms < 1000 ? '#f59e0b' : '#f43f5e'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 60, height: 4, background: 'var(--bg-primary)', borderRadius: 2 }}>
        <div style={{ width: `${Math.min(100, (ms / 3000) * 100)}%`, height: '100%', background: color, borderRadius: 2 }} />
      </div>
      <span style={{ fontSize: 11, color }}>{ms.toFixed(0)}ms</span>
    </div>
  )
}

export default function ProviderHealthPage() {
  const { data, isLoading, refetch, dataUpdatedAt } = useHealthOverview()
  const qc = useQueryClient()

  const checkEp = useMutation({
    mutationFn: (id: string) => fetch(`${API}/endpoints/${id}/check`, { method: 'POST' }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rc-health-page'] }),
  })

  const health    = data?.data
  const providers = health?.providers ?? []
  const endpoints = health?.endpoints ?? []

  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--bg-primary)' }}>
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '24px 20px' }}>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Provider Health</h1>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
              {dataUpdatedAt ? `Updated ${formatDistanceToNow(dataUpdatedAt, { addSuffix: true })}` : 'Refreshes every 15s'}
            </p>
          </div>
          <button onClick={() => refetch()} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
            <RefreshCw style={{ width: 14, height: 14 }} />
          </button>
        </div>

        {isLoading && <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</p>}

        {/* In-memory API providers */}
        <h2 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>
          <Zap style={{ width: 12, height: 12, display: 'inline', marginRight: 6 }} />API Providers (in-memory)
        </h2>

        <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 24 }}>
          {providers.length === 0 && !isLoading && (
            <p style={{ padding: 16, fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>No providers detected — set API key env vars to enable.</p>
          )}
          {providers.map((p, i) => (
            <div key={p.provider} style={{ padding: '12px 16px', borderBottom: i < providers.length - 1 ? '1px solid var(--border)' : 'none', display: 'flex', alignItems: 'center', gap: 12 }}>
              <StatusIcon status={p.status} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>{p.provider}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  checked {formatDistanceToNow(p.lastCheck, { addSuffix: true })}
                  {' · '}error rate {(p.errorRate * 100).toFixed(0)}%
                </div>
              </div>
              <span style={{ fontSize: 11, fontWeight: 600, color: statusColor(p.status), textTransform: 'uppercase' }}>{p.status}</span>
              <LatencyBar ms={p.latencyMs} />
            </div>
          ))}
        </div>

        {/* Remote endpoints */}
        <h2 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>
          <Server style={{ width: 12, height: 12, display: 'inline', marginRight: 6 }} />Remote Endpoints
        </h2>

        <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10 }}>
          {endpoints.length === 0 && !isLoading && (
            <p style={{ padding: 16, fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>No remote endpoints registered. Add via Provider Settings.</p>
          )}
          {endpoints.map((ep, i) => (
            <div key={ep.id} style={{ padding: '12px 16px', borderBottom: i < endpoints.length - 1 ? '1px solid var(--border)' : 'none', display: 'flex', alignItems: 'center', gap: 12 }}>
              <StatusIcon status={ep.healthStatus} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>
                  {ep.name}
                  <span style={{ fontSize: 10, fontWeight: 600, marginLeft: 6, padding: '1px 5px', borderRadius: 4, background: '#0ea5e922', color: '#0ea5e9', border: '1px solid #0ea5e944' }}>{ep.type}</span>
                  {!ep.enabled && <span style={{ fontSize: 10, fontWeight: 600, marginLeft: 6, padding: '1px 5px', borderRadius: 4, background: '#f43f5e22', color: '#f43f5e' }}>disabled</span>}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  priority {ep.priority}
                  {ep.lastHealthCheck ? ` · checked ${formatDistanceToNow(ep.lastHealthCheck, { addSuffix: true })}` : ' · never checked'}
                  {ep.modelIds.length > 0 && ` · ${ep.modelIds.length} models`}
                </div>
              </div>
              <span style={{ fontSize: 11, fontWeight: 600, color: statusColor(ep.healthStatus), textTransform: 'uppercase' }}>{ep.healthStatus}</span>
              <LatencyBar ms={ep.latencyMs} />
              <button
                onClick={() => checkEp.mutate(ep.id)}
                disabled={checkEp.isPending}
                title="Re-check health"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}
              >
                <RefreshCw style={{ width: 13, height: 13 }} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
