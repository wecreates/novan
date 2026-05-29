/**
 * BlueprintPage — operator UI for the round 116-119 features.
 *
 * One page, six tabs:
 *   Cartographer       — codebase map snapshot
 *   Knowledge          — curator-proposed patterns + approval queue
 *   Evals              — eval sets + recent runs (read-only roll-up)
 *   Policy             — operator-editable governance rules
 *   Simulation         — paste a JSON plan, dry-run, see verdicts
 *   Holding-Co         — portfolio strategy + capital allocation
 *
 * Each tab is a small focused component below. The page is intentionally
 * read-mostly — mutations (approve / save rule / run sim) are explicit
 * button clicks with confirmation. No background polling that could
 * surprise the operator.
 */
import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api.js'
import { Map, BookCheck, Beaker, Shield, FlaskConical, Building2, TrendingUp, Network, Activity, Zap, ShoppingBag, ScrollText, LayoutDashboard } from 'lucide-react'

type Tab = 'architecture' | 'cartographer' | 'knowledge' | 'evals' | 'policy' | 'sim' | 'holding' | 'maturity' | 'coordination' | 'health' | 'shortform' | 'acquisition' | 'compliance'

const TABS: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
  { id: 'architecture', label: 'Overview',      icon: <LayoutDashboard className="w-4 h-4" /> },
  { id: 'maturity',     label: 'Maturity',      icon: <TrendingUp className="w-4 h-4" /> },
  { id: 'health',       label: 'Health',        icon: <Activity className="w-4 h-4" /> },
  { id: 'cartographer', label: 'Cartographer',  icon: <Map className="w-4 h-4" /> },
  { id: 'knowledge',    label: 'Knowledge',     icon: <BookCheck className="w-4 h-4" /> },
  { id: 'evals',        label: 'Evals',         icon: <Beaker className="w-4 h-4" /> },
  { id: 'policy',       label: 'Policy',        icon: <Shield className="w-4 h-4" /> },
  { id: 'sim',          label: 'Simulation',    icon: <FlaskConical className="w-4 h-4" /> },
  { id: 'coordination', label: 'Coordination',  icon: <Network className="w-4 h-4" /> },
  { id: 'shortform',    label: 'Short-form',    icon: <Zap className="w-4 h-4" /> },
  { id: 'acquisition',  label: 'Acquisition',   icon: <ShoppingBag className="w-4 h-4" /> },
  { id: 'compliance',   label: 'Compliance',    icon: <ScrollText className="w-4 h-4" /> },
  { id: 'holding',      label: 'Holding-Co',    icon: <Building2 className="w-4 h-4" /> },
]

export default function BlueprintPage(): React.ReactElement {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab') as Tab | null
  const [tab, setTab] = useState<Tab>(tabParam ?? 'architecture')
  const workspaceId = searchParams.get('workspace_id') ?? 'default'

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-zinc-100">Blueprint</h1>
        <p className="text-sm text-zinc-400 mt-1">Cartographer · Knowledge · Evals · Policy · Simulation · Holding-Co</p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-zinc-800 mb-6 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => { setTab(t.id); setSearchParams({ tab: t.id, workspace_id: workspaceId }) }}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
              tab === t.id
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {tab === 'architecture' && <ArchitectureTab workspaceId={workspaceId} onTabSelect={(t) => { setTab(t as Tab); setSearchParams({ tab: t, workspace_id: workspaceId }) }} />}
      {tab === 'maturity'     && <MaturityTab     workspaceId={workspaceId} />}
      {tab === 'health'       && <HealthTab       workspaceId={workspaceId} />}
      {tab === 'cartographer' && <CartographerTab />}
      {tab === 'knowledge'    && <KnowledgeTab    workspaceId={workspaceId} />}
      {tab === 'evals'        && <EvalsTab        workspaceId={workspaceId} />}
      {tab === 'policy'       && <PolicyTab       workspaceId={workspaceId} />}
      {tab === 'sim'          && <SimulationTab   workspaceId={workspaceId} />}
      {tab === 'coordination' && <CoordinationTab workspaceId={workspaceId} />}
      {tab === 'shortform'    && <ShortformTab />}
      {tab === 'acquisition'  && <AcquisitionTab />}
      {tab === 'compliance'   && <ComplianceTab />}
      {tab === 'holding'      && <HoldingCoTab    workspaceId={workspaceId} />}
    </div>
  )
}

