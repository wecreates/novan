/**
 * Feedback History — track which recommendations were accepted, rejected,
 * executed, and their measurable outcomes.
 */
import { useQuery }          from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import { RefreshCw, MessageSquare, CheckCircle, XCircle, Minus, TrendingUp } from 'lucide-react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Feedback {
  id:               string
  workspaceId:      string
  recommendationId: string
  insightId:        string | null
  action:           string
  outcome:          string | null
  outcomeNotes:     string | null
  userId:           string | null
  deltaMetric:      number | null
  metricName:       string | null
  createdAt:        number
  updatedAt:        number
}

// ─── API ──────────────────────────────────────────────────────────────────────

const API = '/api/v1/learning'

function makeApi(ws: string) {
  return {
    list: (params: { limit?: number; offset?: number }) => {
      const qs = new URLSearchParams({ workspace_id: ws, limit: String(params.limit ?? 100), offset: String(params.offset ?? 0) })
      return fetch(`${API}/feedback?${qs}`).then((r) => r.json()) as Promise<{ success: true; data: Feedback[]; meta: { count: number } }>
    },
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ACTION_ICON: Record<string, React.ReactNode> = {
  accepted: <CheckCircle style={{ width: 13, height: 13, color: '#10b981' }} />,
  rejected: <XCircle    style={{ width: 13, height: 13, color: '#f43f5e' }} />,
  ignored:  <Minus      style={{ width: 13, height: 13, color: '#64748b' }} />,
  executed: <TrendingUp style={{ width: 13, height: 13, color: '#6366f1' }} />,
}

const ACTION_COLOR: Record<string, string> = {
  accepted: '#10b981',
  rejected: '#f43f5e',
  ignored:  '#64748b',
  executed: '#6366f1',
}

const OUTCOME_COLOR: Record<string, string> = {
  successful: '#10b981',
  failed:     '#f43f5e',
  partial:    '#f59e0b',
  pending:    '#6366f1',
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function StatPill({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: `${color}11`, border: `1px solid ${color}33`, borderRadius: 8 }}>
      <span style={{ fontSize: 18, fontWeight: 700, color }}>{count}</span>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>
    </div>
  )
}

// ─── Row ──────────────────────────────────────────────────────────────────────

function FeedbackRow({ fb }: { fb: Feedback }) {
  const actionColor  = ACTION_COLOR[fb.action]  ?? '#64748b'
  const outcomeColor = fb.outcome ? (OUTCOME_COLOR[fb.outcome] ?? '#64748b') : null

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ width: 20, display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
        {ACTION_ICON[fb.action] ?? <Minus style={{ width: 13, height: 13 }} />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: actionColor, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{fb.action}</span>
          {fb.outcome && (
            <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background: `${outcomeColor}22`, color: outcomeColor!, border: `1px solid ${outcomeColor}44` }}>
              {fb.outcome}
            </span>
          )}
          {fb.deltaMetric !== null && fb.deltaMetric !== undefined && fb.metricName && (
            <span style={{ fontSize: 11, color: fb.deltaMetric >= 0 ? '#10b981' : '#f43f5e' }}>
              {fb.deltaMetric >= 0 ? '+' : ''}{fb.deltaMetric.toFixed(2)} {fb.metricName}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <code style={{ fontSize: 11, color: 'var(--text-muted)' }}>rec:{fb.recommendationId.slice(0, 12)}…</code>
          {fb.outcomeNotes && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fb.outcomeNotes}</span>}
        </div>
      </div>
      <div style={{ flexShrink: 0, fontSize: 11, color: 'var(--text-muted)' }}>
        {formatDistanceToNow(fb.createdAt, { addSuffix: true })}
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function FeedbackHistoryPage() {
  const { workspaceId } = useWorkspace()
  const feedbackApi = makeApi(workspaceId)
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['learning-feedback', workspaceId],
    queryFn:  () => feedbackApi.list({ limit: 100 }),
    refetchInterval: 30_000,
  })

  const feedback = data?.data ?? []
  const total    = data?.meta.count ?? 0

  const accepted  = feedback.filter((f) => f.action === 'accepted').length
  const rejected  = feedback.filter((f) => f.action === 'rejected').length
  const executed  = feedback.filter((f) => f.action === 'executed').length
  const successful = feedback.filter((f) => f.outcome === 'successful').length

  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--bg-primary)' }}>
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '24px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Feedback History</h1>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
              Real outcomes — accepted, rejected, executed recommendations. Used to update recommendation scores.
            </p>
          </div>
          <button onClick={() => refetch()} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
            <RefreshCw style={{ width: 14, height: 14 }} />
          </button>
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 24 }}>
          <StatPill label="total"      count={total}      color="#64748b" />
          <StatPill label="accepted"   count={accepted}   color="#10b981" />
          <StatPill label="rejected"   count={rejected}   color="#f43f5e" />
          <StatPill label="executed"   count={executed}   color="#6366f1" />
          <StatPill label="successful" count={successful} color="#10b981" />
        </div>

        <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: 16 }}>
          {isLoading && <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading feedback…</p>}
          {!isLoading && feedback.length === 0 && (
            <div style={{ textAlign: 'center', padding: '32px 20px', color: 'var(--text-muted)' }}>
              <MessageSquare style={{ width: 28, height: 28, margin: '0 auto 10px', opacity: 0.4 }} />
              <p style={{ fontSize: 13 }}>No feedback recorded yet</p>
              <p style={{ fontSize: 12, marginTop: 4 }}>Accept, reject, or ignore recommendations to build history</p>
            </div>
          )}
          {feedback.map((fb) => <FeedbackRow key={fb.id} fb={fb} />)}
        </div>
      </div>
    </div>
  )
}
