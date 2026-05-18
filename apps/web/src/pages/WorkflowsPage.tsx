/**
 * Workflows management page — Definitions + Runs.
 */
import { useState }                         from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Search, Play, Pencil, Trash2, ToggleLeft, ToggleRight, X, ChevronRight, Clock } from 'lucide-react'
import { api }                               from '../api.js'
import { StatusBadge }                       from '../components/StatusBadge.js'
import { SectionPanel }                      from '../components/SectionPanel.js'

// ─── Types ────────────────────────────────────────────────────────────────────

type TriggerType = 'manual' | 'scheduled' | 'event' | 'webhook'

interface WorkflowDefinition {
  id:          string
  name:        string
  description?: string
  triggerType: TriggerType
  enabled:     boolean
  steps:       unknown[]
  createdAt:   number
  updatedAt:   number
}

interface WorkflowRunItem {
  id:           string
  workflowId:   string
  workflowName?: string
  status:       'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  triggeredBy:  string
  triggeredAt:  number
  completedAt?: number
}

// ─── Local API ────────────────────────────────────────────────────────────────

const workflowApi = {
  list:    () =>
    api.get<{ success: true; data: WorkflowDefinition[] }>('/api/v1/workflows'),
  create:  (body: { name: string; description?: string; triggerType: TriggerType; steps: unknown[]; enabled: boolean }) =>
    api.post<{ success: true; data: WorkflowDefinition }>('/api/v1/workflows', body),
  update:  (id: string, body: Partial<{ name: string; description: string; triggerType: TriggerType; steps: unknown[]; enabled: boolean }>) =>
    api.put<{ success: true; data: WorkflowDefinition }>(`/api/v1/workflows/${id}`, body),
  delete:  (id: string) =>
    api.delete<{ success: true }>(`/api/v1/workflows/${id}`),
  trigger: (id: string, input?: unknown) =>
    api.post<{ success: true; data: { runId: string } }>(`/api/v1/workflows/${id}/trigger`, { input: input ?? {} }),
}

const runApi = {
  list: (params?: { status?: string; limit?: number }) => {
    const qs = new URLSearchParams()
    if (params?.status) qs.set('status', params.status)
    qs.set('limit', String(params?.limit ?? 20))
    return api.get<{ success: true; data: WorkflowRunItem[] }>(`/api/v1/workflow-runs?${qs.toString()}`)
  },
  cancel: (id: string) =>
    api.post<{ success: true }>(`/api/v1/workflow-runs/${id}/cancel`, {}),
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ago(ts: number): string {
  const s = (Date.now() - ts) / 1000
  if (s < 60)   return `${Math.floor(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

function duration(start: number, end: number): string {
  const ms = end - start
  if (ms < 1000)   return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
}

const TRIGGER_STYLES: Record<TriggerType, string> = {
  manual:    'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
  scheduled: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
  event:     'bg-blue-500/10 text-blue-400 border-blue-500/20',
  webhook:   'bg-amber-500/10 text-amber-400 border-amber-500/20',
}

function TriggerBadge({ type }: { type: TriggerType }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${TRIGGER_STYLES[type]}`}>
      {type}
    </span>
  )
}

// ─── Create Form ──────────────────────────────────────────────────────────────

interface FormState {
  name:        string
  description: string
  triggerType: TriggerType
  steps:       string
  enabled:     boolean
}

const defaultForm: FormState = {
  name:        '',
  description: '',
  triggerType: 'manual',
  steps:       '[]',
  enabled:     true,
}

function CreateWorkflowModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm]     = useState<FormState>(defaultForm)
  const [error, setError]   = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () => {
      let steps: unknown[]
      try { steps = JSON.parse(form.steps) as unknown[] }
      catch { throw new Error('Steps must be valid JSON array') }
      if (!Array.isArray(steps)) throw new Error('Steps must be a JSON array')
      const desc = form.description.trim()
      type CreateBody = { name: string; description?: string; triggerType: TriggerType; steps: unknown[]; enabled: boolean }
      const body: CreateBody = { name: form.name.trim(), triggerType: form.triggerType, steps, enabled: form.enabled }
      if (desc) body.description = desc
      return workflowApi.create(body)
    },
    onSuccess: () => { onCreated(); onClose() },
    onError:   (e: unknown) => setError(e instanceof Error ? e.message : 'Create failed'),
  })

  function set<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm(f => ({ ...f, [k]: v }))
    setError(null)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-[var(--bg-surface)] border border-border rounded-2xl w-full max-w-lg shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-primary">New Workflow</h2>
          <button onClick={onClose} className="text-muted hover:text-secondary transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</div>
          )}

          <div>
            <label className="block text-xs font-medium text-secondary mb-1.5">Name *</label>
            <input
              className="w-full bg-elevated border border-border rounded-lg px-3 py-2 text-sm text-primary placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] transition-colors"
              placeholder="e.g. Daily Report Generator"
              value={form.name}
              onChange={e => set('name', e.target.value)}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-secondary mb-1.5">Description</label>
            <input
              className="w-full bg-elevated border border-border rounded-lg px-3 py-2 text-sm text-primary placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] transition-colors"
              placeholder="Optional description"
              value={form.description}
              onChange={e => set('description', e.target.value)}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-secondary mb-1.5">Trigger Type</label>
            <select
              className="w-full bg-elevated border border-border rounded-lg px-3 py-2 text-sm text-primary focus:outline-none focus:border-[var(--accent)] transition-colors"
              value={form.triggerType}
              onChange={e => set('triggerType', e.target.value as TriggerType)}
            >
              <option value="manual">Manual</option>
              <option value="scheduled">Scheduled</option>
              <option value="event">Event</option>
              <option value="webhook">Webhook</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-secondary mb-1.5">
              Steps <span className="text-muted">(JSON array)</span>
            </label>
            <textarea
              rows={5}
              className="w-full bg-elevated border border-border rounded-lg px-3 py-2 text-xs font-mono text-primary placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] transition-colors resize-none"
              placeholder='[{"id":"step1","type":"action","label":"My Step"}]'
              value={form.steps}
              onChange={e => set('steps', e.target.value)}
            />
          </div>

          <label className="flex items-center gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={e => set('enabled', e.target.checked)}
              className="w-4 h-4 rounded accent-[var(--accent)]"
            />
            <span className="text-sm text-secondary">Enabled</span>
          </label>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-secondary hover:text-primary hover:bg-elevated transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => create.mutate()}
            disabled={!form.name.trim() || create.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            <Plus className="w-3.5 h-3.5" />
            {create.isPending ? 'Creating…' : 'Create Workflow'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Definitions Tab ──────────────────────────────────────────────────────────

function DefinitionsTab() {
  const qc                      = useQueryClient()
  const [search, setSearch]     = useState('')
  const [showCreate, setCreate] = useState(false)
  const [trigFilter, setTrig]   = useState<TriggerType | 'all'>('all')

  const { data, isLoading } = useQuery({
    queryKey: ['workflows'],
    queryFn:  () => workflowApi.list(),
    refetchInterval: 30_000,
  })

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      workflowApi.update(id, { enabled }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['workflows'] }) },
  })

  const remove = useMutation({
    mutationFn: (id: string) => workflowApi.delete(id),
    onSuccess:  () => { void qc.invalidateQueries({ queryKey: ['workflows'] }) },
  })

  const trigger = useMutation({
    mutationFn: (id: string) => workflowApi.trigger(id),
    onSuccess:  () => { void qc.invalidateQueries({ queryKey: ['workflow-runs'] }) },
  })

  const defs = (data?.data ?? []).filter(d => {
    const q = search.toLowerCase()
    const matchSearch = !q || d.name.toLowerCase().includes(q) || (d.description ?? '').toLowerCase().includes(q)
    const matchTrig   = trigFilter === 'all' || d.triggerType === trigFilter
    return matchSearch && matchTrig
  })

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted" />
          <input
            className="w-full bg-elevated border border-border rounded-lg pl-8 pr-3 py-1.5 text-sm text-primary placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] transition-colors"
            placeholder="Search workflows…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <select
          className="bg-elevated border border-border rounded-lg px-3 py-1.5 text-xs text-secondary focus:outline-none focus:border-[var(--accent)] transition-colors"
          value={trigFilter}
          onChange={e => setTrig(e.target.value as TriggerType | 'all')}
        >
          <option value="all">All triggers</option>
          <option value="manual">Manual</option>
          <option value="scheduled">Scheduled</option>
          <option value="event">Event</option>
          <option value="webhook">Webhook</option>
        </select>
        <div className="ml-auto">
          <button
            onClick={() => setCreate(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--accent)] text-white hover:opacity-90 transition-opacity"
          >
            <Plus className="w-3.5 h-3.5" />
            New Workflow
          </button>
        </div>
      </div>

      <SectionPanel title={`Definitions (${defs.length})`} loading={isLoading}>
        {defs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted text-sm gap-2">
            <ChevronRight className="w-8 h-8 opacity-30" />
            {search || trigFilter !== 'all' ? 'No matching workflows' : 'No workflows yet — create one above'}
          </div>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {defs.map(def => (
              <DefinitionRow
                key={def.id}
                def={def}
                onToggle={() => toggle.mutate({ id: def.id, enabled: !def.enabled })}
                onTrigger={() => trigger.mutate(def.id)}
                onDelete={() => { if (confirm(`Delete "${def.name}"?`)) remove.mutate(def.id) }}
                loading={toggle.isPending || remove.isPending || trigger.isPending}
              />
            ))}
          </ul>
        )}
      </SectionPanel>

      {showCreate && (
        <CreateWorkflowModal
          onClose={() => setCreate(false)}
          onCreated={() => { void qc.invalidateQueries({ queryKey: ['workflows'] }) }}
        />
      )}
    </div>
  )
}

