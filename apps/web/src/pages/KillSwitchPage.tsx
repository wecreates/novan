import { useState, useEffect, useCallback } from 'react'
import { Power, PowerOff, RefreshCw, AlertTriangle, CheckCircle, Loader2 } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

const API_PFX = '/api/v1/governor'

type SwitchType = 'remote_worker' | 'provider' | 'browser_job' | 'ai_request'

interface KillSwitch {
  id: string | null; workspaceId: string; switchType: SwitchType
  enabled: boolean; reason: string | null; enabledAt: number | null; disabledAt: number | null
}

const LABELS: Record<SwitchType, { label: string; desc: string; icon: string }> = {
  remote_worker: { label: 'Remote Workers',  desc: 'Stop all remote GPU / compute jobs',        icon: '🖥️' },
  provider:      { label: 'AI Providers',    desc: 'Block all cloud AI provider requests',      icon: '🤖' },
  browser_job:   { label: 'Browser Jobs',    desc: 'Halt all automated browser sessions',       icon: '🌐' },
  ai_request:    { label: 'AI Requests',     desc: 'Block all AI chat / embed requests',        icon: '⚡' },
}

function formatTs(ts: number | null): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString()
}

export default function KillSwitchPage() {
  const { workspaceId } = useWorkspace()
  const [switches, setSwitches] = useState<KillSwitch[]>([])
  const [loading, setLoading]   = useState(true)
  const [busy, setBusy]         = useState<Record<string, boolean>>({})
  const [reason, setReason]     = useState('')
  const [confirmType, setConfirmType] = useState<SwitchType | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const j = await api.get<{ success: boolean; data: KillSwitch[] }>(`${API_PFX}/kill-switches/${workspaceId}`)
      if (j.success) setSwitches(j.data)
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => { void load() }, [load])

  const toggle = async (sw: KillSwitch, enable: boolean) => {
    if (enable && !confirmType) { setConfirmType(sw.switchType); return }
    setBusy((b) => ({ ...b, [sw.switchType]: true }))
    try {
      const action = enable ? 'enable' : 'disable'
      await api.post(
        `${API_PFX}/kill-switches/${workspaceId}/${sw.switchType}/${action}`,
        enable ? { reason: reason || 'Manual activation' } : {},
      )
      setConfirmType(null)
      setReason('')
      void load()
    } finally {
      setBusy((b) => ({ ...b, [sw.switchType]: false }))
    }
  }

  const activeCount = switches.filter((s) => s.enabled).length

  return (
    <div className="h-full overflow-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Power className="w-5 h-5 text-red-400" />
          <div>
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">Kill Switch Controls</h1>
            <p className="text-xs text-[var(--text-muted)]">Emergency stops for remote compute, providers, and browser jobs</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {activeCount > 0 && (
            <span className="px-2 py-0.5 rounded text-xs bg-red-500/10 text-red-400 border border-red-500/20">
              {activeCount} ACTIVE
            </span>
          )}
          <button onClick={load} className="p-1.5 rounded hover:bg-[var(--bg-elevated)] text-[var(--text-muted)]">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Warning banner if any active */}
      {activeCount > 0 && (
        <div className="flex items-start gap-3 bg-red-500/10 border border-red-500/30 rounded-lg p-4">
          <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
          <p className="text-sm text-red-300 font-medium">
            {activeCount} kill switch{activeCount > 1 ? 'es' : ''} currently active. Affected systems are blocked.
          </p>
        </div>
      )}

      {/* Confirm modal */}
      {confirmType && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-5 space-y-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400" />
            <span className="text-sm font-medium text-red-300">
              Confirm: Enable kill switch for {LABELS[confirmType]?.label}?
            </span>
          </div>
          <input
            className="w-full text-sm bg-[var(--bg-elevated)] border border-[var(--border)] rounded px-3 py-1.5 text-[var(--text-primary)] placeholder-[var(--text-muted)]"
            placeholder="Reason (required)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
          />
          <div className="flex gap-2">
            <button
              onClick={() => {
                const sw = switches.find((s) => s.switchType === confirmType)
                if (sw && reason.trim()) void toggle(sw, true)
              }}
              disabled={!reason.trim()}
              className="px-3 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-500 disabled:opacity-50"
            >
              Confirm Enable
            </button>
            <button
              onClick={() => { setConfirmType(null); setReason('') }}
              className="px-3 py-1.5 text-xs rounded bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:bg-[var(--border)]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Switch cards */}
      <div className="grid grid-cols-1 gap-4">
        {loading ? (
          [0,1,2,3].map((i) => (
            <div key={i} className="h-24 bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg animate-pulse" />
          ))
        ) : (
          switches.map((sw) => {
            const meta = LABELS[sw.switchType]
            const isBusy = !!busy[sw.switchType]
            return (
              <div
                key={sw.switchType}
                className={`bg-[var(--bg-surface)] border rounded-lg p-5 flex items-center justify-between transition-colors ${
                  sw.enabled ? 'border-red-500/40 bg-red-500/5' : 'border-[var(--border)]'
                }`}
              >
                <div className="flex items-center gap-4">
                  <span className="text-2xl">{meta?.icon}</span>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-[var(--text-primary)]">{meta?.label}</span>
                      {sw.enabled ? (
                        <span className="px-1.5 py-0.5 rounded text-xs bg-red-500/15 text-red-400 border border-red-500/20">ACTIVE</span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded text-xs bg-green-500/10 text-green-400 border border-green-500/20">STANDBY</span>
                      )}
                    </div>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">{meta?.desc}</p>
                    {sw.enabled && sw.reason && (
                      <p className="text-xs text-red-400 mt-1">Reason: {sw.reason}</p>
                    )}
                    <p className="text-xs text-[var(--text-muted)] mt-1">
                      {sw.enabled ? `Active since ${formatTs(sw.enabledAt)}` : sw.disabledAt ? `Last disabled ${formatTs(sw.disabledAt)}` : 'Never activated'}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => void toggle(sw, !sw.enabled)}
                  disabled={isBusy}
                  className={`flex items-center gap-2 px-4 py-2 rounded text-sm font-medium transition-colors ${
                    sw.enabled
                      ? 'bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30'
                      : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)] border border-[var(--border)] hover:border-red-500/40 hover:text-red-400'
                  }`}
                >
                  {isBusy ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : sw.enabled ? (
                    <CheckCircle className="w-3.5 h-3.5" />
                  ) : (
                    <PowerOff className="w-3.5 h-3.5" />
                  )}
                  {sw.enabled ? 'Disable' : 'Enable'}
                </button>
              </div>
            )
          })
        )}
      </div>

      <p className="text-xs text-[var(--text-muted)]">
        Kill switches take effect immediately. Disable when the threat is resolved.
      </p>
    </div>
  )
}
