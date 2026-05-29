/**
 * AgencyPage — agent catalog browser + CEO delegation console.
 *
 * Left rail: department list with counts.
 * Middle:    agent grid for the selected department (or search results).
 * Right:     selected-agent preview + "Delegate to brain (CEO)" form.
 *
 * The brain (CEO orchestrator) is the actor here — when you submit a
 * task, it picks the best-matching agent from the catalog and runs
 * the agent's system prompt through the existing LLM provider chain.
 */
import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Crown, RefreshCw, Search, Send, Loader2, AlertTriangle,
  Network, ChevronRight, Sparkles, Clock,
} from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'
import { PageHeader } from '../components/PageHeader.js'
import { EmptyState } from '../components/EmptyState.js'

interface AgentDef {
  id:           string
  slug:         string
  department:   string
  name:         string
  description:  string | null
  color:        string | null
  emoji:        string | null
  vibe:         string | null
  tags:         string[]
  systemPrompt?: string
}
interface DeptCount { department: string; count: number }
interface CatalogStatus {
  root:    string
  exists:  boolean
  mdCount: number
  inDb:    number
}
interface DelegationRow {
  id: string; slug?: string; department: string; task: string
  status: string; createdAt: number; completedAt: number | null
  result: string | null; tokens: number; costUsd: number
  provider: string | null; model: string | null; error: string | null
  definitionId: string
}

