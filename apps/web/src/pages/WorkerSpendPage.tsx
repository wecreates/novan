import { useState, useEffect, useCallback } from 'react'
import { Server, RefreshCw, TrendingUp, XCircle, CheckCircle } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

const API_PFX = '/api/v1/governor'

interface EndpointSpend {
  endpointId: string; costUsd: number; requests: number
  promptTokens: number; outputTokens: number; failedRequests: number; lastUsed: number
}

function fmtTs(ts: number): string {
  return ts > 0 ? new Date(ts).toLocaleDateString() : '—'
}

export default function WorkerSpendPage() {
  const { workspaceId } = useWorkspace()
  const [data, setData]       = useState<EndpointSpend[]>([])
  const [loading, setLoading] = useState(true)
  const [days, setDays]       = useState(30)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const j = await api.get<{ success: boolean; data: EndpointSpend[] }>(`${API_PFX}/usage/endpoints/${workspaceId}?days=${days}`)
      if (j.success) setData(j.data)
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }, [workspaceId, days])

  useEffect(() => { void load() }, [load])

  const total = data.reduce((s, r) => s + r.costUsd, 0)
  const totalFailed = data.reduce((s, r) => s + r.failedRequests, 0)
  const maxCost = Math.max(...data.map((d) => d.costUsd), 0.0001)

  return (
    <div className="h-full overflow-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Server className="w-5 h-5 text-green-400" />
          <div>
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">Worker / Endpoint Spend</h1>
            <p className="text-xs text-[var(--text-muted)]">Remote compute cost breakdown by endpoint</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={days}
            onChange={(e) => setDays(parseInt(e.target.value, 10))}
            className="text-xs bg-[var(--bg-elevated)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text-primary)]"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <button onClick={load} className="p-1.5 rounded hover:bg-[var(--bg-elevated)] text-[var(--text-muted)]">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: 'Total Spend',    value: `$${total.toFixed(4)}`,  color: 'text-blue-400',   icon: TrendingUp },
          { label: 'Endpoints',      value: String(data.length),     color: 'text-green-400',  icon: Server },
          { label: 'Total Requests', value: String(data.reduce((s, r) => s + r.requests, 0)), color: 'text-purple-400', icon: TrendingUp },
          { label: 'Failed',         value: String(totalFailed),     color: totalFailed > 0 ? 'text-red-400' : 'text-green-400', icon: totalFailed > 0 ? XCircle : CheckCircle },
        ].map((s) => (
          <div key={s.label} className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg p-3">
            <div className="flex items-center gap-1.5 mb-1">
              <s.icon className={`w-3.5 h-3.5 ${s.color}`} />
              <span className="text-xs text-[var(--text-muted)]">{s.label}</span>
            </div>
            <p className="text-lg font-semibold font-mono text-[var(--text-primary)]">{s.value}</p>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] bg-[var(--bg-elevated)]">
              <th className="text-left px-4 py-2.5 text-xs font-medium text-[var(--text-muted)]">Endpoint</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-[var(--text-muted)]">Spend</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-[var(--text-muted)]">Share</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-[var(--text-muted)]">Requests</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-[var(--text-muted)]">Failed</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-[var(--text-muted)]">Tokens</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-[var(--text-muted)]">Last Used</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              [0,1,2,3].map((i) => (
                <tr key={i} className="border-b border-[var(--border)]">
                  {[0,1,2,3,4,5,6].map((j) => (
                    <td key={j} className="px-4 py-3">
                      <div className="h-4 bg-[var(--bg-elevated)] rounded animate-pulse" />
                    </td>
                  ))}
                </tr>
              ))
            ) : data.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">
                  No endpoint usage data for this period
                </td>
              </tr>
            ) : (
              data.map((row) => {
                const failRate = row.requests > 0 ? row.failedRequests / row.requests : 0
                return (
                  <tr key={row.endpointId} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-elevated)]/30">
                    <td className="px-4 py-3 font-mono text-xs text-[var(--text-primary)]">
                      {row.endpointId.slice(0, 16)}…
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-[var(--text-primary)]">
                      ${row.costUsd.toFixed(6)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 bg-[var(--bg-elevated)] rounded-full overflow-hidden">
                          <div
                            className="h-full bg-green-500 rounded-full"
                            style={{ width: `${(row.costUsd / maxCost) * 100}%` }}
                          />
                        </div>
                        <span className="text-xs text-[var(--text-muted)] w-10 text-right">
                          {total > 0 ? `${Math.round((row.costUsd / total) * 100)}%` : '—'}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-[var(--text-muted)]">
                      {row.requests.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <span className={failRate > 0.1 ? 'text-red-400' : 'text-[var(--text-muted)]'}>
                        {row.failedRequests}
                        {failRate > 0 && ` (${Math.round(failRate * 100)}%)`}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-[var(--text-muted)]">
                      {(row.promptTokens + row.outputTokens).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-xs text-[var(--text-muted)]">
                      {fmtTs(row.lastUsed)}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
