import { useState, useEffect, useCallback } from 'react'
import { Bell, BellOff, RefreshCw, CheckCircle, AlertTriangle } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

const API_PFX = '/api/v1/governor'

interface BudgetAlert {
  id: string; workspaceId: string; alertType: string
  thresholdPct: number; currentUsd: number; limitUsd: number
  dismissed: boolean; dismissedAt: number | null; firedAt: number
}

const TYPE_COLORS: Record<string, string> = {
  daily:   'bg-blue-500/10 text-blue-400 border-blue-500/20',
  weekly:  'bg-purple-500/10 text-purple-400 border-purple-500/20',
  monthly: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
  per_job: 'bg-red-500/10 text-red-400 border-red-500/20',
}

export default function BudgetAlertsPage() {
  const { workspaceId } = useWorkspace()
  const [alerts, setAlerts]           = useState<BudgetAlert[]>([])
  const [loading, setLoading]         = useState(true)
  const [showDismissed, setShowDismissed] = useState(false)
  const [dismissing, setDismissing]   = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const qs = showDismissed ? '?dismissed=true' : ''
      const j = await api.get<{ success: boolean; data: BudgetAlert[] }>(`${API_PFX}/alerts/${workspaceId}${qs}`)
      if (j.success) setAlerts(j.data)
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }, [workspaceId, showDismissed])

  useEffect(() => { void load() }, [load])

  const dismiss = async (id: string) => {
    setDismissing((d) => ({ ...d, [id]: true }))
    try {
      await api.post(`${API_PFX}/alerts/${id}/dismiss`, {})
      void load()
    } finally {
      setDismissing((d) => ({ ...d, [id]: false }))
    }
  }

  const active = alerts.filter((a) => !a.dismissed)

  return (
    <div className="h-full overflow-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Bell className="w-5 h-5 text-yellow-400" />
          <div>
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">Budget Alerts</h1>
            <p className="text-xs text-[var(--text-muted)]">Fired when spend crosses threshold bands</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {active.length > 0 && (
            <span className="px-2 py-0.5 rounded text-xs bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
              {active.length} ACTIVE
            </span>
          )}
          <label className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              checked={showDismissed}
              onChange={(e) => setShowDismissed(e.target.checked)}
              className="rounded"
            />
            Show dismissed
          </label>
          <button onClick={load} className="p-1.5 rounded hover:bg-[var(--bg-elevated)] text-[var(--text-muted)]">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {!loading && active.length === 0 && !showDismissed && (
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)] bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg p-6 justify-center">
          <CheckCircle className="w-4 h-4 text-green-400" />
          No active budget alerts
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {[0,1,2].map((i) => <div key={i} className="h-20 bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg animate-pulse" />)}
        </div>
      ) : (
        <div className="space-y-3">
          {alerts.map((alert) => (
            <div
              key={alert.id}
              className={`bg-[var(--bg-surface)] border rounded-lg p-4 flex items-start justify-between gap-4 ${
                alert.dismissed ? 'border-[var(--border)] opacity-50' : 'border-yellow-500/20 bg-yellow-500/5'
              }`}
            >
              <div className="flex items-start gap-3">
                <AlertTriangle className={`w-4 h-4 mt-0.5 shrink-0 ${alert.dismissed ? 'text-[var(--text-muted)]' : 'text-yellow-400'}`} />
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`px-1.5 py-0.5 rounded text-xs border font-medium ${TYPE_COLORS[alert.alertType] ?? 'text-[var(--text-muted)]'}`}>
                      {alert.alertType.toUpperCase()}
                    </span>
                    <span className="text-xs text-[var(--text-muted)]">
                      {Math.round(alert.thresholdPct * 100)}% of ${alert.limitUsd.toFixed(2)} limit
                    </span>
                  </div>
                  <p className="text-sm text-[var(--text-primary)] mt-1">
                    Spend reached <span className="font-mono">${alert.currentUsd.toFixed(4)}</span>
                    {' '}/ <span className="font-mono">${alert.limitUsd.toFixed(2)}</span>
                    {' '}(<span className="text-yellow-400">{Math.round(alert.thresholdPct * 100)}%</span>)
                  </p>
                  <p className="text-xs text-[var(--text-muted)] mt-1">
                    {new Date(alert.firedAt).toLocaleString()}
                    {alert.dismissed && alert.dismissedAt && ` · Dismissed ${new Date(alert.dismissedAt).toLocaleString()}`}
                  </p>
                </div>
              </div>
              {!alert.dismissed && (
                <button
                  onClick={() => void dismiss(alert.id)}
                  disabled={dismissing[alert.id]}
                  className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-[var(--bg-elevated)] text-[var(--text-secondary)] border border-[var(--border)] hover:border-[var(--text-muted)] transition-colors"
                >
                  <BellOff className="w-3.5 h-3.5" />
                  Dismiss
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
