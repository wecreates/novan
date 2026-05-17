/**
 * Mission Intelligence — long-term operational continuity view.
 *
 * Consumes:
 *   /intelligence/continuity      (previous incidents/fixes/failures, lessons)
 *   /intelligence/trends          (8-week buckets across 6 dimensions)
 *   /intelligence/memory/ranked   (decay-aware memory)
 *   /intelligence/priorities/heatmap
 */
import { useQuery } from '@tanstack/react-query'
import {
  Brain, TrendingUp, TrendingDown, Minus, AlertTriangle, Target, Activity, Shield, Clock,
} from 'lucide-react'
import { intelligenceApi, type TrendSeriesDTO } from '../api.js'

const WORKSPACE = 'default'

function trendIcon(d: TrendSeriesDTO['direction']) {
  if (d === 'improving') return <TrendingDown className="w-4 h-4 text-emerald-400" />
  if (d === 'degrading') return <TrendingUp className="w-4 h-4 text-red-400" />
  if (d === 'flat')      return <Minus className="w-4 h-4 text-[var(--text-muted)]" />
  return <Minus className="w-4 h-4 text-[var(--text-muted)] opacity-40" />
}

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(1, ...values)
  return (
    <div className="flex items-end gap-0.5 h-8">
      {values.map((v, i) => (
        <div key={i}
          className={`w-1.5 rounded-sm ${v === 0 ? 'bg-[var(--border)]' : 'bg-sky-500/60'}`}
          style={{ height: `${Math.max(2, (v / max) * 32)}px` }}
          title={String(v)}
        />
      ))}
    </div>
  )
}

function fmtDays(d: number): string {
  if (d < 1)   return 'today'
  if (d < 7)   return `${Math.round(d)}d ago`
  if (d < 30)  return `${Math.round(d / 7)}w ago`
  if (d < 365) return `${Math.round(d / 30)}mo ago`
  return `${Math.round(d / 365)}y ago`
}

