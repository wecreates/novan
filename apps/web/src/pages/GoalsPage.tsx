import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { goalApi, type Goal } from '../api'

// ── Types ─────────────────────────────────────────────────────────────────────

type StatusFilter = 'all' | 'active' | 'draft' | 'completed' | 'archived'

interface GoalForm {
  title: string
  description: string
  horizon: string
  targetValue: string
  targetUnit: string
  status: Goal['status']
}

const emptyForm = (): GoalForm => ({
  title: '',
  description: '',
  horizon: 'medium',
  targetValue: '',
  targetUnit: '',
  status: 'draft',
})

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_TABS: { value: StatusFilter; label: string }[] = [
  { value: 'all',       label: 'All' },
  { value: 'active',    label: 'Active' },
  { value: 'draft',     label: 'Draft' },
  { value: 'completed', label: 'Completed' },
  { value: 'archived',  label: 'Archived' },
]

const STATUS_COLORS: Record<Goal['status'], { bg: string; text: string }> = {
  active:    { bg: '#dcfce7', text: '#166534' },
  draft:     { bg: '#f3f4f6', text: '#374151' },
  paused:    { bg: '#fef9c3', text: '#854d0e' },
  completed: { bg: '#dbeafe', text: '#1e40af' },
  abandoned: { bg: '#fef3c7', text: '#92400e' },
}

const HORIZON_COLORS: Record<string, { bg: string; text: string }> = {
  short:  { bg: '#ede9fe', text: '#5b21b6' },
  medium: { bg: '#fce7f3', text: '#9d174d' },
  long:   { bg: '#ffedd5', text: '#9a3412' },
}

function progressPct(goal: Goal): number {
  if (!goal.keyResults.length) return goal.progress ?? 0
  const total = goal.keyResults.reduce((s, kr) => s + kr.target, 0)
  if (total === 0) return 0
  const curr  = goal.keyResults.reduce((s, kr) => s + kr.current, 0)
  return Math.min(100, Math.round((curr / total) * 100))
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Badge({ bg, text, label }: { bg: string; text: string; label: string }) {
  return (
    <span style={{
      background: bg,
      color: text,
      fontSize: 11,
      fontWeight: 600,
      borderRadius: 6,
      padding: '2px 8px',
      display: 'inline-block',
      textTransform: 'capitalize',
    }}>
      {label}
    </span>
  )
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div style={{
      background: 'var(--border)',
      borderRadius: 99,
      height: 6,
      overflow: 'hidden',
    }}>
      <div style={{
        width: `${pct}%`,
        height: '100%',
        background: 'var(--accent)',
        borderRadius: 99,
        transition: 'width .3s',
      }} />
    </div>
  )
}

// ── Modal shell ───────────────────────────────────────────────────────────────

function Modal({ title, onClose, children }: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 14,
        padding: 28,
        width: '100%',
        maxWidth: 480,
        boxShadow: '0 20px 60px rgba(0,0,0,.3)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 20,
        }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</span>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--text-muted)', fontSize: 20, lineHeight: 1,
          }}>×</button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ── Field helpers ─────────────────────────────────────────────────────────────

const fieldStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: 'var(--bg-surface)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  color: 'var(--text-primary)',
  fontSize: 14,
  outline: 'none',
  boxSizing: 'border-box',
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
        {label}
      </label>
      {children}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function GoalsPage() {
  const qc = useQueryClient()

  const [filter, setFilter]           = useState<StatusFilter>('all')
  const [expanded, setExpanded]       = useState<Set<string>>(new Set())
  const [editGoal, setEditGoal]       = useState<Goal | null>(null)
  const [showCreate, setShowCreate]   = useState(false)
  const [progressGoal, setProgressGoal] = useState<Goal | null>(null)

  // form state
  const [form, setForm]               = useState<GoalForm>(emptyForm())
  const [progressVal, setProgressVal] = useState('')
  const [progressNote, setProgressNote] = useState('')

  // ── Queries ────────────────────────────────────────────────────────────────

  const { data, isLoading } = useQuery({
    queryKey: ['goals', filter],
    queryFn: async () => {
      const res = await goalApi.list(filter !== 'all' ? { status: filter } : undefined)
      return res.data
    },
  })

  const goals: Goal[] = data ?? []

  // ── Mutations ──────────────────────────────────────────────────────────────

  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['goals'] }) }

  const createMut = useMutation({
    mutationFn: (f: GoalForm) => goalApi.create({
      title: f.title,
      ...(f.description ? { description: f.description } : {}),
      ...(f.horizon     ? { horizon: f.horizon }         : {}),
    }),
    onSuccess: () => { invalidate(); setShowCreate(false); setForm(emptyForm()) },
  })

  const updateMut = useMutation({
    mutationFn: ({ id, f }: { id: string; f: GoalForm }) => goalApi.update(id, {
      title: f.title,
      ...(f.description ? { description: f.description } : {}),
      horizon: f.horizon,
      status: f.status,
    }),
    onSuccess: () => { invalidate(); setEditGoal(null); setForm(emptyForm()) },
  })

  const progressMut = useMutation({
    mutationFn: ({ id, val }: { id: string; val: number }) => goalApi.progress(id, val),
    onSuccess: () => { invalidate(); setProgressGoal(null); setProgressVal(''); setProgressNote('') },
  })

  const completeMut = useMutation({
    mutationFn: (id: string) => goalApi.complete(id),
    onSuccess: invalidate,
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => goalApi.update(id, { status: 'abandoned' }),
    onSuccess: invalidate,
  })

  // ── Handlers ───────────────────────────────────────────────────────────────

  function openCreate() {
    setForm(emptyForm())
    setShowCreate(true)
  }

  function openEdit(g: Goal) {
    setForm({
      title:       g.title,
      description: g.description ?? '',
      horizon:     g.horizon,
      targetValue: '',
      targetUnit:  '',
      status:      g.status,
    })
    setEditGoal(g)
  }

  function openProgress(g: Goal) {
    setProgressVal(String(g.progress))
    setProgressNote('')
    setProgressGoal(g)
  }

  function toggleExpand(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function submitForm() {
    if (!form.title.trim()) return
    if (editGoal) {
      updateMut.mutate({ id: editGoal.id, f: form })
    } else {
      createMut.mutate(form)
    }
  }

  function submitProgress() {
    if (!progressGoal) return
    const val = parseFloat(progressVal)
    if (isNaN(val)) return
    progressMut.mutate({ id: progressGoal.id, val })
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: '24px 28px', maxWidth: 900, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>
            Strategic Goals
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
            Track objectives and key results
          </p>
        </div>
        <button
          onClick={openCreate}
          style={{
            background: 'var(--accent)',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            padding: '8px 16px',
            fontWeight: 600,
            fontSize: 14,
            cursor: 'pointer',
          }}
        >
          + New Goal
        </button>
      </div>

      {/* Status filter tabs */}
      <div style={{
        display: 'flex', gap: 4, marginBottom: 20,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 10, padding: 4,
        width: 'fit-content',
      }}>
        {STATUS_TABS.map(tab => (
          <button
            key={tab.value}
            onClick={() => setFilter(tab.value)}
            style={{
              background: filter === tab.value ? 'var(--bg-elevated)' : 'transparent',
              color: filter === tab.value ? 'var(--text-primary)' : 'var(--text-muted)',
              border: filter === tab.value ? '1px solid var(--border)' : '1px solid transparent',
              borderRadius: 7, padding: '5px 14px',
              fontSize: 13, fontWeight: filter === tab.value ? 600 : 400,
              cursor: 'pointer', transition: 'all .15s',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Loading */}
      {isLoading && (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)', fontSize: 14 }}>
          Loading goals…
        </div>
      )}

      {/* Empty state */}
      {!isLoading && goals.length === 0 && (
        <div style={{
          textAlign: 'center', padding: 60,
          border: '2px dashed var(--border)', borderRadius: 14,
          color: 'var(--text-muted)',
        }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>🎯</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
            No goals yet
          </div>
          <div style={{ fontSize: 13 }}>Create your first strategic goal.</div>
          <button
            onClick={openCreate}
            style={{
              marginTop: 18, background: 'var(--accent)', color: '#fff',
              border: 'none', borderRadius: 8, padding: '8px 18px',
              fontWeight: 600, fontSize: 13, cursor: 'pointer',
            }}
          >
            + New Goal
          </button>
        </div>
      )}

      {/* Goal cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {goals.map(goal => {
          const pct       = progressPct(goal)
          const sColor    = STATUS_COLORS[goal.status] ?? STATUS_COLORS.draft
          const hKey      = goal.horizon.toLowerCase()
          const hColor    = HORIZON_COLORS[hKey] ?? HORIZON_COLORS['medium']!
          const isExpanded = expanded.has(goal.id)

          return (
            <div
              key={goal.id}
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                borderRadius: 12,
                padding: '18px 20px',
              }}
            >
              {/* Card top row */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                    <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
                      {goal.title}
                    </span>
                    <Badge bg={sColor.bg} text={sColor.text} label={goal.status} />
                    <Badge bg={hColor.bg} text={hColor.text} label={`${goal.horizon} term`} />
                  </div>
                  {goal.description && (
                    <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                      {goal.description}
                    </p>
                  )}

                  {/* Progress bar */}
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Progress</span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{pct}%</span>
                    </div>
                    <ProgressBar pct={pct} />
                  </div>

                  {/* Key results toggle */}
                  {goal.keyResults.length > 0 && (
                    <button
                      onClick={() => toggleExpand(goal.id)}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: 'var(--accent)', fontSize: 12, fontWeight: 600,
                        padding: 0, marginTop: 4,
                      }}
                    >
                      {isExpanded ? '▲ Hide' : '▼ Show'} {goal.keyResults.length} key result{goal.keyResults.length !== 1 ? 's' : ''}
                    </button>
                  )}
                </div>

                {/* Actions */}
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <ActionBtn label="Edit"     onClick={() => openEdit(goal)} />
                  <ActionBtn label="Progress" onClick={() => openProgress(goal)} />
                  {goal.status !== 'completed' && (
                    <ActionBtn label="Complete" onClick={() => completeMut.mutate(goal.id)} />
                  )}
                  <ActionBtn label="Delete" danger onClick={() => {
                    if (confirm(`Delete "${goal.title}"?`)) deleteMut.mutate(goal.id)
                  }} />
                </div>
              </div>

              {/* Expanded key results */}
              {isExpanded && goal.keyResults.length > 0 && (
                <div style={{
                  marginTop: 14,
                  borderTop: '1px solid var(--border)',
                  paddingTop: 14,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}>
                  {goal.keyResults.map(kr => {
                    const krPct = kr.target > 0 ? Math.min(100, Math.round((kr.current / kr.target) * 100)) : 0
                    return (
                      <div key={kr.id}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{kr.title}</span>
                          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            {kr.current}{kr.unit} / {kr.target}{kr.unit} ({krPct}%)
                          </span>
                        </div>
                        <ProgressBar pct={krPct} />
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* ── Create / Edit Modal ─────────────────────────────────────────────── */}
      {(showCreate || editGoal !== null) && (
        <Modal
          title={editGoal ? 'Edit Goal' : 'New Goal'}
          onClose={() => { setShowCreate(false); setEditGoal(null); setForm(emptyForm()) }}
        >
          <Field label="Title *">
            <input
              style={fieldStyle}
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder="Goal title"
            />
          </Field>
          <Field label="Description">
            <textarea
              style={{ ...fieldStyle, minHeight: 72, resize: 'vertical' }}
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Optional description"
            />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Horizon">
              <select
                style={fieldStyle}
                value={form.horizon}
                onChange={e => setForm(f => ({ ...f, horizon: e.target.value }))}
              >
                <option value="short">Short term</option>
                <option value="medium">Medium term</option>
                <option value="long">Long term</option>
              </select>
            </Field>
            <Field label="Status">
              <select
                style={fieldStyle}
                value={form.status}
                onChange={e => setForm(f => ({ ...f, status: e.target.value as Goal['status'] }))}
              >
                <option value="draft">Draft</option>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                <option value="completed">Completed</option>
                <option value="abandoned">Abandoned</option>
              </select>
            </Field>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            <button
              onClick={submitForm}
              disabled={!form.title.trim() || createMut.isPending || updateMut.isPending}
              style={{
                flex: 1,
                background: 'var(--accent)', color: '#fff',
                border: 'none', borderRadius: 8,
                padding: '9px 0', fontWeight: 600, fontSize: 14,
                cursor: 'pointer', opacity: form.title.trim() ? 1 : .5,
              }}
            >
              {editGoal ? 'Save Changes' : 'Create Goal'}
            </button>
            <button
              onClick={() => { setShowCreate(false); setEditGoal(null); setForm(emptyForm()) }}
              style={{
                background: 'var(--bg-surface)', color: 'var(--text-secondary)',
                border: '1px solid var(--border)', borderRadius: 8,
                padding: '9px 20px', fontWeight: 600, fontSize: 14, cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </Modal>
      )}

      {/* ── Record Progress Modal ───────────────────────────────────────────── */}
      {progressGoal !== null && (
        <Modal
          title={`Record Progress — ${progressGoal.title}`}
          onClose={() => { setProgressGoal(null); setProgressVal(''); setProgressNote('') }}
        >
          <Field label="Current Progress (%)">
            <input
              style={fieldStyle}
              type="number"
              min={0}
              max={100}
              value={progressVal}
              onChange={e => setProgressVal(e.target.value)}
              placeholder="0–100"
            />
          </Field>
          <Field label="Notes (optional)">
            <textarea
              style={{ ...fieldStyle, minHeight: 64, resize: 'vertical' }}
              value={progressNote}
              onChange={e => setProgressNote(e.target.value)}
              placeholder="What was accomplished?"
            />
          </Field>
          <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            <button
              onClick={submitProgress}
              disabled={progressVal === '' || progressMut.isPending}
              style={{
                flex: 1,
                background: 'var(--accent)', color: '#fff',
                border: 'none', borderRadius: 8,
                padding: '9px 0', fontWeight: 600, fontSize: 14,
                cursor: 'pointer', opacity: progressVal !== '' ? 1 : .5,
              }}
            >
              Save Progress
            </button>
            <button
              onClick={() => { setProgressGoal(null); setProgressVal(''); setProgressNote('') }}
              style={{
                background: 'var(--bg-surface)', color: 'var(--text-secondary)',
                border: '1px solid var(--border)', borderRadius: 8,
                padding: '9px 20px', fontWeight: 600, fontSize: 14, cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ── ActionBtn ─────────────────────────────────────────────────────────────────

function ActionBtn({ label, onClick, danger }: { label: string; onClick: () => void; danger?: true }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: danger ? '#fee2e2' : 'var(--bg-elevated)',
        color: danger ? '#991b1b' : 'var(--text-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 7,
        padding: '5px 10px',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  )
}
