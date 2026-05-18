/**
 * LearningRuntimePage — War Room view of failure memory and learned fixes.
 *
 * Shows:
 * - Aggregate stats (failures, blocked signatures, learned fixes)
 * - Repeated failure patterns
 * - Risky files (high failure rate)
 * - Agent rollback rates
 * - Successful fix patterns
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Brain, AlertTriangle, ShieldAlert, CheckCircle2,
  FileWarning, Bot, ChevronDown, ChevronUp, RefreshCcw, Hash,
} from 'lucide-react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

const API = (p: string) => `/api/v1/learning-runtime${p}`

async function fetchStats(ws: string) {
  const r = await fetch(`${API('/stats')}?workspace_id=${ws}`)
  return (await r.json()).data as Stats
}
async function fetchFailures(ws: string, blocked?: boolean) {
  const q = new URLSearchParams({ workspace_id: ws })
  if (blocked) q.set('blocked', 'true')
  const r = await fetch(`${API('/failures')}?${q}`)
  return (await r.json()).data as Failure[]
}
async function fetchFixes(ws: string) {
  const r = await fetch(`${API('/successful-fixes')}?workspace_id=${ws}`)
  return (await r.json()).data as Fix[]
}

interface Stats {
  totalFailures:        number
  totalOccurrences:     number
  blockedSignatures:    number
  totalSuccessfulFixes: number
  riskyFiles:           Array<{ file: string; failures: number; totalOccurrences: number; blocked: boolean }>
  agentStats:           Array<{ agentId: string; failures: number; successes: number; blocked: number; rollbackRate: number }>
}

interface Failure {
  id: string
  failureType: string
  rootCauseClass: string
  targetRef: string
  targetKind: string
  signature: string
  errorPattern: string
  agentId: string | null
  occurrenceCount: number
  blocked: boolean
  attemptedFixIds: string[]
  evidenceIds: string[]
  firstSeenAt: number
  lastSeenAt: number
}

interface Fix {
  id: string
  failureSignature: string
  fixDescription: string
  targetRef: string
  agentId: string | null
  successCount: number
  lastAppliedAt: number
}

function StatCard({ label, value, color, icon }: { label: string; value: number; color?: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-[var(--bg-surface)] px-4 py-3">
      <div className="flex items-center gap-1.5">
        {icon}
        <p className="text-xs text-muted">{label}</p>
      </div>
      <p className={`text-2xl font-semibold mt-1 ${color ?? 'text-primary'}`}>{value}</p>
    </div>
  )
}

function FailureCard({ f }: { f: Failure }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`rounded-lg border ${f.blocked ? 'border-red-500/40' : 'border-border'} bg-[var(--bg-surface)]`}>
      <div className="px-4 py-3 flex items-start gap-3">
        <span className={`mt-0.5 px-2 py-0.5 rounded text-xs font-medium ${
          f.blocked ? 'bg-red-500/20 text-red-400 border border-red-500/30'
          : f.occurrenceCount >= 2 ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30'
          : 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30'
        }`}>
          {f.blocked ? 'BLOCKED' : `×${f.occurrenceCount}`}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-primary truncate">{f.targetRef}</p>
            <span className="text-xs text-muted">·</span>
            <span className="text-xs text-muted">{f.failureType}</span>
            <span className="text-xs text-muted">·</span>
            <span className="text-xs text-muted">{f.rootCauseClass}</span>
          </div>
          <p className="text-xs text-muted mt-0.5 truncate">{f.errorPattern}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="flex items-center gap-1 text-xs text-muted font-mono">
            <Hash className="w-3 h-3" />{f.signature.slice(0, 8)}
          </span>
          <button onClick={() => setOpen((p) => !p)} className="text-muted hover:text-secondary">
            {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>
      {open && (
        <div className="border-t border-border px-4 py-3 space-y-2 text-xs">
          {f.agentId && <p><span className="text-muted">Agent:</span> <span className="font-mono text-secondary">{f.agentId}</span></p>}
          <p><span className="text-muted">Evidence row IDs:</span> <span className="font-mono text-secondary">{f.evidenceIds.length}</span></p>
          <p><span className="text-muted">Failed fix attempts:</span> <span className="font-mono text-secondary">{f.attemptedFixIds.length}</span></p>
          <p><span className="text-muted">First seen:</span> {new Date(f.firstSeenAt).toLocaleString()}</p>
          <p><span className="text-muted">Last seen:</span> {new Date(f.lastSeenAt).toLocaleString()}</p>
        </div>
      )}
    </div>
  )
}

export default function LearningRuntimePage() {
  const { workspaceId } = useWorkspace()
  const [tab, setTab] = useState<'failures' | 'blocked' | 'fixes' | 'risky' | 'agents'>('failures')

  const { data: stats }    = useQuery({ queryKey: ['lr-stats', workspaceId],    queryFn: () => fetchStats(workspaceId),    enabled: !!workspaceId, refetchInterval: 20_000 })
  const { data: failures = [] } = useQuery({ queryKey: ['lr-failures', workspaceId], queryFn: () => fetchFailures(workspaceId),   enabled: !!workspaceId && (tab === 'failures' || tab === 'blocked'), refetchInterval: 30_000 })
  const { data: fixes = [] }    = useQuery({ queryKey: ['lr-fixes', workspaceId],    queryFn: () => fetchFixes(workspaceId),       enabled: !!workspaceId && tab === 'fixes',    refetchInterval: 30_000 })

  const blockedFailures = failures.filter((f) => f.blocked)

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="shrink-0 px-6 pt-5 pb-4 border-b border-border">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-primary flex items-center gap-2">
              <Brain className="w-4 h-4 text-purple-400" /> Learning Runtime
            </h1>
            <p className="text-xs text-muted mt-0.5">Persisted failure memory · repeat-failure prevention · learned fixes</p>
          </div>
          <RefreshCcw className="w-4 h-4 text-muted" />
        </div>

        {stats && (
          <div className="grid grid-cols-4 gap-2 mt-4">
            <StatCard label="Failure signatures" value={stats.totalFailures}  icon={<AlertTriangle className="w-3 h-3 text-yellow-400" />} />
            <StatCard label="Total occurrences"  value={stats.totalOccurrences} color="text-orange-400" />
            <StatCard label="Blocked"            value={stats.blockedSignatures} color="text-red-400" icon={<ShieldAlert className="w-3 h-3 text-red-400" />} />
            <StatCard label="Learned fixes"      value={stats.totalSuccessfulFixes} color="text-green-400" icon={<CheckCircle2 className="w-3 h-3 text-green-400" />} />
          </div>
        )}

        <div className="flex gap-1 mt-3">
          {[
            { v: 'failures', l: 'Failure Patterns' },
            { v: 'blocked',  l: 'Blocked' },
            { v: 'fixes',    l: 'Learned Fixes' },
            { v: 'risky',    l: 'Risky Files' },
            { v: 'agents',   l: 'Agent Rollback Rates' },
          ].map((t) => (
            <button key={t.v} onClick={() => setTab(t.v as typeof tab)}
              className={`px-3 py-1 rounded text-xs transition-colors ${
                tab === t.v
                  ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                  : 'text-muted hover:text-secondary hover:bg-elevated'
              }`}>{t.l}</button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {tab === 'failures' && (
          <div className="space-y-2 max-w-4xl">
            {failures.length === 0 && <p className="text-sm text-muted">No failures recorded.</p>}
            {failures.map((f) => <FailureCard key={f.id} f={f} />)}
          </div>
        )}

        {tab === 'blocked' && (
          <div className="space-y-2 max-w-4xl">
            {blockedFailures.length === 0 && (
              <p className="text-sm text-muted">No blocked signatures. Agents are not currently refusing any repeat fixes.</p>
            )}
            {blockedFailures.map((f) => <FailureCard key={f.id} f={f} />)}
          </div>
        )}

        {tab === 'fixes' && (
          <div className="space-y-2 max-w-4xl">
            {fixes.length === 0 && <p className="text-sm text-muted">No verified fixes recorded yet.</p>}
            {fixes.map((f) => (
              <div key={f.id} className="rounded-lg border border-green-500/30 bg-[var(--bg-surface)] px-4 py-3">
                <div className="flex items-start gap-3">
                  <span className="px-2 py-0.5 rounded text-xs bg-green-500/20 text-green-400 border border-green-500/30">×{f.successCount}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-primary">{f.fixDescription}</p>
                    <p className="text-xs text-muted mt-0.5 font-mono">{f.targetRef}</p>
                  </div>
                  <span className="text-xs text-muted font-mono"><Hash className="w-3 h-3 inline" /> {f.failureSignature.slice(0, 8)}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'risky' && stats && (
          <div className="space-y-2 max-w-4xl">
            {stats.riskyFiles.length === 0 && <p className="text-sm text-muted">No risky files identified.</p>}
            {stats.riskyFiles.map((rf) => (
              <div key={rf.file} className={`rounded-lg border ${rf.blocked ? 'border-red-500/40' : 'border-border'} bg-[var(--bg-surface)] px-4 py-3 flex items-center gap-3`}>
                <FileWarning className={`w-4 h-4 ${rf.blocked ? 'text-red-400' : 'text-orange-400'} shrink-0`} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-mono text-primary truncate">{rf.file}</p>
                  <p className="text-xs text-muted mt-0.5">
                    {rf.failures} distinct failure pattern(s) · {rf.totalOccurrences} occurrence(s){rf.blocked && ' · BLOCKED'}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'agents' && stats && (
          <div className="space-y-2 max-w-4xl">
            {stats.agentStats.length === 0 && <p className="text-sm text-muted">No agent metrics available.</p>}
            {stats.agentStats.map((a) => (
              <div key={a.agentId} className="rounded-lg border border-border bg-[var(--bg-surface)] px-4 py-3 flex items-center gap-3">
                <Bot className="w-4 h-4 text-muted shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-mono text-primary">{a.agentId}</p>
                  <p className="text-xs text-muted mt-0.5">
                    {a.successes} success · {a.failures} failure · {a.blocked} blocked
                  </p>
                </div>
                <div className="text-right">
                  <p className={`text-sm font-medium ${
                    a.rollbackRate > 0.5 ? 'text-red-400'
                    : a.rollbackRate > 0.2 ? 'text-orange-400'
                    : 'text-green-400'
                  }`}>{(a.rollbackRate * 100).toFixed(1)}%</p>
                  <p className="text-xs text-muted">rollback rate</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
