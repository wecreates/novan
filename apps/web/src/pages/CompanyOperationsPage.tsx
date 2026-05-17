/**
 * Company Operations — 8 divisions + cross-division coordination.
 *
 * Consumes:
 *   /intelligence/divisions
 *   /intelligence/divisions-coordination/blockers
 *   /intelligence/company/mission-status
 *   /intelligence/company/engineering-health
 *   /intelligence/company/operational-efficiency
 *   /intelligence/company/growth-opportunity
 */
import { useQuery } from '@tanstack/react-query'
import {
  Building2, Cpu, ShieldCheck, Activity, Search, Package, TrendingUp, HeartHandshake, Network,
  AlertOctagon, AlertTriangle, CheckCircle2, ArrowRight,
} from 'lucide-react'
import { intelligenceApi, type DivisionSnapshotDTO, type CrossDivisionBlockerDTO } from '../api.js'

const WORKSPACE = 'default'

const DIVISION_META: Record<string, { icon: JSX.Element; description: string }> = {
  engineering:    { icon: <Cpu className="w-4 h-4" />,        description: 'Workflows, patches, audits, tests' },
  security:       { icon: <ShieldCheck className="w-4 h-4" />, description: 'Audit findings, governance, threats' },
  operations:     { icon: <Activity className="w-4 h-4" />,   description: 'Incidents, orchestration, throughput' },
  research:       { icon: <Search className="w-4 h-4" />,     description: 'Topics, findings, feeds, sources' },
  product:        { icon: <Package className="w-4 h-4" />,    description: 'Feedback, UX friction, telemetry' },
  growth:         { icon: <TrendingUp className="w-4 h-4" />, description: 'Adoption, market, competitive intel' },
  support:        { icon: <HeartHandshake className="w-4 h-4" />, description: 'Operator feedback + open issues' },
  infrastructure: { icon: <Network className="w-4 h-4" />,    description: 'Providers, governor, budgets' },
}

function healthColor(h: DivisionSnapshotDTO['health']): string {
  switch (h) {
    case 'thriving':  return 'border-emerald-500/40 bg-emerald-500/5 text-emerald-300'
    case 'healthy':   return 'border-sky-500/40 bg-sky-500/5 text-sky-300'
    case 'attention': return 'border-amber-500/40 bg-amber-500/5 text-amber-300'
    case 'critical':  return 'border-red-500/40 bg-red-500/5 text-red-300'
  }
}

function fmtDays(d: number): string {
  if (d < 1) return 'today'
  if (d < 7) return `${Math.round(d)}d`
  if (d < 30) return `${Math.round(d / 7)}w`
  return `${Math.round(d / 30)}mo`
}