export default function MissionIntelligencePage() {
  const continuity = useQuery({
    queryKey: ['continuity', WORKSPACE],
    queryFn:  () => intelligenceApi.continuity(WORKSPACE),
    refetchInterval: 120_000,
  })
  const trends = useQuery({
    queryKey: ['trends', WORKSPACE],
    queryFn:  () => intelligenceApi.trends(WORKSPACE),
    refetchInterval: 5 * 60_000,
  })
  const memory = useQuery({
    queryKey: ['ranked-memory', WORKSPACE],
    queryFn:  () => intelligenceApi.rankedMemory(WORKSPACE, 15),
    refetchInterval: 5 * 60_000,
  })
  const heatmap = useQuery({
    queryKey: ['priority-heatmap', WORKSPACE],
    queryFn:  () => intelligenceApi.priorityHeatmap(WORKSPACE),
    refetchInterval: 5 * 60_000,
  })

  const isLoading = continuity.isLoading || trends.isLoading
  if (isLoading) return <div className="p-8 text-[var(--text-muted)]">Loading…</div>
  const c = continuity.data?.data
  const t = trends.data?.data
  const m = memory.data?.data ?? []
  const h = heatmap.data?.data

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
      <div className="flex items-center gap-3">
        <Brain className="w-6 h-6 text-sky-400" />
        <div>
          <h1 className="text-xl font-medium text-[var(--text)]">Mission Intelligence</h1>
          <p className="text-xs text-[var(--text-muted)]">Long-term continuity, trends, and lessons learned</p>
        </div>
      </div>

      {/* Trends grid */}
      {t && (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <TrendCard title="Reliability" series={t.reliability} valueKey="failureRate" badgeFormat={v => `${(v*100).toFixed(1)}%`} />
          <TrendCard title="Incidents"   series={t.incident}    valueKey="count" />
          <TrendCard title="Deployment failures" series={t.deployment} valueKey="failed" />
          <TrendCard title="Provider latency" series={t.providerQuality} valueKey="avgLatencyMs" badgeFormat={v => `${v} ms`} />
          <TrendCard title="Cost (image-gen)"  series={t.cost} valueKey="spendUsd" badgeFormat={v => `$${v.toFixed(2)}`} />
          <TrendCard title="Productivity" series={t.productivity} valueKey="patchesApplied" higherIsBetter />
        </div>
      )}

      {/* Priority heatmap */}
      {h && (
        <Section title="Strategic Priorities" icon={<Target className="w-4 h-4" />}>
          {h.dominant.length === 0 ? (
            <EmptyRow text="No priority categories with active goals. Tag missions with deployment_objective / reliability_target / cost_target / security_priority / etc. to bias recommendations." />
          ) : (
            <div className="px-5 py-3 grid grid-cols-2 lg:grid-cols-4 gap-3">
              {h.categories.map(cat => {
                const stat = h.heatmap[cat]
                const isDominant = h.dominant.includes(cat)
                if (!stat || stat.total === 0) return null
                return (
                  <div key={cat} className={`rounded border px-3 py-2 ${isDominant ? 'border-sky-500/40 bg-sky-500/5' : 'border-[var(--border)] bg-[var(--bg-elevated)]'}`}>
                    <div className="text-xs uppercase tracking-wider text-[var(--text-muted)]">{cat.replace(/_/g, ' ')}</div>
                    <div className="text-sm mt-1 font-mono">
                      {stat.active} active · {stat.completed} done
                    </div>
                    <div className="text-xs text-[var(--text-muted)] mt-0.5">{Math.round(stat.avgProgress * 100)}% avg progress</div>
                  </div>
                )
              })}
            </div>
          )}
        </Section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Unresolved risks */}
        <Section title="Unresolved Risks" icon={<AlertTriangle className="w-4 h-4 text-amber-400" />}>
          {!c || c.unresolvedRisks.length === 0
            ? <EmptyRow text="No unresolved risks tracked." />
            : <ul className="divide-y divide-[var(--border)]">
                {c.unresolvedRisks.map(r => (
                  <li key={r.id} className="px-5 py-2.5 flex items-center gap-3 text-sm">
                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                      r.severity === 'critical' ? 'bg-red-500/20 text-red-300' :
                      r.severity === 'high'     ? 'bg-amber-500/20 text-amber-300' :
                                                  'bg-slate-500/20 text-slate-300'
                    }`}>{r.severity}</span>
                    <span className="flex-1 truncate text-[var(--text)]">{r.title}</span>
                    <span className="text-xs text-[var(--text-muted)] font-mono">{fmtDays(r.ageDays)}</span>
                  </li>
                ))}
              </ul>
          }
        </Section>

        {/* Recurring bottlenecks */}
        <Section title="Recurring Bottlenecks" icon={<Activity className="w-4 h-4" />}>
          {!c || c.recurringBottlenecks.length === 0
            ? <EmptyRow text="No recurring failure patterns yet (≥3 occurrences needed)." />
            : <ul className="divide-y divide-[var(--border)]">
                {c.recurringBottlenecks.map((b, i) => (
                  <li key={i} className="px-5 py-2 flex items-center gap-3 text-sm">
                    <span className="text-xs font-mono text-amber-400">{b.occurrences}×</span>
                    <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{b.type}</span>
                    <span className="flex-1 truncate text-[var(--text)] font-mono text-xs">{b.signature}</span>
                  </li>
                ))}
              </ul>
          }
        </Section>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Lessons learned */}
        <Section title="Lessons Learned" icon={<Shield className="w-4 h-4 text-emerald-400" />}>
          {!c || c.lessonsLearned.length === 0
            ? <EmptyRow text="No proven fixes recorded yet. As patches succeed, lessons accumulate here." />
            : <ul className="divide-y divide-[var(--border)]">
                {c.lessonsLearned.map((l, i) => (
                  <li key={i} className="px-5 py-3 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-emerald-400">{l.provenAppliedCount}× applied</span>
                    </div>
                    <div className="text-[var(--text)] mt-1">{l.fix}</div>
                    <div className="text-xs text-[var(--text-muted)] mt-1 font-mono truncate">pattern: {l.pattern}</div>
                  </li>
                ))}
              </ul>
          }
        </Section>

        {/* Ranked memory */}
        <Section title="Strategic Memory (decay-ranked)" icon={<Brain className="w-4 h-4" />}>
          {m.length === 0
            ? <EmptyRow text="No memory items above the relevance threshold." />
            : <ul className="divide-y divide-[var(--border)]">
                {m.slice(0, 10).map(item => (
                  <li key={item.id} className="px-5 py-2.5 text-sm">
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                        item.kind === 'successful_fix' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'
                      }`}>{item.kind.replace('_', ' ')}</span>
                      <span className="text-xs text-[var(--text-muted)] font-mono">score {item.relevanceScore.toFixed(2)}</span>
                      <span className="text-xs text-[var(--text-muted)] ml-auto">decay {item.decayWeight.toFixed(2)} · {fmtDays(item.ageDays)}</span>
                    </div>
                    <div className="text-[var(--text)] mt-1 text-xs truncate">{item.text}</div>
                  </li>
                ))}
              </ul>
          }
        </Section>
      </div>

      {/* Operator decisions */}
      {c && (
        <Section title="Operator Decision History" icon={<Clock className="w-4 h-4" />}>
          <div className="px-5 py-3 grid grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
            <div>
              <div className="text-xs text-[var(--text-muted)]">Approvals approved</div>
              <div className="text-lg font-mono text-emerald-400">{c.operatorDecisions.patchApprovals.approved}</div>
            </div>
            <div>
              <div className="text-xs text-[var(--text-muted)]">Approvals rejected</div>
              <div className="text-lg font-mono text-amber-400">{c.operatorDecisions.patchApprovals.rejected}</div>
            </div>
            <div>
              <div className="text-xs text-[var(--text-muted)]">Pending</div>
              <div className="text-lg font-mono">{c.operatorDecisions.patchApprovals.pending}</div>
            </div>
            <div>
              <div className="text-xs text-[var(--text-muted)]">Approval rate</div>
              <div className="text-lg font-mono">
                {c.operatorDecisions.patchApprovals.approvalRate === null
                  ? '—'
                  : `${Math.round(c.operatorDecisions.patchApprovals.approvalRate * 100)}%`}
              </div>
            </div>
          </div>
        </Section>
      )}
    </div>
  )
}

