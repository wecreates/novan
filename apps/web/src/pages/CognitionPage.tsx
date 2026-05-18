/**
 * Cognition — unified view of cognitive state, executive loop, and skills.
 *
 * Consumes:
 *   /cognition/snapshot          — state + world model + memory hierarchy
 *   /cognition/accuracy          — meta-reasoning report
 *   /executive/state             — current executive state
 *   /executive/reviews           — recent review cycles
 *   /skills                      — registered skills
 *   /skills/gaps                 — repeated patterns without skill packaging
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Brain, Target, AlertTriangle, Sparkles, History, Activity,
  Cpu, Boxes, Play, Plus,
} from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

interface CognitiveSnapshotDTO {
  workspaceId: string; capturedAt: number
  state: {
    activeGoals: Array<{ id: string; title: string; progress: number }>
    activeMissions: number
    operationalContext: { runningAgents: number; openIncidents: number; pendingApprovals: number }
    currentBottlenecks: Array<{ signature: string; occurrences: number }>
    recentIncidents: Array<{ title: string; severity: string; status: string; ageHours: number }>
    capabilityGaps: number
    operatorPreferences: { riskTolerance: string; approvalAutoApplyMinConfidence: number }
    systemLimitations: string[]
  }
  worldModel: {
    runtime: { eventsPerHour: number; agentsRunning: number }
    providers: Array<{ id: string; healthy: number; degraded: number; down: number }>
    costs: { dailySpendUsd: number; weeklySpendUsd: number }
    missions: { active: number; completed: number; paused: number }
    securityPosture: { criticalAuditFindings: number; openSecurityFindings: number }
    learningState: { researchFindingsWeek: number; successfulFixesAllTime: number }
    capabilities: { trackedTotal: number; gaps: number }
  }
  memoryHierarchy: {
    shortTerm: { eventsLastHour: number; topTypes: Array<{ type: string; n: number }> }
    working:   { telemetryLast24h: number; incidentsOpen: number }
    longTerm:  { strategicGoals: number; provenFixes: number }
    failure:   { patterns: number; recurringBlockers: number }
    research:  { findingsAllTime: number; lastFindingAgeHours: number | null }
    mission:   { active: number; completed: number }
  }
}

interface AccuracyDTO {
  window: string; totalChains: number; withKnownOutcome: number
  matched: number; unmatched: number; matchRate: number | null
  avgConfidenceMatched: number | null; avgConfidenceUnmatched: number | null
  calibrationGap: number | null
  byKind: Array<{ kind: string; total: number; matched: number; matchRate: number | null }>
}

interface ExecStateDTO {
  workspaceId: string
  topPriorities: Array<{ title: string; kind?: string; bucket?: string; score?: number }>
  activeRisks: Array<{ name: string; value: number; threshold: number; detail?: string }>
  strategicObjectives: Array<{ title: string; horizon: string; progress: number }>
  blockedInitiatives: Array<{ title: string }>
  costPosture: { dailyLimitUsd: number; dailySpendUsd: number; dailyPct: number } | null
  focusAreas: string[]
  lastReviewAt: number | null; reviewCount: number
}

interface SkillDTO {
  id: string; name: string; slug: string; purpose: string; category: string
  riskLevel: string; status: string; requiresApproval: boolean
  successCount: number; failureCount: number; lastUsedAt: number | null
  avgDurationMs: number | null
}

interface SkillGapDTO {
  pattern: string; occurrences: number
  suggestedSkill: { name: string; category: string; reason: string }
}

export default function CognitionPage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const [runningSkill, setRunningSkill] = useState<string | null>(null)
  const [runOutput, setRunOutput] = useState<string | null>(null)

  const snap   = useQuery({ queryKey: ['cog-snap',   workspaceId], queryFn: () => api.get<{ data: CognitiveSnapshotDTO }>(`/api/v1/cognition/snapshot?workspace_id=${workspaceId}`), refetchInterval: 60_000 })
  const acc    = useQuery({ queryKey: ['cog-acc',    workspaceId], queryFn: () => api.get<{ data: AccuracyDTO }>(`/api/v1/cognition/accuracy?workspace_id=${workspaceId}`),       refetchInterval: 5 * 60_000 })
  const exec   = useQuery({ queryKey: ['exec-state', workspaceId], queryFn: () => api.get<{ data: ExecStateDTO | null }>(`/api/v1/executive/state?workspace_id=${workspaceId}`), refetchInterval: 2 * 60_000 })
  const reviews= useQuery({ queryKey: ['exec-revs',  workspaceId], queryFn: () => api.get<{ data: Array<{ id: string; cycle: string; createdAt: number; signalsAnalyzed: Record<string, unknown> }> }>(`/api/v1/executive/reviews?workspace_id=${workspaceId}&limit=10`), refetchInterval: 5 * 60_000 })
  const skills = useQuery({ queryKey: ['skills',     workspaceId], queryFn: () => api.get<{ data: SkillDTO[] }>(`/api/v1/skills?workspace_id=${workspaceId}`), refetchInterval: 60_000 })
  const gaps   = useQuery({ queryKey: ['skill-gaps', workspaceId], queryFn: () => api.get<{ data: SkillGapDTO[] }>(`/api/v1/skills/gaps?workspace_id=${workspaceId}`), refetchInterval: 5 * 60_000 })

  const seedSkills = useMutation({
    mutationFn: () => api.post<{ data: { created: number; skipped: number } }>(`/api/v1/skills/seed-builtin`, { workspace_id: workspaceId }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['skills', workspaceId] }) },
  })

  const runReview = useMutation({
    mutationFn: (cycle: string) => api.post<unknown>(`/api/v1/executive/run-review`, { workspace_id: workspaceId, cycle }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['exec-state', workspaceId] })
      void qc.invalidateQueries({ queryKey: ['exec-revs',  workspaceId] })
    },
  })

  const runSkill = useMutation({
    mutationFn: (slug: string) => api.post<{ data: { status: string; outputs?: Record<string, unknown>; errorMessage?: string; totalDurationMs: number } }>(`/api/v1/skills/${slug}/execute`, { workspace_id: workspaceId, inputs: {} }),
    onMutate: (slug) => { setRunningSkill(slug); setRunOutput(null) },
    onSuccess: (r) => {
      const o = r.data
      setRunOutput(`${o.status} in ${o.totalDurationMs}ms${o.errorMessage ? ` — ${o.errorMessage}` : ''}`)
      void qc.invalidateQueries({ queryKey: ['skills', workspaceId] })
    },
    onSettled: () => setRunningSkill(null),
  })

  const s = snap.data?.data
  const a = acc.data?.data
  const e = exec.data?.data
  const rv = reviews.data?.data ?? []
  const sk = skills.data?.data ?? []
  const sg = gaps.data?.data ?? []

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
      <div className="flex items-center gap-3">
        <Brain className="w-6 h-6 text-sky-400" />
        <div className="flex-1">
          <h1 className="text-xl font-medium text-primary">Cognition</h1>
          <p className="text-xs text-muted">
            Cognitive state · world model · reasoning chains · executive loop · skills
          </p>
        </div>
      </div>

      {/* Cognitive state strip */}
      {s && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
          <Stat label="active missions"   value={String(s.state.activeMissions)} />
          <Stat label="running agents"    value={String(s.state.operationalContext.runningAgents)} />
          <Stat label="open incidents"    value={String(s.state.operationalContext.openIncidents)} highlight={s.state.operationalContext.openIncidents > 0} />
          <Stat label="pending approvals" value={String(s.state.operationalContext.pendingApprovals)} highlight={s.state.operationalContext.pendingApprovals > 0} />
          <Stat label="capability gaps"   value={String(s.state.capabilityGaps)} />
          <Stat label="bottlenecks"       value={String(s.state.currentBottlenecks.length)} highlight={s.state.currentBottlenecks.length > 0} />
          <Stat label="events/hour"       value={String(s.worldModel.runtime.eventsPerHour)} />
        </div>
      )}

      {/* System limitations */}
      {s && s.state.systemLimitations.length > 0 && (
        <Section title="System self-awareness — limitations" icon={<AlertTriangle className="w-4 h-4 text-amber-400" />}>
          <ul className="px-5 py-3 text-sm space-y-1">
            {s.state.systemLimitations.map((l, i) => (
              <li key={i} className="text-muted">• {l}</li>
            ))}
          </ul>
        </Section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Executive state */}
        <Section title="Executive state" icon={<Target className="w-4 h-4" />} actions={
          <div className="flex gap-1 text-xs">
            <button onClick={() => runReview.mutate('hourly')}     className="px-2 py-1 rounded border border-border hover:bg-elevated">Run hourly</button>
            <button onClick={() => runReview.mutate('six_hourly')} className="px-2 py-1 rounded border border-border hover:bg-elevated">6h</button>
            <button onClick={() => runReview.mutate('daily')}      className="px-2 py-1 rounded border border-border hover:bg-elevated">Daily</button>
            <button onClick={() => runReview.mutate('weekly')}     className="px-2 py-1 rounded border border-border hover:bg-elevated">Weekly</button>
          </div>
        }>
          {!e ? (
            <div className="px-5 py-4 text-muted text-sm">No executive state yet — click a review button.</div>
          ) : (
            <div className="px-5 py-3 space-y-2 text-sm">
              <Kv k="Reviews run" v={String(e.reviewCount)} />
              <Kv k="Last review" v={e.lastReviewAt ? new Date(e.lastReviewAt).toLocaleString() : '—'} />
              <Kv k="Focus areas" v={(e.focusAreas ?? []).join(', ') || '—'} />
              {e.topPriorities.length > 0 && (
                <div className="pt-2 border-t border-border">
                  <div className="text-xs uppercase tracking-wider text-muted mb-1">Top priorities</div>
                  {e.topPriorities.slice(0, 5).map((p, i) => (
                    <div key={i} className="text-xs flex items-center gap-2">
                      {p.bucket && <span className="text-[10px] font-mono px-1 rounded bg-sky-500/20 text-sky-300">{p.bucket}</span>}
                      <span className="flex-1 truncate">{p.title}</span>
                      {typeof p.score === 'number' && <span className="font-mono text-muted">{p.score.toFixed(2)}</span>}
                    </div>
                  ))}
                </div>
              )}
              {e.activeRisks.length > 0 && (
                <div className="pt-2 border-t border-border">
                  <div className="text-xs uppercase tracking-wider text-amber-400 mb-1">Active risks</div>
                  {e.activeRisks.slice(0, 5).map((r, i) => (
                    <div key={i} className="text-xs text-muted">• {r.name}: {r.value} (threshold {r.threshold})</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Section>

        {/* Meta-reasoning accuracy */}
        <Section title="Meta-reasoning" icon={<History className="w-4 h-4" />}>
          {!a ? (
            <div className="px-5 py-4 text-muted text-sm">Loading…</div>
          ) : (
            <div className="px-5 py-3 space-y-2 text-sm">
              <Kv k="Reasoning chains"     v={String(a.totalChains)} />
              <Kv k="With known outcome"   v={String(a.withKnownOutcome)} />
              <Kv k="Match rate"           v={a.matchRate === null ? '—' : `${(a.matchRate*100).toFixed(0)}%`} />
              <Kv k="Calibration gap"      v={a.calibrationGap === null ? '—' : `${a.calibrationGap > 0 ? '+' : ''}${(a.calibrationGap*100).toFixed(1)}%`} />
              <Kv k="Avg conf matched"     v={a.avgConfidenceMatched === null ? '—' : a.avgConfidenceMatched.toFixed(2)} />
              <Kv k="Avg conf unmatched"   v={a.avgConfidenceUnmatched === null ? '—' : a.avgConfidenceUnmatched.toFixed(2)} />
              {a.totalChains === 0 && (
                <div className="text-xs text-muted mt-2 pt-2 border-t border-border">
                  No reasoning chains persisted yet. Run an executive review or accept/dismiss a recommendation to start populating.
                </div>
              )}
            </div>
          )}
        </Section>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* World model + memory hierarchy */}
        <Section title="World model" icon={<Cpu className="w-4 h-4" />}>
          {!s ? <div className="px-5 py-4 text-muted text-sm">Loading…</div> : (
            <div className="px-5 py-3 space-y-1.5 text-sm">
              <Kv k="Cost / day"         v={`$${s.worldModel.costs.dailySpendUsd.toFixed(4)}`} />
              <Kv k="Cost / week"        v={`$${s.worldModel.costs.weeklySpendUsd.toFixed(4)}`} />
              <Kv k="Missions"           v={`${s.worldModel.missions.active} active · ${s.worldModel.missions.completed} done · ${s.worldModel.missions.paused} paused`} />
              <Kv k="Security findings"  v={`${s.worldModel.securityPosture.openSecurityFindings} open (${s.worldModel.securityPosture.criticalAuditFindings} critical)`} />
              <Kv k="Research 7d"        v={String(s.worldModel.learningState.researchFindingsWeek)} />
              <Kv k="Proven fixes"       v={String(s.worldModel.learningState.successfulFixesAllTime)} />
              <Kv k="Capabilities"       v={`${s.worldModel.capabilities.trackedTotal - s.worldModel.capabilities.gaps}/${s.worldModel.capabilities.trackedTotal}`} />
            </div>
          )}
        </Section>

        <Section title="Memory hierarchy" icon={<Boxes className="w-4 h-4" />}>
          {!s ? <div className="px-5 py-4 text-muted text-sm">Loading…</div> : (
            <div className="px-5 py-3 space-y-1.5 text-sm">
              <Kv k="Short-term (1h events)" v={String(s.memoryHierarchy.shortTerm.eventsLastHour)} />
              <Kv k="Working (24h telem.)"   v={String(s.memoryHierarchy.working.telemetryLast24h)} />
              <Kv k="Long-term goals"         v={String(s.memoryHierarchy.longTerm.strategicGoals)} />
              <Kv k="Failure patterns"        v={String(s.memoryHierarchy.failure.patterns)} />
              <Kv k="Recurring blockers"      v={String(s.memoryHierarchy.failure.recurringBlockers)} />
              <Kv k="Mission progress"        v={`${s.memoryHierarchy.mission.active} active`} />
            </div>
          )}
        </Section>
      </div>

      {/* Skills */}
      <Section title="Skills" icon={<Sparkles className="w-4 h-4" />} actions={
        sk.length === 0
          ? (<button onClick={() => seedSkills.mutate()} disabled={seedSkills.isPending} className="text-xs px-3 py-1 rounded border border-sky-500/40 bg-sky-500/10 text-sky-300 flex items-center gap-1"><Plus className="w-3 h-3" />Seed 6 built-in skills</button>)
          : (<span className="text-xs text-muted">{sk.length} registered · {sk.filter(x => x.status === 'verified').length} verified</span>)
      }>
        <>
          {sk.length === 0 ? (
            <div className="px-5 py-6 text-muted text-sm">No skills yet. Click "Seed 6 built-in skills" to register the verified built-ins.</div>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {sk.map(skill => (
                <li key={skill.id} className="px-4 py-2.5 flex items-center gap-3">
                  <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${skill.status === 'verified' ? 'bg-emerald-500/20 text-emerald-300' : skill.status === 'production' ? 'bg-sky-500/20 text-sky-300' : 'bg-slate-500/20 text-slate-300'}`}>{skill.status}</span>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-500/20 text-slate-300">{skill.category}</span>
                  <span className="text-[10px] font-mono">{skill.riskLevel}</span>
                  <div className="flex-1">
                    <div className="text-sm">{skill.name}</div>
                    <div className="text-xs text-muted">{skill.purpose}</div>
                  </div>
                  <span className="text-xs font-mono text-muted" title="success/failure">{skill.successCount}/{skill.failureCount}</span>
                  <button
                    onClick={() => runSkill.mutate(skill.slug)}
                    disabled={runningSkill === skill.slug}
                    className="text-xs px-2 py-1 rounded border border-border hover:bg-elevated flex items-center gap-1"
                  >
                    <Play className="w-3 h-3" />
                    {runningSkill === skill.slug ? 'Running…' : 'Run'}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {runOutput !== null && runOutput !== '' && (
            <div className="px-5 py-2 text-xs text-muted border-t border-border font-mono">{runOutput}</div>
          )}
        </>
      </Section>

      {/* Skill gaps */}
      {sg.length > 0 && (
        <Section title="Skill gaps detected" icon={<Plus className="w-4 h-4 text-amber-400" />}>
          <ul className="divide-y divide-[var(--border)]">
            {sg.map(g => (
              <li key={g.pattern} className="px-4 py-2 flex items-center gap-3 text-sm">
                <span className="font-mono text-xs">{g.pattern}</span>
                <span className="text-amber-400 font-mono text-xs">{g.occurrences}×</span>
                <span className="flex-1 text-muted">→ {g.suggestedSkill.reason}</span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">{g.suggestedSkill.name}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Recent reviews */}
      <Section title="Recent executive reviews" icon={<Activity className="w-4 h-4" />}>
        {rv.length === 0 ? (
          <div className="px-5 py-4 text-muted text-sm">No reviews yet. Click a button above to run one.</div>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {rv.map(r => (
              <li key={r.id} className="px-4 py-2 flex items-center gap-3 text-sm">
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300">{r.cycle}</span>
                <span className="text-xs text-muted">{new Date(r.createdAt).toLocaleString()}</span>
                <span className="flex-1 truncate text-xs">{JSON.stringify(r.signalsAnalyzed).slice(0, 140)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}

function Section({ title, icon, actions, children }: { title: string; icon?: JSX.Element; actions?: JSX.Element; children: JSX.Element | JSX.Element[] }) {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-medium text-primary">{title}</h3>
        {actions && <div className="ml-auto">{actions}</div>}
      </div>
      {children}
    </div>
  )
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`font-mono text-sm ${highlight ? 'text-amber-400' : 'text-primary'}`}>{value}</div>
    </div>
  )
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted">{k}</span>
      <span className="font-mono text-sm">{v}</span>
    </div>
  )
}
