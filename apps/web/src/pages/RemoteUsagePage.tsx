import { useState, useEffect, useCallback } from 'react'
import { Activity, RefreshCw, DollarSign, Zap, Clock, TrendingUp } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

const API_PFX = '/api/v1/governor'

interface EndpointSpend {
  endpointId: string; costUsd: number; requests: number
  promptTokens: number; outputTokens: number; failedRequests: number; lastUsed: number
}

interface ProviderSpend {
  providerId: string; costUsd: number; requests: number; lastUsed: number
}

interface BudgetData {
  spend: { dailySpendUsd: number; weeklySpendUsd: number; monthlySpendUsd: number }
  rules: { dailyLimitUsd: number; monthlyLimitUsd: number }
  throttle: string
}

function pctBar(v: number, limit: number) {
  if (limit <= 0) return null
  const p = Math.min((v / limit) * 100, 100)
  const color = p >= 100 ? 'bg-red-500' : p >= 80 ? 'bg-yellow-500' : 'bg-blue-500'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-[var(--bg-elevated)] rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${p}%` }} />
      </div>
      <span className="text-xs text-[var(--text-muted)] w-10 text-right">{Math.round(p)}%</span>
    </div>
  )
}

export default function RemoteUsagePage() {
  const { workspaceId } = useWorkspace()
  const [endpoints, setEndpoints] = useState<EndpointSpend[]>([])
  const [providers, setProviders] = useState<ProviderSpend[]>([])
  const [budget, setBudget]       = useState<BudgetData | null>(null)
  const [loading, setLoading]     = useState(true)
  const [days, setDays]           = useState(7)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [ej, pj, bj] = await Promise.all([
        api.get<{ success: boolean; data: EndpointSpend[] }>(`${API_PFX}/usage/endpoints/${workspaceId}?days=${days}`),
        api.get<{ success: boolean; data: ProviderSpend[] }>(`${API_PFX}/usage/providers/${workspaceId}?days=${days}`),
        api.get<{ success: boolean; data: BudgetData }>(`${API_PFX}/budgets/${workspaceId}`),
      ])
      if (ej.success) setEndpoints(ej.data)
      if (pj.success) setProviders(pj.data)
      if (bj.success) setBudget(bj.data)
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }, [workspaceId, days])

  useEffect(() => { void load() }, [load])

  const totalEndpointCost  = endpoints.reduce((s, r) => s + r.costUsd, 0)
  const totalProviderCost  = providers.reduce((s, r) => s + r.costUsd, 0)
  const totalTokens        = endpoints.reduce((s, r) => s + r.promptTokens + r.outputTokens, 0)
  const totalRequests      = endpoints.reduce((s, r) => s + r.requests, 0) +
                             providers.reduce((s, r) => s + r.requests, 0)

  return (
    <div className="h-full overflow-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Activity className="w-5 h-5 text-blue-400" />
          <div>
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">Remote Compute Usage</h1>
            <p className="text-xs text-[var(--text-muted)]">Live spend across all remote endpoints and providers</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={days}
            onChange={(e) => setDays(parseInt(e.target.value, 10))}
            className="text-xs bg-[var(--bg-elevated)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text-primary)]"
          >
            <option value={1}>Today</option>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
          </select>
          <button onClick={load} className="p-1.5 rounded hover:bg-[var(--bg-elevated)] text-[var(--text-muted)]">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: 'Total Cost',     value: `$${(totalEndpointCost + totalProviderCost).toFixed(4)}`, icon: DollarSign, color: 'text-blue-400' },
          { label: 'Requests',       value: totalRequests.toLocaleString(),   icon: Zap,        color: 'text-yellow-400' },
          { label: 'Tokens',         value: totalTokens.toLocaleString(),     icon: Activity,   color: 'text-purple-400' },
          { label: 'Daily Budget',   value: budget ? `${((budget.spend.dailySpendUsd / (budget.rules.dailyLimitUsd || 1)) * 100).toFixed(1)}%` : '—',
            icon: TrendingUp, color: budget?.throttle === 'throttled' ? 'text-yellow-400' : budget?.throttle === 'blocked' ? 'text-red-400' : 'text-green-400' },
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

      {/* Budget bars */}
      {budget && (
        <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-[var(--text-muted)]" />
            <span className="text-sm font-medium text-[var(--text-primary)]">Budget Usage</span>
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <span className="text-xs text-[var(--text-muted)] w-14">Daily</span>
              <div className="flex-1">
                {pctBar(budget.spend.dailySpendUsd, budget.rules.dailyLimitUsd)}
              </div>
              <span className="text-xs font-mono text-[var(--text-muted)] w-28 text-right">
                ${budget.spend.dailySpendUsd.toFixed(4)} / ${budget.rules.dailyLimitUsd.toFixed(2)}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-[var(--text-muted)] w-14">Monthly</span>
              <div className="flex-1">
                {pctBar(budget.spend.monthlySpendUsd, budget.rules.monthlyLimitUsd)}
              </div>
              <span className="text-xs font-mono text-[var(--text-muted)] w-28 text-right">
                ${budget.spend.monthlySpendUsd.toFixed(4)} / ${budget.rules.monthlyLimitUsd.toFixed(2)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Side-by-side: endpoints + providers */}
      <div className="grid grid-cols-2 gap-4">
        {/* Endpoints */}
        <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--border)] flex items-center gap-2">
            <Activity className="w-3.5 h-3.5 text-green-400" />
            <span className="text-sm font-medium text-[var(--text-primary)]">Remote Endpoints</span>
          </div>
          <div className="divide-y divide-[var(--border)]">
            {loading ? (
              [0,1,2].map((i) => <div key={i} className="px-4 py-3 h-12 animate-pulse bg-[var(--bg-elevated)]/30" />)
            ) : endpoints.length === 0 ? (
              <p className="px-4 py-6 text-xs text-center text-[var(--text-muted)]">No endpoint data</p>
            ) : (
              endpoints.slice(0, 8).map((e) => (
                <div key={e.endpointId} className="px-4 py-2.5 flex items-center justify-between hover:bg-[var(--bg-elevated)]/30">
                  <span className="text-xs font-mono text-[var(--text-primary)] truncate w-32">{e.endpointId.slice(0, 14)}…</span>
                  <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
                    <span>{e.requests} reqs</span>
                    <span className="font-mono text-[var(--text-primary)]">${e.costUsd.toFixed(5)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Providers */}
        <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-[var(--border)] flex items-center gap-2">
            <Zap className="w-3.5 h-3.5 text-purple-400" />
            <span className="text-sm font-medium text-[var(--text-primary)]">AI Providers</span>
          </div>
          <div className="divide-y divide-[var(--border)]">
            {loading ? (
              [0,1,2].map((i) => <div key={i} className="px-4 py-3 h-12 animate-pulse bg-[var(--bg-elevated)]/30" />)
            ) : providers.length === 0 ? (
              <p className="px-4 py-6 text-xs text-center text-[var(--text-muted)]">No provider data</p>
            ) : (
              providers.slice(0, 8).map((p) => (
                <div key={p.providerId} className="px-4 py-2.5 flex items-center justify-between hover:bg-[var(--bg-elevated)]/30">
                  <span className="text-xs font-mono text-[var(--text-primary)]">{p.providerId}</span>
                  <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
                    <span>{p.requests} reqs</span>
                    <span className="font-mono text-[var(--text-primary)]">${p.costUsd.toFixed(5)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
