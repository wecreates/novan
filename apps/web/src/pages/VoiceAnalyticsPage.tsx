/**
 * VoiceAnalyticsPage — operator dashboard for the voice subsystem.
 *
 * Surfaces the data already captured by the voice layer:
 *   - Recent sessions (mode, provider, latency, cost, failovers, blocked)
 *   - Provider quality rollup (composite + per-dimension averages) from
 *     operator feedback
 *   - Recent voice_quality_feedback entries
 *   - Per-session drill-down: summary + event timeline
 *
 * Minimal styling, table-first, low cognitive load — meant to be glanced
 * at like the war room, not lived in.
 */
import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, BarChart3, MessageSquare, Star } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

interface SessionRow {
  id: string; mode: string; preset: string; selectedProvider: string
  startedAt: number; endedAt: number | null
  avgLatencyMs: number | null; totalCostUsd: number
  failoverCount: number; blockedCommands: number; status: string
}
interface QualityRollup {
  provider: string; count: number
  avgNaturalness: number; avgClarity: number; avgUsefulness: number; composite: number
}
interface FeedbackRow {
  id: string; sessionId: string; provider: string | null
  naturalness: number | null; speed: number | null; clarity: number | null
  tone: number | null; usefulness: number | null; comment: string | null; createdAt: number
}
interface SessionSummary {
  sessionId: string; turns: number; accepted: number; rejected: number
  corrected: number; clarified: number; failovers: number
  topIntents: Array<{ kind: string; count: number }>
  providersUsed: string[]; avgLatencyMs: number | null
  blockedCommands: number; durationMs: number | null
  transcriptHead: string; transcriptTail: string
}
interface EventRow {
  id: string; sessionId: string; kind: string; role: string | null
  text: string | null; provider: string | null; latencyMs: number | null
  costUsd: number | null; createdAt: number
  meta: { intent?: string; conversationMeta?: string; verdict?: string; risk?: string } | null
}

