/**
 * Runtime — 24/7 self-monitor view.
 *
 * Consumes /api/v1/runtime/* — shows uptime, cron health, recent
 * autonomous-mind cycles, calibration findings, cron budgets.
 */
import React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Heart, Activity, Brain, Sparkles, Coins, RefreshCw, AlertCircle,
} from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

interface RuntimeStatus {
  bootedAt: number; uptimeMs: number; uptimeHuman: string
  lastHeartbeatAt: number; lastHeartbeatAgoMs: number
  cyclesRun: number; cronStartCount: number
  learningCronActive: number; liveness: 'live' | 'stale'
  nodeVersion: string; pid: number; memoryMb: number
  lastErrors: Array<{ at: number; task: string; message: string }>
}
interface ChainRow {
  id: string; decision: string; confidence: number | null; createdAt: number
  subjectId: string | null
}
interface Calibration {
  source: string; total: number; matched: number; unmatched: number
  matchRate: number; calibrationGap: number; suggestion: string; suggestedDelta: number
}
interface Budget {
  cronName: string; callsUsed: number; tokensUsed: number; costUsdUsed: number
  maxCalls: number; maxTokens: number; maxCostUsd: number
  blocked: boolean; windowMs: number
}

export default function RuntimePage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()

  const status = useQuery({
    queryKey: ['runtime-status'],
    queryFn:  () => api.get<{ data: RuntimeStatus }>(`/api/v1/runtime/status`),
    refetchInterval: 15_000,
  })
  const mind = useQuery({
    queryKey: ['runtime-mind', workspaceId],
    queryFn:  () => api.get<{ data: ChainRow[] }>(`/api/v1/runtime/mind/recent?workspace_id=${workspaceId}&limit=15`),
    refetchInterval: 30_000,
  })
  const cal = useQuery({
    queryKey: ['runtime-cal', workspaceId],
    queryFn:  () => api.get<{ data: Calibration[] }>(`/api/v1/runtime/calibration?workspace_id=${workspaceId}`),
    refetchInterval: 60_000,
  })
  const budgets = useQuery({
    queryKey: ['runtime-budgets'],
    queryFn:  () => api.get<{ data: Budget[] }>(`/api/v1/runtime/budgets`),
    refetchInterval: 30_000,
  })

  const triggerMind = useMutation({
    mutationFn: () => api.post(`/api/v1/runtime/mind/cycle`, { workspace_id: workspaceId }),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['runtime-mind', workspaceId] }),
  })

  const s = status.data?.data

  return (
    <div className="p-6 space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center gap-3">
        <Heart className={`w-5 h-5 ${s?.liveness === 'live' ? 'text-emerald-400 animate-pulse' : 'text-slate-500'}`} />
        <h1 className="text-xl font-semibold">Runtime — 24/7</h1>
        <span className="text-xs text-[var(--text-muted)] ml-1">{s ? `${s.liveness}` : 'loading…'}</span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => triggerMind.mutate()} disabled={triggerMind.isPending}
            className="px-3 py-1.5 text-xs rounded border border-[var(--border)] hover:bg-[var(--surface-hover)] flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5" /> {triggerMind.isPending ? 'Running…' : 'Run mind cycle now'}
          </button>
        </div>
      </div>

      {/* Liveness strip */}
      {s && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <Stat label="Uptime" value={s.uptimeHuman} />
          <Stat label="Heartbeats" value={String(s.cyclesRun)} />
          <Stat label="Crons active" value={String(s.learningCronActive)} />
          <Stat label="Memory" value={`${s.memoryMb} MB`} />
          <Stat label="Last beat" value={`${Math.floor(s.lastHeartbeatAgoMs / 1000)}s ago`} />
          <Stat label="Cron re-arms" value={String(s.cronStartCount)} />
        </div>
      )}

      {/* Recent mind cycles */}
      <Section title="Autonomous mind — recent decisions" icon={<Brain className="w-4 h-4 text-purple-400" />}>
        {(mind.data?.data ?? []).length === 0 ? (
          <Empty msg="No autonomous-mind decisions recorded yet — first cycle pending or no actionable gaps." />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {(mind.data?.data ?? []).map(c => (
              <li key={c.id} className="px-5 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[var(--text-muted)] w-32 shrink-0">{new Date(c.createdAt).toLocaleString().replace(',', '')}</span>
                  <span className="text-[var(--text)]">{c.decision}</span>
                  {c.confidence !== null && (
                    <span className="ml-auto text-[10px] text-[var(--text-muted)]">conf {c.confidence.toFixed(2)}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Calibration findings */}
      <Section title="Meta-learning — calibration by source" icon={<Activity className="w-4 h-4 text-sky-400" />}>
        {(cal.data?.data ?? []).length === 0 ? (
          <Empty msg="Insufficient decided outcomes per source (need ≥10) — calibration will appear as predictions resolve." />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {(cal.data?.data ?? []).map(c => (
              <li key={c.source} className="px-5 py-2 text-xs flex items-center gap-3">
                <span className="font-mono">{c.source}</span>
                <span className="text-[var(--text-muted)]">{c.matched}/{c.total} matched ({(c.matchRate * 100).toFixed(0)}%)</span>
                <span className={`ml-auto px-1.5 py-0.5 rounded border text-[10px] ${
                  c.suggestion === 'in_band' ? 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10'
                  : c.suggestion === 'lower_confidence' ? 'text-amber-300 border-amber-500/30 bg-amber-500/10'
                  : 'text-sky-300 border-sky-500/30 bg-sky-500/10'
                }`}>
                  {c.suggestion} (Δ{c.suggestedDelta >= 0 ? '+' : ''}{c.suggestedDelta})
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Cron budgets */}
      <Section title="Cron budgets" icon={<Coins className="w-4 h-4 text-amber-400" />}>
        {(budgets.data?.data ?? []).length === 0 ? (
          <Empty msg="No budgets configured yet — first cron run will create them." />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {(budgets.data?.data ?? []).map(b => (
              <li key={b.cronName} className="px-5 py-2 text-xs flex items-center gap-3">
                <span className="font-mono">{b.cronName}</span>
                <span className="text-[var(--text-muted)]">
                  {b.callsUsed}/{b.maxCalls} calls · ${b.costUsdUsed.toFixed(3)}/${b.maxCostUsd.toFixed(2)}
                </span>
                {b.blocked && <span className="ml-auto text-red-400">BLOCKED</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Last errors */}
      {s && s.lastErrors.length > 0 && (
        <Section title={`Recent errors (${s.lastErrors.length})`} icon={<AlertCircle className="w-4 h-4 text-red-400" />}>
          <ul className="divide-y divide-[var(--border)]">
            {s.lastErrors.slice(-10).reverse().map((e, i) => (
              <li key={i} className="px-5 py-2 text-xs">
                <span className="font-mono text-[var(--text-muted)]">{new Date(e.at).toLocaleString().replace(',', '')}</span>
                <span className="ml-2 text-amber-300">{e.task}</span>
                <span className="ml-2 text-[var(--text-muted)]">{e.message}</span>
              </li>
            ))}
          </ul>
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{label}</div>
      <div className="font-mono mt-0.5 text-lg">{value}</div>
    </div>
  )
}

function Empty({ msg }: { msg: string }) {
  return <div className="px-5 py-4 text-xs text-[var(--text-muted)] italic">{msg}</div>
}
