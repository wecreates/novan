/**
 * Learning Center — overview of learning system status.
 * Links to all 5 sub-pages and shows summary metrics.
 */
import { useQuery }          from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import { RefreshCw, Brain, TrendingUp, MessageSquare, BarChart3, AlertCircle, CheckCircle, Clock, Zap } from 'lucide-react'
import { Link }              from 'react-router-dom'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

// ─── API ──────────────────────────────────────────────────────────────────────

const API = '/api/v1/learning'

interface LearningHealth {
  signalsLast24h: number
  activePatterns: number
  totalInsights:  number
  pendingReview:  number
  totalFeedback:  number
  status:         string
  checkedAt:      number
}

function useHealth() {
  const { workspaceId } = useWorkspace()
  return useQuery<{ success: true; data: LearningHealth }>({
    queryKey: ['learning-health', workspaceId],
    queryFn:  () => fetch(`${API}/health?workspace_id=${workspaceId}`).then((r) => r.json()),
    refetchInterval: 30_000,
  })
}

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({ label, value, icon: Icon, color, to }: { label: string; value: number | string; icon: React.ElementType; color: string; to?: string }) {
  const content = (
    <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px', display: 'flex', flexDirection: 'column', gap: 8, cursor: to ? 'pointer' : 'default', transition: 'border-color 0.15s' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon style={{ width: 16, height: 16, color }} />
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color }}>{value}</div>
    </div>
  )
  if (to) return <Link to={to} style={{ textDecoration: 'none' }}>{content}</Link>
  return content
}

// ─── Quick Link ───────────────────────────────────────────────────────────────

function QuickLink({ to, icon: Icon, label, description, badge }: { to: string; icon: React.ElementType; label: string; description: string; badge?: number }) {
  return (
    <Link to={to} style={{ textDecoration: 'none' }}>
      <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px', display: 'flex', alignItems: 'flex-start', gap: 12, transition: 'border-color 0.15s' }}>
        <div style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--bg-primary)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon style={{ width: 16, height: 16, color: 'var(--text-secondary)' }} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{label}</span>
            {badge !== undefined && badge > 0 && (
              <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 10, background: '#f43f5e33', color: '#f43f5e', border: '1px solid #f43f5e44' }}>{badge}</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{description}</div>
        </div>
      </div>
    </Link>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LearningCenterPage() {
  const { data, isLoading, refetch } = useHealth()
  const health = data?.data

  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--bg-primary)' }}>
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 20px' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Learning Center</h1>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Real operational intelligence — no fake learning, no hidden changes</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {health && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Updated {formatDistanceToNow(health.checkedAt, { addSuffix: true })}
              </span>
            )}
            <button onClick={() => refetch()} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
              <RefreshCw style={{ width: 14, height: 14 }} />
            </button>
          </div>
        </div>

        {/* Status bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 24, padding: '10px 14px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8 }}>
          {health?.status === 'active'
            ? <CheckCircle style={{ width: 14, height: 14, color: '#10b981' }} />
            : <Clock style={{ width: 14, height: 14, color: '#f59e0b' }} />
          }
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            {isLoading ? 'Loading…' : `Learning worker ${health?.status ?? 'unknown'} — signals collected from real ops events`}
          </span>
          {health?.pendingReview !== undefined && health.pendingReview > 0 && (
            <span style={{ marginLeft: 'auto', fontSize: 12, color: '#f59e0b' }}>
              {health.pendingReview} insight{health.pendingReview !== 1 ? 's' : ''} awaiting review
            </span>
          )}
        </div>

        {/* Stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 28 }}>
          <StatCard label="Signals (24h)"   value={health?.signalsLast24h ?? '—'} icon={Zap}          color="#6366f1" to="/learning/patterns" />
          <StatCard label="Active Patterns" value={health?.activePatterns  ?? '—'} icon={TrendingUp}   color="#f59e0b" to="/learning/patterns" />
          <StatCard label="Total Insights"  value={health?.totalInsights   ?? '—'} icon={Brain}        color="#8b5cf6" to="/learning/insights" />
          <StatCard label="Pending Review"  value={health?.pendingReview   ?? '—'} icon={AlertCircle}  color="#f43f5e" to="/learning/insights" />
          <StatCard label="Feedback Items"  value={health?.totalFeedback   ?? '—'} icon={MessageSquare} color="#10b981" to="/learning/feedback" />
        </div>

        {/* Navigation cards */}
        <h2 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 12 }}>Explore</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          <QuickLink
            to="/learning/insights"
            icon={Brain}
            label="Insight Review"
            description="Review, approve, or reject AI-generated insights before they affect anything"
            {...(health?.pendingReview !== undefined ? { badge: health.pendingReview } : {})}
          />
          <QuickLink
            to="/learning/patterns"
            icon={TrendingUp}
            label="Pattern Explorer"
            description="Browse detected patterns with evidence — repeated failures, bottlenecks, friction"
          />
          <QuickLink
            to="/learning/recommendations"
            icon={Zap}
            label="Recommendation Queue"
            description="Approved insights ranked by evidence strength and feedback history"
          />
          <QuickLink
            to="/learning/memory-quality"
            icon={BarChart3}
            label="Memory Quality"
            description="Embedding coverage, retrieval hit rates, stale memory, cluster analysis"
          />
          <QuickLink
            to="/learning/feedback"
            icon={MessageSquare}
            label="Feedback History"
            description="Track which recommendations were accepted, executed, and their outcomes"
          />
        </div>
      </div>
    </div>
  )
}
