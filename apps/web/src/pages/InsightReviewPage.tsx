/**
 * Insight Review — review, approve, or reject pending learning insights.
 * All insights require evidence. Low-confidence insights are flagged.
 * No insight auto-executes. Human approval required for actionable items.
 */
import { useState }                                  from 'react'
import { useQuery, useMutation, useQueryClient }     from '@tanstack/react-query'
import { formatDistanceToNow }                       from 'date-fns'
import { RefreshCw, CheckCircle, XCircle, Brain, ChevronDown, ChevronRight } from 'lucide-react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Insight {
  id:             string
  workspaceId:    string
  title:          string
  body:           string
  category:       string
  confidence:     number
  evidence:       unknown[]
  actionRequired: boolean
  approved:       boolean | null
  status:         string
  patternId:      string | null
  createdAt:      number
  updatedAt:      number
}

// ─── API ──────────────────────────────────────────────────────────────────────

const API = '/api/v1/learning'

function makeApi(ws: string) {
  return {
    list: (status?: string) => {
      const qs = new URLSearchParams({ workspace_id: ws, limit: '100' })
      if (status) qs.set('status', status)
      return fetch(`${API}/insights?${qs}`).then((r) => r.json()) as Promise<{ success: true; data: Insight[] }>
    },
    approve: (id: string) =>
      fetch(`${API}/insights/${id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approved_by: 'user' }) }).then((r) => r.json()),
    reject: (id: string, reason?: string) =>
      fetch(`${API}/insights/${id}/reject`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason, rejected_by: 'user' }) }).then((r) => r.json()),
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_FILTERS = ['pending_review', 'approved', 'rejected', 'executed'] as const
const CATEGORY_COLORS: Record<string, string> = {
  reliability: '#f59e0b',
  operational: '#6366f1',
  performance: '#0ea5e9',
  content:     '#10b981',
  revenue:     '#8b5cf6',
  security:    '#f43f5e',
}

function ConfidenceBadge({ value }: { value: number }) {
  const pct   = Math.round(value * 100)
  const color = pct >= 80 ? '#10b981' : pct >= 60 ? '#f59e0b' : '#f43f5e'
  return (
    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 4, background: `${color}22`, color, border: `1px solid ${color}44` }}>
      {pct}% confidence
    </span>
  )
}

function CategoryBadge({ value }: { value: string }) {
  const color = CATEGORY_COLORS[value] ?? '#64748b'
  return (
    <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', padding: '2px 6px', borderRadius: 4, background: `${color}22`, color, border: `1px solid ${color}44`, textTransform: 'uppercase' }}>
      {value}
    </span>
  )
}

// ─── Insight Card ─────────────────────────────────────────────────────────────

function InsightCard({ insight, onApprove, onReject }: { insight: Insight; onApprove: () => void; onReject: () => void }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div style={{ background: 'var(--bg-elevated)', border: `1px solid ${insight.status === 'pending_review' ? '#f59e0b44' : 'var(--border)'}`, borderRadius: 10, padding: 16, marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
            <CategoryBadge value={insight.category} />
            <ConfidenceBadge value={insight.confidence} />
            {insight.actionRequired && (
              <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: '#f43f5e22', color: '#f43f5e', border: '1px solid #f43f5e44' }}>ACTION REQUIRED</span>
            )}
            {insight.confidence < 0.6 && (
              <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: '#f59e0b22', color: '#f59e0b', border: '1px solid #f59e0b44' }}>LOW CONFIDENCE — REVIEW CAREFULLY</span>
            )}
          </div>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 6px 0' }}>{insight.title}</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 8px 0', lineHeight: 1.5 }}>{insight.body}</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              onClick={() => setExpanded(!expanded)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, padding: 0 }}
            >
              {expanded ? <ChevronDown style={{ width: 12, height: 12 }} /> : <ChevronRight style={{ width: 12, height: 12 }} />}
              Evidence ({Array.isArray(insight.evidence) ? insight.evidence.length : 0} items)
            </button>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {formatDistanceToNow(insight.createdAt, { addSuffix: true })}
            </span>
          </div>
          {expanded && (
            <pre style={{ fontSize: 11, color: 'var(--text-secondary)', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: 10, marginTop: 8, overflow: 'auto', maxHeight: 200 }}>
              {JSON.stringify(insight.evidence, null, 2)}
            </pre>
          )}
        </div>
        {insight.status === 'pending_review' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
            <button
              onClick={onApprove}
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 6, background: '#10b98122', border: '1px solid #10b98144', color: '#10b981', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            >
              <CheckCircle style={{ width: 12, height: 12 }} /> Approve
            </button>
            <button
              onClick={onReject}
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 6, background: '#f43f5e22', border: '1px solid #f43f5e44', color: '#f43f5e', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            >
              <XCircle style={{ width: 12, height: 12 }} /> Reject
            </button>
          </div>
        )}
        {insight.status !== 'pending_review' && (
          <div style={{ flexShrink: 0, fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 6,
            background: insight.status === 'approved' ? '#10b98122' : insight.status === 'rejected' ? '#f43f5e22' : 'var(--bg-primary)',
            color: insight.status === 'approved' ? '#10b981' : insight.status === 'rejected' ? '#f43f5e' : 'var(--text-muted)',
            border: `1px solid ${insight.status === 'approved' ? '#10b98144' : insight.status === 'rejected' ? '#f43f5e44' : 'var(--border)'}`,
          }}>
            {insight.status.toUpperCase()}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function InsightReviewPage() {
  const [statusFilter, setStatusFilter] = useState<string>('pending_review')
  const qc = useQueryClient()
  const { workspaceId } = useWorkspace()
  const insightApi = makeApi(workspaceId)

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['learning-insights', workspaceId, statusFilter],
    queryFn:  () => insightApi.list(statusFilter),
    refetchInterval: 30_000,
  })

  const approve = useMutation({
    mutationFn: (id: string) => insightApi.approve(id),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['learning-insights'] }),
  })

  const reject = useMutation({
    mutationFn: (id: string) => insightApi.reject(id),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['learning-insights'] }),
  })

  const insights = data?.data ?? []

  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--bg-primary)' }}>
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '24px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Insight Review</h1>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>All insights require evidence. Low confidence is always visible. No auto-execution.</p>
          </div>
          <button onClick={() => refetch()} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
            <RefreshCw style={{ width: 14, height: 14 }} />
          </button>
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 20, flexWrap: 'wrap' }}>
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              style={{ padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer', border: '1px solid var(--border)',
                background: statusFilter === s ? 'var(--bg-elevated)' : 'transparent',
                color: statusFilter === s ? 'var(--text-primary)' : 'var(--text-muted)',
              }}
            >
              {s.replace('_', ' ')}
            </button>
          ))}
        </div>

        {isLoading && <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading insights…</p>}
        {!isLoading && insights.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
            <Brain style={{ width: 32, height: 32, margin: '0 auto 12px', opacity: 0.4 }} />
            <p style={{ fontSize: 13 }}>No {statusFilter.replace('_', ' ')} insights</p>
          </div>
        )}

        {insights.map((insight) => (
          <InsightCard
            key={insight.id}
            insight={insight}
            onApprove={() => approve.mutate(insight.id)}
            onReject={() => reject.mutate(insight.id)}
          />
        ))}
      </div>
    </div>
  )
}
