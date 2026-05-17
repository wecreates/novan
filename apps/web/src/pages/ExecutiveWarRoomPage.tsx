/**
 * Executive War Room — proactive operational intelligence.
 *
 * Consumes:
 *   /intelligence/forecasts
 *   /intelligence/tradeoffs
 *   /intelligence/executive/reliability
 *   /intelligence/executive/security
 *   /intelligence/executive/cost
 *   /intelligence/executive/mission-progress
 *
 * Rule honored: every prediction is visually separated from facts and
 * carries a 'prediction' badge.
 */
import { useQuery } from '@tanstack/react-query'
import {
  TrendingUp, AlertOctagon, AlertTriangle, CheckCircle2, DollarSign, Shield,
  Target, Activity, Gauge, GitBranch, Sparkles,
} from 'lucide-react'
import { intelligenceApi, type ForecastDTO, type TradeoffDTO } from '../api.js'

const WORKSPACE = 'default'

function fmtDays(d: number | null): string {
  if (d === null) return '—'
  if (d < 0) return `${Math.abs(d)}d overdue`
  if (d < 1) return 'today'
  if (d < 7) return `${Math.round(d)}d`
  if (d < 30) return `${Math.round(d / 7)}w`
  return `${Math.round(d / 30)}mo`
}

function likelihoodColor(l: ForecastDTO['likelihood']): string {
  switch (l) {
    case 'critical': return 'border-red-500/40 bg-red-500/10 text-red-300'
    case 'high':     return 'border-amber-500/40 bg-amber-500/10 text-amber-300'
    case 'medium':   return 'border-sky-500/40 bg-sky-500/10 text-sky-300'
    case 'low':      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
    default:         return 'border-slate-500/30 bg-slate-500/10 text-slate-400'
  }
}

function forecastLabel(type: string): string {
  return type.replace(/_/g, ' ').replace(/likely$/, '').trim()
}

