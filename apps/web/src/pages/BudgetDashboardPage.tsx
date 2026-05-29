import { useState, useEffect, useCallback } from 'react'
import {
  DollarSign, AlertTriangle, CheckCircle, TrendingUp,
  RefreshCw, Edit2, Save, X, Shield,
} from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

const API_PFX = '/api/v1/governor'

interface BudgetRules {
  dailyLimitUsd: number; weeklyLimitUsd: number; monthlyLimitUsd: number
  maxPerJobUsd: number; maxBrowserSessionSecs: number; maxAiRequestSecs: number
  maxRetries: number; maxConcurrentRemote: number; alertThreshold: number; hardStop: boolean
}
interface SpendState { dailySpendUsd: number; weeklySpendUsd: number; monthlySpendUsd: number }
interface BudgetData {
  rules: BudgetRules; spend: SpendState
  throttle: 'normal' | 'throttled' | 'blocked'; activeSwitches: string[]; hardStop: boolean
}

function pct(spend: number, limit: number): number {
  return limit > 0 ? Math.min((spend / limit) * 100, 100) : 0
}

function fmtUsd(v: number): string {
  return v < 0.01 ? `$${v.toFixed(5)}` : `$${v.toFixed(2)}`
}

function GaugeBar({ label, current, limit }: { label: string; current: number; limit: number }) {
  const p = pct(current, limit)
  const color = p >= 100 ? 'bg-red-500' : p >= 80 ? 'bg-yellow-500' : 'bg-blue-500'
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-secondary">
        <span>{label}</span>
        <span>{limit > 0 ? `${fmtUsd(current)} / ${fmtUsd(limit)}` : 'No limit'}</span>
      </div>
      {limit > 0 ? (
        <div className="h-2 bg-elevated rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${p}%` }} />
        </div>
      ) : (
        <div className="h-2 bg-elevated rounded-full">
          <div className="h-full w-1 bg-[var(--text-muted)] rounded-full" />
        </div>
      )}
    </div>
  )
}

function ThrottleBadge({ level }: { level: string }) {
  const styles: Record<string, string> = {
    normal:    'bg-green-500/10 text-green-400 border-green-500/20',
    throttled: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
    blocked:   'bg-red-500/10 text-red-400 border-red-500/20',
  }
  return (
    <span className={`px-2 py-0.5 rounded text-xs border font-medium ${styles[level] ?? styles.normal}`}>
      {level.toUpperCase()}
    </span>
  )
}

