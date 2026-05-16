import { useState }                          from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { riskApi, type Risk }                from '../api.js'
import { SectionPanel }                      from '../components/SectionPanel.js'

// ─── Types ────────────────────────────────────────────────────────────────────

type SeverityFilter = 'all' | 'critical' | 'high' | 'medium' | 'low'
type StatusFilter   = 'all' | 'open' | 'mitigating' | 'resolved' | 'accepted'
type Probability    = 'low' | 'medium' | 'high'
type Impact         = 'low' | 'medium' | 'high'

interface FormState {
  title:       string
  description: string
  severity:    'low' | 'medium' | 'high' | 'critical'
  probability: number
  impact:      number
  likelihood:  'low' | 'medium' | 'high'
  owner:       string
  mitigation:  string
  category:    string
}

const EMPTY_FORM: FormState = {
  title:       '',
  description: '',
  severity:    'medium',
  probability: 5,
  impact:      5,
  likelihood:  'medium',
  owner:       '',
  mitigation:  '',
  category:    'operational',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function severityColor(s: Risk['severity']): string {
  switch (s) {
    case 'critical': return '#ef4444'
    case 'high':     return '#f97316'
    case 'medium':   return '#f59e0b'
    case 'low':      return '#22c55e'
  }
}

function statusColor(s: Risk['status']): string {
  switch (s) {
    case 'open':       return '#ef4444'
    case 'mitigating': return '#3b82f6'
    case 'resolved':   return '#22c55e'
    case 'accepted':   return '#8b5cf6'
  }
}

function toBucket(val: number): Probability | Impact {
  if (val <= 3)  return 'low'
  if (val <= 6)  return 'medium'
  return 'high'
}

// Risk matrix: probability rows (high→low) × impact cols (low→high)
const PROB_ROWS: Probability[] = ['high', 'medium', 'low']
const IMP_COLS:  Impact[]      = ['low', 'medium', 'high']

function matrixCellColor(prob: Probability, imp: Impact): string {
  const score = (prob === 'high' ? 3 : prob === 'medium' ? 2 : 1)
              * (imp  === 'high' ? 3 : imp  === 'medium' ? 2 : 1)
  if (score >= 6) return 'rgba(239,68,68,0.18)'
  if (score >= 3) return 'rgba(245,158,11,0.18)'
  return 'rgba(34,197,94,0.12)'
}

// ─── Badge ────────────────────────────────────────────────────────────────────

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      background: color + '22',
      color,
      border: `1px solid ${color}44`,
      borderRadius: 6,
      padding: '1px 7px',
      fontSize: 11,
      fontWeight: 600,
      whiteSpace: 'nowrap' as const,
    }}>
      {label}
    </span>
  )
}

// ─── Risk Matrix ──────────────────────────────────────────────────────────────

