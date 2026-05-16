import { useState, useEffect, useCallback } from 'react'
import { BarChart2, RefreshCw, TrendingUp } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

const API_PFX = '/api/v1/governor'

interface ProviderSpend {
  providerId: string; costUsd: number; requests: number; lastUsed: number
}

function fmtTs(ts: number): string {
  return ts > 0 ? new Date(ts).toLocaleDateString() : '—'
}

export default function ProviderSpendPage() {
  const { workspaceId } = useWorkspace()
  const [data, setData]     = useState<ProviderSpend[]>([])
  const [loading, setLoading] = useState(true)
  const [days, setDays]     = useState(30)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const j = await api.get<{ success: boolean; data: ProviderSpend[] }>(`${API_PFX}/usage/providers/${workspaceId}?days=${days}`)
      if (j.success) setData(j.data)
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }, [workspaceId, days])

  useEffect(() => { void load() }, [load])

  const total = data.reduce((s, r) => s + r.costUsd, 0)
  const maxCost = Math.max(...data.map((d) => d.costUsd), 0.0001)

  return (
    <div className="h-full overflow-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <BarChart2 className="w-5 h-5 text-purple-400" />
          <div>
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">Provider Spend</h1>
            <p className="text-xs text-[var(--text-muted)]">Cost breakdown by AI provider</p>
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

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Total Spend',   value: `$${total.toFixed(4)}`,   icon: TrendingUp, color: 'text-blue-400' },
          { label: 'Providers',     value: String(data.length),       icon: BarChart2,  color: 'text-purple-400' },
          { label: 'Total Requests', value: String(data.reduce((s, r) => s + r.requests, 0)), icon: BarChart2, color: 'text-green-400' },
        ].map((s) => (
          <div key={s.label} className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg p-4">
            <div className="flex items-center gap-2 mb-1">
              <s.icon className={`w-4 h-4 ${s.color}`} />
              <span className="text-xs text-[var(--text-muted)]">{s.label}</span>
            </div>
            <p className="text-xl font-semibold text-[var(--text-primary)] font-mono">{s.value}</p>
          </div>
        ))}
      </div>

      {/* Provider table */}
      <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] bg-[var(--bg-elevated)]">
              <th className="text-left px-4 py-2.5 text-xs font-medium text-[var(--text-muted)]">Provider</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-[var(--text-muted)]">Spend</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-[var(--text-muted)]">Share</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-[var(--text-muted)]">Requests</th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-[var(--text-muted)]">Last Used</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              [0,1,2,3].map((i) => (
                <tr key={i} className="border-b border-[var(--border)]">
                  {[0,1,2,3,4].map((j) => (
                    <td key={j} className="px-4 py-3">
                      <div className="h-4 bg-[var(--bg-elevated)] rounded animate-pulse" />
                    </td>
                  ))}
                </tr>
              ))
            ) : data.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">
                  No provider spend data for this period
                </td>
              </tr>
            ) : (
              data.map((row) => (
                <tr key={row.providerId} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-elevated)]/30">
                  <td className="px-4 py-3 font-mono text-xs text-[var(--text-primary)]">{row.providerId}</td>
                  <td className="px-4 py-3 font-mono text-xs text-[var(--text-primary)]">${row.costUsd.toFixed(6)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-[var(--bg-elevated)] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-purple-500 rounded-full"
                          style={{ width: `${(row.costUsd / maxCost) * 100}%` }}
                        />
                      </div>
                      <span className="text-xs text-[var(--text-muted)] w-10 text-right">
                        {total > 0 ? `${Math.round((row.costUsd / total) * 100)}%` : '—'}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-[var(--text-muted)]">{row.requests.toLocaleString()}</td>
                  <td className="px-4 py-3 text-xs text-[var(--text-muted)]">{fmtTs(row.lastUsed)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
