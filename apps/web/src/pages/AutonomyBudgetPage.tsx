import { useState, useEffect, useCallback } from 'react'
import { DollarSign, Plus, Power, AlertTriangle, CheckCircle, RefreshCw, TrendingUp } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

/**
 * AutonomyBudgetPage — R146.101.
 *
 * Operator-facing surface for the autonomy-budget system (R146.97).
 * Set ceilings, view spend, disable budgets. Without UI the brain has the
 * capability but the operator has no way to set/view limits.
 */

type Category = 'ads' | 'content-gen' | 'data' | 'all'
type Period   = 'daily' | 'weekly' | 'monthly'

interface Budget {
  id:          string
  workspaceId: string
  businessId:  string | null
  category:    Category
  period:      Period
  ceilingUsd:  number
  enabled:     boolean
  notes:       string | null
  createdAt:   number
  updatedAt:   number
}

interface SpendSummary {
  workspaceId: string
  businessId:  string | null
  spendByCategory: Record<Category, { daily: number; weekly: number; monthly: number }>
  budgets:     Budget[]
}

function fmtUsd(v: number): string {
  return v < 0.01 && v > 0 ? `$${v.toFixed(5)}` : `$${v.toFixed(2)}`
}

async function brainOp<T = unknown>(workspaceId: string, op: string, params: Record<string, unknown>, approval = false): Promise<T> {
  const res = await api.post('/api/v1/brain/task', {
    workspace_id: workspaceId,
    plan:         [{ op, params }],
    ...(approval ? { approval_token: 'OPERATOR_APPROVED' } : {}),
  }) as { data?: { results?: Array<{ ok: boolean; data?: T; error?: string }> } }
  const r = res?.data?.results?.[0]
  if (!r?.ok) throw new Error(r?.error ?? `op ${op} failed`)
  return r.data as T
}

