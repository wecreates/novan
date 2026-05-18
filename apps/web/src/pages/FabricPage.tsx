/**
 * Fabric — distributed runtime nodes + scaling events.
 */
import React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Network, Activity, TrendingUp, AlertTriangle } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

interface Node { id: string; region: string; role: string; status: string; capacity: number; activeLoad: number; queueDepth: number; lastHeartbeatAt: number }
interface ScalingEvent { id: string; kind: string; target: string; before: number | null; after: number | null; reason: string; approvedBy: string | null; createdAt: number }
interface Snapshot {
  totalNodes: number
  nodes: Node[]
  byRegion: Record<string, { healthy: number; degraded: number; down: number; isolated: number }>
  byRole: Record<string, { healthy: number; total: number; load: number; capacity: number; queueDepth: number }>
  recentScalingEvents: ScalingEvent[]
}

const STATUS: Record<string, string> = {
  healthy:  'text-emerald-300 bg-emerald-500/10',
  degraded: 'text-amber-300 bg-amber-500/10',
  down:     'text-red-300 bg-red-500/10',
  isolated: 'text-slate-300 bg-slate-500/10',
}

export default function FabricPage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const snap = useQuery({
    queryKey: ['fabric', workspaceId],
    queryFn: () => api.get<{ data: Snapshot }>(`/api/v1/fabric/snapshot?workspace_id=${workspaceId}`),
    refetchInterval: 30_000,
  })

  const runScaling = useMutation({
    mutationFn: () => api.post(`/api/v1/fabric/scaling/run`, { workspace_id: workspaceId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fabric', workspaceId] }),
  })

  const d = snap.data?.data
  return (
    <div className="p-6 space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center gap-3">
        <Network className="w-5 h-5 text-sky-400" />
        <h1 className="text-xl font-semibold">Runtime Fabric</h1>
        <span className="text-xs text-muted ml-1">
          {d ? `${d.totalNodes} nodes · ${Object.keys(d.byRegion).length} regions` : 'loading…'}
        </span>
        <button onClick={() => runScaling.mutate()} disabled={runScaling.isPending}
          className="ml-auto px-3 py-1.5 text-xs rounded border border-border hover:bg-[var(--surface-hover)] flex items-center gap-1.5">
          <TrendingUp className="w-3.5 h-3.5" /> {runScaling.isPending ? 'Running…' : 'Run scaling cycle'}
        </button>
      </div>

      {/* By region */}
      {d && Object.keys(d.byRegion).length > 0 && (
        <Section title="By region" icon={<Network className="w-4 h-4 text-purple-400" />}>
          <ul className="divide-y divide-[var(--border)]">
            {Object.entries(d.byRegion).map(([region, s]) => (
              <li key={region} className="px-4 py-2 text-sm flex items-center gap-4">
                <span className="font-mono">{region}</span>
                <span className="text-emerald-300 text-xs">{s.healthy} healthy</span>
                {s.degraded > 0 && <span className="text-amber-300 text-xs">{s.degraded} degraded</span>}
                {s.down > 0 && <span className="text-red-300 text-xs">{s.down} down</span>}
                {s.isolated > 0 && <span className="text-slate-300 text-xs">{s.isolated} isolated</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* By role */}
      {d && Object.keys(d.byRole).length > 0 && (
        <Section title="By role" icon={<Activity className="w-4 h-4 text-emerald-400" />}>
          <ul className="divide-y divide-[var(--border)]">
            {Object.entries(d.byRole).map(([role, s]) => {
              const util = s.capacity > 0 ? (s.load / s.capacity) : 0
              return (
                <li key={role} className="px-4 py-2 text-sm flex items-center gap-3">
                  <span className="font-mono w-20">{role}</span>
                  <span className="text-muted">{s.healthy}/{s.total} healthy</span>
                  <span className={`text-xs ${util > 0.75 ? 'text-amber-300' : util > 0.5 ? 'text-sky-300' : 'text-muted'}`}>
                    util {(util * 100).toFixed(0)}%
                  </span>
                  <span className="ml-auto text-muted text-xs">queue {s.queueDepth}</span>
                </li>
              )
            })}
          </ul>
        </Section>
      )}

      {/* Nodes */}
      <Section title={`Nodes (${d?.nodes.length ?? 0})`} icon={<Network className="w-4 h-4 text-sky-400" />}>
        {(d?.nodes ?? []).length === 0 ? (
          <Empty msg="No nodes registered. POST /api/v1/fabric/nodes/register to add one." />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {d!.nodes.map(n => (
              <li key={n.id} className="px-4 py-2 text-xs flex items-center gap-3">
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS[n.status] ?? STATUS.healthy}`}>{n.status}</span>
                <span className="font-mono w-32 truncate">{n.id}</span>
                <span className="text-muted w-16">{n.region}</span>
                <span className="font-mono w-16">{n.role}</span>
                <span className="text-muted">load {n.activeLoad}/{n.capacity}</span>
                <span className="text-muted">queue {n.queueDepth}</span>
                <span className="ml-auto text-[10px] text-muted">{Math.floor((Date.now() - n.lastHeartbeatAt) / 1000)}s ago</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Scaling events */}
      <Section title={`Scaling events (${d?.recentScalingEvents.length ?? 0})`} icon={<TrendingUp className="w-4 h-4 text-amber-400" />}>
        {(d?.recentScalingEvents ?? []).length === 0 ? (
          <Empty msg="No scaling events. Cron runs every 2min; manual trigger via 'Run scaling cycle'." />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {d!.recentScalingEvents.slice(0, 10).map(e => (
              <li key={e.id} className="px-4 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-muted w-20">{new Date(e.createdAt).toLocaleTimeString()}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${e.kind === 'scale_up' ? 'bg-sky-500/10 text-sky-300' : e.kind === 'scale_down' ? 'bg-slate-500/10 text-slate-300' : 'bg-amber-500/10 text-amber-300'}`}>{e.kind}</span>
                  <span className="font-mono">{e.target}</span>
                  {e.before !== null && e.after !== null && (
                    <span className="text-muted">{e.before} → {e.after}</span>
                  )}
                  <span className="text-[10px] text-muted ml-auto">{e.approvedBy}</span>
                </div>
                <p className="text-[10px] text-muted mt-0.5">{e.reason}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}

function Section({ title, icon, children }: { title: string; icon?: JSX.Element; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-medium text-primary">{title}</h3>
      </div>
      {children}
    </div>
  )
}

function Empty({ msg }: { msg: string }) {
  return <div className="px-4 py-3 text-xs text-muted italic">{msg}</div>
}
