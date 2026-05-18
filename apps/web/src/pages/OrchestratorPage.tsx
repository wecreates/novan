/**
 * OrchestratorPage — War Room view of multi-agent orchestrator.
 *
 * Shows:
 * - Registered agents (status, capabilities, health metrics)
 * - Active assignments (status, dependencies, blocked)
 * - Active execution locks
 * - Dependency graph (current batch)
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Bot, Lock, GitMerge, Activity, RefreshCcw, Zap,
  CheckCircle2, AlertTriangle, XCircle, Pause, Wrench,
} from 'lucide-react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

const API = (p: string) => `/api/v1/orchestrator${p}`

async function fetchAgents(ws: string) { const r = await fetch(`${API('/agents')}?workspace_id=${ws}`); return (await r.json()).data as Agent[] }
async function fetchAssignments(ws: string, status?: string) { const q = new URLSearchParams({ workspace_id: ws }); if (status) q.set('status', status); const r = await fetch(`${API('/assignments')}?${q}`); return (await r.json()).data as Assignment[] }
async function fetchLocks(ws: string) { const r = await fetch(`${API('/locks')}?workspace_id=${ws}`); return (await r.json()).data as ExLock[] }
async function fetchGraph(ws: string) { const r = await fetch(`${API('/graph')}?workspace_id=${ws}`); return (await r.json()).data as GraphNode[] }
async function recoverLocks(ws: string) { const r = await fetch(API('/locks/recover'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace_id: ws }) }); return (await r.json()).data as { recovered: number } }

interface Agent {
  id: string; agentName: string; capabilities: string[]; status: string
  lastHeartbeat: number; activeAssignments: number
  successCount: number; failureCount: number; rollbackCount: number
}
interface Assignment {
  id: string; agentId: string; taskKind: string; taskRef: string; status: string
  dependsOn: string[]; priority: number; assignedAt: number; errorMessage: string | null
}
interface ExLock {
  id: string; lockKind: string; resourceKey: string; holderId: string
  holderKind: string; acquiredAt: number; expiresAt: number
}
interface GraphNode {
  id: string; taskKind: string; taskRef: string; agentId: string; status: string; dependsOn: string[]
}

const STATUS_COLORS: Record<string, string> = {
  idle:       'bg-gray-500/20 text-gray-400',
  busy:       'bg-blue-500/20 text-blue-400',
  down:       'bg-red-500/20 text-red-400',
  disabled:   'bg-gray-500/20 text-gray-400',
  restarting: 'bg-yellow-500/20 text-yellow-400',
  assigned:   'bg-blue-500/20 text-blue-400',
  running:    'bg-purple-500/20 text-purple-400',
  complete:   'bg-green-500/20 text-green-400',
  failed:     'bg-red-500/20 text-red-400',
  blocked:    'bg-orange-500/20 text-orange-400',
  cancelled:  'bg-gray-500/20 text-gray-400',
}

const LOCK_COLORS: Record<string, string> = {
  file:     'text-blue-400',
  workflow: 'text-purple-400',
  queue:    'text-orange-400',
  task:     'text-green-400',
}

function StatCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="rounded-lg border border-border bg-[var(--bg-surface)] px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`text-2xl font-semibold mt-1 ${color ?? 'text-primary'}`}>{value}</p>
    </div>
  )
}

export default function OrchestratorPage() {
  const { workspaceId } = useWorkspace()
  const [tab, setTab] = useState<'agents' | 'assignments' | 'locks' | 'graph'>('agents')
  const qc = useQueryClient()

  const { data: agents = [] } = useQuery({ queryKey: ['orch-agents', workspaceId], queryFn: () => fetchAgents(workspaceId), enabled: !!workspaceId, refetchInterval: 10_000 })
  const { data: assignments = [] } = useQuery({ queryKey: ['orch-assignments', workspaceId], queryFn: () => fetchAssignments(workspaceId), enabled: !!workspaceId && tab === 'assignments', refetchInterval: 10_000 })
  const { data: locks = [] } = useQuery({ queryKey: ['orch-locks', workspaceId], queryFn: () => fetchLocks(workspaceId), enabled: !!workspaceId && tab === 'locks', refetchInterval: 10_000 })
  const { data: graph = [] } = useQuery({ queryKey: ['orch-graph', workspaceId], queryFn: () => fetchGraph(workspaceId), enabled: !!workspaceId && tab === 'graph', refetchInterval: 15_000 })

  const recoverMut = useMutation({
    mutationFn: () => recoverLocks(workspaceId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orch-locks'] }),
  })

  const totalActive    = agents.filter((a) => a.status === 'busy' || a.status === 'idle').length
  const totalDown      = agents.filter((a) => a.status === 'down').length
  const totalLocks     = locks.length
  const blockedTasks   = assignments.filter((a) => a.status === 'blocked').length

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="shrink-0 px-6 pt-5 pb-4 border-b border-border">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-primary flex items-center gap-2">
              <GitMerge className="w-4 h-4 text-blue-400" /> Multi-Agent Orchestrator
            </h1>
            <p className="text-xs text-muted mt-0.5">Capability-matched assignments · file/workflow/queue locking · parallel execution</p>
          </div>
          <button onClick={() => qc.invalidateQueries({ queryKey: ['orch-agents'] })} className="text-muted hover:text-secondary">
            <RefreshCcw className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-4 gap-2 mt-4">
          <StatCard label="Healthy agents" value={totalActive} color="text-green-400" />
          <StatCard label="Down agents"    value={totalDown}   color="text-red-400" />
          <StatCard label="Active locks"   value={totalLocks}  color="text-yellow-400" />
          <StatCard label="Blocked tasks"  value={blockedTasks} color="text-orange-400" />
        </div>

        <div className="flex gap-1 mt-3">
          {[
            { v: 'agents',      l: 'Agents',      i: <Bot className="w-3 h-3" /> },
            { v: 'assignments', l: 'Assignments', i: <Activity className="w-3 h-3" /> },
            { v: 'locks',       l: 'Locks',       i: <Lock className="w-3 h-3" /> },
            { v: 'graph',       l: 'Dependency Graph', i: <GitMerge className="w-3 h-3" /> },
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
        {tab === 'agents' && (
          <div className="space-y-2 max-w-4xl">
            {agents.length === 0 && <p className="text-sm text-muted">No agents registered. POST to /agents/register to register one.</p>}
            {agents.map((a) => {
              const total = a.successCount + a.failureCount
              const successPct = total > 0 ? (a.successCount / total) * 100 : 0
              const staleMs = Date.now() - a.lastHeartbeat
              return (
                <div key={a.id} className={`rounded-lg border ${a.status === 'down' ? 'border-red-500/40' : 'border-border'} bg-[var(--bg-surface)] px-4 py-3`}>
                  <div className="flex items-start gap-3">
                    <Bot className="w-4 h-4 text-muted mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-primary">{a.agentName}</p>
                        <span className={`px-2 py-0.5 rounded text-xs capitalize ${STATUS_COLORS[a.status] ?? ''}`}>{a.status}</span>
                      </div>
                      <p className="text-xs font-mono text-muted mt-0.5">{a.id}</p>
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {a.capabilities.map((c) => (
                          <span key={c} className="px-1.5 py-0.5 rounded text-xs bg-elevated text-muted">{c}</span>
                        ))}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className={`text-sm font-medium ${successPct >= 90 ? 'text-green-400' : successPct >= 70 ? 'text-yellow-400' : 'text-red-400'}`}>
                        {total > 0 ? `${successPct.toFixed(0)}%` : '—'}
                      </p>
                      <p className="text-xs text-muted">{a.activeAssignments} active</p>
                      <p className="text-xs text-muted">{a.successCount}✓ / {a.failureCount}✗ / {a.rollbackCount}↩</p>
                      <p className="text-xs text-muted mt-1">heartbeat {Math.floor(staleMs / 1000)}s ago</p>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'assignments' && (
          <div className="space-y-2 max-w-4xl">
            {assignments.length === 0 && <p className="text-sm text-muted">No assignments yet.</p>}
            {assignments.map((a) => (
              <div key={a.id} className="rounded-lg border border-border bg-[var(--bg-surface)] px-4 py-3">
                <div className="flex items-start gap-3">
                  <span className={`mt-0.5 px-2 py-0.5 rounded text-xs capitalize ${STATUS_COLORS[a.status] ?? ''}`}>
                    {a.status === 'blocked' && <Pause className="w-3 h-3 inline mr-0.5" />}
                    {a.status === 'complete' && <CheckCircle2 className="w-3 h-3 inline mr-0.5" />}
                    {a.status === 'failed' && <XCircle className="w-3 h-3 inline mr-0.5" />}
                    {a.status}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-primary">{a.taskKind}: <span className="font-mono text-xs">{a.taskRef}</span></p>
                    <p className="text-xs text-muted mt-0.5">
                      Agent <span className="font-mono">{a.agentId}</span> · priority {a.priority}
                      {a.dependsOn.length > 0 && <> · depends on {a.dependsOn.length} task(s)</>}
                    </p>
                    {a.errorMessage && <p className="text-xs text-red-400 mt-1">{a.errorMessage}</p>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'locks' && (
          <div className="space-y-2 max-w-4xl">
            <div className="flex justify-between items-center mb-2">
              <p className="text-xs text-muted">{locks.length} active lock(s)</p>
              <button onClick={() => recoverMut.mutate()} disabled={recoverMut.isPending}
                className="flex items-center gap-1.5 px-3 py-1 rounded text-xs bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 border border-yellow-500/30 transition-colors disabled:opacity-50">
                <Wrench className="w-3 h-3" /> {recoverMut.isPending ? 'Recovering…' : 'Sweep stale'}
              </button>
            </div>
            {recoverMut.data && (
              <div className="text-xs text-green-400 mb-2">Recovered {recoverMut.data.recovered} stale lock(s)</div>
            )}
            {locks.length === 0 && <p className="text-sm text-muted">No active locks.</p>}
            {locks.map((l) => {
              const remainingMs = l.expiresAt - Date.now()
              const stale = remainingMs <= 0
              return (
                <div key={l.id} className={`rounded-lg border ${stale ? 'border-orange-500/30' : 'border-border'} bg-[var(--bg-surface)] px-4 py-3 flex items-center gap-3`}>
                  <Lock className={`w-4 h-4 ${LOCK_COLORS[l.lockKind] ?? ''} shrink-0`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-mono text-primary truncate">{l.lockKind}: {l.resourceKey}</p>
                    <p className="text-xs text-muted mt-0.5">held by <span className="font-mono">{l.holderId}</span> ({l.holderKind})</p>
                  </div>
                  <div className="text-right">
                    {stale ? (
                      <span className="text-xs text-orange-400 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />stale</span>
                    ) : (
                      <span className="text-xs text-muted">expires in {Math.floor(remainingMs / 1000)}s</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {tab === 'graph' && (
          <div className="space-y-2 max-w-4xl">
            {graph.length === 0 && <p className="text-sm text-muted">No recent assignments to visualize.</p>}
            <p className="text-xs text-muted mb-2">
              Showing {graph.length} assignment(s) from last 6h. Parallel = no shared dependencies.
            </p>
            {graph.map((n) => (
              <div key={n.id} className="rounded-lg border border-border bg-[var(--bg-surface)] px-4 py-3">
                <div className="flex items-center gap-3">
                  <Zap className={`w-4 h-4 shrink-0 ${n.dependsOn.length === 0 ? 'text-green-400' : 'text-blue-400'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm text-primary">{n.taskKind}: <span className="font-mono text-xs">{n.taskRef.slice(0, 24)}</span></p>
                      <span className={`px-1.5 py-0.5 rounded text-xs capitalize ${STATUS_COLORS[n.status] ?? ''}`}>{n.status}</span>
                    </div>
                    <p className="text-xs text-muted mt-0.5">
                      {n.dependsOn.length === 0 ? <span className="text-green-400">runnable in parallel</span>
                        : <>depends on {n.dependsOn.length} task(s)</>}
                      {' · '}agent <span className="font-mono">{n.agentId}</span>
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