export default function AgencyPage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const [department, setDepartment] = useState<string | null>(null)
  const [query,      setQuery]      = useState('')
  const [selected,   setSelected]   = useState<string | null>(null)
  const [task,       setTask]       = useState('')
  const [hint,       setHint]       = useState('')
  const [lastDelegation, setLastDelegation] = useState<DelegationRow | null>(null)

  const status = useQuery({
    queryKey: ['agency-status', workspaceId],
    queryFn:  () => api.get<{ data: CatalogStatus }>(`/api/v1/agency/catalog/status?workspace_id=${workspaceId}`),
    refetchInterval: 30_000,
  })

  const depts = useQuery({
    queryKey: ['agency-departments', workspaceId],
    queryFn:  () => api.get<{ data: DeptCount[] }>(`/api/v1/agency/departments?workspace_id=${workspaceId}`),
  })

  const defs = useQuery({
    queryKey: ['agency-definitions', workspaceId, department, query],
    queryFn:  () => {
      const params = new URLSearchParams({ workspace_id: workspaceId })
      if (department) params.set('department', department)
      if (query.trim()) params.set('q', query.trim())
      return api.get<{ data: AgentDef[] }>(`/api/v1/agency/definitions?${params}`)
    },
  })

  const detail = useQuery({
    queryKey: ['agency-definition', workspaceId, selected],
    queryFn:  () => selected
      ? api.get<{ data: AgentDef }>(`/api/v1/agency/definitions/${selected}?workspace_id=${workspaceId}`)
      : Promise.resolve({ data: null as AgentDef | null }),
    enabled: !!selected,
  })

  const delegations = useQuery({
    queryKey: ['agency-delegations', workspaceId],
    queryFn:  () => api.get<{ data: DelegationRow[] }>(`/api/v1/agency/delegations?workspace_id=${workspaceId}&limit=10`),
    refetchInterval: lastDelegation && lastDelegation.status === 'pending' ? 2_000 : 30_000,
  })

  const sync = useMutation({
    mutationFn: () => api.post(`/api/v1/agency/catalog/sync`, { workspace_id: workspaceId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agency-status', workspaceId] })
      qc.invalidateQueries({ queryKey: ['agency-departments', workspaceId] })
      qc.invalidateQueries({ queryKey: ['agency-definitions', workspaceId] })
    },
  })

  const delegate = useMutation<{ data: DelegationRow }, Error, void>({
    mutationFn: () => api.post(`/api/v1/agency/delegate`, {
      workspace_id: workspaceId,
      task,
      ...(hint.trim() ? { hint: hint.trim() } : {}),
      ...(selected   ? { hint: selected   } : {}),
    }),
    onSuccess: (res) => {
      setLastDelegation(res.data)
      qc.invalidateQueries({ queryKey: ['agency-delegations', workspaceId] })
    },
  })

  const deptRows  = depts.data?.data ?? []
  const defRows   = defs.data?.data ?? []
  const selDetail = detail.data?.data
  const recent    = delegations.data?.data ?? []
  const st        = status.data?.data

  const departmentLabel = (d: string) =>
    d.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

  const emptyCatalog = (st?.inDb ?? 0) === 0

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <PageHeader
        breadcrumb="Brain · CEO"
        title="Agency"
        subtitle="Catalog of 200+ specialized agents. The brain (CEO) routes tasks to the best one."
        actions={
          <>
            <button onClick={() => sync.mutate()}
              disabled={sync.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[var(--border)] hover:border-[var(--border-strong)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-ring disabled:opacity-40">
              {sync.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              {sync.isPending ? 'Importing…' : 'Sync catalog'}
            </button>
          </>
        }
      />

      {/* Status strip */}
      <section className="panel p-3 mb-5 flex items-center gap-3 text-xs">
        <Crown className="w-4 h-4 text-[var(--accent-active)]" />
        <span className="text-[var(--text-primary)]">
          {st?.inDb ?? 0} agents loaded
        </span>
        <span className="text-[var(--text-muted)]">·</span>
        <span className="text-[var(--text-muted)] font-mono truncate">{st?.root ?? '—'}</span>
        {st && st.exists && st.mdCount !== st.inDb && (
          <span className="ml-auto text-[var(--accent-warning)] flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" />
            {st.mdCount} on disk, {st.inDb} in DB — sync recommended
          </span>
        )}
      </section>

      <CeoDashboard workspaceId={workspaceId} />

      {emptyCatalog && (
        <EmptyState
          icon={<Network className="w-8 h-8" />}
          title="Catalog empty"
          description="Click ‘Sync catalog’ to import the agency-agents-main markdown corpus from disk."
        />
      )}

      {!emptyCatalog && (
        <div className="grid grid-cols-1 lg:grid-cols-[200px,1fr,360px] gap-4">
          {/* Departments rail */}
          <aside className="panel p-3 max-h-[70vh] overflow-y-auto">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)] mb-2">Departments</h3>
            <button onClick={() => setDepartment(null)}
              className={`w-full text-left px-2 py-1.5 rounded-md text-[12px] flex items-center justify-between mb-0.5 transition-colors focus-ring ${
                department === null
                  ? 'bg-[var(--bg-elevated)] text-[var(--accent-active)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]'
              }`}>
              <span>All</span>
              <span className="text-[10px] text-[var(--text-muted)]">{deptRows.reduce((s, d) => s + d.count, 0)}</span>
            </button>
            {deptRows.map(d => (
              <button key={d.department} onClick={() => setDepartment(d.department)}
                className={`w-full text-left px-2 py-1.5 rounded-md text-[12px] flex items-center justify-between mb-0.5 transition-colors focus-ring ${
                  department === d.department
                    ? 'bg-[var(--bg-elevated)] text-[var(--accent-active)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]'
                }`}>
                <span>{departmentLabel(d.department)}</span>
                <span className="text-[10px] text-[var(--text-muted)]">{d.count}</span>
              </button>
            ))}
          </aside>

          {/* Agent grid */}
          <section className="min-w-0">
            <div className="flex items-center gap-2 mb-3">
              <div className="flex-1 relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)] pointer-events-none" />
                <input value={query} onChange={e => setQuery(e.target.value)}
                  placeholder={department ? `Search in ${departmentLabel(department)}…` : 'Search all agents…'}
                  className="input pl-8 w-full" />
              </div>
              <span className="text-[11px] text-[var(--text-muted)] whitespace-nowrap">{defRows.length} match</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-[60vh] overflow-y-auto pr-1">
              {defRows.map(a => {
                const active = a.slug === selected
                return (
                  <button key={a.id} onClick={() => setSelected(a.slug)}
                    className={`panel text-left p-3 flex items-start gap-3 transition-colors focus-ring ${
                      active ? 'ring-1 ring-[var(--accent-active)] border-[var(--accent-active)]' : 'hover:border-[var(--border-strong)]'
                    }`}>
                    <span className="w-8 h-8 rounded-md bg-[var(--bg-elevated)] flex items-center justify-center text-lg shrink-0">
                      {a.emoji ?? '·'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-[var(--text-primary)] truncate">{a.name}</div>
                      <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">{departmentLabel(a.department)}</div>
                      <div className="text-[11px] text-[var(--text-secondary)] line-clamp-2 mt-1">{a.vibe ?? a.description ?? '—'}</div>
                    </div>
                  </button>
                )
              })}
              {defRows.length === 0 && !defs.isLoading && (
                <div className="col-span-full text-center text-[12px] text-[var(--text-muted)] py-8">
                  No agents in this view. Try the search box or pick another department.
                </div>
              )}
            </div>
          </section>

          {/* Detail + delegation */}
          <aside className="panel p-4 flex flex-col gap-4 max-h-[70vh] overflow-y-auto">
            {selDetail ? (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-2xl">{selDetail.emoji ?? '·'}</span>
                  <div className="min-w-0">
                    <div className="text-[14px] font-medium text-[var(--text-primary)] truncate">{selDetail.name}</div>
                    <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{departmentLabel(selDetail.department)} · {selDetail.slug}</div>
                  </div>
                </div>
                {selDetail.vibe && <p className="text-[11px] text-[var(--text-secondary)] italic mb-2">“{selDetail.vibe}”</p>}
                {selDetail.description && <p className="text-[12px] text-[var(--text-secondary)] mb-3">{selDetail.description}</p>}
                {selDetail.tags && selDetail.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-3">
                    {selDetail.tags.slice(0, 8).map(t => (
                      <span key={t} className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)]">{t}</span>
                    ))}
                  </div>
                )}
                {selDetail.systemPrompt && (
                  <details>
                    <summary className="text-[11px] text-[var(--text-muted)] cursor-pointer hover:text-[var(--text-secondary)]">
                      System prompt ({selDetail.systemPrompt.length} chars)
                    </summary>
                    <pre className="mt-2 text-[10px] font-mono whitespace-pre-wrap text-[var(--text-muted)] max-h-48 overflow-y-auto">
                      {selDetail.systemPrompt}
                    </pre>
                  </details>
                )}
              </div>
            ) : (
              <div className="text-[12px] text-[var(--text-muted)] text-center py-4">
                Pick an agent to preview, or just describe a task below and let the CEO route it.
              </div>
            )}

            {/* Delegation form */}
            <div className="border-t border-[var(--border)] pt-3">
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)] mb-2 flex items-center gap-1.5">
                <Crown className="w-3 h-3 text-[var(--accent-active)]" />
                Delegate to the brain
              </h3>
              <textarea value={task} onChange={e => setTask(e.target.value)}
                rows={3}
                placeholder="Describe what you need done. The CEO picks the right agent."
                className="input w-full mb-2 resize-none text-[12px]" />
              <input value={hint} onChange={e => setHint(e.target.value)}
                placeholder="Optional hint (department or agent slug)"
                className="input w-full mb-2 text-[11px] font-mono" />
              <button onClick={() => delegate.mutate()}
                disabled={delegate.isPending || !task.trim()}
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md bg-[var(--accent-active)]/15 border border-[var(--accent-active)]/40 hover:bg-[var(--accent-active)]/25 text-[var(--accent-active)] text-[12px] disabled:opacity-40 focus-ring">
                {delegate.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                {delegate.isPending ? 'CEO routing…' : 'Send to CEO'}
              </button>
              {delegate.isError && (
                <div className="mt-2 text-[11px] text-[var(--accent-critical)] flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  {(delegate.error as Error).message}
                </div>
              )}
            </div>

            {/* Last result */}
            {lastDelegation?.result && (
              <div className="border-t border-[var(--border)] pt-3">
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)] mb-2 flex items-center gap-1.5">
                  <Sparkles className="w-3 h-3 text-[var(--accent-healthy)]" />
                  Agent response
                </h3>
                <pre className="text-[11px] whitespace-pre-wrap text-[var(--text-primary)] max-h-64 overflow-y-auto">
                  {lastDelegation.result}
                </pre>
                <div className="text-[10px] text-[var(--text-muted)] mt-2">
                  {lastDelegation.tokens} tokens · ${lastDelegation.costUsd.toFixed(4)} · {lastDelegation.model}
                </div>
              </div>
            )}
          </aside>
        </div>
      )}

      {/* Recent delegations */}
      {recent.length > 0 && (
        <section className="mt-6">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)] mb-2 flex items-center gap-1.5">
            <Clock className="w-3 h-3" /> Recent delegations
          </h2>
          <div className="space-y-1.5">
            {recent.map(r => (
              <div key={r.id} className="panel p-2.5 flex items-center gap-3 text-[12px]">
                <span className={`w-1.5 h-1.5 rounded-full ${
                  r.status === 'succeeded' ? 'bg-[var(--accent-healthy)]'
                  : r.status === 'failed'  ? 'bg-[var(--accent-critical)]'
                                           : 'bg-[var(--accent-warning)]'
                }`} />
                <span className="text-[var(--text-muted)] uppercase text-[10px] tracking-wider w-24 shrink-0 truncate">{r.department}</span>
                <span className="flex-1 text-[var(--text-primary)] truncate">{r.task}</span>
                <span className="text-[var(--text-muted)] text-[10px] shrink-0">
                  {r.completedAt ? `${r.tokens} tok` : r.status}
                </span>
                <ChevronRight className="w-3 h-3 text-[var(--text-muted)] shrink-0" />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

// ─── CEO dashboard ─────────────────────────────────────────────────────
interface DeptRollup { department: string; count: number; recent: number; succeeded: number; failed: number }
interface BusinessRow { id: string; name: string; stage: string; health: string; metadata: { responsibleDepartments?: string[] } }
interface CycleResult { delegationsCreated: number; chainsRecorded: number; divisionsRed: number; divisionsYellow: number; businessesObserved: number; durationMs: number }

function CeoDashboard({ workspaceId }: { workspaceId: string }) {
  const qc = useQueryClient()
  const depts = useQuery({
    queryKey: ['ceo-departments', workspaceId],
    queryFn:  () => api.get<{ data: DeptRollup[] }>(`/api/v1/agency/ceo/departments?workspace_id=${workspaceId}`),
    refetchInterval: 60_000,
  })
  const biz = useQuery({
    queryKey: ['businesses', workspaceId],
    queryFn:  () => api.get<{ data: BusinessRow[] }>(`/api/v1/businesses?workspace_id=${workspaceId}`),
  })
  const cycle = useMutation<{ data: CycleResult }, Error, void>({
    mutationFn: () => api.post(`/api/v1/agency/ceo/cycle`, { workspace_id: workspaceId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ceo-departments', workspaceId] })
      qc.invalidateQueries({ queryKey: ['agency-delegations', workspaceId] })
    },
  })
  const totalAgents = (depts.data?.data ?? []).reduce((s, d) => s + d.count, 0)
  const activeDepts = (depts.data?.data ?? []).filter(d => d.recent > 0).length
  return (
    <section className="panel p-4 mb-5">
      <div className="flex items-center gap-2 mb-3">
        <Crown className="w-4 h-4 text-[var(--accent-active)]" />
        <h3 className="text-sm font-medium text-[var(--text-primary)]">CEO orchestration</h3>
        <span className="text-[10px] text-[var(--text-muted)]">
          {totalAgents} agents · {activeDepts}/{depts.data?.data?.length ?? 0} depts active in 7d · {biz.data?.data?.length ?? 0} businesses
        </span>
        <button onClick={() => cycle.mutate()} disabled={cycle.isPending}
          className="ml-auto inline-flex items-center gap-1.5 px-3 py-1 rounded-md bg-[var(--accent)] text-white text-xs hover:opacity-90 disabled:opacity-40">
          {cycle.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
          Run CEO cycle
        </button>
      </div>
      {cycle.data && (
        <div className="text-[11px] text-[var(--text-muted)] mb-3 px-2 py-1.5 bg-[var(--surface-elev)] rounded">
          Last cycle: <strong className="text-[var(--text-primary)]">{cycle.data.data.delegationsCreated} delegations</strong>, {cycle.data.data.chainsRecorded} chains, {cycle.data.data.divisionsRed} red + {cycle.data.data.divisionsYellow} yellow divisions over {cycle.data.data.businessesObserved} businesses · {cycle.data.data.durationMs}ms
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <h4 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)] mb-1.5">Departments (7d activity)</h4>
          <ul className="space-y-0.5 text-[11px] max-h-[200px] overflow-y-auto">
            {(depts.data?.data ?? []).slice(0, 12).map(d => (
              <li key={d.department} className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-[var(--surface-hover)]">
                <span className="font-mono flex-1 truncate">{d.department}</span>
                <span className="text-[var(--text-muted)]">{d.count} agt</span>
                {d.recent > 0 && <span className="text-[var(--accent)]">{d.recent} dlg</span>}
                {d.failed > 0 && <span className="text-[var(--error)]">{d.failed} ✗</span>}
              </li>
            ))}
            {(depts.data?.data ?? []).length === 0 && (
              <li className="text-[var(--text-muted)] italic px-1.5 py-1">No departments yet — sync catalog first.</li>
            )}
          </ul>
        </div>
        <div>
          <h4 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)] mb-1.5">Businesses under management</h4>
          <ul className="space-y-1 text-[11px] max-h-[200px] overflow-y-auto">
            {(biz.data?.data ?? []).map(b => (
              <li key={b.id} className="px-2 py-1.5 rounded border border-[var(--border)]">
                <div className="flex items-center gap-2">
                  <span className="font-medium flex-1 truncate">{b.name}</span>
                  <span className={`text-[10px] px-1.5 rounded ${b.health === 'green' ? 'bg-emerald-500/15 text-emerald-400' : b.health === 'yellow' ? 'bg-amber-500/15 text-amber-400' : 'bg-rose-500/15 text-rose-400'}`}>{b.health}</span>
                  <span className="text-[10px] text-[var(--text-muted)]">{b.stage}</span>
                </div>
                <div className="text-[10px] text-[var(--text-muted)] mt-0.5 font-mono">
                  {(b.metadata?.responsibleDepartments ?? []).join(' · ') || '(no departments mapped)'}
                </div>
              </li>
            ))}
            {(biz.data?.data ?? []).length === 0 && (
              <li className="text-[var(--text-muted)] italic px-1.5 py-1">No businesses yet.</li>
            )}
          </ul>
        </div>
      </div>
    </section>
  )
}