export default function ExecutiveWarRoomPage() {
  const forecasts = useQuery({ queryKey: ['forecasts', WORKSPACE], queryFn: () => intelligenceApi.forecasts(WORKSPACE), refetchInterval: 5 * 60_000 })
  const tradeoffs = useQuery({ queryKey: ['tradeoffs', WORKSPACE], queryFn: () => intelligenceApi.tradeoffs(WORKSPACE, 5), refetchInterval: 5 * 60_000 })
  const reliability = useQuery({ queryKey: ['exec-reliability', WORKSPACE], queryFn: () => intelligenceApi.executiveReliability(WORKSPACE), refetchInterval: 2 * 60_000 })
  const security    = useQuery({ queryKey: ['exec-security',    WORKSPACE], queryFn: () => intelligenceApi.executiveSecurity(WORKSPACE),    refetchInterval: 5 * 60_000 })
  const cost        = useQuery({ queryKey: ['exec-cost',        WORKSPACE], queryFn: () => intelligenceApi.executiveCost(WORKSPACE),        refetchInterval: 5 * 60_000 })
  const mission     = useQuery({ queryKey: ['exec-mission',     WORKSPACE], queryFn: () => intelligenceApi.executiveMissionProgress(WORKSPACE), refetchInterval: 2 * 60_000 })

  if (forecasts.isLoading) return <div className="p-8 text-[var(--text-muted)]">Loading…</div>
  const fs = forecasts.data?.data
  const to = tradeoffs.data?.data ?? []
  const r = reliability.data?.data
  const s = security.data?.data
  const c = cost.data?.data
  const m = mission.data?.data

  // Bucket forecasts by likelihood (critical/high surface above the fold)
  const elevatedForecasts = (fs?.forecasts ?? []).filter(f => f.likelihood === 'critical' || f.likelihood === 'high')
  const otherForecasts    = (fs?.forecasts ?? []).filter(f => f.likelihood !== 'critical' && f.likelihood !== 'high')

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
      <div className="flex items-center gap-3">
        <Sparkles className="w-6 h-6 text-amber-400" />
        <div>
          <h1 className="text-xl font-medium text-[var(--text)]">Executive War Room</h1>
          <p className="text-xs text-[var(--text-muted)]">Forecasts + tradeoffs. Facts and predictions are clearly separated.</p>
        </div>
      </div>

      {/* Forecast summary strip */}
      {fs && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <ForecastCount label="critical" value={fs.summary.critical} color="red" />
          <ForecastCount label="high"     value={fs.summary.high}     color="amber" />
          <ForecastCount label="medium"   value={fs.summary.medium}   color="sky" />
          <ForecastCount label="low"      value={fs.summary.low}      color="emerald" />
          <ForecastCount label="insuff. data" value={fs.summary.insufficientData} color="slate" />
        </div>
      )}

      {/* Elevated forecasts */}
      <Section title="Top Operational Risks (predicted)" icon={<AlertOctagon className="w-4 h-4 text-red-400" />} predictionBadge>
        {elevatedForecasts.length === 0 ? (
          <EmptyRow text="No critical or high-likelihood forecasts. System trending stable." />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {elevatedForecasts.map(f => <ForecastRow key={f.type} f={f} />)}
          </ul>
        )}
      </Section>

      {/* Top tradeoffs */}
      <Section title="Top Strategic Tradeoffs" icon={<Gauge className="w-4 h-4" />}>
        {to.length === 0 ? (
          <EmptyRow text="No tradeoffs to surface. Recommendations queue is empty." />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {to.map(t => <TradeoffRow key={t.recommendationId} t={t} />)}
          </ul>
        )}
      </Section>

      {/* 4-up briefing strip */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Reliability */}
        <BriefingPanel title="Reliability" icon={<Activity className="w-4 h-4 text-sky-400" />}>
          {r ? (
            <div className="px-5 py-3 space-y-2 text-sm">
              <FactRow label="Open incidents" value={r.facts.openIncidents} highlight={r.facts.openIncidents > 0 ? 'amber' : ''} />
              <FactRow label="Critical open" value={r.facts.openCriticalIncidents} highlight={r.facts.openCriticalIncidents > 0 ? 'red' : ''} />
              <FactRow label="Failed workflows (24h)" value={r.facts.failedWorkflows24h} />
              <FactRow label="Rollbacks (24h)" value={r.facts.rollbacks24h} highlight={r.facts.rollbacks24h > 0 ? 'amber' : ''} />
              {r.predictions.runtimeBottleneck && (
                <PredictionFooter f={r.predictions.runtimeBottleneck} />
              )}
            </div>
          ) : <EmptyRow text="Loading…" />}
        </BriefingPanel>

        {/* Security */}
        <BriefingPanel title="Security" icon={<Shield className="w-4 h-4 text-emerald-400" />}>
          {s ? (
            <div className="px-5 py-3 space-y-2 text-sm">
              <FactRow label="Audit findings" value={s.facts.securityAuditFindings} highlight={s.facts.securityAuditFindings > 5 ? 'amber' : ''} />
              <FactRow label="Critical findings" value={s.facts.criticalSecurityFindings} highlight={s.facts.criticalSecurityFindings > 0 ? 'red' : ''} />
              <FactRow label="Governance blocks (7d)" value={s.facts.governanceBlocks7d} />
              <FactRow label="Patches blocked (7d)" value={s.facts.patchesBlocked7d} />
              {s.predictions.securityRiskGrowing && (
                <PredictionFooter f={s.predictions.securityRiskGrowing} />
              )}
            </div>
          ) : <EmptyRow text="Loading…" />}
        </BriefingPanel>

        {/* Cost */}
        <BriefingPanel title="Cost" icon={<DollarSign className="w-4 h-4 text-amber-400" />}>
          {c ? (
            <div className="px-5 py-3 space-y-2 text-sm">
              {c.facts.dailyBudget && (
                <FactRow label="Daily budget"
                  value={`$${c.facts.dailyBudget.spentUsd.toFixed(2)} / $${c.facts.dailyBudget.limitUsd.toFixed(2)} (${Math.round(c.facts.dailyBudget.pctUsed*100)}%)`}
                  highlight={c.facts.dailyBudget.pctUsed >= 0.8 ? 'amber' : ''}
                />
              )}
              {c.facts.monthlyBudget && (
                <FactRow label="Monthly budget"
                  value={`$${c.facts.monthlyBudget.spentUsd.toFixed(2)} / $${c.facts.monthlyBudget.limitUsd.toFixed(2)} (${Math.round(c.facts.monthlyBudget.pctUsed*100)}%)`}
                  highlight={c.facts.monthlyBudget.pctUsed >= 0.8 ? 'amber' : ''}
                />
              )}
              <FactRow label="Image spend 24h" value={`$${c.facts.imageSpend24h.spendUsd.toFixed(4)} (${c.facts.imageSpend24h.count})`} />
              <FactRow label="Image spend 7d"  value={`$${c.facts.imageSpend7d.spendUsd.toFixed(4)} (${c.facts.imageSpend7d.count})`} />
              {c.predictions.budgetOverrun && (
                <PredictionFooter f={c.predictions.budgetOverrun} />
              )}
            </div>
          ) : <EmptyRow text="Loading…" />}
        </BriefingPanel>

        {/* Mission progress */}
        <BriefingPanel title="Mission Progress" icon={<Target className="w-4 h-4 text-sky-400" />}>
          {m ? (
            <div className="px-5 py-3 space-y-2 text-sm">
              <FactRow label="Active" value={m.facts.counts.active} />
              <FactRow label="Completed" value={m.facts.counts.completed} />
              <FactRow label="Paused" value={m.facts.counts.paused} highlight={m.facts.counts.paused > 0 ? 'amber' : ''} />
              <FactRow label="At-risk missions" value={m.facts.atRisk.length} highlight={m.facts.atRisk.length > 0 ? 'red' : ''} />
              <FactRow label="Unresolved risks" value={m.facts.unresolvedRisks.length} highlight={m.facts.unresolvedRisks.length > 0 ? 'amber' : ''} />
            </div>
          ) : <EmptyRow text="Loading…" />}
        </BriefingPanel>
      </div>

      {/* Lower-priority forecasts */}
      {otherForecasts.length > 0 && (
        <Section title="Lower-Priority Forecasts" icon={<TrendingUp className="w-4 h-4" />} predictionBadge>
          <ul className="divide-y divide-[var(--border)]">
            {otherForecasts.map(f => <ForecastRow key={f.type} f={f} />)}
          </ul>
        </Section>
      )}
    </div>
  )
}

