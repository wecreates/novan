/**
 * Cost Dashboard — AI spending tracker, budget limits, and failure log.
 * Budget limits editable inline. Failure log shows last 100 failures.
 */
import { useState }                              from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow }                   from 'date-fns'
import { RefreshCw, AlertCircle, DollarSign, TrendingDown, Edit2, Check, X } from 'lucide-react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

const API = '/api/v1/ai-router'

// ─── Types ────────────────────────────────────────────────────────────────────

interface BudgetState {
  workspaceId: string
  dailySpendUsd:   number; monthlySpendUsd:  number
  dailyLimitUsd:   number; monthlyLimitUsd:  number
  dailyResetAt:    number; monthlyResetAt:   number
  alertThreshold:  number
  envLimits: { dailyUsd: number; monthlyUsd: number }
}

interface Failure {
  id: string; providerId: string; taskType: string; model: string
  errorType: string; errorMessage: string
  fallbackUsed: boolean; fallbackProviderId: string | null
  costUsd: number; latencyMs: number | null; createdAt: number
}

// ─── API ──────────────────────────────────────────────────────────────────────

function makeApi(ws: string) {
  return {
    budget:   () => fetch(`${API}/budget?workspace_id=${ws}`).then((r) => r.json()) as Promise<{ success: true; data: BudgetState }>,
    failures: () => fetch(`${API}/failures?workspace_id=${ws}&limit=100`).then((r) => r.json()) as Promise<{ success: true; data: Failure[] }>,
    updateBudget: (body: Record<string, unknown>) => fetch(`${API}/budget`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()),
  }
}

// ─── Gauge ────────────────────────────────────────────────────────────────────

function SpendGauge({ label, spend, limit, resetAt }: { label: string; spend: number; limit: number; resetAt: number }) {
  const pct = limit > 0 ? Math.min(100, (spend / limit) * 100) : 0
  const color = pct >= 90 ? '#f43f5e' : pct >= 70 ? '#f59e0b' : '#10b981'
  return (
    <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>resets {formatDistanceToNow(resetAt, { addSuffix: true })}</span>
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, color, marginBottom: 8 }}>
        ${spend.toFixed(4)}
        <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 6 }}>/ ${limit}</span>
      </div>
      <div style={{ height: 6, background: 'var(--bg-primary)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 3, transition: 'width 0.3s' }} />
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{pct.toFixed(1)}% used</div>
    </div>
  )
}

// ─── Editable Budget Limits ───────────────────────────────────────────────────

function BudgetLimitsEditor({ budget, onSaved }: { budget: BudgetState; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)
  const [daily,   setDaily]   = useState(String(budget.dailyLimitUsd))
  const [monthly, setMonthly] = useState(String(budget.monthlyLimitUsd))
  const qc = useQueryClient()
  const { workspaceId } = useWorkspace()
  const api = makeApi(workspaceId)

  const mut = useMutation({
    mutationFn: () => api.updateBudget({ workspace_id: workspaceId, daily_limit_usd: parseFloat(daily), monthly_limit_usd: parseFloat(monthly) }),
    onSuccess: () => { setEditing(false); qc.invalidateQueries({ queryKey: ['rc-budget-dash'] }); onSaved() },
  })

  if (!editing) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10 }}>
        <DollarSign style={{ width: 14, height: 14, color: 'var(--text-muted)' }} />
        <span style={{ fontSize: 13, color: 'var(--text-secondary)', flex: 1 }}>
          Limits: <strong>${budget.dailyLimitUsd}/day</strong> · <strong>${budget.monthlyLimitUsd}/month</strong>
          {' · '}alert at {Math.round(budget.alertThreshold * 100)}%
        </span>
        <button onClick={() => setEditing(true)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
          <Edit2 style={{ width: 13, height: 13 }} />
        </button>
      </div>
    )
  }

  return (
    <div style={{ padding: 16, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
        <div>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Daily limit ($)</label>
          <input type="number" value={daily} onChange={(e) => setDaily(e.target.value)} min="0" step="0.5" style={{ width: 100, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13 }} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Monthly limit ($)</label>
          <input type="number" value={monthly} onChange={(e) => setMonthly(e.target.value)} min="0" step="1" style={{ width: 100, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13 }} />
        </div>
        <button onClick={() => mut.mutate()} disabled={mut.isPending} style={{ padding: '5px 12px', borderRadius: 6, border: 'none', background: '#10b981', color: '#fff', fontSize: 12, cursor: 'pointer' }}>
          <Check style={{ width: 12, height: 12 }} />
        </button>
        <button onClick={() => setEditing(false)} style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}>
          <X style={{ width: 12, height: 12 }} />
        </button>
      </div>
    </div>
  )
}

