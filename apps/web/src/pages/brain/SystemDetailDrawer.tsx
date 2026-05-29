/**
 * SystemDetailDrawer — right-side panel rendered on /brain when a
 * persistent business system chip is clicked.
 *
 * Shows everything we know about the system + action buttons that
 * close the loop: delegate the system's work via the CEO orchestrator,
 * change status, rename, edit summary.
 *
 * Honest scope:
 *   - Every field is read from the persisted DB row, not synthesized.
 *   - "Delegate" hands off to the existing CEO orchestrator with the
 *     system's agent_slug pre-filled. The agent's actual response
 *     comes back as a real agent_delegations row.
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  X, Send, Loader2, Pause, Play, Archive, Edit3, Check, Crown,
  AlertTriangle, ExternalLink,
} from 'lucide-react'
import { api } from '../../api.js'
import { useWorkspace } from '../../contexts/WorkspaceContext.js'
import type { BusinessSystem } from '../../hooks/useBusinessGraph.js'

interface Props {
  system:   BusinessSystem
  onClose:  () => void
}

const LAYER_ACCENT: Record<BusinessSystem['layer'], string> = {
  executive: '#8B7CFF', operations: '#3DDC97', finance: '#E6B86A',
  creative:  '#D67BA6', growth: '#5BAFFF', intelligence: '#5BAFFF', security: '#E69B6A',
}

export function SystemDetailDrawer({ system, onClose }: Props) {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const accent = LAYER_ACCENT[system.layer]
  const [renameMode, setRenameMode] = useState(false)
  const [renameValue, setRenameValue] = useState(system.name)
  const [summaryMode, setSummaryMode] = useState(false)
  const [summaryValue, setSummaryValue] = useState(system.summary ?? '')
  const [task, setTask] = useState('')
  const [delegationResult, setDelegationResult] = useState<string | null>(null)

  // Fetch fresh detail (drawer might out-live the parent's list query)
  const detail = useQuery({
    queryKey: ['business-system-detail', system.businessId, system.id],
    queryFn:  () => api.get<{ data: BusinessSystem }>(`/api/v1/businesses/${system.businessId}/systems/${system.id}`)
                       .then(r => r.data),
    initialData: system,
    refetchInterval: 15_000,
  })
  const s = detail.data ?? system

  // Agent definition lookup (for "Open agent" link + display)
  const agentDef = useQuery({
    queryKey: ['agency-def', s.agentSlug],
    queryFn:  () => s.agentSlug
      ? api.get<{ data: { name: string; emoji: string; vibe: string | null } }>(`/api/v1/agency/definitions/${s.agentSlug}?workspace_id=${workspaceId}`)
          .then(r => r.data)
      : Promise.resolve(null),
    enabled: !!s.agentSlug,
    staleTime: 5 * 60_000,
  })

  // Mutations
  const patchSystem = useMutation({
    mutationFn: (patch: Partial<{ name: string; summary: string; status: string }>) =>
      api.patch(`/api/v1/businesses/${system.businessId}/systems/${system.id}`, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['business-system-detail', system.businessId, system.id] })
      qc.invalidateQueries({ queryKey: ['business-systems', workspaceId, system.businessId] })
    },
  })

  const delegate = useMutation({
    mutationFn: () => api.post<{ data: { result: string; tokens: number; costUsd: number } }>(
      `/api/v1/agency/delegate`,
      { workspace_id: workspaceId, task, ...(s.agentSlug ? { hint: s.agentSlug } : {}) },
    ).then(r => r.data),
    onSuccess: (r) => { setDelegationResult(r.result); setTask('') },
  })

  const statusActions: Array<{ next: BusinessSystem['status']; label: string; icon: typeof Pause }> = [
    { next: 'active',   label: 'Activate', icon: Play },
    { next: 'paused',   label: 'Pause',    icon: Pause },
    { next: 'archived', label: 'Archive',  icon: Archive },
  ].filter(a => a.next !== s.status) as typeof statusActions

  return (
    <aside
      className="absolute top-0 right-0 h-full w-[360px] bg-[var(--bg-surface)]/95 backdrop-blur-md border-l border-[var(--border)] z-overlay flex flex-col"
      role="dialog"
      aria-label={`Details for ${s.name}`}
    >
      {/* Header */}
      <header className="p-4 border-b border-[var(--border)] flex items-start gap-3">
        <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
          style={{ background: `${accent}1A`, boxShadow: `0 0 0 1px ${accent}40`, color: accent }}>
          <Crown className="w-4 h-4" strokeWidth={1.6} />
        </div>
        <div className="flex-1 min-w-0">
          {renameMode ? (
            <div className="flex items-center gap-1">
              <input value={renameValue} onChange={e => setRenameValue(e.target.value)}
                className="input flex-1 text-[13px] py-1" autoFocus />
              <button onClick={() => { patchSystem.mutate({ name: renameValue }); setRenameMode(false) }}
                className="w-7 h-7 rounded-md hover:bg-[var(--surface-hover)] flex items-center justify-center text-[var(--accent-healthy)] focus-ring">
                <Check className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => { setRenameValue(s.name); setRenameMode(false) }}
                className="w-7 h-7 rounded-md hover:bg-[var(--surface-hover)] flex items-center justify-center text-[var(--text-muted)] focus-ring">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <h2 className="text-[15px] font-medium text-[var(--text-primary)] truncate">{s.name}</h2>
              <button onClick={() => setRenameMode(true)}
                className="opacity-0 group-hover:opacity-100 hover:opacity-100 transition-opacity p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-ring rounded">
                <Edit3 className="w-3 h-3" />
              </button>
            </div>
          )}
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mt-0.5">
            {s.kind.replace('_', ' ')} · {s.layer}
          </div>
        </div>
        <button onClick={onClose}
          aria-label="Close drawer"
          className="w-7 h-7 rounded-md hover:bg-[var(--surface-hover)] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-ring">
          <X className="w-4 h-4" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Status */}
        <section>
          <h3 className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)] mb-1.5">Status</h3>
          <div className="flex items-center gap-2 mb-2">
            <span className={`px-2 py-0.5 rounded-md text-[11px] border ${
              s.status === 'active'   ? 'border-[var(--accent-healthy)]/40 text-[var(--accent-healthy)] bg-[var(--accent-healthy)]/10' :
              s.status === 'paused'   ? 'border-[var(--accent-warning)]/40 text-[var(--accent-warning)] bg-[var(--accent-warning)]/10' :
              s.status === 'archived' ? 'border-[var(--border)] text-[var(--text-muted)]' :
                                        'border-[var(--accent-active)]/40 text-[var(--accent-active)] bg-[var(--accent-active)]/10'
            }`}>{s.status}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {statusActions.map(({ next, label, icon: Icon }) => (
              <button key={next}
                onClick={() => patchSystem.mutate({ status: next })}
                disabled={patchSystem.isPending}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-[var(--border)] hover:border-[var(--border-strong)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-ring disabled:opacity-40 transition-colors">
                <Icon className="w-3 h-3" /> {label}
              </button>
            ))}
          </div>
        </section>

        {/* Summary */}
        <section>
          <div className="flex items-center justify-between mb-1.5">
            <h3 className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)]">Summary</h3>
            {!summaryMode && (
              <button onClick={() => setSummaryMode(true)}
                className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] focus-ring rounded px-1">
                edit
              </button>
            )}
          </div>
          {summaryMode ? (
            <div className="space-y-1.5">
              <textarea value={summaryValue} onChange={e => setSummaryValue(e.target.value)}
                rows={3}
                className="input w-full resize-none text-[12px]" autoFocus />
              <div className="flex gap-1.5">
                <button onClick={() => { patchSystem.mutate({ summary: summaryValue }); setSummaryMode(false) }}
                  className="px-2 py-1 rounded-md bg-[var(--accent-active)]/15 border border-[var(--accent-active)]/40 text-[11px] text-[var(--accent-active)] focus-ring">Save</button>
                <button onClick={() => { setSummaryValue(s.summary ?? ''); setSummaryMode(false) }}
                  className="px-2 py-1 rounded-md border border-[var(--border)] text-[11px] text-[var(--text-muted)] focus-ring">Cancel</button>
              </div>
            </div>
          ) : (
            <p className="text-[12px] text-[var(--text-secondary)] leading-relaxed">
              {s.summary || <span className="text-[var(--text-muted)] italic">no summary yet</span>}
            </p>
          )}
        </section>

        {/* Agent */}
        {s.agentSlug && (
          <section>
            <h3 className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)] mb-1.5">Assigned agent</h3>
            <a href={`/agency`}
              className="flex items-center gap-2 p-2 rounded-md bg-[var(--bg-elevated)] border border-[var(--border)] hover:border-[var(--border-strong)] transition-colors">
              <span className="text-xl">{agentDef.data?.emoji ?? '·'}</span>
              <div className="flex-1 min-w-0">
                <div className="text-[12px] text-[var(--text-primary)] truncate">{agentDef.data?.name ?? s.agentSlug}</div>
                <div className="text-[10px] text-[var(--text-muted)] font-mono truncate">{s.agentSlug}</div>
              </div>
              <ExternalLink className="w-3 h-3 text-[var(--text-muted)]" />
            </a>
          </section>
        )}

        {/* Delegate */}
        <section>
          <h3 className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)] mb-1.5 flex items-center gap-1">
            <Crown className="w-3 h-3 text-[var(--accent-active)]" /> Delegate work to this system
          </h3>
          <textarea value={task} onChange={e => setTask(e.target.value)}
            rows={2}
            placeholder={s.agentSlug ? `Describe what ${s.name} should do…` : `Describe the task — the CEO will pick an agent`}
            className="input w-full resize-none text-[12px] mb-1.5" />
          <button onClick={() => delegate.mutate()}
            disabled={delegate.isPending || !task.trim()}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--accent-active)]/15 border border-[var(--accent-active)]/40 hover:bg-[var(--accent-active)]/25 text-[11px] text-[var(--accent-active)] disabled:opacity-40 focus-ring transition-colors">
            {delegate.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
            {delegate.isPending ? 'CEO routing…' : 'Send to CEO'}
          </button>
          {delegate.isError && (
            <div className="mt-1.5 text-[11px] text-[var(--accent-critical)] flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />{(delegate.error as Error).message}
            </div>
          )}
          {delegationResult && (
            <div className="mt-2 p-2 rounded-md bg-[var(--bg-elevated)] border border-[var(--border)]">
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">Agent response</div>
              <pre className="text-[11px] whitespace-pre-wrap text-[var(--text-primary)] max-h-48 overflow-y-auto">{delegationResult}</pre>
            </div>
          )}
        </section>

        {/* Meta */}
        <section className="text-[10px] text-[var(--text-muted)] space-y-0.5 font-mono">
          <div>id: {s.id}</div>
          <div>parent: {s.parentId ?? '—'}</div>
          {s.position && <div>pos: ({s.position.x.toFixed(1)}, {s.position.y.toFixed(1)}, {s.position.z.toFixed(1)})</div>}
          <div>created: {new Date(s.createdAt).toLocaleString()}</div>
          <div>updated: {new Date(s.updatedAt).toLocaleString()}</div>
        </section>
      </div>
    </aside>
  )
}