function ForecastCount({ label, value, color }: { label: string; value: number; color: 'red' | 'amber' | 'sky' | 'emerald' | 'slate' }) {
  const map = {
    red:     'border-red-500/40 bg-red-500/5 text-red-300',
    amber:   'border-amber-500/40 bg-amber-500/5 text-amber-300',
    sky:     'border-sky-500/40 bg-sky-500/5 text-sky-300',
    emerald: 'border-emerald-500/40 bg-emerald-500/5 text-emerald-300',
    slate:   'border-slate-500/30 bg-slate-500/5 text-slate-400',
  } as const
  return (
    <div className={`rounded-lg border ${map[color]} px-4 py-3`}>
      <div className="text-[10px] uppercase tracking-wider opacity-80">{label}</div>
      <div className="text-2xl font-mono mt-1">{value}</div>
    </div>
  )
}

function ForecastRow({ f }: { f: ForecastDTO }) {
  return (
    <li className="px-5 py-3 flex items-start gap-3">
      <span className={`text-xs font-mono px-2 py-1 rounded border ${likelihoodColor(f.likelihood)}`}>
        {f.likelihood}
      </span>
      <div className="flex-1">
        <div className="text-sm font-medium text-[var(--text)]">{forecastLabel(f.type)}</div>
        <div className="text-xs text-[var(--text-muted)] mt-0.5 font-mono">
          confidence (r²): {f.confidence.toFixed(2)}  ·  horizon: {f.horizonWeeks}w
        </div>
        <div className="text-xs text-[var(--text-muted)] mt-1">{f.evidence}</div>
      </div>
    </li>
  )
}