export default function CompanyOperationsPage() {
  const divisions = useQuery({
    queryKey: ['divisions', WORKSPACE],
    queryFn:  () => intelligenceApi.divisions(WORKSPACE),
    refetchInterval: 2 * 60_000,
  })
  const blockers = useQuery({
    queryKey: ['cross-blockers', WORKSPACE],
    queryFn:  () => intelligenceApi.crossDivisionBlockers(WORKSPACE),
    refetchInterval: 2 * 60_000,
  })
  const missionStatus = useQuery({
    queryKey: ['company-mission-status', WORKSPACE],
    queryFn:  () => intelligenceApi.companyMissionStatus(WORKSPACE),
    refetchInterval: 5 * 60_000,
  })
  const eng = useQuery({ queryKey: ['eng-health',  WORKSPACE], queryFn: () => intelligenceApi.engineeringHealth(WORKSPACE), refetchInterval: 5 * 60_000 })
  const ops = useQuery({ queryKey: ['ops-efficiency', WORKSPACE], queryFn: () => intelligenceApi.operationalEfficiency(WORKSPACE), refetchInterval: 5 * 60_000 })
  const growth = useQuery({ queryKey: ['growth-opportunity', WORKSPACE], queryFn: () => intelligenceApi.growthOpportunity(WORKSPACE), refetchInterval: 5 * 60_000 })

  if (divisions.isLoading) return <div className="p-8 text-[var(--text-muted)]">Loading…</div>
  const data = divisions.data?.data
  if (!data) return <div className="p-8 text-red-400">Could not load divisions</div>

  const blockerList   = blockers.data?.data ?? []
  const missionGroups = missionStatus.data?.data ?? []
  const totalMissions = missionGroups.reduce((s, g) => s + g.count, 0)

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
      <div className="flex items-center gap-3">
        <Building2 className="w-6 h-6 text-sky-400" />
        <div>
          <h1 className="text-xl font-medium text-[var(--text)]">Company Operations</h1>
          <p className="text-xs text-[var(--text-muted)]">8 operational divisions over real runtime data</p>
        </div>
      </div>

      {/* Division grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        {data.divisions.map(name => {
          const snap = data.snapshot[name]
          if (!snap) return null
          const meta = DIVISION_META[name]
          return (
            <div key={name} className={`rounded-lg border ${healthColor(snap.health)} px-4 py-3`}>
              <div className="flex items-center gap-2">
                {meta?.icon}
                <div className="text-sm font-medium uppercase tracking-wider">{name}</div>
              </div>
              <div className="text-xs opacity-70 mt-1">{meta?.description}</div>
              <div className="mt-3 grid grid-cols-2 gap-1 text-xs">
                <Metric label="agents"   value={snap.metrics.activeAgents} />
                <Metric label="missions" value={snap.metrics.activeMissions} />
                <Metric label="blockers" value={snap.metrics.openBlockers} highlight={snap.metrics.openBlockers > 0} />
                <Metric label="events 24h" value={snap.metrics.eventsLast24h} />
              </div>
              <div className="mt-2 text-[10px] font-mono uppercase tracking-wider opacity-80">
                {snap.health}
              </div>
            </div>
          )
        })}
      </div>

      {/* Cross-division coordination */}
      <Section title="Cross-Division Blockers" icon={<AlertOctagon className="w-4 h-4 text-amber-400" />}>
        {blockerList.length === 0 ? (
          <EmptyRow text="No cross-division blockers detected." />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {blockerList.map(b => <CrossBlockerRow key={b.blockerId} b={b} />)}
          </ul>
        )}
      </Section>

      {/* Company mission status */}
      <Section title="Company Mission Status" icon={<CheckCircle2 className="w-4 h-4 text-emerald-400" />}>
        {totalMissions === 0 ? (
          <EmptyRow text="No missions defined yet." />
        ) : (
          <div className="px-5 py-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            {missionGroups.map((g, i) => (
              <div key={i} className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2">
                <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                  {g.horizon} · {g.status}
                </div>
                <div className="text-lg font-mono mt-1">{g.count}</div>
                <div className="text-xs text-[var(--text-muted)] mt-0.5">{Math.round(g.avgProgress * 100)}% avg</div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Three reports */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <ReportPanel title="Engineering Health" icon={<Cpu className="w-4 h-4" />}>
          {eng.data ? (
            <div className="px-5 py-3 space-y-2 text-sm">
              <KV k="Workflows (7d)"   v={eng.data.data.facts.workflowsTotal} />
              <KV k="Failure rate 7d"  v={`${(Number(eng.data.data.facts.failureRate7d ?? 0) * 100).toFixed(1)}%`} />
              <KV k="Patches applied"  v={eng.data.data.facts.patchesApplied} />
              <KV k="Rollback rate"    v={`${(Number(eng.data.data.facts.rollbackRate7d ?? 0) * 100).toFixed(1)}%`} />
              <KV k="Open code audits" v={eng.data.data.facts.openCodeAuditFindings} highlight={(eng.data.data.facts.openCodeAuditFindings ?? 0) >= 50} />
              <KV k="Open incidents"   v={eng.data.data.facts.openIncidents} highlight={(eng.data.data.facts.openIncidents ?? 0) > 0} />
            </div>
          ) : <EmptyRow text="Loading…" />}
        </ReportPanel>

        <ReportPanel title="Operational Efficiency" icon={<Activity className="w-4 h-4" />}>
          {ops.data ? (
            <div className="px-5 py-3 space-y-2 text-sm">
              <KV k="Incidents 7d"     v={ops.data.data.facts.incidentsTotal} />
              <KV k="Resolved 7d"      v={ops.data.data.facts.incidentsResolved ?? 0} />
              <KV k="Critical 7d"      v={ops.data.data.facts.incidentsCritical ?? 0} highlight={(ops.data.data.facts.incidentsCritical ?? 0) > 0} />
              <KV k="Resolution rate"  v={ops.data.data.facts.resolutionRate === null ? '—' : `${(Number(ops.data.data.facts.resolutionRate) * 100).toFixed(1)}%`} />
              <KV k="Gov blocks 7d"    v={ops.data.data.facts.governanceBlocks ?? 0} />
              <KV k="Auto-throttles"   v={ops.data.data.facts.autoThrottles ?? 0} />
              <KV k="Running agents"   v={ops.data.data.facts.runningAgents ?? 0} />
            </div>
          ) : <EmptyRow text="Loading…" />}
        </ReportPanel>

        <ReportPanel title="Growth Opportunity" icon={<TrendingUp className="w-4 h-4" />}>
          {growth.data ? (
            <div className="px-5 py-3 space-y-2 text-sm">
              <KV k="High-conf findings 7d" v={growth.data.data.facts.highConfidenceResearchFindings} />
              <KV k="Feature-use events 7d" v={growth.data.data.facts.featureUseEvents7d} />
              <KV k="Distinct features 7d"  v={growth.data.data.facts.distinctFeaturesUsed7d} />
              {growth.data.data.facts.growthKeywordFindings.length > 0 && (
                <div className="pt-2 border-t border-[var(--border)]">
                  <div className="text-xs text-[var(--text-muted)] mb-1">Recent growth signals</div>
                  {growth.data.data.facts.growthKeywordFindings.slice(0, 3).map((f, i) => (
                    <div key={i} className="text-xs text-[var(--text)] truncate" title={f.summary}>
                      • {f.summary.slice(0, 60)} (conf {f.confidence.toFixed(2)})
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : <EmptyRow text="Loading…" />}
        </ReportPanel>
      </div>
    </div>
  )
}

function Metric({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div>
      <div className="text-[var(--text-muted)] text-[10px] uppercase tracking-wider">{label}</div>
      <div className={`font-mono ${highlight ? 'text-amber-400' : 'text-[var(--text)]'}`}>{value}</div>
    </div>
  )
}

function CrossBlockerRow({ b }: { b: CrossDivisionBlockerDTO }) {
  return (
    <li className="px-5 py-3 flex items-center gap-3 text-sm">
      <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
        b.severity === 'critical' ? 'bg-red-500/20 text-red-300' :
        b.severity === 'high'     ? 'bg-amber-500/20 text-amber-300' :
                                    'bg-slate-500/20 text-slate-300'
      }`}>{b.severity}</span>
      <span className="text-xs uppercase tracking-wider text-sky-400 font-mono">{b.from}</span>
      <ArrowRight className="w-3 h-3 text-[var(--text-muted)]" />
      <span className="text-xs uppercase tracking-wider text-[var(--text-muted)] font-mono">{b.to.join(', ')}</span>
      <span className="flex-1 text-[var(--text)] truncate">{b.title}</span>
      <span className="text-xs text-[var(--text-muted)] font-mono">{fmtDays(b.ageDays)}</span>
    </li>
  )
}

function KV({ k, v, highlight }: { k: string; v: number | string | null | undefined; highlight?: boolean }) {
  const display = v === null || v === undefined ? '—' : v
  return (
    <div className="flex justify-between">
      <span className="text-[var(--text-muted)]">{k}</span>
      <span className={`font-mono text-sm ${highlight ? 'text-amber-400' : 'text-[var(--text)]'}`}>{display}</span>
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

function ReportPanel({ title, icon, children }: { title: string; icon: JSX.Element; children: JSX.Element | JSX.Element[] }) {
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