export default function VoiceAnalyticsPage() {
  const { workspaceId } = useWorkspace()
  const [openSession, setOpenSession] = useState<string | null>(null)

  interface SkillRollup {
    topPhrases: Array<{ phrase: string; count: number; intentKind: string | null }>
    topIntents: Array<{ intentKind: string; count: number }>
    topBrainNodes: Array<{ nodeId: string; count: number }>
    misunderstandings: Array<{ phrase: string; count: number }>
    correctionPairs: Array<{ from: string; to: string; count: number }>
    repeatedPhrases: Array<{ phrase: string; count: number }>
    preferredActions: Array<{ intentKind: string; count: number }>
    correctionRate: number; total: number; windowMs: number
  }
  interface VoiceMetricsData {
    totalTurns: number; avgConfidence: number | null; lowConfidenceRate: number
    correctionRate: number; interruptionRate: number; approvalRate: number
    blockedActionRate: number
    perProviderLatency: Array<{ provider: string; samples: number; p50: number; p95: number }>
    topIntents: Array<{ intent: string; count: number }>
  }
  interface ShortcutRow {
    id: string; phrase: string; expansion: string; description: string | null
    useCount: number; lastUsedAt: number | null; enabled: boolean
  }

  const skillQ = useQuery<{ success: true; data: SkillRollup }>({
    queryKey: ['voice-analytics', 'skill', workspaceId],
    queryFn:  () => api.get(`/api/v1/voice/skill-memory?workspace_id=${workspaceId}&window_days=30`),
  })
  const metricsQ = useQuery<{ success: true; data: VoiceMetricsData }>({
    queryKey: ['voice-analytics', 'metrics', workspaceId],
    queryFn:  () => api.get(`/api/v1/voice/metrics?workspace_id=${workspaceId}&window_days=7`),
  })
  const shortcutsQ = useQuery<{ success: true; data: ShortcutRow[] }>({
    queryKey: ['voice-analytics', 'shortcuts', workspaceId],
    queryFn:  () => api.get(`/api/v1/voice/shortcuts?workspace_id=${workspaceId}`),
  })

  const sessionsQ = useQuery<{ success: true; data: SessionRow[] }>({
    queryKey: ['voice-analytics', 'sessions', workspaceId],
    queryFn:  () => api.get(`/api/v1/voice/sessions?workspace_id=${workspaceId}&limit=100`),
    refetchInterval: 15_000,
  })
  const rollupQ = useQuery<{ success: true; data: QualityRollup[] }>({
    queryKey: ['voice-analytics', 'rollup', workspaceId],
    queryFn:  () => api.get(`/api/v1/voice/feedback/rollup?workspace_id=${workspaceId}&since_days=30`),
  })
  const feedbackQ = useQuery<{ success: true; data: FeedbackRow[] }>({
    queryKey: ['voice-analytics', 'feedback', workspaceId],
    queryFn:  () => api.get(`/api/v1/voice/feedback?workspace_id=${workspaceId}&limit=50`),
  })
  const summaryQ = useQuery<{ success: true; data: SessionSummary }>({
    queryKey: ['voice-analytics', 'summary', openSession],
    queryFn:  () => api.get(`/api/v1/voice/sessions/${openSession}/summary?workspace_id=${workspaceId}`),
    enabled:  !!openSession,
  })
  const eventsQ = useQuery<{ success: true; data: EventRow[] }>({
    queryKey: ['voice-analytics', 'events', openSession],
    queryFn:  () => api.get(`/api/v1/voice/sessions/${openSession}/events?workspace_id=${workspaceId}`),
    enabled:  !!openSession,
  })

  const sessions = sessionsQ.data?.data ?? []
  const rollup   = rollupQ.data?.data ?? []
  const feedback = feedbackQ.data?.data ?? []

  // Aggregates from the sessions list
  const totals = {
    sessions:  sessions.length,
    active:    sessions.filter(s => s.status === 'active').length,
    avgLatency: avg(sessions.map(s => s.avgLatencyMs).filter((n): n is number => n !== null)),
    totalCost: sum(sessions.map(s => s.totalCostUsd)),
    failovers: sum(sessions.map(s => s.failoverCount)),
    blocked:   sum(sessions.map(s => s.blockedCommands)),
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <header className="flex items-baseline justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Voice analytics</h1>
          <p className="text-muted text-sm mt-1">Sessions, provider quality, and operator feedback.</p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted">
          <span className="inline-flex items-center gap-1"><Activity className="w-3 h-3" />{totals.active} active</span>
          <span>·</span><span>{totals.sessions} total</span>
        </div>
      </header>

      {/* Top KPIs */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Kpi label="Avg latency"  value={totals.avgLatency !== null ? `${Math.round(totals.avgLatency)}ms` : '—'} />
        <Kpi label="Total cost"   value={`$${totals.totalCost.toFixed(2)}`} />
        <Kpi label="Failovers"    value={String(totals.failovers)} />
        <Kpi label="Blocked cmds" value={String(totals.blocked)} {...(totals.blocked > 0 ? { accent: 'rose' as const } : {})} />
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Provider quality rollup */}
        <section>
          <div className="label mb-2 flex items-center gap-2"><BarChart3 className="w-3 h-3" /> Provider quality (last 30d)</div>
          <div className="drawer-edge overflow-x-auto">
            <table className="w-full text-2xs">
              <thead className="text-muted">
                <tr><th className="text-left p-2">provider</th><th className="text-left p-2">composite</th><th className="text-left p-2">natural</th><th className="text-left p-2">clarity</th><th className="text-left p-2">usefulness</th><th className="text-left p-2">n</th></tr>
              </thead>
              <tbody>
                {rollup.length === 0 && <tr><td colSpan={6} className="p-3 text-center text-muted italic">No feedback yet — rate sessions to populate.</td></tr>}
                {rollup.map(r => (
                  <tr key={r.provider} className="border-t border-border">
                    <td className="p-2 font-mono">{r.provider}</td>
                    <td className="p-2"><CompositeBar value={r.composite} /></td>
                    <td className="p-2">{r.avgNaturalness.toFixed(2)}</td>
                    <td className="p-2">{r.avgClarity.toFixed(2)}</td>
                    <td className="p-2">{r.avgUsefulness.toFixed(2)}</td>
                    <td className="p-2 text-muted">{r.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Recent feedback */}
        <section>
          <div className="label mb-2 flex items-center gap-2"><Star className="w-3 h-3" /> Recent feedback</div>
          <div className="drawer-edge overflow-x-auto max-h-[260px] overflow-y-auto">
            <table className="w-full text-2xs">
              <thead className="text-muted sticky top-0 bg-surface">
                <tr><th className="text-left p-2">when</th><th className="text-left p-2">provider</th><th className="text-left p-2">nat</th><th className="text-left p-2">spd</th><th className="text-left p-2">cla</th><th className="text-left p-2">tone</th><th className="text-left p-2">use</th></tr>
              </thead>
              <tbody>
                {feedback.length === 0 && <tr><td colSpan={7} className="p-3 text-center text-muted italic">No feedback yet.</td></tr>}
                {feedback.map(f => (
                  <tr key={f.id} className="border-t border-border">
                    <td className="p-2 text-muted">{new Date(f.createdAt).toLocaleString()}</td>
                    <td className="p-2 font-mono">{f.provider ?? '—'}</td>
                    <td className="p-2">{f.naturalness ?? '—'}</td>
                    <td className="p-2">{f.speed ?? '—'}</td>
                    <td className="p-2">{f.clarity ?? '—'}</td>
                    <td className="p-2">{f.tone ?? '—'}</td>
                    <td className="p-2">{f.usefulness ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {/* Voice intelligence */}
      <section className="mt-8 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div>
          <div className="label mb-2">Top voice commands (30d)</div>
          <div className="drawer-edge p-3 max-h-[240px] overflow-y-auto">
            {(skillQ.data?.data.topIntents ?? []).length === 0 && <div className="text-2xs text-muted italic">No voice commands yet.</div>}
            <ul className="text-2xs space-y-1">
              {(skillQ.data?.data.topIntents ?? []).map(i => (
                <li key={i.intentKind} className="flex items-center justify-between">
                  <span className="font-mono">{i.intentKind}</span>
                  <span className="text-muted">{i.count}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div>
          <div className="label mb-2">Misunderstood phrases · correction rate {((skillQ.data?.data.correctionRate ?? 0) * 100).toFixed(1)}%</div>
          <div className="drawer-edge p-3 max-h-[240px] overflow-y-auto">
            {(skillQ.data?.data.misunderstandings ?? []).length === 0 && <div className="text-2xs text-muted italic">No misunderstandings recorded.</div>}
            <ul className="text-2xs space-y-1">
              {(skillQ.data?.data.misunderstandings ?? []).map(m => (
                <li key={m.phrase} className="flex items-center justify-between">
                  <span className="truncate max-w-[200px]">{m.phrase}</span>
                  <span className="text-muted">×{m.count}</span>
                </li>
              ))}
            </ul>
            {(skillQ.data?.data.correctionPairs ?? []).length > 0 && (
              <>
                <div className="text-2xs text-muted mt-3 mb-1">Correction pairs</div>
                <ul className="text-2xs space-y-1 font-mono">
                  {skillQ.data!.data.correctionPairs.map(c => (
                    <li key={`${c.from}-${c.to}`} className="flex items-center justify-between">
                      <span>{c.from} → {c.to}</span>
                      <span className="text-muted">×{c.count}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>

        <div>
          <div className="label mb-2">Custom shortcuts ({shortcutsQ.data?.data.length ?? 0})</div>
          <div className="drawer-edge p-3 max-h-[240px] overflow-y-auto">
            {(shortcutsQ.data?.data ?? []).length === 0 && <div className="text-2xs text-muted italic">No shortcuts yet. POST /api/v1/voice/shortcuts to create one.</div>}
            <ul className="text-2xs space-y-1.5">
              {(shortcutsQ.data?.data ?? []).map(s => (
                <li key={s.id}>
                  <div className="flex items-center justify-between">
                    <span className="font-mono">"{s.phrase}"</span>
                    <span className="text-muted">×{s.useCount}</span>
                  </div>
                  <div className="text-2xs text-muted truncate">→ {s.expansion}</div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Performance metrics + safety blocks */}
      <section className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Avg confidence"      value={metricsQ.data?.data.avgConfidence != null ? (metricsQ.data.data.avgConfidence * 100).toFixed(0) + '%' : '—'} />
        <Kpi label="Low-confidence rate" value={((metricsQ.data?.data.lowConfidenceRate ?? 0) * 100).toFixed(1) + '%'} />
        <Kpi label="Correction rate"     value={((metricsQ.data?.data.correctionRate ?? 0) * 100).toFixed(1) + '%'} />
        <Kpi label="Approval rate"       value={((metricsQ.data?.data.approvalRate ?? 0) * 100).toFixed(0) + '%'} />
        <Kpi label="Interruption rate"   value={((metricsQ.data?.data.interruptionRate ?? 0) * 100).toFixed(1) + '%'} />
        <Kpi label="Blocked actions"     value={((metricsQ.data?.data.blockedActionRate ?? 0) * 100).toFixed(1) + '%'}
          {...((metricsQ.data?.data.blockedActionRate ?? 0) > 0 ? { accent: 'rose' as const } : {})} />
        <Kpi label="Top brain nodes" value={(skillQ.data?.data.topBrainNodes ?? []).map(n => n.nodeId).slice(0, 3).join(', ') || '—'} />
        <Kpi label="Top repeated"    value={(skillQ.data?.data.repeatedPhrases ?? [])[0]?.phrase ?? '—'} />
      </section>

      {/* Provider latency (p50/p95) */}
      {(metricsQ.data?.data.perProviderLatency ?? []).length > 0 && (
        <section className="mt-6">
          <div className="label mb-2">Provider latency (7d)</div>
          <div className="drawer-edge overflow-x-auto">
            <table className="w-full text-2xs">
              <thead className="text-muted">
                <tr><th className="text-left p-2">provider</th><th className="text-left p-2">samples</th><th className="text-left p-2">p50</th><th className="text-left p-2">p95</th></tr>
              </thead>
              <tbody>
                {metricsQ.data!.data.perProviderLatency.map(p => (
                  <tr key={p.provider} className="border-t border-border">
                    <td className="p-2 font-mono">{p.provider}</td>
                    <td className="p-2 text-muted">{p.samples}</td>
                    <td className="p-2">{p.p50}ms</td>
                    <td className="p-2">{p.p95}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Sessions table */}
      <section className="mt-8">
        <div className="label mb-2 flex items-center gap-2"><MessageSquare className="w-3 h-3" /> Sessions</div>
        <div className="drawer-edge overflow-x-auto">
          <table className="w-full text-2xs">
            <thead className="text-muted">
              <tr><th className="text-left p-2">id</th><th className="text-left p-2">when</th><th className="text-left p-2">mode</th><th className="text-left p-2">provider</th><th className="text-left p-2">preset</th><th className="text-left p-2">latency</th><th className="text-left p-2">cost</th><th className="text-left p-2">failovers</th><th className="text-left p-2">blocked</th><th className="text-left p-2">status</th></tr>
            </thead>
            <tbody>
              {sessions.length === 0 && <tr><td colSpan={10} className="p-3 text-center text-muted italic">No voice sessions yet.</td></tr>}
              {sessions.map(s => (
                <tr key={s.id} className="border-t border-border hover:bg-[var(--surface-hover)] cursor-pointer"
                  onClick={() => setOpenSession(s.id === openSession ? null : s.id)}>
                  <td className="p-2 font-mono">{s.id.slice(0, 8)}</td>
                  <td className="p-2 text-muted">{new Date(s.startedAt).toLocaleString()}</td>
                  <td className="p-2">{s.mode}</td>
                  <td className="p-2 font-mono">{s.selectedProvider}</td>
                  <td className="p-2">{s.preset}</td>
                  <td className="p-2">{s.avgLatencyMs ?? '—'}ms</td>
                  <td className="p-2">${s.totalCostUsd.toFixed(3)}</td>
                  <td className="p-2">{s.failoverCount}</td>
                  <td className={`p-2 ${s.blockedCommands > 0 ? 'text-rose-300' : ''}`}>{s.blockedCommands}</td>
                  <td className="p-2">{s.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Drill-down */}
      {openSession && (
        <section className="mt-6 drawer-edge p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="label">Session {openSession.slice(0, 8)}</div>
            <button onClick={() => setOpenSession(null)} className="btn btn-ghost text-2xs">Close</button>
          </div>
          {summaryQ.data?.data ? (
            <>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4 text-xs">
                <Stat label="turns"     value={summaryQ.data.data.turns} />
                <Stat label="accepted"  value={summaryQ.data.data.accepted} />
                <Stat label="rejected"  value={summaryQ.data.data.rejected} {...(summaryQ.data.data.rejected > 0 ? { accent: 'rose' as const } : {})} />
                <Stat label="corrected" value={summaryQ.data.data.corrected} />
                <Stat label="clarified" value={summaryQ.data.data.clarified} />
              </div>
              <div className="text-2xs text-muted mb-3">
                top intents · {summaryQ.data.data.topIntents.map(i => `${i.kind} (${i.count})`).join(' · ') || '—'}
              </div>
              {summaryQ.data.data.transcriptHead && <div className="text-2xs"><span className="text-muted">first:</span> {summaryQ.data.data.transcriptHead}</div>}
              {summaryQ.data.data.transcriptTail && <div className="text-2xs"><span className="text-muted">last:</span> {summaryQ.data.data.transcriptTail}</div>}
            </>
          ) : <div className="text-2xs text-muted italic">Loading…</div>}

          <div className="label mt-4 mb-2">Event timeline</div>
          <div className="max-h-[300px] overflow-y-auto">
            <table className="w-full text-2xs">
              <thead className="text-muted sticky top-0 bg-surface">
                <tr><th className="text-left p-2">when</th><th className="text-left p-2">kind</th><th className="text-left p-2">role</th><th className="text-left p-2">intent</th><th className="text-left p-2">verdict</th><th className="text-left p-2">risk</th><th className="text-left p-2">provider</th><th className="text-left p-2">text</th></tr>
              </thead>
              <tbody>
                {(eventsQ.data?.data ?? []).map(e => (
                  <tr key={e.id} className="border-t border-border">
                    <td className="p-2 text-muted">{new Date(e.createdAt).toLocaleTimeString()}</td>
                    <td className="p-2">{e.kind}</td>
                    <td className="p-2">{e.role ?? '—'}</td>
                    <td className="p-2 font-mono">{e.meta?.intent ?? '—'}</td>
                    <td className={`p-2 ${e.meta?.verdict === 'reject' ? 'text-rose-300' : e.meta?.verdict === 'confirm' ? 'text-amber-300' : ''}`}>{e.meta?.verdict ?? '—'}</td>
                    <td className="p-2">{e.meta?.risk ?? '—'}</td>
                    <td className="p-2 font-mono">{e.provider ?? '—'}</td>
                    <td className="p-2 truncate max-w-[260px]">{e.text ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}

function Kpi({ label, value, accent }: { label: string; value: string; accent?: 'rose' }) {
  return (
    <div className="drawer-edge p-3">
      <div className="text-2xs text-muted">{label}</div>
      <div className={`text-lg font-semibold ${accent === 'rose' ? 'text-rose-300' : ''}`}>{value}</div>
    </div>
  )
}
function Stat({ label, value, accent }: { label: string; value: number | string; accent?: 'rose' }) {
  return (
    <div>
      <div className="text-2xs text-muted">{label}</div>
      <div className={`text-base font-mono ${accent === 'rose' ? 'text-rose-300' : ''}`}>{value}</div>
    </div>
  )
}
function CompositeBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value))
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 max-w-[80px] h-2 rounded bg-surface-hover overflow-hidden">
        <div className={`h-full ${pct >= 0.7 ? 'bg-emerald-400' : pct >= 0.4 ? 'bg-amber-400' : 'bg-rose-400'}`} style={{ width: `${pct * 100}%` }} />
      </div>
      <span className="font-mono">{value.toFixed(2)}</span>
    </div>
  )
}

function avg(xs: number[]): number | null { return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length }
function sum(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) }