function TradeoffRow({ t }: { t: TradeoffDTO }) {
  return (
    <li className="px-5 py-4">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <div className="text-sm font-medium text-[var(--text)]">{t.recommendation.title}</div>
          <div className="text-xs text-[var(--text-muted)] mt-1">
            {t.recommendation.kind.replace(/_/g, ' ')}  ·  bucket: {t.recommendation.decision.bucket}  ·  net: {t.netScore.toFixed(2)}
          </div>
        </div>
        <span className={`text-[10px] font-mono px-2 py-0.5 rounded ${
          t.operationalImpact === 'critical' ? 'bg-red-500/20 text-red-300' :
          t.operationalImpact === 'high'     ? 'bg-amber-500/20 text-amber-300' :
                                                'bg-slate-500/20 text-slate-300'
        }`}>impact: {t.operationalImpact}</span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <TradeoffMetric label="benefit"     m={t.expectedBenefit} good />
        <TradeoffMetric label="risk"        m={t.expectedRisk} />
        <TradeoffMetric label="cost"        m={t.estimatedCost} />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
        <TradeoffMetric label="complexity"  m={t.implementationComplexity} />
        <TradeoffMetric label="rollback"    m={t.rollbackDifficulty} />
      </div>
    </li>
  )
}

function TradeoffMetric({ label, m, good }: { label: string; m: TradeoffDTO['expectedBenefit']; good?: boolean }) {
  return (
    <div className="border border-[var(--border)] rounded px-2 py-1">
      <div className="flex items-center justify-between">
        <span className="text-[var(--text-muted)] uppercase tracking-wider text-[10px]">{label}</span>
        <span className={`font-mono text-sm ${good ? 'text-emerald-400' : 'text-[var(--text)]'}`}>
          {m.value} {m.unit === 'usd' ? 'USD' : m.unit === 'hours' ? 'h' : ''}
        </span>
      </div>
      <div className="text-[10px] text-[var(--text-muted)] mt-0.5 truncate" title={m.derivedFrom}>
        {m.provenance.replace(/_/g, ' ')}
      </div>
    </div>
  )
}

function FactRow({ label, value, highlight }: { label: string; value: number | string; highlight?: '' | 'amber' | 'red' }) {
  const cls = highlight === 'red'   ? 'text-red-400' :
              highlight === 'amber' ? 'text-amber-400' :
                                      'text-[var(--text)]'
  return (
    <div className="flex justify-between">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span className={`font-mono text-sm ${cls}`}>{value}</span>
    </div>
  )
}

function PredictionFooter({ f }: { f: ForecastDTO }) {
  return (
    <div className="mt-2 pt-2 border-t border-[var(--border)] text-xs">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-purple-400 font-mono">prediction</span>
        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${likelihoodColor(f.likelihood)}`}>
          {f.likelihood}
        </span>
      </div>
      <div className="text-[var(--text-muted)] mt-1">{f.evidence}</div>
    </div>
  )
}

function Section({ title, icon, children, predictionBadge }: { title: string; icon?: JSX.Element; children: JSX.Element | JSX.Element[]; predictionBadge?: boolean }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <div className="px-5 py-3 border-b border-[var(--border)] flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-medium text-[var(--text)]">{title}</h3>
        {predictionBadge && (
          <span className="ml-auto text-[10px] uppercase tracking-wider text-purple-400 font-mono">prediction</span>
        )}
      </div>
      {children}
    </div>
  )
}

function BriefingPanel({ title, icon, children }: { title: string; icon: JSX.Element; children: JSX.Element | JSX.Element[] }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <div className="px-5 py-3 border-b border-[var(--border)] flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-medium text-[var(--text)]">{title}</h3>
        <span className="ml-auto text-[10px] uppercase tracking-wider text-emerald-400 font-mono">facts</span>
      </div>
      {children}
    </div>
  )
}

function EmptyRow({ text }: { text: string }) {
  return <div className="px-5 py-6 text-[var(--text-muted)] text-sm">{text}</div>
}
