import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { insightApi, type Insight } from '../api'

// ── Types ─────────────────────────────────────────────────────────────────────

// The server may return a priority field even if not yet in the shared type
interface InsightWithPriority extends Insight {
  priority?: 'critical' | 'high' | 'medium' | 'low'
}

type TabFilter = 'active' | 'dismissed' | 'all'

interface CreateFormState {
  title:      string
  body:       string
  category:   string
  priority:   string
  confidence: string
  source:     string
  expiresAt:  string
}

const emptyForm = (): CreateFormState => ({
  title:      '',
  body:       '',
  category:   'operational',
  priority:   'medium',
  confidence: '0.8',
  source:     '',
  expiresAt:  '',
})

// ── Priority helpers ──────────────────────────────────────────────────────────

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high:     1,
  medium:   2,
  low:      3,
}

const PRIORITY_COLORS: Record<string, { bg: string; text: string }> = {
  critical: { bg: '#fee2e2', text: '#991b1b' },
  high:     { bg: '#ffedd5', text: '#9a3412' },
  medium:   { bg: '#fef9c3', text: '#854d0e' },
  low:      { bg: '#f3f4f6', text: '#374151' },
}

const CATEGORY_COLORS: Record<string, { bg: string; text: string }> = {
  operational:  { bg: '#dbeafe', text: '#1e40af' },
  strategic:    { bg: '#ede9fe', text: '#5b21b6' },
  risk:         { bg: '#fee2e2', text: '#991b1b' },
  opportunity:  { bg: '#dcfce7', text: '#166534' },
  performance:  { bg: '#fce7f3', text: '#9d174d' },
}

function priorityOrder(i: InsightWithPriority): number {
  return PRIORITY_ORDER[i.priority ?? ''] ?? 4
}

function sortInsights(list: InsightWithPriority[]): InsightWithPriority[] {
  return [...list].sort((a, b) => {
    const pd = priorityOrder(a) - priorityOrder(b)
    return pd !== 0 ? pd : b.createdAt - a.createdAt
  })
}

// ── Time helpers ──────────────────────────────────────────────────────────────

function relativeTime(ts: number): string {
  const diff = Date.now() - ts * 1000
  const m = Math.floor(diff / 60000)
  if (m < 1)  return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(ts * 1000).toLocaleDateString()
}

function expiryLabel(ts: number): { text: string; urgent: boolean } {
  const diff = ts * 1000 - Date.now()
  if (diff <= 0) return { text: 'Expired', urgent: true }
  const h = Math.floor(diff / 3600000)
  if (h < 24) return { text: `Expires in ${h}h`, urgent: true }
  const d = Math.floor(h / 24)
  return { text: `Expires in ${d}d`, urgent: d <= 3 }
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Badge({ bg, text, label }: { bg: string; text: string; label: string }) {
  return (
    <span style={{
      background: bg,
      color:      text,
      fontSize:   11,
      fontWeight: 600,
      borderRadius: 6,
      padding:    '2px 8px',
      display:    'inline-block',
      textTransform: 'capitalize',
      whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  )
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100)
  const color = pct >= 80 ? '#16a34a' : pct >= 50 ? '#d97706' : '#dc2626'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{
        flex: 1,
        background: 'var(--border)',
        borderRadius: 99,
        height: 5,
        overflow: 'hidden',
      }}>
        <div style={{
          width:  `${pct}%`,
          height: '100%',
          background: color,
          borderRadius: 99,
          transition: 'width .3s',
        }} />
      </div>
      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', minWidth: 30 }}>
        {pct}%
      </span>
    </div>
  )
}

const fieldStyle: React.CSSProperties = {
  width:      '100%',
  padding:    '8px 10px',
  background: 'var(--bg-surface)',
  border:     '1px solid var(--border)',
  borderRadius: 8,
  color:      'var(--text-primary)',
  fontSize:   14,
  outline:    'none',
  boxSizing:  'border-box',
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{
        display:    'block',
        fontSize:   12,
        fontWeight: 600,
        color:      'var(--text-secondary)',
        marginBottom: 4,
      }}>
        {label}
      </label>
      {children}
    </div>
  )
}

// ── Insight card ──────────────────────────────────────────────────────────────