export default function AutonomyBudgetPage() {
  const { workspaceId } = useWorkspace()
  const [summary, setSummary]  = useState<SpendSummary | null>(null)
  const [loading, setLoading]  = useState(true)
  const [error,   setError]    = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [form, setForm] = useState<{ category: Category; period: Period; ceilingUsd: number; businessId: string; notes: string }>({
    category: 'all', period: 'daily', ceilingUsd: 50, businessId: '', notes: '',
  })

  const refresh = useCallback(async () => {
    if (!workspaceId) return
    setLoading(true); setError(null)
    try {
      const s = await brainOp<SpendSummary>(workspaceId, 'autonomy.spendSummary', {})
      setSummary(s)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => { void refresh() }, [refresh])

  const createBudget = async () => {
    if (!workspaceId) return
    setSubmitting(true); setError(null)
    try {
      await brainOp(workspaceId, 'autonomy.setBudget', {
        category: form.category,
        period:   form.period,
        ceilingUsd: form.ceilingUsd,
        ...(form.businessId ? { businessId: form.businessId } : {}),
        ...(form.notes ? { notes: form.notes } : {}),
      }, true)
      setShowForm(false)
      setForm({ category: 'all', period: 'daily', ceilingUsd: 50, businessId: '', notes: '' })
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const disableBudget = async (id: string) => {
    if (!workspaceId) return
    if (!confirm('Disable this budget? Existing spend will not be affected; future autonomous spend will require approval.')) return
    try {
      await brainOp(workspaceId, 'autonomy.disableBudget', { id }, true)
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (loading && !summary) return <div className="p-8 text-gray-500">Loading autonomy budgets…</div>

  const cats: Category[] = ['ads', 'content-gen', 'data', 'all']
  const periods: Period[] = ['daily', 'weekly', 'monthly']

  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><DollarSign className="w-6 h-6" />Autonomy Budgets</h1>
          <p className="text-sm text-gray-600 mt-1">Set how much the brain can spend without asking. Below the ceiling: autonomous. Above: approval required.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={refresh} className="px-3 py-2 rounded-lg border hover:bg-gray-50 flex items-center gap-2 text-sm"><RefreshCw className="w-4 h-4" />Refresh</button>
          <button onClick={() => setShowForm(s => !s)} className="px-3 py-2 rounded-lg bg-black text-white hover:bg-gray-800 flex items-center gap-2 text-sm"><Plus className="w-4 h-4" />New budget</button>
        </div>
      </div>

      {error && <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm flex items-center gap-2"><AlertTriangle className="w-4 h-4" />{error}</div>}

      {showForm && (
        <div className="mb-6 p-5 rounded-xl border bg-gray-50">
          <h3 className="font-medium mb-4">New autonomy budget</h3>
          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="text-sm text-gray-700">Category</span>
              <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value as Category }))} className="mt-1 w-full rounded-lg border px-3 py-2 bg-white">
                {cats.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-sm text-gray-700">Period</span>
              <select value={form.period} onChange={e => setForm(f => ({ ...f, period: e.target.value as Period }))} className="mt-1 w-full rounded-lg border px-3 py-2 bg-white">
                {periods.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-sm text-gray-700">Ceiling (USD)</span>
              <input type="number" value={form.ceilingUsd} onChange={e => setForm(f => ({ ...f, ceilingUsd: Number(e.target.value) }))} className="mt-1 w-full rounded-lg border px-3 py-2" min={0} step={5} />
            </label>
            <label className="block">
              <span className="text-sm text-gray-700">Business ID (optional — leave blank for workspace-wide)</span>
              <input type="text" value={form.businessId} onChange={e => setForm(f => ({ ...f, businessId: e.target.value }))} className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-sm" placeholder="e.g. 019e8589-…" />
            </label>
            <label className="block col-span-2">
              <span className="text-sm text-gray-700">Notes (optional)</span>
              <input type="text" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="mt-1 w-full rounded-lg border px-3 py-2" placeholder="why this budget" />
            </label>
          </div>
          <div className="mt-4 flex gap-2">
            <button onClick={createBudget} disabled={submitting} className="px-4 py-2 rounded-lg bg-black text-white hover:bg-gray-800 text-sm disabled:opacity-50">{submitting ? 'Saving…' : 'Save budget'}</button>
            <button onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg border hover:bg-gray-50 text-sm">Cancel</button>
          </div>
        </div>
      )}

      <h2 className="text-lg font-medium mb-3 flex items-center gap-2"><TrendingUp className="w-5 h-5" />Period spend</h2>
      <div className="grid grid-cols-4 gap-3 mb-8">
        {cats.map(cat => {
          const s = summary?.spendByCategory?.[cat] ?? { daily: 0, weekly: 0, monthly: 0 }
          return (
            <div key={cat} className="p-4 rounded-xl border bg-white">
              <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">{cat}</div>
              <div className="grid grid-cols-3 text-center text-xs">
                <div><div className="text-gray-500">Today</div><div className="font-semibold text-base mt-1">{fmtUsd(s.daily)}</div></div>
                <div><div className="text-gray-500">7d</div><div className="font-semibold text-base mt-1">{fmtUsd(s.weekly)}</div></div>
                <div><div className="text-gray-500">30d</div><div className="font-semibold text-base mt-1">{fmtUsd(s.monthly)}</div></div>
              </div>
            </div>
          )
        })}
      </div>

      <h2 className="text-lg font-medium mb-3">Configured ceilings</h2>
      {(summary?.budgets ?? []).length === 0 ? (
        <div className="p-8 text-center rounded-xl border bg-gray-50 text-gray-600">
          <div className="mb-1 font-medium">No budgets configured yet</div>
          <div className="text-sm">Without one, every autonomous spend requires operator approval. Click <strong>New budget</strong> above to set one.</div>
        </div>
      ) : (
        <div className="rounded-xl border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-700 text-xs uppercase tracking-wider">
              <tr>
                <th className="px-4 py-2 text-left">Category</th>
                <th className="px-4 py-2 text-left">Period</th>
                <th className="px-4 py-2 text-right">Ceiling</th>
                <th className="px-4 py-2 text-left">Scope</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-left">Notes</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {(summary?.budgets ?? []).map(b => (
                <tr key={b.id} className="border-t">
                  <td className="px-4 py-2 font-medium">{b.category}</td>
                  <td className="px-4 py-2">{b.period}</td>
                  <td className="px-4 py-2 text-right font-mono">{fmtUsd(Number(b.ceilingUsd))}</td>
                  <td className="px-4 py-2 text-xs text-gray-600">{b.businessId ?? 'workspace-wide'}</td>
                  <td className="px-4 py-2">
                    {b.enabled
                      ? <span className="inline-flex items-center gap-1 text-green-700 text-xs"><CheckCircle className="w-3 h-3" />active</span>
                      : <span className="text-gray-500 text-xs">disabled</span>}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-600">{b.notes ?? ''}</td>
                  <td className="px-4 py-2 text-right">
                    {b.enabled && (
                      <button onClick={() => disableBudget(b.id)} className="text-xs text-red-600 hover:text-red-700 inline-flex items-center gap-1">
                        <Power className="w-3 h-3" />Disable
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