function RuleRow({
  label, value, field, unit, onSave,
}: {
  label: string; value: number | boolean; field: string; unit?: string
  onSave: (field: string, value: number | boolean) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(value))

  const commit = () => {
    const parsed = typeof value === 'boolean' ? draft === 'true' : parseFloat(draft)
    if (!isNaN(parsed as number)) onSave(field, parsed)
    setEditing(false)
  }

  return (
    <div className="flex items-center justify-between py-2 border-b border-border last:border-0">
      <span className="text-sm text-secondary">{label}</span>
      <div className="flex items-center gap-2">
        {editing ? (
          <>
            {typeof value === 'boolean' ? (
              <select
                className="text-xs bg-elevated border border-border rounded px-2 py-0.5 text-primary"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              >
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            ) : (
              <input
                className="w-24 text-xs bg-elevated border border-border rounded px-2 py-0.5 text-primary"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
                autoFocus
              />
            )}
            <button onClick={commit} aria-label="Save budget" title="Save" className="text-green-400 hover:text-green-300"><Save className="w-3 h-3" /></button>
            <button onClick={() => setEditing(false)} aria-label="Cancel edit" title="Cancel" className="text-muted hover:text-secondary"><X className="w-3 h-3" /></button>
          </>
        ) : (
          <>
            <span className="text-sm font-mono text-primary">
              {typeof value === 'boolean' ? (value ? 'Yes' : 'No') : `${value === 0 ? '∞' : value}${unit ?? ''}`}
            </span>
            <button onClick={() => { setDraft(String(value)); setEditing(true) }} className="text-muted hover:text-blue-400">
              <Edit2 className="w-3 h-3" />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export default function BudgetDashboardPage() {
  const { workspaceId } = useWorkspace()
  const [data, setData] = useState<BudgetData | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const j = await api.get<{ success: boolean; data: BudgetData }>(`${API_PFX}/budgets/${workspaceId}`)
      if (j.success) setData(j.data)
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => { void load() }, [load])

  const saveRule = async (field: string, value: number | boolean) => {
    const body: Record<string, unknown> = {}
    const keyMap: Record<string, string> = {
      dailyLimitUsd: 'daily_limit_usd', weeklyLimitUsd: 'weekly_limit_usd',
      monthlyLimitUsd: 'monthly_limit_usd', maxPerJobUsd: 'max_per_job_usd',
      maxBrowserSessionSecs: 'max_browser_session_secs', maxAiRequestSecs: 'max_ai_request_secs',
      maxRetries: 'max_retries', maxConcurrentRemote: 'max_concurrent_remote',
      alertThreshold: 'alert_threshold', hardStop: 'hard_stop',
    }
    body[keyMap[field] ?? field] = value
    await api.put(`${API_PFX}/budgets/${workspaceId}`, body)
    void load()
  }

  const rules = data?.rules
  const spend = data?.spend

  return (
    <div className="h-full overflow-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Shield className="w-5 h-5 text-blue-400" />
          <div>
            <h1 className="text-lg font-semibold text-primary">Budget Dashboard</h1>
            <p className="text-xs text-muted">Cost limits, spend tracking, safety rules</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {data && <ThrottleBadge level={data.throttle} />}
          <button onClick={load} className="p-1.5 rounded hover:bg-elevated text-muted">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Spend gauges */}
      <div className="bg-[var(--bg-surface)] border border-border rounded-lg p-5 space-y-4">
        <div className="flex items-center gap-2 mb-2">
          <TrendingUp className="w-4 h-4 text-blue-400" />
          <span className="text-sm font-medium text-primary">Current Spend</span>
        </div>
        {loading ? (
          <div className="space-y-3">
            {[0,1,2].map((i) => <div key={i} className="h-5 bg-elevated rounded animate-pulse" />)}
          </div>
        ) : (
          <div className="space-y-4">
            <GaugeBar label="Daily"   current={spend?.dailySpendUsd ?? 0}   limit={rules?.dailyLimitUsd ?? 0} />
            <GaugeBar label="Weekly"  current={spend?.weeklySpendUsd ?? 0}  limit={rules?.weeklyLimitUsd ?? 0} />
            <GaugeBar label="Monthly" current={spend?.monthlySpendUsd ?? 0} limit={rules?.monthlyLimitUsd ?? 0} />
          </div>
        )}
      </div>

      {/* Active switches warning */}
      {(data?.activeSwitches.length ?? 0) > 0 && (
        <div className="flex items-start gap-3 bg-red-500/10 border border-red-500/20 rounded-lg p-4">
          <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-red-300">Kill switches active</p>
            <p className="text-xs text-red-400 mt-1">{data!.activeSwitches.join(', ')}</p>
          </div>
        </div>
      )}

      {/* Budget rules */}
      <div className="bg-[var(--bg-surface)] border border-border rounded-lg p-5">
        <div className="flex items-center gap-2 mb-4">
          <DollarSign className="w-4 h-4 text-green-400" />
          <span className="text-sm font-medium text-primary">Budget Rules</span>
          <span className="text-xs text-muted ml-1">click pencil to edit</span>
        </div>
        {loading || !rules ? (
          <div className="space-y-2">
            {[0,1,2,3,4,5,6,7,8,9].map((i) => <div key={i} className="h-8 bg-elevated rounded animate-pulse" />)}
          </div>
        ) : (
          <>
            <RuleRow label="Daily limit (USD)"            value={rules.dailyLimitUsd}         field="dailyLimitUsd"         unit=" USD"  onSave={saveRule} />
            <RuleRow label="Weekly limit (USD)"           value={rules.weeklyLimitUsd}        field="weeklyLimitUsd"        unit=" USD"  onSave={saveRule} />
            <RuleRow label="Monthly limit (USD)"          value={rules.monthlyLimitUsd}       field="monthlyLimitUsd"       unit=" USD"  onSave={saveRule} />
            <RuleRow label="Max cost per job (USD)"       value={rules.maxPerJobUsd}          field="maxPerJobUsd"          unit=" USD"  onSave={saveRule} />
            <RuleRow label="Max browser session (secs)"   value={rules.maxBrowserSessionSecs} field="maxBrowserSessionSecs" unit="s"    onSave={saveRule} />
            <RuleRow label="Max AI request (secs)"        value={rules.maxAiRequestSecs}      field="maxAiRequestSecs"      unit="s"    onSave={saveRule} />
            <RuleRow label="Max retries"                  value={rules.maxRetries}            field="maxRetries"                        onSave={saveRule} />
            <RuleRow label="Max concurrent remote jobs"   value={rules.maxConcurrentRemote}   field="maxConcurrentRemote"               onSave={saveRule} />
            <RuleRow label="Alert threshold (fraction)"   value={rules.alertThreshold}        field="alertThreshold"                    onSave={saveRule} />
            <RuleRow label="Hard stop at limit"           value={rules.hardStop}              field="hardStop"                          onSave={saveRule} />
          </>
        )}
      </div>

      {/* Quick links */}
      <div className="grid grid-cols-2 gap-3">
        {[
          { label: 'Kill Switches',   href: '/governor/kill-switches', icon: '🔴' },
          { label: 'Runaway Jobs',    href: '/governor/runaway',       icon: '🔥' },
          { label: 'Budget Alerts',   href: '/governor/alerts',        icon: '🔔' },
          { label: 'Provider Spend',  href: '/governor/providers',     icon: '📊' },
        ].map((l) => (
          <a key={l.href} href={l.href}
            className="flex items-center gap-3 bg-[var(--bg-surface)] border border-border rounded-lg px-4 py-3 hover:border-blue-500/40 hover:bg-blue-500/5 transition-colors">
            <span className="text-lg">{l.icon}</span>
            <span className="text-sm font-medium text-secondary">{l.label}</span>
          </a>
        ))}
      </div>

      {data?.activeSwitches.length === 0 && (
        <div className="flex items-center gap-2 text-xs text-muted">
          <CheckCircle className="w-3 h-3 text-green-400" />
          <span>All kill switches inactive — compute running normally</span>
        </div>
      )}
    </div>
  )
}