function DefinitionRow({ def, onToggle, onTrigger, onDelete, loading }: {
  def:      WorkflowDefinition
  onToggle: () => void
  onTrigger: () => void
  onDelete: () => void
  loading:  boolean
}) {
  const stepCount = Array.isArray(def.steps) ? def.steps.length : 0

  return (
    <li className="px-4 py-3 hover:bg-elevated transition-colors">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-medium text-primary truncate">{def.name}</span>
            <TriggerBadge type={def.triggerType} />
            {!def.enabled && (
              <span className="text-xs text-muted bg-elevated border border-border px-1.5 py-0.5 rounded-full">disabled</span>
            )}
          </div>
          {def.description && (
            <div className="text-xs text-secondary mb-1 truncate">{def.description}</div>
          )}
          <div className="text-xs text-muted">
            {stepCount} {stepCount === 1 ? 'step' : 'steps'} · Updated {ago(def.updatedAt)}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            title="Trigger manually"
            onClick={onTrigger}
            disabled={loading || !def.enabled}
            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-500/10 text-emerald-400 text-xs font-medium border border-emerald-500/20 hover:bg-emerald-500/20 disabled:opacity-40 transition-colors"
          >
            <Play className="w-3 h-3" />
            Run
          </button>
          <button
            title="Edit"
            disabled={loading}
            className="p-1.5 rounded-lg text-muted hover:text-secondary hover:bg-elevated disabled:opacity-40 transition-colors"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            title={def.enabled ? 'Disable' : 'Enable'}
            onClick={onToggle}
            disabled={loading}
            className="p-1.5 rounded-lg text-muted hover:text-secondary hover:bg-elevated disabled:opacity-40 transition-colors"
          >
            {def.enabled
              ? <ToggleRight className="w-4 h-4 text-emerald-400" />
              : <ToggleLeft  className="w-4 h-4" />
            }
          </button>
          <button
            title="Delete"
            onClick={onDelete}
            disabled={loading}
            className="p-1.5 rounded-lg text-muted hover:text-red-400 hover:bg-red-500/10 disabled:opacity-40 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </li>
  )
}