function TrendCard({ title, series, valueKey, badgeFormat, higherIsBetter }: { title: string; series: TrendSeriesDTO; valueKey: string; badgeFormat?: (v: number) => string; higherIsBetter?: boolean }) {
  const values = series.series.map(b => Number(b.metrics[valueKey] ?? 0))
  const last = values[values.length - 1] ?? 0
  const format = badgeFormat ?? (v => String(v))
  // For metrics where "higher is better", invert visual direction
  const visualDir: TrendSeriesDTO['direction'] = higherIsBetter
    ? series.direction === 'improving' ? 'degrading'
    : series.direction === 'degrading' ? 'improving'
    : series.direction
    : series.direction
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-[var(--text-muted)]">{title}</span>
        {trendIcon(visualDir)}
      </div>
      <div className="text-lg font-mono mt-1 text-[var(--text)]">{format(last)}</div>
      <div className="mt-2"><Sparkline values={values} /></div>
      <div className="text-[10px] text-[var(--text-muted)] mt-1 truncate">{series.note}</div>
    </div>
  )
}

function Section({ title, icon, children }: { title: string; icon?: JSX.Element; children: JSX.Element | JSX.Element[] }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <div className="px-5 py-3 border-b border-[var(--border)] flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-medium text-[var(--text)]">{title}</h3>
      </div>
      {children}
    </div>
  )
}

function EmptyRow({ text }: { text: string }) {
  return <div className="px-5 py-6 text-[var(--text-muted)] text-sm">{text}</div>
}
