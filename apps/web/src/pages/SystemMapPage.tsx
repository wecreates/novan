/**
 * System Map — navigable view of services + routes + capabilities.
 * Consumes /api/v1/self/introspect + /discovered-capabilities + /git/snapshots.
 */
import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Map as MapIcon, Cpu, Network, GitCommit, RefreshCw } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

interface Module { file: string; bytes: number; exports: string[] }
interface Introspect {
  generatedAt: number; repoRoot: string
  serviceCount: number; routeCount: number; totalExports: number
  servicesIndex: Module[]; routesIndex: Module[]
}
interface Discovered {
  serviceFile: string; exportsCount: number; maturity: string
  firstSeenAt: number; lastSeenAt: number
}
interface Snapshot {
  gitSha: string; commitMessage: string | null; committedAt: number; filesChanged: number
}

const MATURITY: Record<string, string> = {
  scaffolded: 'text-slate-400 bg-slate-500/10',
  basic:      'text-sky-300 bg-sky-500/10',
  healthy:    'text-emerald-300 bg-emerald-500/10',
  mature:     'text-purple-300 bg-purple-500/10',
}

export default function SystemMapPage() {
  const { workspaceId } = useWorkspace()
  const [filter, setFilter] = useState('')

  const intro = useQuery({
    queryKey: ['introspect'],
    queryFn: () => api.get<{ data: Introspect }>(`/api/v1/self/introspect`),
    refetchInterval: 5 * 60_000,
  })
  const disc = useQuery({
    queryKey: ['discovered', workspaceId],
    queryFn: () => api.get<{ data: Discovered[] }>(`/api/v1/self/discovered-capabilities?workspace_id=${workspaceId}`),
    refetchInterval: 60_000,
  })
  const snaps = useQuery({
    queryKey: ['snapshots', workspaceId],
    queryFn: () => api.get<{ data: Snapshot[] }>(`/api/v1/self/git/snapshots?workspace_id=${workspaceId}&limit=10`),
    refetchInterval: 5 * 60_000,
  })

  const matMap = new Map((disc.data?.data ?? []).map(d => [d.serviceFile, d.maturity]))
  const services = (intro.data?.data?.servicesIndex ?? []).filter(m =>
    !filter || m.file.toLowerCase().includes(filter.toLowerCase()) ||
    m.exports.some(e => e.toLowerCase().includes(filter.toLowerCase())),
  )
  const routes = (intro.data?.data?.routesIndex ?? []).filter(m =>
    !filter || m.file.toLowerCase().includes(filter.toLowerCase()),
  )

  return (
    <div className="p-6 space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center gap-3">
        <MapIcon className="w-5 h-5 text-sky-400" />
        <h1 className="text-xl font-semibold">System Map</h1>
        <span className="text-xs text-[var(--text-muted)] ml-1">
          {intro.data?.data ? `${intro.data.data.serviceCount} services · ${intro.data.data.routeCount} routes · ${intro.data.data.totalExports} exports` : 'loading…'}
        </span>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter…"
          className="ml-auto bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-xs w-48" />
        <button onClick={() => { intro.refetch(); disc.refetch(); snaps.refetch() }}
          className="p-1.5 rounded hover:bg-[var(--surface-hover)]">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Recent commits */}
      <Section title="Recent commits" icon={<GitCommit className="w-4 h-4 text-amber-400" />}>
        {(snaps.data?.data ?? []).length === 0 ? <Empty msg="No snapshots — git not available in container or capture pending." /> : (
          <ul className="divide-y divide-[var(--border)]">
            {snaps.data!.data.slice(0, 6).map(s => (
              <li key={s.gitSha} className="px-4 py-2 text-xs flex items-center gap-3">
                <span className="font-mono text-[var(--text-muted)] w-20">{s.gitSha.slice(0, 8)}</span>
                <span className="text-[var(--text-muted)] w-32">{new Date(s.committedAt).toLocaleDateString()}</span>
                <span className="flex-1 truncate" title={s.commitMessage ?? ''}>{s.commitMessage}</span>
                <span className="text-[10px] text-[var(--text-muted)]">{s.filesChanged} files</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Services */}
      <Section title={`Services (${services.length})`} icon={<Cpu className="w-4 h-4 text-emerald-400" />}>
        <ul className="divide-y divide-[var(--border)] max-h-[40vh] overflow-y-auto">
          {services.map(m => {
            const mat = matMap.get(m.file) ?? 'basic'
            return (
              <li key={m.file} className="px-4 py-2 text-xs flex items-center gap-3">
                <span className="font-mono w-60 truncate" title={m.file}>{m.file}</span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] ${MATURITY[mat] ?? MATURITY.basic}`}>{mat}</span>
                <span className="text-[var(--text-muted)]">{m.exports.length} exports</span>
                <span className="text-[10px] text-[var(--text-muted)] truncate flex-1" title={m.exports.join(', ')}>
                  {m.exports.slice(0, 5).join(', ')}{m.exports.length > 5 ? '…' : ''}
                </span>
              </li>
            )
          })}
        </ul>
      </Section>

      {/* Routes */}
      <Section title={`Routes (${routes.length})`} icon={<Network className="w-4 h-4 text-sky-400" />}>
        <ul className="divide-y divide-[var(--border)] max-h-[30vh] overflow-y-auto">
          {routes.map(m => (
            <li key={m.file} className="px-4 py-2 text-xs flex items-center gap-3">
              <span className="font-mono w-60 truncate" title={m.file}>{m.file}</span>
              <span className="text-[var(--text-muted)]">{m.exports.length} exports</span>
              <span className="text-[10px] text-[var(--text-muted)] truncate flex-1">{m.exports.join(', ')}</span>
            </li>
          ))}
        </ul>
      </Section>
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

function Empty({ msg }: { msg: string }) {
  return <div className="px-4 py-3 text-xs text-[var(--text-muted)] italic">{msg}</div>
}