// ── Architecture overview tab — one-screen system snapshot ─────────
function ArchitectureTab({ workspaceId, onTabSelect }: { workspaceId: string; onTabSelect: (t: string) => void }): React.ReactElement {
  const ov = useQuery({
    queryKey: ['overview', workspaceId],
    queryFn:  () => api.get<{ success: true; data: ArchitectureOverview }>(`/api/v1/blueprint/architecture/overview?workspace_id=${workspaceId}`).then(r => r.data),
    refetchInterval: 30_000,
  })
  if (ov.isLoading) return <div className="text-zinc-400">Snapshotting architecture…</div>
  const d = ov.data
  if (!d) return <div className="text-zinc-400">No overview available.</div>

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-4">
        <Card title="Stage">
          <div className="text-4xl font-bold text-blue-400">{d.maturityStage}</div>
          <div className="text-xs text-zinc-500 mt-1">SPEC §4 build sequence</div>
        </Card>
        <Card title="Self-Improvement">
          <div className={`text-lg font-medium ${d.healthVerdict === 'healthy' ? 'text-green-400' : d.healthVerdict === 'investigate' ? 'text-amber-400' : 'text-red-400'}`}>
            {d.healthVerdict === 'pause_self_improvement' ? '⛔ paused' : d.healthVerdict === 'investigate' ? '⚠ investigate' : '✓ healthy'}
          </div>
          <div className="text-xs text-zinc-500 mt-1">5-detector verdict from §10.4</div>
        </Card>
        <Card title="Recent Alerts (24h)">
          <div className={`text-4xl font-bold ${d.recentAlerts.length === 0 ? 'text-green-400' : d.recentAlerts.length < 3 ? 'text-amber-400' : 'text-red-400'}`}>{d.recentAlerts.length}</div>
          <div className="text-xs text-zinc-500 mt-1">governance / loop / cron-error events</div>
        </Card>
      </div>

      <Card title="Tabs (click to navigate)">
        <div className="grid grid-cols-4 gap-2">
          {d.tabs.map(t => (
            <button key={t.id} onClick={() => onTabSelect(t.id)}
              className={`text-left p-3 rounded border transition-colors ${
                t.status === 'ok' ? 'border-green-700 hover:border-green-500' :
                t.status === 'partial' ? 'border-amber-700 hover:border-amber-500' :
                t.status === 'alert' ? 'border-red-700 hover:border-red-500' :
                'border-zinc-700 hover:border-zinc-500'
              }`}>
              <div className="flex justify-between items-center">
                <span className="text-zinc-200 text-sm">{t.label}</span>
                <span className={`text-xs ${t.status === 'ok' ? 'text-green-400' : t.status === 'partial' ? 'text-amber-400' : t.status === 'alert' ? 'text-red-400' : 'text-zinc-500'}`}>
                  {t.status === 'ok' ? '✓' : t.status === 'partial' ? '⚠' : t.status === 'alert' ? '⛔' : '○'}
                </span>
              </div>
            </button>
          ))}
        </div>
      </Card>

      <Card title={`Cron tasks (last 24h) — ${d.crons.length} active`}>
        {d.crons.length === 0
          ? <div className="text-sm text-zinc-500">No cron activity in the last 24h. Either cron is paused or the workspace has no events to drive.</div>
          : <table className="w-full text-sm">
              <thead className="text-zinc-400 text-xs border-b border-zinc-800">
                <tr><th className="text-left py-2">Task</th><th className="text-right">Last fired</th><th className="text-right">Count 24h</th></tr>
              </thead>
              <tbody>
                {d.crons.slice(0, 20).map(c => (
                  <tr key={c.task} className="border-b border-zinc-900">
                    <td className="py-1 text-zinc-200"><code>{c.task}</code></td>
                    <td className="text-right text-xs text-zinc-500">{new Date(c.lastFired).toLocaleTimeString()}</td>
                    <td className="text-right font-mono text-zinc-400">{c.count24h}</td>
                  </tr>
                ))}
              </tbody>
            </table>
        }
      </Card>

      <Card title={`Connectors — ${d.connectors.filter(c => c.ready).length} of ${d.connectors.length} ready`}>
        <div className="grid grid-cols-3 gap-2 text-sm">
          {d.connectors.map(c => (
            <div key={c.id} className={`p-2 rounded border ${c.ready ? 'border-green-800 bg-green-950/30' : 'border-zinc-800'}`}>
              <div className="flex justify-between">
                <span className="text-zinc-200">{c.name}</span>
                <span className={c.ready ? 'text-green-400' : 'text-zinc-500'}>{c.ready ? '✓' : '○'}</span>
              </div>
              {!c.ready && c.missingEnv.length > 0 && (
                <div className="text-xs text-zinc-500 mt-1">missing: {c.missingEnv.join(', ')}</div>
              )}
            </div>
          ))}
        </div>
      </Card>

      {d.recentAlerts.length > 0 && (
        <Card title="Recent governance / loop / cron-error signals (24h)">
          <ul className="space-y-1 text-sm">
            {d.recentAlerts.map((a, i) => (
              <li key={i} className="flex justify-between">
                <code className="text-amber-300">{a.type}</code>
                <span className="text-xs text-zinc-500">{new Date(a.createdAt).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

// ── Health tab — self-improvement pathology monitor ────────────────
function HealthTab({ workspaceId }: { workspaceId: string }): React.ReactElement {
  const health = useQuery({
    queryKey: ['si', 'health', workspaceId],
    queryFn:  () => api.get<{ success: true; data: HealthVerdict }>(`/api/v1/blueprint/self-improvement/health?workspace_id=${workspaceId}`).then(r => r.data),
  })
  const alerts = useQuery({
    queryKey: ['si', 'alerts', workspaceId],
    queryFn:  () => api.get<{ success: true; data: HealthAlert[] }>(`/api/v1/blueprint/self-improvement/recent-alerts?workspace_id=${workspaceId}&days=7`).then(r => r.data),
  })
  if (health.isLoading) return <div className="text-zinc-400">Running pathology detectors…</div>
  const h = health.data
  if (!h) return <div className="text-zinc-400">No verdict available.</div>

  const verdictColor = h.overallVerdict === 'healthy'    ? 'text-green-400'
                     : h.overallVerdict === 'investigate' ? 'text-amber-400'
                     :                                     'text-red-400'

  return (
    <div className="space-y-6">
      <Card title={`Self-improvement verdict: ${h.overallVerdict.toUpperCase()}`}>
        <div className={`text-lg font-medium mb-4 ${verdictColor}`}>
          {h.overallVerdict === 'healthy'   && '✓ Healthy — autonomous self-modification permitted'}
          {h.overallVerdict === 'investigate' && '⚠ Investigate — one pathology fired; review before allowing further self-mod'}
          {h.overallVerdict === 'pause_self_improvement' && '⛔ Paused — multiple pathologies fired; governance.stability_alert emitted'}
        </div>
        <p className="text-xs text-zinc-500 mb-4">Per SPEC §10.4, 5 pathology detectors run daily across this workspace. Verdict triggers <code>governance.stability_alert</code> events on pause.</p>
        <ul className="space-y-3 text-sm">
          <PathologyRow label="Goodhart drift"          detail={`${h.goodhart.divergences} divergence(s)`} active={h.goodhart.drifted} />
          <PathologyRow label="Capability narrowing"    detail={`OOD failure rate ${(h.capabilityNarrowing.oodFailRate * 100).toFixed(0)}%`} active={h.capabilityNarrowing.narrowing} />
          <PathologyRow label="Coordination drift"      detail={`agent-vs-workflow delta ${(h.coordinationDrift.delta * 100).toFixed(1)}pp`} active={h.coordinationDrift.drifted} />
          <PathologyRow label="Compounding subtle errors" detail={`trend: ${h.compoundingErrors.trend}`} active={h.compoundingErrors.compounding} />
          <PathologyRow label="Reward hacking"          detail={`${h.rewardHacking.suspiciousCount} suspicious agent(s)`} active={h.rewardHacking.suspiciousCount > 0} />
        </ul>
      </Card>

      <Card title={`Recent alerts (last 7d) — ${alerts.data?.length ?? 0}`}>
        {alerts.data?.length === 0
          ? <div className="text-sm text-zinc-500">No alerts in the last 7 days — self-improvement loop running cleanly.</div>
          : <ul className="space-y-2 text-sm">
              {alerts.data?.slice(0, 30).map((a, i) => (
                <li key={i} className="border-l-2 border-amber-500 pl-3">
                  <div className="flex justify-between">
                    <code className="text-zinc-200">{a.type}</code>
                    <span className="text-xs text-zinc-500">{new Date(a.createdAt).toLocaleString()}</span>
                  </div>
                  <pre className="text-xs text-zinc-400 mt-1 whitespace-pre-wrap">{JSON.stringify(a.payload, null, 2).slice(0, 400)}</pre>
                </li>
              ))}
            </ul>
        }
      </Card>
    </div>
  )
}
function PathologyRow({ label, detail, active }: { label: string; detail: string; active: boolean }): React.ReactElement {
  return (
    <li className="flex items-center gap-3">
      <span className={active ? 'text-red-400' : 'text-green-400'}>{active ? '⚠' : '✓'}</span>
      <div className="flex-1">
        <div className={active ? 'text-zinc-200' : 'text-zinc-300'}>{label}</div>
        <div className="text-xs text-zinc-500">{detail}</div>
      </div>
    </li>
  )
}

// ── Short-form tab — hook patterns + platform guidance ─────────────
function ShortformTab(): React.ReactElement {
  const [platform, setPlatform] = useState<string>('tiktok')
  const hooks = useQuery({
    queryKey: ['sf', 'hooks'],
    queryFn:  () => api.get<{ success: true; data: HookPattern[] }>(`/api/v1/blueprint/shortform/hook-patterns`).then(r => r.data),
  })
  const guidance = useQuery({
    queryKey: ['sf', 'guidance', platform],
    queryFn:  () => api.get<{ success: true; data: PlatformGuidance }>(`/api/v1/blueprint/shortform/platform-guidance?platform=${platform}`).then(r => r.data),
  })
  return (
    <div className="space-y-6">
      <Card title="Platform native-aesthetic guidance">
        <div className="flex gap-2 mb-3">
          {['tiktok', 'youtube_shorts', 'instagram_reels', 'facebook_reels', 'snapchat_spotlight', 'pinterest_idea_pins'].map(p => (
            <button key={p} onClick={() => setPlatform(p)}
              className={`px-3 py-1 text-xs rounded ${platform === p ? 'bg-blue-600 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}>
              {p.replace('_', ' ')}
            </button>
          ))}
        </div>
        {guidance.data && (
          <div className="space-y-2 text-sm">
            <KV k="Framing" v={guidance.data.framing} />
            <KV k="Hook window" v={guidance.data.hookWindow} />
            <KV k="Caption style" v={guidance.data.captionStyle} />
            <KV k="Duration" v={guidance.data.preferredDuration} />
            <KV k="Watermark risks" v={guidance.data.watermarkRisks} />
            {guidance.data.notes.length > 0 && (
              <div>
                <div className="text-xs uppercase text-zinc-500 mt-3 mb-1">Notes</div>
                <ul className="text-sm space-y-1">
                  {guidance.data.notes.map((n, i) => <li key={i} className="text-zinc-300">• {n}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card title={`Hook pattern catalog (${hooks.data?.length ?? 0})`}>
        {hooks.isLoading ? <div className="text-zinc-400">Loading…</div>
          : <ul className="space-y-3 text-sm">
              {hooks.data?.map(h => (
                <li key={h.id} className="border-l-2 border-blue-500 pl-3">
                  <div className="font-medium text-zinc-200">{h.pattern}</div>
                  <div className="text-xs text-zinc-500 mt-1">category: {h.category} · placement {h.placementSeconds[0]}-{h.placementSeconds[1]}s</div>
                  <div className="text-zinc-300 mt-1 italic">"{h.example}"</div>
                  <div className="text-xs text-zinc-500 mt-1">works when: {h.worksWhen}</div>
                </li>
              ))}
            </ul>
        }
      </Card>
    </div>
  )
}

// ── Acquisition tab — due diligence checklist ──────────────────────
function AcquisitionTab(): React.ReactElement {
  const items = useQuery({
    queryKey: ['acq', 'checklist'],
    queryFn:  () => api.get<{ success: true; data: DiligenceItem[] }>(`/api/v1/blueprint/acquisition/diligence-checklist`).then(r => r.data),
  })
  const byCategory = useMemo(() => {
    const m: Record<string, DiligenceItem[]> = {}
    for (const it of items.data ?? []) {
      if (!m[it.category]) m[it.category] = []
      m[it.category]!.push(it)
    }
    return m
  }, [items.data])
  return (
    <Card title={`Due diligence checklist (${items.data?.length ?? 0} items across ${Object.keys(byCategory).length} categories)`}>
      <p className="text-xs text-zinc-500 mb-4">Per SPEC §11.5 + channel-acquisition.ts. Run before any channel purchase. Items marked CRITICAL are deal-breakers.</p>
      {Object.entries(byCategory).map(([cat, list]) => (
        <div key={cat} className="mb-5">
          <div className="text-sm font-medium text-blue-400 mb-2">{cat.replace('_', ' ').toUpperCase()} ({list.length})</div>
          <ul className="space-y-2 text-sm">
            {list.map((it, i) => (
              <li key={i} className="border-l-2 border-zinc-800 pl-3">
                <div className="text-zinc-200">{it.question}</div>
                <div className="text-xs text-red-300 mt-0.5">⚠ {it.redFlag}</div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Card>
  )
}

// ── Compliance tab — viable configurations + cost destroyers ───────
function ComplianceTab(): React.ReactElement {
  const data = useQuery({
    queryKey: ['cmp', 'configs'],
    queryFn:  () => api.get<{ success: true; data: ComplianceData }>(`/api/v1/blueprint/compliance/viable-configurations`).then(r => r.data),
  })
  if (data.isLoading) return <div className="text-zinc-400">Loading…</div>
  const d = data.data
  if (!d) return <div className="text-zinc-400">No data.</div>
  return (
    <div className="space-y-6">
      <Card title="Viable configurations (where the math works)">
        <ul className="space-y-3 text-sm">
          {d.viable.map(c => (
            <li key={c.id} className="border-l-2 border-green-500 pl-3">
              <div className="font-medium text-zinc-200">{c.name}</div>
              <div className="text-xs text-zinc-500 mt-0.5">Break-even: {c.breakEvenPoint}</div>
              <div className="text-zinc-300 mt-1">{c.rationale}</div>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="NOT viable configurations">
        <ul className="space-y-1 text-sm">
          {d.nonViable.map((n, i) => <li key={i} className="text-zinc-400">• {n}</li>)}
        </ul>
      </Card>
      <Card title="Cost destroyers — patterns that destroy projects">
        <ul className="space-y-3 text-sm">
          {d.costDestroyers.map((c, i) => (
            <li key={i} className="border-l-2 border-red-500 pl-3">
              <div className="font-medium text-zinc-200">{c.pattern}</div>
              <div className="text-xs text-red-300 mt-1">Signal: {c.signal}</div>
              <div className="text-xs text-green-300 mt-1">Fix: {c.fix}</div>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Payback accelerators">
        <ul className="space-y-2 text-sm">
          {d.accelerators.map((a, i) => (
            <li key={i} className="border-l-2 border-blue-500 pl-3">
              <div className="text-zinc-200">{a.name}</div>
              <div className="text-xs text-zinc-500">Tradeoff: {a.tradeoff}</div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}

function KV({ k, v }: { k: string; v: string }): React.ReactElement {
  return (
    <div className="flex gap-2">
      <span className="text-xs uppercase text-zinc-500 min-w-[110px]">{k}</span>
      <span className="text-zinc-300 text-sm">{v}</span>
    </div>
  )
}

// ── Maturity tab ────────────────────────────────────────────────────
function MaturityTab({ workspaceId }: { workspaceId: string }): React.ReactElement {
  const assessment = useQuery({
    queryKey: ['maturity', 'assess', workspaceId],
    queryFn:  () => api.get<{ success: true; data: MaturityAssessment }>(`/api/v1/blueprint/maturity/assess?workspace_id=${workspaceId}`).then(r => r.data),
  })
  if (assessment.isLoading) return <div className="text-zinc-400">Assessing maturity…</div>
  const a = assessment.data
  if (!a) return <div className="text-zinc-400">No assessment available.</div>
  return (
    <div>
      <Card title={`Current stage: ${a.currentStage} — ${a.reports[a.currentStage]?.title ?? ''}`}>
        <p className="text-sm text-zinc-300 mb-4">{a.reports[a.currentStage]?.description ?? ''}</p>
        {a.nextActions.length > 0 && (
          <div className="mb-3">
            <div className="text-xs uppercase text-zinc-500 mb-2">Next actions to advance</div>
            <ul className="space-y-1 text-sm">
              {a.nextActions.map((act, i) => <li key={i} className="text-amber-300">• {act}</li>)}
            </ul>
          </div>
        )}
      </Card>
      <div className="mt-6 space-y-4">
        {a.reports.map(r => (
          <Card key={r.stage} title={`Stage ${r.stage} — ${r.title} (${(r.completion * 100).toFixed(0)}% complete)`}>
            <div className="w-full bg-zinc-900 rounded h-1.5 mb-3">
              <div
                className={`h-1.5 rounded ${r.completion >= 0.8 ? 'bg-green-500' : r.completion >= 0.4 ? 'bg-amber-500' : 'bg-zinc-700'}`}
                style={{ width: `${r.completion * 100}%` }}
              />
            </div>
            <p className="text-xs text-zinc-400 mb-3">{r.description}</p>
            <ul className="space-y-1 text-sm">
              {r.signals.map(s => (
                <li key={s.id} className="flex items-start gap-2">
                  <span className={s.present ? 'text-green-400' : 'text-zinc-600'}>{s.present ? '✓' : '◯'}</span>
                  <div className="flex-1">
                    <div className={s.present ? 'text-zinc-200' : 'text-zinc-400'}>{s.label}</div>
                    <div className="text-xs text-zinc-500">{s.evidence}</div>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </div>
  )
}

// ── Coordination tab ────────────────────────────────────────────────
function CoordinationTab({ workspaceId }: { workspaceId: string }): React.ReactElement {
  const [boardKey, setBoardKey] = useState<string>('')
  const escalations = useQuery({
    queryKey: ['coord', 'escalations', workspaceId],
    queryFn:  () => api.get<{ success: true; data: EscalationEvent[] }>(`/api/v1/blueprint/coordination/escalations?workspace_id=${workspaceId}`).then(r => r.data),
  })
  const loops = useQuery({
    queryKey: ['coord', 'loops', workspaceId],
    queryFn:  () => api.get<{ success: true; data: LoopEvent[] }>(`/api/v1/blueprint/coordination/loops?workspace_id=${workspaceId}`).then(r => r.data),
  })
  const blackboard = useQuery({
    queryKey: ['coord', 'blackboard', workspaceId, boardKey],
    queryFn:  () => boardKey
      ? api.get<{ success: true; data: { entries: BoardEntry[]; inconsistencies: Inconsistency[] } }>(`/api/v1/blueprint/coordination/blackboard?workspace_id=${workspaceId}&board_key=${encodeURIComponent(boardKey)}`).then(r => r.data)
      : Promise.resolve({ entries: [] as BoardEntry[], inconsistencies: [] as Inconsistency[] }),
    enabled: boardKey.length > 0,
  })

  return (
    <div className="space-y-6">
      <Card title={`Recent escalations (last 24h) — ${escalations.data?.length ?? 0}`}>
        {escalations.isLoading ? <div className="text-zinc-400">Loading…</div>
          : (escalations.data?.length ?? 0) === 0
            ? <div className="text-sm text-zinc-500">No escalations in the last 24 hours — agents are operating within budget.</div>
            : <ul className="space-y-2 text-sm">
                {escalations.data?.slice(0, 30).map((e, i) => (
                  <li key={i} className="border-l-2 border-amber-500 pl-3">
                    <div className="flex justify-between">
                      <span className="text-zinc-200">{e.fromAgent} → {e.toTier}</span>
                      <span className="text-xs text-zinc-500">{new Date(e.escalatedAt).toLocaleTimeString()}</span>
                    </div>
                    <div className="text-xs text-amber-300">{e.reason}</div>
                  </li>
                ))}
              </ul>
        }
      </Card>

      <Card title={`Detected loops (last 24h) — ${loops.data?.length ?? 0}`}>
        {loops.isLoading ? <div className="text-zinc-400">Loading…</div>
          : (loops.data?.length ?? 0) === 0
            ? <div className="text-sm text-zinc-500">No loop detections — brain-task executor running cleanly.</div>
            : <ul className="space-y-2 text-sm">
                {loops.data?.slice(0, 30).map((l, i) => (
                  <li key={i} className="border-l-2 border-red-500 pl-3">
                    <code className="text-zinc-200">{l.op}</code>
                    <div className="text-xs text-red-300">{l.reason}</div>
                  </li>
                ))}
              </ul>
        }
      </Card>

      <Card title="Blackboard inspector">
        <div className="flex gap-2 mb-3">
          <input
            value={boardKey}
            onChange={e => setBoardKey(e.target.value)}
            placeholder="board key (typically a task or workflow id)"
            className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-1 text-sm text-zinc-200"
          />
        </div>
        {boardKey && blackboard.data && (
          <div>
            {blackboard.data.inconsistencies.length > 0 && (
              <div className="mb-4 p-3 bg-red-900/20 border border-red-800 rounded">
                <div className="text-sm text-red-300 mb-2">⚠ Unflagged inconsistencies detected ({blackboard.data.inconsistencies.length})</div>
                <ul className="space-y-1 text-xs">
                  {blackboard.data.inconsistencies.map((inc, i) => (
                    <li key={i} className="text-red-200">{inc.reason}</li>
                  ))}
                </ul>
              </div>
            )}
            {blackboard.data.entries.length === 0
              ? <div className="text-sm text-zinc-500">No entries on this board yet.</div>
              : <ul className="space-y-2 text-sm">
                  {blackboard.data.entries.map(e => (
                    <li key={e.id} className="border-l-2 border-blue-500 pl-3">
                      <div className="flex justify-between">
                        <span className="text-zinc-300"><code>{e.agentId}</code> · {e.kind}</span>
                        <span className="text-xs text-zinc-500">{(e.confidence * 100).toFixed(0)}%</span>
                      </div>
                      <div className="text-xs text-zinc-300 mt-0.5">{e.content.slice(0, 200)}</div>
                    </li>
                  ))}
                </ul>
            }
          </div>
        )}
      </Card>
    </div>
  )
}

// ── Cartographer tab ────────────────────────────────────────────────
function CartographerTab(): React.ReactElement {
  const qc = useQueryClient()
  const snap = useQuery({
    queryKey: ['cartographer', 'snapshot'],
    queryFn:  () => api.get<{ success: true; data: CartographerSnapshot }>(
      `/api/v1/blueprint/cartographer/snapshot`
    ).then(r => r.data).catch(() => null),
  })
  const refresh = useMutation({
    mutationFn: () => api.post<{ success: true }>('/api/v1/blueprint/cartographer/snapshot', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cartographer'] }),
  })

  if (snap.isLoading) return <div className="text-zinc-400">Loading snapshot…</div>
  const s = snap.data
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm text-zinc-400">
          {s ? `${s.fileCount} files · generated ${new Date(s.generatedAt).toLocaleString()}` : 'No snapshot yet'}
        </div>
        <button
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-700 rounded text-white disabled:opacity-50"
        >
          {refresh.isPending ? 'Scanning…' : 'Re-scan'}
        </button>
      </div>

      {s && (
        <div className="grid grid-cols-2 gap-6">
          <Card title="Files by role">
            <ul className="text-sm space-y-1">
              {Object.entries(s.byRole).map(([role, count]) => (
                <li key={role} className="flex justify-between">
                  <span className="text-zinc-300">{role}</span>
                  <span className="text-zinc-400 font-mono">{count}</span>
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Idioms identified">
            <ul className="text-sm space-y-2">
              {s.idioms.map(i => (
                <li key={i.pattern} className="border-l-2 border-blue-500 pl-3">
                  <div className="font-medium text-zinc-200">{i.pattern}</div>
                  <div className="text-xs text-zinc-400 mt-0.5">{i.description}</div>
                  <code className="text-xs text-zinc-500 mt-1 block">{i.example}</code>
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Hot imports (high blast radius)">
            <ul className="text-sm space-y-1">
              {s.hotImports.slice(0, 10).map(h => (
                <li key={h.file} className="flex justify-between">
                  <code className="text-zinc-300 truncate">{h.file}</code>
                  <span className="text-zinc-400 ml-2 font-mono">{h.importedBy}</span>
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Fragile files (high churn × many importers)">
            {s.fragileFiles.length === 0
              ? <div className="text-sm text-zinc-500">None detected — repo is in steady state.</div>
              : <ul className="text-sm space-y-1">
                  {s.fragileFiles.map(f => <li key={f}><code className="text-amber-300">{f}</code></li>)}
                </ul>
            }
          </Card>
        </div>
      )}
    </div>
  )
}

// ── Knowledge tab ───────────────────────────────────────────────────
function KnowledgeTab({ workspaceId }: { workspaceId: string }): React.ReactElement {
  const qc = useQueryClient()
  const proposals = useQuery({
    queryKey: ['knowledge', 'proposals', workspaceId],
    queryFn:  () => api.get<{ success: true; data: KnowledgePattern[] }>(`/api/v1/blueprint/knowledge/proposals?workspace_id=${workspaceId}`).then(r => r.data),
  })
  const approved = useQuery({
    queryKey: ['knowledge', 'approved', workspaceId],
    queryFn:  () => api.get<{ success: true; data: KnowledgePattern[] }>(`/api/v1/blueprint/knowledge/approved?workspace_id=${workspaceId}`).then(r => r.data),
  })
  const approve = useMutation({
    mutationFn: (p: KnowledgePattern) => api.post('/api/v1/blueprint/knowledge/approve', {
      workspace_id: workspaceId, pattern_id: p.patternId, approved_by: 'operator', pattern_data: p,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['knowledge'] }),
  })
  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => api.post('/api/v1/blueprint/knowledge/reject', {
      workspace_id: workspaceId, pattern_id: id, reason,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['knowledge'] }),
  })

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card title={`Proposed patterns (${proposals.data?.length ?? 0})`}>
        {proposals.isLoading
          ? <div className="text-zinc-400">Loading…</div>
          : proposals.data?.length === 0
            ? <div className="text-sm text-zinc-500">No new patterns to review.</div>
            : <ul className="space-y-3">
                {proposals.data?.map(p => (
                  <li key={p.patternId} className="border border-zinc-800 rounded p-3">
                    <div className="flex justify-between items-start gap-3">
                      <div className="flex-1">
                        <div className="font-medium text-zinc-200">{p.title}</div>
                        <div className="text-xs text-zinc-400 mt-1">source: {p.source} · confidence: {(p.confidence * 100).toFixed(0)}%</div>
                        <p className="text-sm text-zinc-300 mt-2">{p.description}</p>
                      </div>
                    </div>
                    <div className="flex gap-2 mt-3">
                      <button onClick={() => approve.mutate(p)} disabled={approve.isPending}
                        className="px-2 py-1 text-xs bg-green-700 hover:bg-green-600 rounded text-white">Approve</button>
                      <button onClick={() => reject.mutate({ id: p.patternId, reason: 'operator declined' })} disabled={reject.isPending}
                        className="px-2 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 rounded text-zinc-200">Reject</button>
                    </div>
                  </li>
                ))}
              </ul>
        }
      </Card>

      <Card title={`Approved patterns (${approved.data?.length ?? 0})`}>
        {approved.data?.length === 0
          ? <div className="text-sm text-zinc-500">No approved patterns yet.</div>
          : <ul className="space-y-2">
              {approved.data?.map(p => (
                <li key={p.id} className="border-l-2 border-green-600 pl-3">
                  <div className="font-medium text-zinc-200 text-sm">{p.title}</div>
                  <div className="text-xs text-zinc-400 mt-1">{p.description}</div>
                </li>
              ))}
            </ul>
        }
      </Card>
    </div>
  )
}

// ── Evals tab ───────────────────────────────────────────────────────
function EvalsTab({ workspaceId }: { workspaceId: string }): React.ReactElement {
  const sets = useQuery({
    queryKey: ['evals', 'sets', workspaceId],
    queryFn:  () => api.get<{ success: true; data: EvalSet[] }>(`/api/v1/blueprint/evals/sets?workspace_id=${workspaceId}`).then(r => r.data),
  })
  return (
    <Card title={`Eval sets (${sets.data?.length ?? 0})`}>
      {sets.isLoading
        ? <div className="text-zinc-400">Loading…</div>
        : sets.data?.length === 0
          ? <div className="text-sm text-zinc-500">No eval sets yet — create one via the API or brain.task.</div>
          : <table className="w-full text-sm">
              <thead className="text-zinc-400 text-xs border-b border-zinc-800">
                <tr><th className="text-left py-2">Name</th><th className="text-left">Target</th><th className="text-right">Baseline pass rate</th><th className="text-right">Updated</th></tr>
              </thead>
              <tbody>
                {sets.data?.map(s => (
                  <tr key={s.id} className="border-b border-zinc-900">
                    <td className="py-2 text-zinc-200">{s.name}</td>
                    <td className="text-zinc-400">{s.targetSubject}</td>
                    <td className="text-right font-mono text-zinc-300">{(s.baselinePassRate * 100).toFixed(0)}%</td>
                    <td className="text-right text-zinc-500 text-xs">{new Date(s.updatedAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
      }
    </Card>
  )
}

// ── Policy tab ──────────────────────────────────────────────────────
function PolicyTab({ workspaceId }: { workspaceId: string }): React.ReactElement {
  const rules = useQuery({
    queryKey: ['policy', 'rules', workspaceId],
    queryFn:  () => api.get<{ success: true; data: { defaults: DefaultRule[]; overrides: OverrideRule[] } }>(`/api/v1/blueprint/policy/rules?workspace_id=${workspaceId}`).then(r => r.data),
  })
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card title={`Built-in defaults (${rules.data?.defaults.length ?? 0})`}>
        <p className="text-xs text-zinc-500 mb-3">These rules ship with Novan. Operator overrides (right panel) can replace any rule by re-using its id.</p>
        <ul className="space-y-2 text-sm">
          {rules.data?.defaults.map(r => (
            <li key={r.id} className="border-l-2 border-zinc-700 pl-3">
              <div className="font-mono text-xs text-zinc-400">{r.id} · priority {r.priority}</div>
              <div className="text-zinc-200 mt-0.5">{r.description}</div>
            </li>
          ))}
        </ul>
      </Card>

      <Card title={`Operator overrides (${rules.data?.overrides.length ?? 0})`}>
        <p className="text-xs text-zinc-500 mb-3">Add a rule via POST /api/v1/blueprint/policy/rules. Supported kinds: spend_cap, quiet_hours, op_block, op_require_approval, pattern_block.</p>
        {rules.data?.overrides.length === 0
          ? <div className="text-sm text-zinc-500">No operator overrides — defaults govern.</div>
          : <ul className="space-y-2 text-sm">
              {rules.data?.overrides.map(r => (
                <li key={r.id} className={`border-l-2 pl-3 ${r.enabled ? 'border-blue-500' : 'border-zinc-700'}`}>
                  <div className="font-mono text-xs text-zinc-400">{r.id} · {r.kind} · priority {r.priority} {!r.enabled && '· disabled'}</div>
                  <div className="text-zinc-200 mt-0.5">{r.description}</div>
                </li>
              ))}
            </ul>
        }
      </Card>
    </div>
  )
}

// ── Simulation tab ──────────────────────────────────────────────────
function SimulationTab({ workspaceId }: { workspaceId: string }): React.ReactElement {
  const [planText, setPlanText] = useState<string>(`[
  { "op": "portfolio.list",     "params": {}, "risk": "low" },
  { "op": "business.create",    "params": { "brief": "POD test shop" }, "risk": "high" },
  { "op": "agent.dispatch",     "params": { "persona": "trend_hunter", "task": "find a niche" }, "risk": "medium" }
]`)
  const [caller, setCaller] = useState<'operator' | 'agent' | 'cron' | 'mcp'>('agent')
  const [result, setResult] = useState<SimResult | null>(null)
  const [error, setError]   = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const run = async () => {
    setRunning(true); setError(null); setResult(null)
    try {
      const plan = JSON.parse(planText)
      const r = await api.post<{ success: true; data: SimResult }>('/api/v1/blueprint/simulation/dry-run', {
        workspace_id: workspaceId, caller, plan,
      })
      setResult(r.data)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div>
      <Card title="Dry-run a plan">
        <p className="text-xs text-zinc-500 mb-2">Read-only ops execute live; mutating ops are intercepted with projected-effect descriptions. No live mutations occur.</p>
        <div className="flex gap-2 mb-3">
          <label className="text-sm text-zinc-400">Caller:</label>
          <select value={caller} onChange={e => setCaller(e.target.value as never)}
            className="text-sm bg-zinc-900 border border-zinc-700 rounded px-2 py-1">
            <option value="operator">operator</option>
            <option value="agent">agent</option>
            <option value="cron">cron</option>
            <option value="mcp">mcp</option>
          </select>
        </div>
        <textarea
          value={planText} onChange={e => setPlanText(e.target.value)}
          className="w-full h-40 font-mono text-xs bg-zinc-950 border border-zinc-800 rounded p-3 text-zinc-200"
        />
        <button onClick={run} disabled={running}
          className="mt-3 px-3 py-1 text-sm bg-blue-600 hover:bg-blue-700 rounded text-white disabled:opacity-50">
          {running ? 'Running…' : 'Dry-run'}
        </button>
        {error && <div className="mt-3 text-sm text-red-400">{error}</div>}
      </Card>

      {result && (
        <div className="mt-6">
          <Card title="Result">
            <div className="text-sm text-zinc-300 mb-3">{result.summary}</div>
            <ul className="space-y-2">
              {result.ops.map((o, i) => (
                <li key={i} className="border-l-2 border-zinc-700 pl-3">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${classifyColor(o.classification)}`}>{o.classification}</span>
                    <code className="text-zinc-200 text-sm">{o.op}</code>
                  </div>
                  {o.projectedEffect && <div className="text-xs text-zinc-400 mt-1">→ {o.projectedEffect}</div>}
                  {o.reason && <div className="text-xs text-red-400 mt-1">{o.reason}</div>}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </div>
  )
}

function classifyColor(c: string): string {
  if (c === 'read_only_executed')     return 'bg-green-900 text-green-300'
  if (c === 'mutating_intercepted')   return 'bg-amber-900 text-amber-300'
  if (c.startsWith('denied'))          return 'bg-red-900 text-red-300'
  return 'bg-zinc-800 text-zinc-300'
}

// ── Holding-Co tab ──────────────────────────────────────────────────
function HoldingCoTab({ workspaceId }: { workspaceId: string }): React.ReactElement {
  const strategy = useQuery({
    queryKey: ['holding', 'strategy', workspaceId],
    queryFn:  () => api.get<{ success: true; data: PortfolioMove[] }>(`/api/v1/blueprint/holding-co/portfolio-strategy?workspace_id=${workspaceId}`).then(r => r.data),
  })
  const [pool, setPool] = useState<number>(1000)
  const [alloc, setAlloc] = useState<AllocationResult | null>(null)
  const [allocating, setAllocating] = useState(false)

  const runAllocate = async () => {
    setAllocating(true)
    try {
      const r = await api.post<{ success: true; data: AllocationResult }>('/api/v1/blueprint/holding-co/allocate-capital', {
        workspace_id: workspaceId, pool_usd: pool,
      })
      setAlloc(r.data)
    } catch (e) {
      setAlloc(null)
    } finally {
      setAllocating(false)
    }
  }

  const movesByType = useMemo(() => {
    const m: Record<string, PortfolioMove[]> = {}
    for (const move of strategy.data ?? []) {
      if (!m[move.move]) m[move.move] = []
      m[move.move]!.push(move)
    }
    return m
  }, [strategy.data])

  return (
    <div className="space-y-6">
      <Card title="Portfolio strategy">
        {strategy.isLoading
          ? <div className="text-zinc-400">Loading…</div>
          : <div className="space-y-4">
              {Object.entries(movesByType).map(([move, list]) => (
                <div key={move}>
                  <div className={`text-sm font-medium mb-2 ${moveColor(move)}`}>{move.replace('_', ' ').toUpperCase()} ({list.length})</div>
                  <ul className="space-y-1 text-sm">
                    {list.map(b => (
                      <li key={b.businessId} className="border-l-2 border-zinc-800 pl-3">
                        <div className="text-zinc-200">{b.name}</div>
                        <div className="text-xs text-zinc-400">{b.rationale}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
        }
      </Card>

      <Card title="Capital allocator">
        <div className="flex items-center gap-3 mb-3">
          <label className="text-sm text-zinc-400">Pool $:</label>
          <input type="number" value={pool} onChange={e => setPool(Number(e.target.value))}
            className="bg-zinc-900 border border-zinc-700 rounded px-3 py-1 text-sm text-zinc-200 w-32" />
          <button onClick={runAllocate} disabled={allocating}
            className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-700 rounded text-white disabled:opacity-50">
            {allocating ? 'Computing…' : 'Allocate'}
          </button>
        </div>
        {alloc && (
          <div>
            <p className="text-sm text-zinc-300 mb-3">{alloc.rationale}</p>
            <table className="w-full text-sm">
              <thead className="text-zinc-400 text-xs border-b border-zinc-800">
                <tr>
                  <th className="text-left py-2">Business</th>
                  <th className="text-right">Gap $</th>
                  <th className="text-right">Velocity</th>
                  <th className="text-right">Trust</th>
                  <th className="text-right">Proposed $</th>
                </tr>
              </thead>
              <tbody>
                {alloc.allocations.map(a => (
                  <tr key={a.businessId} className="border-b border-zinc-900">
                    <td className="py-2 text-zinc-200">{a.name}</td>
                    <td className="text-right font-mono text-zinc-300">${a.gapUsd.toFixed(0)}</td>
                    <td className="text-right font-mono text-zinc-400">{(a.velocityScore * 100).toFixed(0)}%</td>
                    <td className="text-right font-mono text-zinc-400">{(a.trustScore * 100).toFixed(0)}%</td>
                    <td className="text-right font-mono text-blue-300">${a.proposedAllocationUsd}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

function moveColor(move: string): string {
  if (move === 'double_down')      return 'text-green-400'
  if (move === 'sunset_proposal')  return 'text-red-400'
  if (move === 'pivot')             return 'text-amber-400'
  return 'text-zinc-300'
}

// ── Generic card ────────────────────────────────────────────────────
function Card({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="border border-zinc-800 rounded-lg p-5 bg-zinc-950/40">
      <h3 className="text-sm font-medium text-zinc-200 mb-4">{title}</h3>
      {children}
    </div>
  )
}

// ── Types (shape matches the API responses) ─────────────────────────
interface CartographerSnapshot {
  rootPath:     string
  generatedAt:  number
  fileCount:    number
  byRole:       Record<string, number>
  topFiles:     Array<{ path: string; loc: number; role: string }>
  hotImports:   Array<{ file: string; importedBy: number }>
  fragileFiles: string[]
  idioms:       Array<{ pattern: string; example: string; description: string }>
}
interface KnowledgePattern {
  patternId:   string
  id?:         string
  source:      string
  title:       string
  description: string
  appliesTo:   string[]
  confidence:  number
  proposedAt:  number
  status:      string
}
interface EvalSet { id: string; name: string; targetSubject: string; baselinePassRate: number; updatedAt: number }
interface DefaultRule { id: string; description: string; priority: number }
interface OverrideRule { id: string; kind: string; description: string; priority: number; enabled: boolean }
interface SimResult {
  summary: string
  ops: Array<{ op: string; classification: string; projectedEffect?: string; reason?: string }>
}
interface PortfolioMove { businessId: string; name: string; move: string; rationale: string }
interface AllocationResult {
  rationale: string
  allocations: Array<{
    businessId: string; name: string; gapUsd: number;
    velocityScore: number; trustScore: number; proposedAllocationUsd: number;
  }>
}
interface MaturityAssessment {
  currentStage: number
  nextActions: string[]
  reports: Array<{
    stage: number
    title: string
    description: string
    signals: Array<{ id: string; label: string; present: boolean; evidence: string }>
    completion: number
    blockers: string[]
  }>
}
interface EscalationEvent { fromAgent: string; toTier: string; reason: string; escalatedAt: number }
interface LoopEvent       { op: string; reason: string; identicalCount: number }
interface BoardEntry      { id: string; agentId: string; kind: string; content: string; confidence: number; createdAt: number }
interface Inconsistency   { pairIds: [string, string]; reason: string }
interface HealthVerdict {
  goodhart:            { drifted: boolean; divergences: number }
  capabilityNarrowing: { narrowing: boolean; oodFailRate: number }
  coordinationDrift:   { drifted: boolean; delta: number }
  compoundingErrors:   { compounding: boolean; trend: string }
  rewardHacking:       { suspiciousCount: number }
  overallVerdict:      'healthy' | 'investigate' | 'pause_self_improvement'
}
interface HealthAlert { type: string; createdAt: number; payload: Record<string, unknown> }
interface HookPattern {
  id: string; pattern: string; example: string; category: string;
  placementSeconds: [number, number]; worksWhen: string; avoid: string[]
}
interface PlatformGuidance {
  platform: string; framing: string; hookWindow: string; captionStyle: string;
  preferredDuration: string; watermarkRisks: string; notes: string[]
}
interface DiligenceItem { category: string; question: string; redFlag: string }
interface ComplianceData {
  viable:        Array<{ id: string; name: string; breakEvenPoint: string; rationale: string }>
  nonViable:     string[]
  costDestroyers: Array<{ pattern: string; signal: string; fix: string }>
  accelerators:  Array<{ name: string; tradeoff: string }>
}
interface ArchitectureOverview {
  tabs:          Array<{ id: string; label: string; status: 'ok' | 'partial' | 'alert' | 'early' }>
  crons:         Array<{ task: string; lastFired: number; count24h: number }>
  connectors:    Array<{ id: string; name: string; ready: boolean; missingEnv: string[] }>
  healthVerdict: string
  maturityStage: number
  recentAlerts:  Array<{ type: string; createdAt: number }>
}