// ─── Error type color ─────────────────────────────────────────────────────────

const ERROR_COLORS: Record<string, string> = {
  rate_limit:   '#f59e0b',
  auth:         '#f43f5e',
  timeout:      '#0ea5e9',
  server_error: '#8b5cf6',
  budget_blocked: '#f43f5e',
  unknown:      '#64748b',
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CostDashboardPage() {
  const { workspaceId } = useWorkspace()
  const api = makeApi(workspaceId)
  const { data: budgetRes, isLoading: bl, refetch } = useQuery({ queryKey: ['rc-budget-dash', workspaceId],  queryFn: api.budget,   refetchInterval: 30_000 })
  const { data: failRes,   isLoading: fl }           = useQuery({ queryKey: ['rc-failures-dash', workspaceId], queryFn: api.failures, refetchInterval: 30_000 })

  const budget   = budgetRes?.data
  const failures = failRes?.data ?? []

  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--bg-primary)' }}>
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '24px 20px' }}>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Cost Dashboard</h1>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Spend tracked per request. Hard stop when limit reached. No silent overages.</p>
          </div>
          <button onClick={() => refetch()} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
            <RefreshCw style={{ width: 14, height: 14 }} />
          </button>
        </div>

        {/* Spend gauges */}
        {bl ? (
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 20 }}>Loading budget…</p>
        ) : budget ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              <SpendGauge label="Daily Spend"   spend={budget.dailySpendUsd}   limit={budget.dailyLimitUsd}   resetAt={budget.dailyResetAt} />
              <SpendGauge label="Monthly Spend" spend={budget.monthlySpendUsd} limit={budget.monthlyLimitUsd} resetAt={budget.monthlyResetAt} />
            </div>
            <div style={{ marginBottom: 24 }}>
              <BudgetLimitsEditor budget={budget} onSaved={() => refetch()} />
            </div>
          </>
        ) : null}

        {/* Failure log */}
        <h2 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 12 }}>
          <AlertCircle style={{ width: 12, height: 12, display: 'inline', marginRight: 6 }} />Failure Log
        </h2>

        <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: 8 }}>
          {fl && <p style={{ padding: 8, color: 'var(--text-muted)', fontSize: 13 }}>Loading…</p>}
          {!fl && failures.length === 0 && (
            <div style={{ textAlign: 'center', padding: '32px 20px', color: 'var(--text-muted)' }}>
              <TrendingDown style={{ width: 28, height: 28, margin: '0 auto 10px', opacity: 0.4 }} />
              <p style={{ fontSize: 13 }}>No failures recorded</p>
            </div>
          )}
          {failures.map((f) => {
            const ec = ERROR_COLORS[f.errorType] ?? '#64748b'
            return (
              <div key={f.id} style={{ padding: '10px 8px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flexShrink: 0, marginTop: 1 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: `${ec}22`, color: ec, border: `1px solid ${ec}44` }}>
                    {f.errorType.replace(/_/g, ' ')}
                  </span>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 2 }}>
                    <strong>{f.providerId}</strong> · {f.taskType} · {f.model}
                    {f.fallbackUsed && f.fallbackProviderId && (
                      <span style={{ marginLeft: 8, color: '#10b981' }}>→ fallback: {f.fallbackProviderId}</span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.errorMessage}
                  </div>
                </div>
                <div style={{ flexShrink: 0, textAlign: 'right' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{formatDistanceToNow(f.createdAt, { addSuffix: true })}</div>
                  {f.latencyMs !== null && <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{f.latencyMs.toFixed(0)}ms</div>}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
