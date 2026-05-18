/**
 * Business Directory — full CRUD + metrics management for businesses.
 */
import { useState }                          from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Building2, ExternalLink, Plus, Pencil, BarChart2, Search, X, Check } from 'lucide-react'
import { businessApi, type Business }        from '../api.js'

// ─── helpers ──────────────────────────────────────────────────────────────────

const HEALTH_COLORS: Record<Business['health'], string> = {
  green:  'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
  yellow: 'bg-amber-500/15   text-amber-400   border-amber-500/25',
  red:    'bg-red-500/15     text-red-400     border-red-500/25',
}

const STAGE_COLORS: Record<string, string> = {
  seed:     'bg-purple-500/15 text-purple-400',
  early:    'bg-blue-500/15   text-blue-400',
  growth:   'bg-cyan-500/15   text-cyan-400',
  scale:    'bg-teal-500/15   text-teal-400',
  mature:   'bg-green-500/15  text-green-400',
  default:  'bg-zinc-500/15   text-zinc-400',
}

function stageColor(stage: string) {
  return STAGE_COLORS[stage] ?? STAGE_COLORS['default']!
}

function fmtMetricVal(v: unknown): string {
  if (typeof v === 'number') {
    if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
    if (Math.abs(v) >= 1_000)     return `${(v / 1_000).toFixed(1)}K`
    return String(v)
  }
  return String(v)
}

// ─── Create / Edit form ───────────────────────────────────────────────────────

interface BizFormState {
  name:          string
  industry:      string
  domain:        string
  stage:         string
  health:        Business['health']
}

const EMPTY_FORM: BizFormState = {
  name:          '',
  industry:      '',
  domain:        '',
  stage:         'early',
  health:        'green',
}

function formFromBusiness(b: Business): BizFormState {
  return {
    name:          b.name,
    industry:      b.industry ?? '',
    domain:        b.domain   ?? '',
    stage:         b.stage,
    health:        b.health,
  }
}