function InsightCard({
  insight,
  onActOn,
  onDismiss,
  actOnPending,
  dismissPending,
}: {
  insight:        InsightWithPriority
  onActOn:        (id: string) => void
  onDismiss:      (id: string) => void
  actOnPending:   boolean
  dismissPending: boolean
}) {
  const catColor  = CATEGORY_COLORS[insight.category] ?? CATEGORY_COLORS['operational']!
  const priColor  = insight.priority ? (PRIORITY_COLORS[insight.priority] ?? PRIORITY_COLORS['medium']!) : null
  const isDismissed = insight.dismissed

  return (
    <div style={{
      background:   isDismissed ? 'var(--bg-surface)' : 'var(--bg-elevated)',
      border:       '1px solid var(--border)',
      borderRadius: 12,
      padding:      '20px 22px',
      opacity:      isDismissed ? 0.65 : 1,
      transition:   'opacity .2s',
    }}>
      {/* Top row: title + badges */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
        <h3 style={{
          margin:     0,
          fontSize:   16,
          fontWeight: 700,
          color:      'var(--text-primary)',
          lineHeight: 1.35,
          flex:       1,
        }}>
          {insight.title}
        </h3>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {catColor && <Badge bg={catColor.bg} text={catColor.text} label={insight.category} />}
          {priColor && insight.priority && (
            <Badge bg={priColor.bg} text={priColor.text} label={insight.priority} />
          )}
        </div>
      </div>

      {/* Body */}
      {insight.body && (
        <p style={{
          margin:     '0 0 14px',
          fontSize:   13,
          color:      'var(--text-secondary)',
          lineHeight: 1.6,
        }}>
          {insight.body}
        </p>
      )}

      {/* Confidence */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>
          Confidence
        </div>
        <ConfidenceBar value={insight.confidence} />
      </div>

      {/* Meta row */}
      <div style={{
        display:    'flex',
        flexWrap:   'wrap',
        gap:        '6px 16px',
        fontSize:   12,
        color:      'var(--text-muted)',
        marginBottom: 14,
      }}>
        <span>Source: <strong style={{ color: 'var(--text-secondary)' }}>{insight.source}</strong></span>
        <span>Created {relativeTime(insight.createdAt)}</span>
        {insight.expiresAt !== null && insight.expiresAt !== undefined && (() => {
          const ex = expiryLabel(insight.expiresAt)
          return (
            <span style={{ color: ex.urgent ? '#dc2626' : 'var(--text-muted)', fontWeight: ex.urgent ? 600 : 400 }}>
              {ex.urgent ? '⚠ ' : ''}{ex.text}
            </span>
          )
        })()}
        {insight.actedOn && (
          <span style={{ color: '#16a34a', fontWeight: 600 }}>✓ Acted on</span>
        )}
        {isDismissed && (
          <span style={{ color: 'var(--text-muted)' }}>Dismissed</span>
        )}
      </div>

      {/* Actions — only for non-dismissed insights */}
      {!isDismissed && (
        <div style={{ display: 'flex', gap: 8 }}>
          {!insight.actedOn && (
            <button
              onClick={() => onActOn(insight.id)}
              disabled={actOnPending}
              style={{
                background:   '#dcfce7',
                color:        '#166534',
                border:       '1px solid #bbf7d0',
                borderRadius: 7,
                padding:      '6px 14px',
                fontSize:     12,
                fontWeight:   700,
                cursor:       actOnPending ? 'not-allowed' : 'pointer',
                opacity:      actOnPending ? .6 : 1,
                transition:   'opacity .15s',
              }}
            >
              Act On
            </button>
          )}
          <button
            onClick={() => onDismiss(insight.id)}
            disabled={dismissPending}
            style={{
              background:   'var(--bg-surface)',
              color:        'var(--text-muted)',
              border:       '1px solid var(--border)',
              borderRadius: 7,
              padding:      '6px 14px',
              fontSize:     12,
              fontWeight:   600,
              cursor:       dismissPending ? 'not-allowed' : 'pointer',
              opacity:      dismissPending ? .6 : 1,
              transition:   'opacity .15s',
            }}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  )
}

// ── Create form (inline modal) ────────────────────────────────────────────────

function CreateForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState<CreateFormState>(emptyForm())
  const qc = useQueryClient()

  const createMut = useMutation({
    mutationFn: (f: CreateFormState) => {
      const conf = parseFloat(f.confidence)
      return insightApi.create({
        title:  f.title.trim(),
        body:   f.body.trim(),
        source: f.source.trim(),
        ...(f.category  ? { category:   f.category }          : {}),
        ...(isNaN(conf) ? {}            : { confidence: conf }),
        ...(f.expiresAt ? { expiresAt: Math.floor(new Date(f.expiresAt).getTime() / 1000) } : {}),
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['insights'] })
      onCreated()
    },
  })

  const valid = form.title.trim().length > 0 && form.source.trim().length > 0

  return (
    <div style={{
      position:   'fixed',
      inset:      0,
      zIndex:     1000,
      background: 'rgba(0,0,0,.45)',
      display:    'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background:   'var(--bg-elevated)',
        border:       '1px solid var(--border)',
        borderRadius: 14,
        padding:      28,
        width:        '100%',
        maxWidth:     500,
        boxShadow:    '0 20px 60px rgba(0,0,0,.3)',
        maxHeight:    '90vh',
        overflowY:    'auto',
      }}>
        <div style={{
          display:       'flex',
          alignItems:    'center',
          justifyContent: 'space-between',
          marginBottom:  20,
        }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
            Add Insight
          </span>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border:     'none',
              cursor:     'pointer',
              color:      'var(--text-muted)',
              fontSize:   20,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        <Field label="Title *">
          <input
            style={fieldStyle}
            value={form.title}
            onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
            placeholder="Insight title"
            autoFocus
          />
        </Field>

        <Field label="Body">
          <textarea
            style={{ ...fieldStyle, minHeight: 80, resize: 'vertical' }}
            value={form.body}
            onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
            placeholder="Describe the insight…"
          />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Category">
            <select
              style={fieldStyle}
              value={form.category}
              onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
            >
              <option value="operational">Operational</option>
              <option value="strategic">Strategic</option>
              <option value="risk">Risk</option>
              <option value="opportunity">Opportunity</option>
              <option value="performance">Performance</option>
            </select>
          </Field>

          <Field label="Priority">
            <select
              style={fieldStyle}
              value={form.priority}
              onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
            >
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Confidence (0–1)">
            <input
              style={fieldStyle}
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={form.confidence}
              onChange={e => setForm(f => ({ ...f, confidence: e.target.value }))}
              placeholder="0.8"
            />
          </Field>

          <Field label="Source *">
            <input
              style={fieldStyle}
              value={form.source}
              onChange={e => setForm(f => ({ ...f, source: e.target.value }))}
              placeholder="System or agent name"
            />
          </Field>
        </div>

        <Field label="Expires At (optional)">
          <input
            style={fieldStyle}
            type="date"
            value={form.expiresAt}
            onChange={e => setForm(f => ({ ...f, expiresAt: e.target.value }))}
          />
        </Field>

        <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
          <button
            onClick={() => { if (valid) createMut.mutate(form) }}
            disabled={!valid || createMut.isPending}
            style={{
              flex:         1,
              background:   'var(--accent)',
              color:        '#fff',
              border:       'none',
              borderRadius: 8,
              padding:      '9px 0',
              fontWeight:   600,
              fontSize:     14,
              cursor:       valid && !createMut.isPending ? 'pointer' : 'not-allowed',
              opacity:      valid && !createMut.isPending ? 1 : .5,
            }}
          >
            {createMut.isPending ? 'Creating…' : 'Create Insight'}
          </button>
          <button
            onClick={onClose}
            style={{
              background:   'var(--bg-surface)',
              color:        'var(--text-secondary)',
              border:       '1px solid var(--border)',
              borderRadius: 8,
              padding:      '9px 20px',
              fontWeight:   600,
              fontSize:     14,
              cursor:       'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ tab, onAdd }: { tab: TabFilter; onAdd: () => void }) {
  const msgs: Record<TabFilter, { icon: string; heading: string; sub: string; showAdd: boolean }> = {
    active:    { icon: '💡', heading: 'No active insights', sub: 'Add one or wait for agents to generate insights.', showAdd: true },
    dismissed: { icon: '🗂', heading: 'No dismissed insights', sub: 'Dismissed insights will appear here.', showAdd: false },
    all:       { icon: '💡', heading: 'No insights yet', sub: 'Add your first insight to get started.', showAdd: true },
  }
  const m = msgs[tab]
  return (
    <div style={{
      textAlign:    'center',
      padding:      60,
      border:       '2px dashed var(--border)',
      borderRadius: 14,
      color:        'var(--text-muted)',
    }}>
      <div style={{ fontSize: 36, marginBottom: 12 }}>{m.icon}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
        {m.heading}
      </div>
      <div style={{ fontSize: 13 }}>{m.sub}</div>
      {m.showAdd && (
        <button
          onClick={onAdd}
          style={{
            marginTop:    18,
            background:   'var(--accent)',
            color:        '#fff',
            border:       'none',
            borderRadius: 8,
            padding:      '8px 18px',
            fontWeight:   600,
            fontSize:     13,
            cursor:       'pointer',
          }}
        >
          + Add Insight
        </button>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function InsightsPage() {
  const qc = useQueryClient()

  const [tab, setTab]             = useState<TabFilter>('active')
  const [showCreate, setShowCreate] = useState(false)

  // Pending tracking per-insight
  const [actOnPending,    setActOnPending]    = useState<Set<string>>(new Set())
  const [dismissPending,  setDismissPending]  = useState<Set<string>>(new Set())

  // ── Query ──────────────────────────────────────────────────────────────────

  const queryParam: { dismissed?: boolean } =
    tab === 'active'    ? { dismissed: false } :
    tab === 'dismissed' ? { dismissed: true  } :
    {}

  const { data, isLoading } = useQuery({
    queryKey: ['insights', tab],
    queryFn: async () => {
      const res = await insightApi.list(queryParam)
      return res.data as InsightWithPriority[]
    },
  })

  const insights = sortInsights(data ?? [])

  // ── Mutations ──────────────────────────────────────────────────────────────

  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['insights'] }) }

  function handleActOn(id: string) {
    setActOnPending(prev => { const s = new Set(prev); s.add(id); return s })
    insightApi.actOn(id)
      .then(invalidate)
      .finally(() => setActOnPending(prev => { const s = new Set(prev); s.delete(id); return s }))
  }

  function handleDismiss(id: string) {
    setDismissPending(prev => { const s = new Set(prev); s.add(id); return s })
    insightApi.dismiss(id)
      .then(invalidate)
      .finally(() => setDismissPending(prev => { const s = new Set(prev); s.delete(id); return s }))
  }

  // ── Tabs ───────────────────────────────────────────────────────────────────

  const TABS: { value: TabFilter; label: string }[] = [
    { value: 'active',    label: 'Active'    },
    { value: 'dismissed', label: 'Dismissed' },
    { value: 'all',       label: 'All'       },
  ]

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: '24px 28px', maxWidth: 860, margin: '0 auto' }}>

      {/* Header */}
      <div style={{
        display:       'flex',
        alignItems:    'center',
        justifyContent: 'space-between',
        marginBottom:  24,
      }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--text-primary)' }}>
            Insights
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
            Signals, patterns, and recommendations
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          style={{
            background:   'var(--accent)',
            color:        '#fff',
            border:       'none',
            borderRadius: 8,
            padding:      '8px 16px',
            fontWeight:   600,
            fontSize:     14,
            cursor:       'pointer',
          }}
        >
          + Add Insight
        </button>
      </div>

      {/* Filter tabs */}
      <div style={{
        display:    'flex',
        gap:        4,
        marginBottom: 20,
        background: 'var(--bg-surface)',
        border:     '1px solid var(--border)',
        borderRadius: 10,
        padding:    4,
        width:      'fit-content',
      }}>
        {TABS.map(t => (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            style={{
              background:   tab === t.value ? 'var(--bg-elevated)' : 'transparent',
              color:        tab === t.value ? 'var(--text-primary)' : 'var(--text-muted)',
              border:       tab === t.value ? '1px solid var(--border)' : '1px solid transparent',
              borderRadius: 7,
              padding:      '5px 14px',
              fontSize:     13,
              fontWeight:   tab === t.value ? 600 : 400,
              cursor:       'pointer',
              transition:   'all .15s',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Loading */}
      {isLoading && (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)', fontSize: 14 }}>
          Loading insights…
        </div>
      )}

      {/* Empty state */}
      {!isLoading && insights.length === 0 && (
        <EmptyState tab={tab} onAdd={() => setShowCreate(true)} />
      )}

      {/* Cards */}
      {!isLoading && insights.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {insights.map(insight => (
            <InsightCard
              key={insight.id}
              insight={insight}
              onActOn={handleActOn}
              onDismiss={handleDismiss}
              actOnPending={actOnPending.has(insight.id)}
              dismissPending={dismissPending.has(insight.id)}
            />
          ))}
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <CreateForm
          onClose={() => setShowCreate(false)}
          onCreated={() => setShowCreate(false)}
        />
      )}
    </div>
  )
}