// ─── Runs Tab ─────────────────────────────────────────────────────────────────

const RUN_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const

function RunsTab() {
  const qc                        = useQueryClient()
  const [statusFilter, setStatus] = useState<string>('all')

  const { data, isLoading } = useQuery({
    queryKey: ['workflow-runs', statusFilter],
    queryFn:  () => runApi.list(
      statusFilter !== 'all'
        ? { status: statusFilter, limit: 50 }
        : { limit: 50 },
    ),
    refetchInterval: 10_000,
  })

  const cancel = useMutation({
    mutationFn: (id: string) => runApi.cancel(id),
    onSuccess:  () => { void qc.invalidateQueries({ queryKey: ['workflow-runs'] }) },
  })

  const runs = data?.data ?? []

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setStatus('all')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${statusFilter === 'all' ? 'bg-[var(--accent)] text-white' : 'bg-elevated text-secondary hover:text-primary border border-border'}`}
        >
          All
        </button>
        {RUN_STATUSES.map(s => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors ${statusFilter === s ? 'bg-[var(--accent)] text-white' : 'bg-elevated text-secondary hover:text-primary border border-border'}`}
          >
            {s}
          </button>
        ))}
      </div>

      <SectionPanel title={`Runs (${runs.length})`} loading={isLoading}>
        {runs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted text-sm gap-2">
            <Clock className="w-8 h-8 opacity-30" />
            No runs found
          </div>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {runs.map(run => (
              <RunRow
                key={run.id}
                run={run}
                onCancel={() => cancel.mutate(run.id)}
                cancelling={cancel.isPending}
              />
            ))}
          </ul>
        )}
      </SectionPanel>
    </div>
  )
}

function RunRow({ run, onCancel, cancelling }: {
  run:       WorkflowRunItem
  onCancel:  () => void
  cancelling: boolean
}) {
  return (
    <li className="px-4 py-3 hover:bg-elevated transition-colors">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-medium text-primary truncate">
              {run.workflowName ?? run.workflowId.slice(0, 8) + '…'}
            </span>
            <StatusBadge status={run.status} label={run.status} pulse={run.status === 'running'} />
          </div>
          <div className="flex items-center gap-3 text-xs text-muted">
            <span>By {run.triggeredBy}</span>
            <span>·</span>
            <span>{ago(run.triggeredAt)}</span>
            {run.completedAt !== undefined && (
              <>
                <span>·</span>
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {duration(run.triggeredAt, run.completedAt)}
                </span>
              </>
            )}
          </div>
          <div className="text-[10px] text-muted mt-0.5 font-mono">{run.id}</div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {run.status === 'running' && (
            <button
              onClick={onCancel}
              disabled={cancelling}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-500/10 text-amber-400 text-xs font-medium border border-amber-500/20 hover:bg-amber-500/20 disabled:opacity-50 transition-colors"
            >
              <X className="w-3 h-3" />
              Cancel
            </button>
          )}
          <button
            title="View steps"
            className="p-1.5 rounded-lg text-muted hover:text-secondary hover:bg-elevated transition-colors"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </li>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type Tab = 'definitions' | 'runs'

export default function WorkflowsPage() {
  const [tab, setTab] = useState<Tab>('definitions')

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Page header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <div>
          <h1 className="text-lg font-semibold text-primary">Workflows</h1>
          <p className="text-xs text-muted mt-0.5">Manage automation definitions and monitor execution runs</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 px-6 pt-4 border-b border-border shrink-0">
        {(['definitions', 'runs'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize border-b-2 transition-colors -mb-px ${
              tab === t
                ? 'border-[var(--accent)] text-[var(--accent)]'
                : 'border-transparent text-muted hover:text-secondary'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto px-6 py-4">
        {tab === 'definitions' ? <DefinitionsTab /> : <RunsTab />}
      </div>
    </div>
  )
}