function BizForm({
  initial,
  onSave,
  onCancel,
  saving,
}: {
  initial:  BizFormState
  onSave:   (f: BizFormState) => void
  onCancel: () => void
  saving:   boolean
}) {
  const [f, setF] = useState<BizFormState>(initial)
  const set = <K extends keyof BizFormState>(k: K, v: BizFormState[K]) =>
    setF((prev) => ({ ...prev, [k]: v }))

  return (
    <div className="border border-border rounded-xl bg-[var(--bg-surface)] p-5 space-y-4">
      <div className="text-sm font-semibold text-primary">
        {initial.name ? 'Edit Business' : 'New Business'}
      </div>

      {/* Row 1: name + industry */}
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-muted uppercase tracking-wide">Name *</label>
          <input
            value={f.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="Acme Corp"
            className="bg-elevated border border-border rounded-lg px-3 py-2 text-sm text-primary outline-none focus:border-blue-500/50"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-muted uppercase tracking-wide">Industry</label>
          <input
            value={f.industry}
            onChange={(e) => set('industry', e.target.value)}
            placeholder="SaaS, FinTech…"
            className="bg-elevated border border-border rounded-lg px-3 py-2 text-sm text-primary outline-none focus:border-blue-500/50"
          />
        </div>
      </div>

      {/* Row 2: domain + stage + health */}
      <div className="grid grid-cols-3 gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-muted uppercase tracking-wide">Domain</label>
          <input
            value={f.domain}
            onChange={(e) => set('domain', e.target.value)}
            placeholder="acme.com"
            className="bg-elevated border border-border rounded-lg px-3 py-2 text-sm text-primary outline-none focus:border-blue-500/50"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-muted uppercase tracking-wide">Stage</label>
          <select
            value={f.stage}
            onChange={(e) => set('stage', e.target.value)}
            className="bg-elevated border border-border rounded-lg px-3 py-2 text-sm text-primary outline-none"
          >
            {['seed', 'early', 'growth', 'scale', 'mature'].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-muted uppercase tracking-wide">Health</label>
          <select
            value={f.health}
            onChange={(e) => set('health', e.target.value as Business['health'])}
            className="bg-elevated border border-border rounded-lg px-3 py-2 text-sm text-primary outline-none"
          >
            {(['green', 'yellow', 'red'] as const).map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="px-4 py-1.5 rounded-lg border border-border text-xs text-secondary hover:bg-elevated transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => onSave(f)}
          disabled={!f.name.trim() || saving}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-blue-500/20 border border-blue-500/40 text-xs text-blue-400 hover:bg-blue-500/30 disabled:opacity-40 transition-colors"
        >
          <Check className="w-3 h-3" />
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

// ─── Add Metrics modal ────────────────────────────────────────────────────────

function MetricsModal({
  business,
  onClose,
}: {
  business: Business
  onClose:  () => void
}) {
  const qc = useQueryClient()
  const [rows, setRows] = useState<{ key: string; val: string }[]>([{ key: '', val: '' }])

  const addMut = useMutation({
    mutationFn: (metrics: Record<string, unknown>) =>
      businessApi.metrics(business.id, metrics),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['businesses'] })
      onClose()
    },
  })

  const updateRow = (i: number, field: 'key' | 'val', value: string) => {
    setRows((prev) => prev.map((r, idx) => idx === i ? { ...r, [field]: value } : r))
  }

  const removeRow = (i: number) =>
    setRows((prev) => prev.filter((_, idx) => idx !== i))

  const addRow = () => setRows((prev) => [...prev, { key: '', val: '' }])

  const handleSubmit = () => {
    const metrics: Record<string, unknown> = {}
    for (const r of rows) {
      const k = r.key.trim()
      if (!k) continue
      const num = Number(r.val)
      metrics[k] = r.val.trim() !== '' && !isNaN(num) ? num : r.val
    }
    if (Object.keys(metrics).length === 0) return
    addMut.mutate(metrics)
  }

  const hasValid = rows.some((r) => r.key.trim() !== '')

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-md bg-[var(--bg-surface)] border border-border rounded-2xl shadow-2xl p-6 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-primary">Add Metrics</div>
            <div className="text-xs text-muted mt-0.5">{business.name}</div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-muted hover:bg-elevated transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Existing metrics preview */}
        {Object.keys(business.metrics).length > 0 && (
          <div className="rounded-lg border border-border bg-elevated px-3 py-2">
            <div className="text-[10px] text-muted uppercase tracking-wide mb-1.5">Current Metrics</div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(business.metrics).map(([k, v]) => (
                <span key={k} className="text-[10px] px-2 py-0.5 rounded bg-[var(--bg-surface)] border border-border text-secondary">
                  {k}: <span className="text-primary font-mono">{fmtMetricVal(v)}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Key-value editor */}
        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_1fr_auto] gap-2 text-[10px] text-muted uppercase tracking-wide px-1">
            <span>Key</span><span>Value</span><span />
          </div>
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2">
              <input
                value={r.key}
                onChange={(e) => updateRow(i, 'key', e.target.value)}
                placeholder="mrr"
                className="bg-elevated border border-border rounded-lg px-3 py-1.5 text-xs text-primary outline-none focus:border-blue-500/50"
              />
              <input
                value={r.val}
                onChange={(e) => updateRow(i, 'val', e.target.value)}
                placeholder="12000"
                className="bg-elevated border border-border rounded-lg px-3 py-1.5 text-xs text-primary outline-none focus:border-blue-500/50"
              />
              <button
                onClick={() => removeRow(i)}
                disabled={rows.length === 1}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-muted hover:text-red-400 hover:bg-red-500/10 disabled:opacity-30 transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          <button
            onClick={addRow}
            className="flex items-center gap-1 text-xs text-muted hover:text-blue-400 transition-colors px-1"
          >
            <Plus className="w-3 h-3" />
            Add row
          </button>
        </div>

        {addMut.isError && (
          <div className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
            {(addMut.error as Error).message}
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg border border-border text-xs text-secondary hover:bg-elevated transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!hasValid || addMut.isPending}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-blue-500/20 border border-blue-500/40 text-xs text-blue-400 hover:bg-blue-500/30 disabled:opacity-40 transition-colors"
          >
            <BarChart2 className="w-3 h-3" />
            {addMut.isPending ? 'Saving…' : 'Save Metrics'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Business card ────────────────────────────────────────────────────────────

function BusinessCard({
  business,
  onEdit,
  onAddMetrics,
}: {
  business:     Business
  onEdit:       () => void
  onAddMetrics: () => void
}) {
  const metricEntries = Object.entries(business.metrics).slice(0, 6)
  const domainUrl     = business.domain
    ? business.domain.startsWith('http') ? business.domain : `https://${business.domain}`
    : null

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-[var(--bg-surface)] p-4 hover:border-blue-500/30 transition-colors">

      {/* Top: name + badges */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-primary truncate">{business.name}</div>
          <div className="flex items-center gap-1.5 flex-wrap mt-1">
            {business.industry && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-500/20 text-blue-400">
                {business.industry}
              </span>
            )}
            <span className={`text-[10px] px-1.5 py-0.5 rounded capitalize ${stageColor(business.stage)}`}>
              {business.stage}
            </span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border capitalize ${HEALTH_COLORS[business.health]}`}>
              {business.health}
            </span>
          </div>
        </div>
      </div>

      {/* Domain link */}
      {domainUrl && (
        <a
          href={domainUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-xs text-muted hover:text-blue-400 transition-colors w-fit"
        >
          <ExternalLink className="w-3 h-3" />
          {business.domain}
        </a>
      )}

      {/* Metrics */}
      {metricEntries.length > 0 && (
        <div className="rounded-lg border border-border bg-elevated px-3 py-2">
          <div className="text-[10px] text-muted uppercase tracking-wide mb-1.5">Metrics</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            {metricEntries.map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-muted truncate">{k}</span>
                <span className="text-[10px] font-mono text-primary shrink-0">{fmtMetricVal(v)}</span>
              </div>
            ))}
          </div>
          {Object.keys(business.metrics).length > 6 && (
            <div className="text-[10px] text-muted mt-1.5">
              +{Object.keys(business.metrics).length - 6} more
            </div>
          )}
        </div>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1 border-t border-border">
        <button
          onClick={onEdit}
          className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs text-secondary border border-border hover:bg-elevated hover:text-primary transition-colors"
        >
          <Pencil className="w-3 h-3" />
          Edit
        </button>
        <button
          onClick={onAddMetrics}
          className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs text-secondary border border-border hover:bg-elevated hover:text-blue-400 transition-colors"
        >
          <BarChart2 className="w-3 h-3" />
          Add Metrics
        </button>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function BusinessesPage() {
  const qc = useQueryClient()

  const [search,       setSearch]       = useState('')
  const [showForm,     setShowForm]     = useState(false)
  const [editTarget,   setEditTarget]   = useState<Business | null>(null)
  const [metricsTarget, setMetricsTarget] = useState<Business | null>(null)

  // ── Data ──────────────────────────────────────────────────────────────────
  const { data, isLoading } = useQuery({
    queryKey:       ['businesses'],
    queryFn:        () => businessApi.list(),
    refetchInterval: 60_000,
  })

  const businesses = data?.data ?? []

  // ── Mutations ─────────────────────────────────────────────────────────────
  const createMut = useMutation({
    mutationFn: (f: BizFormState) =>
      businessApi.create({
        name:     f.name,
        ...(f.industry ? { industry: f.industry } : {}),
        ...(f.domain   ? { domain:   f.domain   } : {}),
        stage:    f.stage,
        health:   f.health,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['businesses'] })
      setShowForm(false)
    },
  })

  const updateMut = useMutation({
    mutationFn: ({ id, f }: { id: string; f: BizFormState }) =>
      businessApi.update(id, {
        name:     f.name,
        ...(f.industry ? { industry: f.industry } : { industry: null }),
        ...(f.domain   ? { domain:   f.domain   } : { domain:   null }),
        stage:    f.stage,
        health:   f.health,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['businesses'] })
      setEditTarget(null)
    },
  })

  // ── Filter ────────────────────────────────────────────────────────────────
  const q = search.trim().toLowerCase()
  const filtered = q
    ? businesses.filter((b) =>
        b.name.toLowerCase().includes(q) ||
        (b.industry ?? '').toLowerCase().includes(q) ||
        (b.domain   ?? '').toLowerCase().includes(q)
      )
    : businesses

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleCreate = (f: BizFormState) => createMut.mutate(f)
  const handleUpdate = (f: BizFormState) => {
    if (!editTarget) return
    updateMut.mutate({ id: editTarget.id, f })
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-bg">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="shrink-0 flex items-center justify-between px-6 py-3 border-b border-border bg-[var(--bg-surface)]">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-blue-500/20 border border-blue-500/30 flex items-center justify-center">
            <Building2 className="w-3.5 h-3.5 text-blue-400" />
          </div>
          <div>
            <div className="text-sm font-semibold text-primary">Business Directory</div>
            <div className="text-xs text-secondary">
              {businesses.length} business{businesses.length !== 1 ? 'es' : ''}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, industry, domain…"
              className="pl-8 pr-8 py-1.5 rounded-lg border border-border bg-elevated text-sm text-primary placeholder-[var(--text-muted)] outline-none focus:border-blue-500/50 w-60 transition-colors"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-secondary"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Add button */}
          <button
            onClick={() => { setShowForm((v) => !v); setEditTarget(null) }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-blue-500/15 border border-blue-500/30 text-blue-400 hover:bg-blue-500/25 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Business
          </button>
        </div>
      </header>

      {/* ── Scrollable body ──────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto p-6 space-y-6">

        {/* Create form */}
        {showForm && !editTarget && (
          <BizForm
            initial={EMPTY_FORM}
            onSave={handleCreate}
            onCancel={() => setShowForm(false)}
            saving={createMut.isPending}
          />
        )}

        {createMut.isError && (
          <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
            {(createMut.error as Error).message}
          </div>
        )}

        {/* Edit form (inline, replaces card) — rendered in grid below */}

        {/* Loading */}
        {isLoading && (
          <div className="flex items-center justify-center py-20 text-muted text-sm">
            <div className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mr-3" />
            Loading businesses…
          </div>
        )}

        {/* Empty state */}
        {!isLoading && businesses.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
            <div className="w-14 h-14 rounded-2xl bg-elevated border border-border flex items-center justify-center">
              <Building2 className="w-7 h-7 text-muted" />
            </div>
            <div>
              <div className="text-sm font-medium text-primary">No businesses yet</div>
              <div className="text-xs text-muted mt-1">Click "Add Business" to get started</div>
            </div>
          </div>
        )}

        {/* No search results */}
        {!isLoading && businesses.length > 0 && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
            <Search className="w-8 h-8 text-muted" />
            <div>
              <div className="text-sm text-primary">No results for "{search}"</div>
              <button
                onClick={() => setSearch('')}
                className="text-xs text-blue-400 hover:text-blue-300 mt-1 transition-colors"
              >
                Clear search
              </button>
            </div>
          </div>
        )}

        {/* Grid */}
        {!isLoading && filtered.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filtered.map((b) =>
              editTarget?.id === b.id ? (
                /* Inline edit form replacing the card */
                <div key={b.id} className="md:col-span-2 xl:col-span-3">
                  <BizForm
                    initial={formFromBusiness(b)}
                    onSave={handleUpdate}
                    onCancel={() => setEditTarget(null)}
                    saving={updateMut.isPending}
                  />
                  {updateMut.isError && (
                    <div className="mt-2 text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
                      {(updateMut.error as Error).message}
                    </div>
                  )}
                </div>
              ) : (
                <BusinessCard
                  key={b.id}
                  business={b}
                  onEdit={() => { setEditTarget(b); setShowForm(false) }}
                  onAddMetrics={() => setMetricsTarget(b)}
                />
              )
            )}
          </div>
        )}
      </div>

      {/* ── Metrics modal ────────────────────────────────────────────────── */}
      {metricsTarget && (
        <MetricsModal
          business={metricsTarget}
          onClose={() => setMetricsTarget(null)}
        />
      )}
    </div>
  )
}
