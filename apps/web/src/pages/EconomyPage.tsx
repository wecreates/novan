/**
 * Economy — autonomous economic intelligence war room.
 *
 * Consumes:
 *   /economy/war-room        (single payload: state, roi, allocation, forecast, waste)
 *   /economy/chains          (recent economic reasoning chains for learning loop)
 *
 * Facts vs estimates are visually separated.
 */
import React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Coins, TrendingUp, TrendingDown, AlertTriangle, RefreshCw,
  Sparkles, Activity, BadgeCheck, BadgeAlert,
} from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

type Fact     = { factType: 'fact';     value: number; source: string }
type Estimate = { factType: 'estimate'; value: number; basis: string; confidence: number }

interface WarRoom {
  generatedAt: number
  state: {
    windowDays: number
    spend: { aiProviders: Fact; remoteEndpoints: Fact; imageGen: Fact; agentExec: Fact; total: Fact }
    budget: {
      dailyLimitUsd: number; monthlyLimitUsd: number
      dailySpendUsd: number; monthlySpendUsd: number
      dailyUtilization: number; monthlyUtilization: number
    } | null
    byProvider: Array<{ provider: string; spendUsd: number; calls: number; avgCostUsd: number; failureRate: number }>
    byTaskType: Array<{ taskType: string; spendUsd: number; calls: number; avgCostUsd: number }>
  }
  roi: {
    windowDays: number
    workflows: Array<{ workflowId: string; runs: number; successes: number; successRate: number; aiSpendUsd: Estimate }>
    providersByEfficiency: Array<{ provider: string; spendUsd: number; successfulCalls: number; costPerSuccessUsd: Estimate }>
    recommendationOutcome: { economicChainsLogged: number; matched: number; unmatched: number; matchRate: number | null }
    notes: string[]
  }
  allocationSuggestions: Array<{
    type: string; title: string; rationale: string
    estimatedSavingsUsd: number; confidence: number
    evidence: Array<{ source: string; extract: string }>
  }>
  forecast: {
    windowDays: number; dailySpendSeries: number[]
    slopePerDayUsd: number; projectedNextWeekUsd: number | null
    likelihood: 'low' | 'medium' | 'high' | 'insufficient_data'
    evidence: string; confidence: number
  }
  wasteAlerts: Array<{ provider: string; spendUsd: number; failureRate: number; wastedUsdEstimate: Estimate }>
}

interface EconChain {
  id: string; decision: string; confidence: number | null; createdAt: number
  outcomeKnown: boolean; outcomeMatched: boolean | null
  outcomeEvidence: Record<string, unknown> | null
}

const LIKE: Record<string, string> = {
  high:   'text-red-300 bg-red-500/15 border-red-500/30',
  medium: 'text-amber-300 bg-amber-500/15 border-amber-500/30',
  low:    'text-emerald-300 bg-emerald-500/15 border-emerald-500/30',
  insufficient_data: 'text-slate-400 bg-slate-500/10 border-slate-500/30',
}

