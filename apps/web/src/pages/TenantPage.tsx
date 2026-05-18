/**
 * TenantPage — Workspace health + billing + plan view.
 *
 * Shows:
 * - Active plan + subscription state
 * - Usage meters with limit progress
 * - Plan comparison + upgrade flow
 * - Workspace members
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Building2, CreditCard, BarChart3, Users, ArrowUpCircle,
  CheckCircle2, AlertTriangle, RefreshCcw, Sparkles,
} from 'lucide-react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

const API = (p: string) => `/api/v1/billing${p}`
const SEC = (p: string) => `/api/v1/security${p}`

async function fetchPlans()                 { return (await (await fetch(API('/plans'))).json()).data as Plan[] }
async function fetchSubscription(ws: string) { return (await (await fetch(`${API('/subscription')}?workspace_id=${ws}`)).json()).data as Sub | null }
async function fetchUsage(ws: string)       { return (await (await fetch(`${API('/usage')}?workspace_id=${ws}`)).json()).data as Usage[] }
async function fetchMembers(ws: string)     { return (await (await fetch(`${SEC('/rbac/members')}?workspace_id=${ws}`)).json()).data as Member[] }

async function changePlan(ws: string, planId: string) {
  const r = await fetch(API('/plan/change'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace_id: ws, plan_id: planId }) })
  if (!r.ok) throw new Error((await r.json()).error)
  return r.json()
}
async function startSub(ws: string, planId: string) {
  const r = await fetch(API('/subscription'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace_id: ws, plan_id: planId, trial_days: 14 }) })
  return r.json()
}

interface Plan {
  id: string; name: string; monthlyPriceUsd: number
  seatLimit: number; workflowLimit: number; workspaceLimit: number
  monthlyTokenLimit: number; monthlySpendLimitUsd: number
  featureFlags: Record<string, boolean>
}
interface Sub {
  id: string; planId: string; status: string
  currentPeriodStart: number | null; currentPeriodEnd: number | null
  trialEndsAt: number | null
}
interface Usage { meterKey: string; amount: number; periodStart: number }
interface Member { id: string; userId: string; role: string; grants: string[] }

const STATUS_COLORS: Record<string, string> = {
  trialing: 'bg-blue-500/20 text-blue-400 border border-blue-500/30',
  active:   'bg-green-500/20 text-green-400 border border-green-500/30',
  past_due: 'bg-orange-500/20 text-orange-400 border border-orange-500/30',
  canceled: 'bg-gray-500/20 text-gray-400 border border-gray-500/30',
  paused:   'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
  expired:  'bg-red-500/20 text-red-400 border border-red-500/30',
}

const METER_LABELS: Record<string, string> = {
  provider_spend_usd: 'Provider Spend ($)',
  tokens:             'Tokens',
  workflow_runs:      'Workflow Runs',
  remote_worker_min:  'Remote Worker (min)',
  storage_mb:         'Storage (MB)',
  replay_count:       'DLQ Replays',
  autonomous_runs:    'Autonomous Runs',
}

function UsageBar({ label, current, limit }: { label: string; current: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, (current / limit) * 100) : 0
  const color = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-yellow-500' : 'bg-green-500'
  return (
    <div className="rounded-lg border border-border bg-[var(--bg-surface)] px-4 py-3">
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs text-muted">{label}</p>
        <p className="text-xs font-mono text-secondary">
          {current.toLocaleString()} / {limit.toLocaleString()}
        </p>
      </div>
      <div className="w-full h-1.5 bg-elevated rounded-full overflow-hidden">
        <div className={`h-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      {pct >= 90 && (
        <p className="text-xs text-red-400 mt-1 flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" /> Approaching limit
        </p>
      )}
    </div>
  )
}

export default function TenantPage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const [tab, setTab] = useState<'overview' | 'usage' | 'plans' | 'members'>('overview')

  const { data: plans = [] }  = useQuery({ queryKey: ['t-plans'],        queryFn: fetchPlans })
  const { data: sub }         = useQuery({ queryKey: ['t-sub',     workspaceId], queryFn: () => fetchSubscription(workspaceId), enabled: !!workspaceId, refetchInterval: 30_000 })
  const { data: usage = [] }  = useQuery({ queryKey: ['t-usage',   workspaceId], queryFn: () => fetchUsage(workspaceId),         enabled: !!workspaceId && tab !== 'plans', refetchInterval: 30_000 })
  const { data: members = [] } = useQuery({ queryKey: ['t-members', workspaceId], queryFn: () => fetchMembers(workspaceId),     enabled: !!workspaceId && tab === 'members' })

  const currentPlan = plans.find((p) => p.id === sub?.planId) ?? plans.find((p) => p.id === 'free')

  const changeMut = useMutation({
    mutationFn: (planId: string) => sub ? changePlan(workspaceId, planId) : startSub(workspaceId, planId),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['t-sub'] }) },
  })

  const usageMap = new Map(usage.map((u) => [u.meterKey, u.amount]))

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="shrink-0 px-6 pt-5 pb-4 border-b border-border">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-primary flex items-center gap-2">
              <Building2 className="w-4 h-4 text-blue-400" /> Workspace & Billing
            </h1>
            <p className="text-xs text-muted mt-0.5">
              Plan limits · usage meters · members · isolated tenant runtime
            </p>
          </div>
          <button onClick={() => { qc.invalidateQueries({ queryKey: ['t-sub'] }); qc.invalidateQueries({ queryKey: ['t-usage'] }) }} className="text-muted hover:text-secondary">
            <RefreshCcw className="w-4 h-4" />
          </button>
        </div>

        {/* Subscription summary */}
        {sub && currentPlan && (
          <div className="mt-4 grid grid-cols-3 gap-3">
            <div className="rounded-lg border border-border bg-[var(--bg-surface)] px-4 py-3">
              <p className="text-xs text-muted">Plan</p>
              <p className="text-lg font-semibold text-primary mt-0.5">{currentPlan.name}</p>
              <p className="text-xs text-muted mt-0.5">${currentPlan.monthlyPriceUsd}/mo</p>
            </div>
            <div className="rounded-lg border border-border bg-[var(--bg-surface)] px-4 py-3">
              <p className="text-xs text-muted">Status</p>
              <span className={`inline-block mt-1 px-2 py-0.5 rounded text-xs capitalize ${STATUS_COLORS[sub.status] ?? ''}`}>
                {sub.status}
              </span>
              {sub.trialEndsAt && sub.status === 'trialing' && (
                <p className="text-xs text-muted mt-1">
                  Trial ends {new Date(sub.trialEndsAt).toLocaleDateString()}
                </p>
              )}
            </div>
            <div className="rounded-lg border border-border bg-[var(--bg-surface)] px-4 py-3">
              <p className="text-xs text-muted">Period</p>
              <p className="text-sm text-primary mt-0.5">
                {sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toLocaleDateString() : '—'}
              </p>
              <p className="text-xs text-muted mt-0.5">Next renewal</p>
            </div>
          </div>
        )}

        {!sub && plans.length > 0 && (
          <div className="mt-4 rounded-lg border border-blue-500/30 bg-blue-500/5 p-4 flex items-center gap-3">
            <Sparkles className="w-5 h-5 text-blue-400" />
            <div className="flex-1">
              <p className="text-sm font-medium text-blue-300">No active subscription</p>
              <p className="text-xs text-muted mt-0.5">Start a 14-day trial on any plan to unlock billing-gated features.</p>
            </div>
            <button onClick={() => changeMut.mutate('starter')} disabled={changeMut.isPending}
              className="px-3 py-1.5 rounded text-xs bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border border-blue-500/30 disabled:opacity-50">
              Start Trial
            </button>
          </div>
        )}

        <div className="flex gap-1 mt-3">
          {[
            { v: 'overview', l: 'Overview',   i: <BarChart3 className="w-3 h-3" /> },
            { v: 'usage',    l: 'Usage',      i: <BarChart3 className="w-3 h-3" /> },
            { v: 'plans',    l: 'Plans',      i: <CreditCard className="w-3 h-3" /> },
            { v: 'members',  l: 'Members',    i: <Users className="w-3 h-3" /> },
          ].map((t) => (
            <button key={t.v} onClick={() => setTab(t.v as typeof tab)}
              className={`px-3 py-1 rounded text-xs flex items-center gap-1.5 transition-colors ${
                tab === t.v
                  ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                  : 'text-muted hover:text-secondary hover:bg-elevated'
              }`}>{t.i}{t.l}</button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {tab === 'overview' && currentPlan && (
          <div className="max-w-4xl space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <UsageBar label="Monthly tokens" current={usageMap.get('tokens') ?? 0} limit={currentPlan.monthlyTokenLimit} />
              <UsageBar label="Monthly spend ($)" current={usageMap.get('provider_spend_usd') ?? 0} limit={currentPlan.monthlySpendLimitUsd} />
            </div>
            <div className="rounded-lg border border-border bg-[var(--bg-surface)] p-4">
              <p className="text-sm font-medium text-primary mb-2">Plan limits</p>
              <div className="grid grid-cols-3 gap-3 text-xs">
                <div><span className="text-muted">Seats:</span> {currentPlan.seatLimit}</div>
                <div><span className="text-muted">Workflows:</span> {currentPlan.workflowLimit}</div>
                <div><span className="text-muted">Workspaces:</span> {currentPlan.workspaceLimit}</div>
              </div>
              <div className="mt-3 pt-3 border-t border-border">
                <p className="text-xs text-muted mb-1">Features</p>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(currentPlan.featureFlags).map(([k, v]) => (
                    <span key={k} className={`px-2 py-0.5 rounded text-xs flex items-center gap-1 ${v ? 'bg-green-500/10 text-green-400' : 'bg-gray-500/10 text-gray-400'}`}>
                      {v && <CheckCircle2 className="w-3 h-3" />}
                      {k}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === 'usage' && (
          <div className="max-w-4xl grid grid-cols-2 gap-3">
            {Object.entries(METER_LABELS).map(([key, label]) => {
              const amount = usageMap.get(key) ?? 0
              const limit = key === 'tokens' ? currentPlan?.monthlyTokenLimit ?? 0
                : key === 'provider_spend_usd' ? currentPlan?.monthlySpendLimitUsd ?? 0
                : 0
              return <UsageBar key={key} label={label} current={amount} limit={limit || amount + 1} />
            })}
          </div>
        )}

        {tab === 'plans' && (
          <div className="max-w-6xl grid grid-cols-4 gap-3">
            {plans.map((p) => {
              const isCurrent = p.id === sub?.planId
              return (
                <div key={p.id} className={`rounded-lg border ${isCurrent ? 'border-blue-500/40 bg-blue-500/5' : 'border-border bg-[var(--bg-surface)]'} p-4`}>
                  <p className="text-sm font-medium text-primary">{p.name}</p>
                  <p className="text-2xl font-semibold text-primary mt-1">${p.monthlyPriceUsd}<span className="text-xs text-muted">/mo</span></p>
                  <div className="mt-3 space-y-1 text-xs text-secondary">
                    <p>{p.seatLimit} seats</p>
                    <p>{p.workflowLimit} workflows</p>
                    <p>{p.monthlyTokenLimit.toLocaleString()} tokens/mo</p>
                    <p>${p.monthlySpendLimitUsd}/mo provider spend</p>
                  </div>
                  <div className="mt-3 space-y-0.5">
                    {Object.entries(p.featureFlags).filter(([_, v]) => v).map(([k]) => (
                      <p key={k} className="text-xs text-green-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />{k}</p>
                    ))}
                  </div>
                  <button onClick={() => changeMut.mutate(p.id)} disabled={isCurrent || changeMut.isPending}
                    className={`mt-4 w-full px-3 py-1.5 rounded text-xs transition-colors ${
                      isCurrent
                        ? 'bg-elevated text-muted cursor-not-allowed'
                        : 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border border-blue-500/30'
                    }`}>
                    {isCurrent ? 'Current Plan' : sub ? <><ArrowUpCircle className="w-3 h-3 inline mr-1" />Change to {p.name}</> : 'Start Trial'}
                  </button>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'members' && (
          <div className="max-w-4xl space-y-2">
            {members.length === 0 && <p className="text-sm text-muted">No members registered. Use POST /api/v1/security/rbac/grant to add.</p>}
            {members.map((m) => (
              <div key={m.id} className="rounded-lg border border-border bg-[var(--bg-surface)] px-4 py-3 flex items-center gap-3">
                <Users className="w-4 h-4 text-muted" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-mono text-primary">{m.userId}</p>
                  <p className="text-xs text-muted mt-0.5">{m.grants.length} permission(s)</p>
                </div>
                <span className="px-2 py-0.5 rounded text-xs bg-blue-500/10 text-blue-400 capitalize">{m.role}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