function RiskMatrix({
  risks,
  onCellClick,
  activeCell,
}: {
  risks:       Risk[]
  onCellClick: (prob: Probability, imp: Impact) => void
  activeCell:  { prob: Probability; imp: Impact } | null
}) {
  function countCell(prob: Probability, imp: Impact) {
    return risks.filter(r =>
      toBucket(r.probability) === prob &&
      toBucket(r.impact)      === imp,
    ).length
  }

  return (
    <div style={{ padding: '12px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4 }}>
        {/* Y-axis label */}
        <div style={{
          writingMode: 'vertical-rl' as const,
          transform: 'rotate(180deg)',
          fontSize: 10,
          color: 'var(--text-muted)',
          letterSpacing: 1,
          textTransform: 'uppercase' as const,
          marginRight: 4,
          alignSelf: 'center',
        }}>
          Probability
        </div>

        <div style={{ flex: 1 }}>
          {/* Col headers */}
          <div style={{ display: 'grid', gridTemplateColumns: '56px repeat(3,1fr)', marginBottom: 4 }}>
            <div />
            {IMP_COLS.map(c => (
              <div key={c} style={{ textAlign: 'center', fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' as const }}>
                {c}
              </div>
            ))}
          </div>

          {/* Rows */}
          {PROB_ROWS.map(prob => (
            <div key={prob} style={{ display: 'grid', gridTemplateColumns: '56px repeat(3,1fr)', marginBottom: 3 }}>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' as const, display: 'flex', alignItems: 'center' }}>
                {prob}
              </div>
              {IMP_COLS.map(imp => {
                const count   = countCell(prob, imp)
                const active  = activeCell?.prob === prob && activeCell?.imp === imp
                return (
                  <button
                    key={imp}
                    onClick={() => onCellClick(prob, imp)}
                    style={{
                      background: matrixCellColor(prob, imp),
                      border: active
                        ? '2px solid var(--text-primary)'
                        : '1px solid var(--border)',
                      borderRadius: 6,
                      height: 52,
                      display: 'flex',
                      flexDirection: 'column' as const,
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      transition: 'opacity 0.15s',
                      margin: '0 2px',
                    }}
                  >
                    <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
                      {count}
                    </span>
                    {count > 0 && (
                      <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>risk{count !== 1 ? 's' : ''}</span>
                    )}
                  </button>
                )
              })}
            </div>
          ))}

          {/* X-axis label */}
          <div style={{ textAlign: 'center', fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, textTransform: 'uppercase' as const, marginTop: 6 }}>
            Impact
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Form ─────────────────────────────────────────────────────────────────────

function RiskForm({
  initial,
  onSubmit,
  onCancel,
  submitting,
}: {
  initial:    FormState
  onSubmit:   (f: FormState) => void
  onCancel:   () => void
  submitting: boolean
}) {
  const [form, setForm] = useState<FormState>(initial)

  function set<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm(prev => ({ ...prev, [k]: v }))
  }

  const labelStyle: React.CSSProperties = {
    fontSize: 12,
    color: 'var(--text-secondary)',
    marginBottom: 4,
    display: 'block',
  }
  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 13,
    color: 'var(--text-primary)',
    outline: 'none',
    boxSizing: 'border-box' as const,
  }
  const row: React.CSSProperties = { display: 'flex', gap: 12, marginBottom: 12 }
  const col: React.CSSProperties = { flex: 1, display: 'flex', flexDirection: 'column' as const }

  return (
    <div style={{ padding: '16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-elevated)' }}>
      <div style={row}>
        <div style={{ ...col, flex: 2 }}>
          <label style={labelStyle}>Title *</label>
          <input
            style={inputStyle}
            value={form.title}
            onChange={e => set('title', e.target.value)}
            placeholder="Risk title"
          />
        </div>
        <div style={col}>
          <label style={labelStyle}>Category</label>
          <input
            style={inputStyle}
            value={form.category}
            onChange={e => set('category', e.target.value)}
            placeholder="e.g. operational"
          />
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>Description</label>
        <textarea
          style={{ ...inputStyle, minHeight: 56, resize: 'vertical' as const }}
          value={form.description}
          onChange={e => set('description', e.target.value)}
          placeholder="Describe the risk…"
        />
      </div>

      <div style={row}>
        <div style={col}>
          <label style={labelStyle}>Severity</label>
          <select style={inputStyle} value={form.severity} onChange={e => set('severity', e.target.value as FormState['severity'])}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <div style={col}>
          <label style={labelStyle}>Likelihood</label>
          <select style={inputStyle} value={form.likelihood} onChange={e => set('likelihood', e.target.value as FormState['likelihood'])}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
        <div style={col}>
          <label style={labelStyle}>Probability (0–10)</label>
          <input
            style={inputStyle}
            type="number"
            min={0}
            max={10}
            step={0.1}
            value={form.probability}
            onChange={e => set('probability', parseFloat(e.target.value) || 0)}
          />
        </div>
        <div style={col}>
          <label style={labelStyle}>Impact (0–10)</label>
          <input
            style={inputStyle}
            type="number"
            min={0}
            max={10}
            step={0.1}
            value={form.impact}
            onChange={e => set('impact', parseFloat(e.target.value) || 0)}
          />
        </div>
        <div style={col}>
          <label style={labelStyle}>Owner</label>
          <input
            style={inputStyle}
            value={form.owner}
            onChange={e => set('owner', e.target.value)}
            placeholder="Owner name"
          />
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <label style={labelStyle}>Mitigation plan</label>
        <textarea
          style={{ ...inputStyle, minHeight: 56, resize: 'vertical' as const }}
          value={form.mitigation}
          onChange={e => set('mitigation', e.target.value)}
          placeholder="Describe mitigation steps…"
        />
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          onClick={onCancel}
          style={{
            padding: '6px 14px',
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'transparent',
            color: 'var(--text-secondary)',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
        <button
          onClick={() => onSubmit(form)}
          disabled={!form.title.trim() || submitting}
          style={{
            padding: '6px 16px',
            borderRadius: 6,
            border: 'none',
            background: '#3b82f6',
            color: '#fff',
            fontSize: 13,
            fontWeight: 600,
            cursor: form.title.trim() && !submitting ? 'pointer' : 'not-allowed',
            opacity: form.title.trim() && !submitting ? 1 : 0.6,
          }}
        >
          {submitting ? 'Saving…' : 'Save Risk'}
        </button>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function RisksPage() {
  const qc = useQueryClient()

  // Filters
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all')
  const [statusFilter,   setStatusFilter]   = useState<StatusFilter>('all')
  const [matrixCell,     setMatrixCell]      = useState<{ prob: Probability; imp: Impact } | null>(null)
  const [showMatrix,     setShowMatrix]      = useState(true)

  // Form state
  const [showForm,    setShowForm]    = useState(false)
  const [editRisk,    setEditRisk]    = useState<Risk | null>(null)
  const [mitigateId,  setMitigateId]  = useState<string | null>(null)
  const [mitigateDesc, setMitigateDesc] = useState('')

  // Fetch
  const { data, isLoading } = useQuery({
    queryKey: ['risks'],
    queryFn:  () => riskApi.list(),
    refetchInterval: 30_000,
  })
  const risks = data?.data ?? []

  // Mutations
  const createMut = useMutation({
    mutationFn: (f: FormState) => {
      const body: Parameters<typeof riskApi.create>[0] = {
        title:       f.title,
        severity:    f.severity,
        probability: f.probability,
        impact:      f.impact,
        category:    f.category || 'operational',
      }
      if (f.description) body.description = f.description
      return riskApi.create(body)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['risks'] })
      setShowForm(false)
    },
  })

  const updateMut = useMutation({
    mutationFn: ({ id, f }: { id: string; f: FormState }) => riskApi.update(id, {
      title:       f.title,
      severity:    f.severity,
      probability: f.probability,
      impact:      f.impact,
      category:    f.category || 'operational',
      ...(f.description ? { description: f.description } : {}),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['risks'] })
      setEditRisk(null)
    },
  })

  const resolveMut = useMutation({
    mutationFn: (id: string) => riskApi.resolve(id),
    onSuccess:  () => { void qc.invalidateQueries({ queryKey: ['risks'] }) },
  })

  const mitigateMut = useMutation({
    mutationFn: ({ id, desc }: { id: string; desc: string }) => riskApi.mitigate(id, desc),
    onSuccess:  () => {
      void qc.invalidateQueries({ queryKey: ['risks'] })
      setMitigateId(null)
      setMitigateDesc('')
    },
  })

  // Filter logic
  const filtered = risks.filter(r => {
    if (severityFilter !== 'all' && r.severity !== severityFilter) return false
    if (statusFilter   !== 'all' && r.status   !== statusFilter)   return false
    if (matrixCell) {
      if (toBucket(r.probability) !== matrixCell.prob) return false
      if (toBucket(r.impact)      !== matrixCell.imp)  return false
    }
    return true
  })

  function handleMatrixClick(prob: Probability, imp: Impact) {
    if (matrixCell?.prob === prob && matrixCell?.imp === imp) {
      setMatrixCell(null)
    } else {
      setMatrixCell({ prob, imp })
    }
  }

  function handleCreateSubmit(f: FormState) {
    createMut.mutate(f)
  }

  function handleEditSubmit(f: FormState) {
    if (!editRisk) return
    updateMut.mutate({ id: editRisk.id, f })
  }

  function startEdit(r: Risk) {
    setEditRisk(r)
    setShowForm(false)
  }

  const btnBase: React.CSSProperties = {
    padding: '4px 10px',
    borderRadius: 5,
    border: '1px solid var(--border)',
    background: 'transparent',
    fontSize: 11,
    cursor: 'pointer',
    fontWeight: 500,
  }

  const filterBtn = (active: boolean): React.CSSProperties => ({
    padding: '4px 10px',
    borderRadius: 5,
    border: `1px solid ${active ? '#3b82f6' : 'var(--border)'}`,
    background: active ? '#3b82f622' : 'transparent',
    color: active ? '#3b82f6' : 'var(--text-secondary)',
    fontSize: 11,
    cursor: 'pointer',
    fontWeight: active ? 600 : 400,
  })

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1200, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>
            Risk Register
          </h1>
          <p style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
            {risks.length} total risk{risks.length !== 1 ? 's' : ''}
            {filtered.length !== risks.length && ` · ${filtered.length} shown`}
          </p>
        </div>
        <button
          onClick={() => { setShowForm(f => !f); setEditRisk(null) }}
          style={{
            padding: '7px 16px',
            borderRadius: 7,
            border: 'none',
            background: '#3b82f6',
            color: '#fff',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span style={{ fontSize: 16, lineHeight: 1 }}>+</span> Add Risk
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <div style={{ marginBottom: 16, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ padding: '10px 16px', background: 'var(--bg-surface)', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
            New Risk
          </div>
          <RiskForm
            initial={EMPTY_FORM}
            onSubmit={handleCreateSubmit}
            onCancel={() => setShowForm(false)}
            submitting={createMut.isPending}
          />
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const, marginBottom: 16, alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 2 }}>Severity:</span>
        {(['all', 'critical', 'high', 'medium', 'low'] as SeverityFilter[]).map(s => (
          <button key={s} style={filterBtn(severityFilter === s)} onClick={() => setSeverityFilter(s)}>
            {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8, marginRight: 2 }}>Status:</span>
        {(['all', 'open', 'mitigating', 'resolved', 'accepted'] as StatusFilter[]).map(s => (
          <button key={s} style={filterBtn(statusFilter === s)} onClick={() => setStatusFilter(s)}>
            {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
        {matrixCell && (
          <button
            onClick={() => setMatrixCell(null)}
            style={{ ...btnBase, color: 'var(--text-secondary)', marginLeft: 8 }}
          >
            ✕ Clear matrix filter
          </button>
        )}
      </div>

      {/* Matrix toggle + panel */}
      <div style={{ marginBottom: 16, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', background: 'var(--bg-surface)' }}>
        <button
          onClick={() => setShowMatrix(m => !m)}
          style={{
            width: '100%',
            padding: '10px 16px',
            background: 'transparent',
            border: 'none',
            borderBottom: showMatrix ? '1px solid var(--border)' : 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            cursor: 'pointer',
            color: 'var(--text-primary)',
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600 }}>Risk Matrix</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{showMatrix ? '▲ hide' : '▼ show'}</span>
        </button>
        {showMatrix && (
          <RiskMatrix
            risks={risks}
            onCellClick={handleMatrixClick}
            activeCell={matrixCell}
          />
        )}
      </div>

      {/* Risk list */}
      <SectionPanel
        title="Risks"
        subtitle={`${filtered.length} risk${filtered.length !== 1 ? 's' : ''}`}
        loading={isLoading}
      >
        {filtered.length === 0 ? (
          <div style={{
            display: 'flex',
            flexDirection: 'column' as const,
            alignItems: 'center',
            justifyContent: 'center',
            padding: '48px 24px',
            color: 'var(--text-muted)',
          }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>🛡️</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
              No risks found
            </div>
            <div style={{ fontSize: 12 }}>
              {risks.length === 0 ? 'Add your first risk to get started.' : 'Try adjusting your filters.'}
            </div>
          </div>
        ) : (
          <div>
            {/* List header */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '2fr 80px 90px 64px 100px 150px',
              gap: 8,
              padding: '8px 16px',
              borderBottom: '1px solid var(--border)',
              fontSize: 10,
              fontWeight: 600,
              color: 'var(--text-muted)',
              textTransform: 'uppercase' as const,
              letterSpacing: 0.5,
            }}>
              <span>Risk</span>
              <span>Severity</span>
              <span>Status</span>
              <span style={{ textAlign: 'center' }}>Score</span>
              <span>Owner</span>
              <span style={{ textAlign: 'right' }}>Actions</span>
            </div>

            {filtered.map(r => (
              <div key={r.id}>
                {/* Edit form inline */}
                {editRisk?.id === r.id && (
                  <div style={{ borderBottom: '1px solid var(--border)' }}>
                    <RiskForm
                      initial={{
                        title:       r.title,
                        description: r.description ?? '',
                        severity:    r.severity,
                        probability: r.probability,
                        impact:      r.impact,
                        likelihood:  toBucket(r.probability),
                        owner:       '',
                        mitigation:  '',
                        category:    r.category,
                      }}
                      onSubmit={handleEditSubmit}
                      onCancel={() => setEditRisk(null)}
                      submitting={updateMut.isPending}
                    />
                  </div>
                )}

                {/* Row */}
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: '2fr 80px 90px 64px 100px 150px',
                  gap: 8,
                  padding: '10px 16px',
                  borderBottom: '1px solid var(--border)',
                  alignItems: 'center',
                  background: editRisk?.id === r.id ? 'var(--bg-elevated)' : 'transparent',
                }}>
                  {/* Title + description */}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {r.title}
                    </div>
                    {r.description && (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.description}
                      </div>
                    )}
                  </div>

                  {/* Severity */}
                  <div><Badge label={r.severity} color={severityColor(r.severity)} /></div>

                  {/* Status */}
                  <div><Badge label={r.status} color={statusColor(r.status)} /></div>

                  {/* Score */}
                  <div style={{ textAlign: 'center', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                    {r.riskScore.toFixed(1)}
                  </div>

                  {/* Owner (category as fallback) */}
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.category}
                  </div>

                  {/* Actions */}
                  <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end', flexWrap: 'wrap' as const }}>
                    {r.status !== 'mitigating' && r.status !== 'resolved' && (
                      <button
                        onClick={() => {
                          if (mitigateId === r.id) { setMitigateId(null); setMitigateDesc('') }
                          else { setMitigateId(r.id); setMitigateDesc('') }
                        }}
                        style={{ ...btnBase, color: '#3b82f6', borderColor: '#3b82f644' }}
                      >
                        Mitigate
                      </button>
                    )}
                    {r.status !== 'resolved' && (
                      <button
                        onClick={() => resolveMut.mutate(r.id)}
                        disabled={resolveMut.isPending}
                        style={{ ...btnBase, color: '#22c55e', borderColor: '#22c55e44' }}
                      >
                        Resolve
                      </button>
                    )}
                    <button
                      onClick={() => startEdit(r)}
                      style={{ ...btnBase, color: 'var(--text-secondary)' }}
                    >
                      Edit
                    </button>
                  </div>
                </div>

                {/* Inline mitigate input */}
                {mitigateId === r.id && (
                  <div style={{
                    padding: '10px 16px',
                    borderBottom: '1px solid var(--border)',
                    background: 'var(--bg-elevated)',
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                  }}>
                    <input
                      style={{
                        flex: 1,
                        background: 'var(--bg-primary)',
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        padding: '6px 10px',
                        fontSize: 12,
                        color: 'var(--text-primary)',
                        outline: 'none',
                      }}
                      placeholder="Describe mitigation action…"
                      value={mitigateDesc}
                      onChange={e => setMitigateDesc(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && mitigateDesc.trim()) {
                          mitigateMut.mutate({ id: r.id, desc: mitigateDesc.trim() })
                        }
                      }}
                    />
                    <button
                      onClick={() => mitigateMut.mutate({ id: r.id, desc: mitigateDesc.trim() })}
                      disabled={!mitigateDesc.trim() || mitigateMut.isPending}
                      style={{ ...btnBase, background: '#3b82f6', color: '#fff', border: 'none' }}
                    >
                      Submit
                    </button>
                    <button
                      onClick={() => { setMitigateId(null); setMitigateDesc('') }}
                      style={{ ...btnBase, color: 'var(--text-secondary)' }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </SectionPanel>
    </div>
  )
}