export default function EconomyPage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()

  const war = useQuery({
    queryKey: ['economy-war', workspaceId],
    queryFn:  () => api.get<{ data: WarRoom }>(`/api/v1/economy/war-room?workspace_id=${workspaceId}`),
    refetchInterval: 60_000,
  })
  const chains = useQuery({
    queryKey: ['economy-chains', workspaceId],
    queryFn:  () => api.get<{ data: EconChain[] }>(`/api/v1/economy/chains?workspace_id=${workspaceId}&limit=20`),
    refetchInterval: 60_000,
  })

  const recommend = useMutation({
    mutationFn: () => api.post(`/api/v1/economy/recommend`, { workspace_id: workspaceId }),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['economy-war', workspaceId] }); qc.invalidateQueries({ queryKey: ['economy-chains', workspaceId] }) },
  })
  const evalLoop = useMutation({
    mutationFn: () => api.post(`/api/v1/economy/evaluate-outcomes`, { workspace_id: workspaceId }),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['economy-chains', workspaceId] }),
  })

  const w = war.data?.data
  const cs = chains.data?.data ?? []

  return (
    <div className="p-6 space-y-4 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Coins className="w-5 h-5 text-amber-400" />
        <h1 className="text-xl font-semibold">Economic War Room</h1>
        <span className="text-xs text-[var(--text-muted)] ml-1">facts vs estimates — separated</span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => recommend.mutate()} disabled={recommend.isPending}
            className="px-3 py-1.5 text-xs rounded border border-[var(--border)] hover:bg-[var(--surface-hover)] flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5" /> {recommend.isPending ? 'Generating…' : 'Generate recommendations'}
          </button>
          <button onClick={() => evalLoop.mutate()} disabled={evalLoop.isPending}
            className="px-3 py-1.5 text-xs rounded border border-[var(--border)] hover:bg-[var(--surface-hover)] flex items-center gap-1.5">
            <RefreshCw className={`w-3.5 h-3.5 ${evalLoop.isPending ? 'animate-spin' : ''}`} /> Evaluate outcomes
          </button>
        </div>
      </div>

      {/* Spend snapshot */}
      {w && (
        <Section title={`Spend snapshot — last ${w.state.windowDays}d (facts)`} icon={<Activity className="w-4 h-4 text-emerald-400" />}>
          <div className="px-5 py-4 grid grid-cols-2 md:grid-cols-5 gap-3">
            <SpendStat label="AI providers" v={w.state.spend.aiProviders.value} />
            <SpendStat label="Remote endpoints" v={w.state.spend.remoteEndpoints.value} />
            <SpendStat label="Image gen" v={w.state.spend.imageGen.value} />
            <SpendStat label="Agent/queue" v={w.state.spend.agentExec.value} />
            <SpendStat label="TOTAL" v={w.state.spend.total.value} bold />
          </div>
          {w.state.budget ? (
            <div className="px-5 pb-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm border-t border-[var(--border)] pt-3">
              <Kv k="Daily limit" v={`$${w.state.budget.dailyLimitUsd.toFixed(2)}`} />
              <Kv k="Daily spend" v={`$${w.state.budget.dailySpendUsd.toFixed(2)} (${(w.state.budget.dailyUtilization * 100).toFixed(0)}%)`} />
              <Kv k="Monthly limit" v={`$${w.state.budget.monthlyLimitUsd.toFixed(2)}`} />
              <Kv k="Monthly spend" v={`$${w.state.budget.monthlySpendUsd.toFixed(2)} (${(w.state.budget.monthlyUtilization * 100).toFixed(0)}%)`} />
            </div>
          ) : null}
        </Section>
      )}

      {/* Spend by provider/task */}
      {w && (w.state.byProvider.length > 0 || w.state.byTaskType.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Section title="By provider (fact)" icon={<BadgeCheck className="w-4 h-4 text-emerald-400" />}>
            {w.state.byProvider.length === 0 ? <Empty msg="no provider spend in window" /> : (
              <ul className="divide-y divide-[var(--border)]">
                {w.state.byProvider.slice(0, 8).map(p => (
                  <li key={p.provider} className="px-5 py-2 flex items-center gap-3 text-sm">
                    <span className="font-mono">{p.provider}</span>
                    <span className="ml-auto font-mono text-emerald-300">${p.spendUsd.toFixed(4)}</span>
                    <span className="text-[var(--text-muted)] text-xs">{p.calls} calls</span>
                    {p.failureRate > 0.05 && (
                      <span className="text-amber-400 text-xs">fail {(p.failureRate * 100).toFixed(0)}%</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="By task type (fact)" icon={<BadgeCheck className="w-4 h-4 text-emerald-400" />}>
            {w.state.byTaskType.length === 0 ? <Empty msg="no task spend in window" /> : (
              <ul className="divide-y divide-[var(--border)]">
                {w.state.byTaskType.slice(0, 8).map(t => (
                  <li key={t.taskType} className="px-5 py-2 flex items-center gap-3 text-sm">
                    <span className="font-mono">{t.taskType}</span>
                    <span className="ml-auto font-mono text-emerald-300">${t.spendUsd.toFixed(4)}</span>
                    <span className="text-[var(--text-muted)] text-xs">{t.calls} calls @ ${t.avgCostUsd.toFixed(5)}/call</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}

      {/* Forecast */}
      {w && (
        <Section title="Spend forecast (prediction)" icon={<TrendingUp className="w-4 h-4 text-purple-400" />}>
          <div className="px-5 py-4 flex items-center gap-4 text-sm">
            <span className={`px-2 py-0.5 rounded text-xs border ${LIKE[w.forecast.likelihood]}`}>
              {w.forecast.likelihood}
            </span>
            <span className="font-mono">
              {w.forecast.projectedNextWeekUsd !== null
                ? `next 7d projected: $${w.forecast.projectedNextWeekUsd.toFixed(2)}`
                : 'insufficient data'}
            </span>
            <span className="text-[var(--text-muted)] text-xs ml-auto">{w.forecast.evidence}</span>
          </div>
          {w.forecast.dailySpendSeries.length > 0 && (
            <div className="px-5 pb-3 text-xs text-[var(--text-muted)] font-mono">
              series: [{w.forecast.dailySpendSeries.map(v => v.toFixed(3)).join(', ')}]
            </div>
          )}
        </Section>
      )}

      {/* Waste alerts */}
      {w && w.wasteAlerts.length > 0 && (
        <Section title={`Waste alerts (${w.wasteAlerts.length}, estimate)`} icon={<AlertTriangle className="w-4 h-4 text-amber-400" />}>
          <ul className="divide-y divide-[var(--border)]">
            {w.wasteAlerts.map(a => (
              <li key={a.provider} className="px-5 py-2.5 text-sm flex items-center gap-3">
                <span className="font-mono">{a.provider}</span>
                <span className="text-[var(--text-muted)] text-xs">fail {(a.failureRate * 100).toFixed(0)}% × spend ${a.spendUsd.toFixed(2)}</span>
                <span className="ml-auto font-mono text-amber-300">~${a.wastedUsdEstimate.value.toFixed(4)} wasted (estimate)</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Allocation suggestions */}
      {w && (
        <Section title={`Allocation suggestions (${w.allocationSuggestions.length}, estimate)`} icon={<Sparkles className="w-4 h-4 text-sky-400" />}>
          {w.allocationSuggestions.length === 0 ? <Empty msg="no actionable suggestions — system is efficient or sample size too small" /> : (
            <ul className="divide-y divide-[var(--border)]">
              {w.allocationSuggestions.map((s, i) => (
                <li key={i} className="px-5 py-3 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-xs px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30">{s.type}</span>
                    <span className="font-medium">{s.title}</span>
                    {s.estimatedSavingsUsd > 0 && (
                      <span className="ml-auto font-mono text-emerald-300 text-xs">~${s.estimatedSavingsUsd.toFixed(2)} est. savings</span>
                    )}
                  </div>
                  <p className="text-xs text-[var(--text-muted)] mt-1">{s.rationale}</p>
                  <p className="text-[10px] text-[var(--text-muted)] mt-1">confidence {s.confidence.toFixed(2)} · {s.evidence.map(e => e.source).join(', ')}</p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {/* ROI */}
      {w && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Section title={`Workflow ROI — last ${w.roi.windowDays}d`} icon={<TrendingUp className="w-4 h-4 text-emerald-400" />}>
            {w.roi.workflows.length === 0 ? <Empty msg="no workflow runs in window" /> : (
              <ul className="divide-y divide-[var(--border)]">
                {w.roi.workflows.slice(0, 6).map(wf => (
                  <li key={wf.workflowId} className="px-5 py-2 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs truncate">{wf.workflowId.slice(0, 18)}</span>
                      <span className="ml-auto font-mono">{wf.successes}/{wf.runs}</span>
                      <span className={`text-xs ${wf.successRate >= 0.8 ? 'text-emerald-300' : wf.successRate >= 0.5 ? 'text-amber-300' : 'text-red-300'}`}>
                        {(wf.successRate * 100).toFixed(0)}%
                      </span>
                    </div>
                    <p className="text-[10px] text-[var(--text-muted)]">est. AI spend: ${wf.aiSpendUsd.value.toFixed(4)} (estimate, conf {wf.aiSpendUsd.confidence.toFixed(2)})</p>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title={`Provider efficiency — cost/success (estimate)`} icon={<TrendingDown className="w-4 h-4 text-sky-400" />}>
            {w.roi.providersByEfficiency.length === 0 ? <Empty msg="no provider data in window" /> : (
              <ul className="divide-y divide-[var(--border)]">
                {w.roi.providersByEfficiency.slice(0, 6).map(p => (
                  <li key={p.provider} className="px-5 py-2 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-mono">{p.provider}</span>
                      <span className="ml-auto font-mono text-emerald-300">${p.costPerSuccessUsd.value.toFixed(6)}/success</span>
                    </div>
                    <p className="text-[10px] text-[var(--text-muted)]">{p.successfulCalls} successes · spend ${p.spendUsd.toFixed(4)} · conf {p.costPerSuccessUsd.confidence.toFixed(2)}</p>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}

      {/* Learning loop */}
      {w && (
        <Section title="Learning loop (predicted vs actual)" icon={<BadgeAlert className="w-4 h-4 text-purple-400" />}>
          <div className="px-5 py-3 text-sm flex items-center gap-4">
            <Kv k="Chains logged" v={String(w.roi.recommendationOutcome.economicChainsLogged)} />
            <Kv k="Matched" v={String(w.roi.recommendationOutcome.matched)} />
            <Kv k="Unmatched" v={String(w.roi.recommendationOutcome.unmatched)} />
            <Kv k="Match rate" v={w.roi.recommendationOutcome.matchRate === null ? '— (need ≥5)' : `${(w.roi.recommendationOutcome.matchRate * 100).toFixed(0)}%`} />
          </div>
          {w.roi.notes.length > 0 && (
            <ul className="px-5 pb-3 text-xs text-[var(--text-muted)] space-y-0.5">
              {w.roi.notes.map((n, i) => <li key={i}>• {n}</li>)}
            </ul>
          )}
          {cs.length > 0 && (
            <ul className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
              {cs.slice(0, 8).map(c => (
                <li key={c.id} className="px-5 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[var(--text-muted)]">{new Date(c.createdAt).toLocaleDateString()}</span>
                    <span>{c.decision}</span>
                    <span className="ml-auto">
                      {c.outcomeKnown
                        ? (c.outcomeMatched ? <span className="text-emerald-400">matched</span> : <span className="text-red-400">unmatched</span>)
                        : <span className="text-slate-400">pending</span>}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </div>
  )
}

function Section({ title, icon, children }: { title: string; icon?: JSX.Element; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <div className="px-4 py-2.5 border-b border-[var(--border)] flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-medium text-[var(--text)]">{title}</h3>
      </div>
      {children}
    </div>
  )
}

function SpendStat({ label, v, bold }: { label: string; v: number; bold?: boolean }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{label}</div>
      <div className={`font-mono mt-0.5 ${bold ? 'text-xl text-emerald-300' : 'text-lg'}`}>${v.toFixed(4)}</div>
    </div>
  )
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{k}</div>
      <div className="font-mono text-sm">{v}</div>
    </div>
  )
}

function Empty({ msg }: { msg: string }) {
  return <div className="px-5 py-4 text-xs text-[var(--text-muted)] italic">{msg}</div>
}
