/**
 * Pattern Explorer — browse detected operational patterns with evidence.
 * Shows: pattern type, occurrences, confidence, affected IDs, status.
 * All patterns include real evidence. Confidence is never faked.
 */
import { useState }          from 'react'
import { useQuery }          from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import { RefreshCw, TrendingUp, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Pattern {
  id:          string
  workspaceId: string
  patternType: string
  title:       string
  description: string
  occurrences: number
  confidence:  number
  evidence:    unknown[]
  affectedIds: string[]
  status:      string
  firstSeenAt: number
  lastSeenAt:  number
}

// ─── API ──────────────────────────────────────────────────────────────────────

const API = '/api/v1/learning'

function makeApi(ws: string) {
  return {
    list: (params: { type?: string; status?: string }) => {
      const qs = new URLSearchParams({ workspace_id: ws, limit: '100' })
      if (params.type)   qs.set('pattern_type', params.type)
      if (params.status) qs.set('status', params.status)
      return fetch(`${API}/patterns?${qs}`).then((r) => r.json()) as Promise<{ success: true; data: Pattern[] }>
    },
    updateStatus: (id: string, status: string) =>
      fetch(`${API}/patterns/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }).then((r) => r.json()),
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PATTERN_TYPES = ['all', 'repeated_failure', 'approval_friction', 'recurring_bottleneck', 'high_performing_workflow', 'slow_route', 'recovery_path', 'abandoned_workflow', 'duplicate_task', 'stale_context'] as const
const STATUS_FILTERS = ['active', 'resolved', 'ignored'] as const

const TYPE_COLORS: Record<string, string> = {
  repeated_failure:        '#f43f5e',
  approval_friction:       '#f59e0b',
  recurring_bottleneck:    '#fb923c',
  high_performing_workflow: '#10b981',
  slow_route:              '#0ea5e9',
  recovery_path:           '#6366f1',
  abandoned_workflow:      '#8b5cf6',
  duplicate_task:          '#64748b',
  stale_context:           '#475569',
}

// ─── Pattern Card ─────────────────────────────────────────────────────────────

function PatternCard({ pattern }: { pattern: Pattern }) {
  const [expanded, setExpanded] = useState(false)
  const color  = TYPE_COLORS[pattern.patternType] ?? '#64748b'
  const confPct = Math.round(pattern.confidence * 100)

  return (
    <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: 16, marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, marginTop: 5, flexShrink: 0 }} />
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', padding: '2px 6px', borderRadius: 4, background: `${color}22`, color, border: `1px solid ${color}44`, textTransform: 'uppercase' }}>
              {pattern.patternType.replace(/_/g, ' ')}
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{pattern.occurrences}x occurrences</span>
            <span style={{ fontSize: 11, color: confPct >= 80 ? '#10b981' : confPct >= 60 ? '#f59e0b' : '#f43f5e' }}>{confPct}% confidence</span>
            {pattern.confidence < 0.6 && <AlertTriangle style={{ width: 12, height: 12, color: '#f43f5e' }} />}
          </div>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 4px 0' }}>{pattern.title}</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 8px 0', lineHeight: 1.5 }}>{pattern.description}</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              onClick={() => setExpanded(!expanded)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, padding: 0 }}
            >
              {expanded ? <ChevronDown style={{ width: 12, height: 12 }} /> : <ChevronRight style={{ width: 12, height: 12 }} />}
              Evidence
            </button>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>First seen {formatDistanceToNow(pattern.firstSeenAt, { addSuffix: true })}</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Last {formatDistanceToNow(pattern.lastSeenAt, { addSuffix: true })}</span>
          </div>
          {expanded && (
            <div style={{ marginTop: 10 }}>
              <pre style={{ fontSize: 11, color: 'var(--text-secondary)', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: 10, overflow: 'auto', maxHeight: 180 }}>
                {JSON.stringify(pattern.evidence, null, 2)}
              </pre>
              {pattern.affectedIds.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Affected: </span>
                  {pattern.affectedIds.slice(0, 5).map((id) => (
                    <code key={id} style={{ fontSize: 11, color: 'var(--text-secondary)', background: 'var(--bg-primary)', padding: '1px 4px', borderRadius: 3, marginRight: 4 }}>{id.slice(0, 20)}…</code>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div style={{ flexShrink: 0, fontSize: 11, padding: '3px 8px', borderRadius: 5,
          background: pattern.status === 'active' ? '#10b98122' : pattern.status === 'resolved' ? 'var(--bg-primary)' : '#64748b22',
          color: pattern.status === 'active' ? '#10b981' : 'var(--text-muted)',
          border: `1px solid ${pattern.status === 'active' ? '#10b98144' : 'var(--border)'}`,
        }}>
          {pattern.status}
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PatternExplorerPage() {
  const [typeFilter, setTypeFilter]     = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('active')
  const { workspaceId } = useWorkspace()
  const patternApi = makeApi(workspaceId)

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['learning-patterns', workspaceId, typeFilter, statusFilter],
    queryFn:  () => patternApi.list(typeFilter === 'all' ? { status: statusFilter } : { type: typeFilter, status: statusFilter }),
    refetchInterval: 30_000,
  })

  const patterns = data?.data ?? []

  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--bg-primary)' }}>
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '24px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Pattern Explorer</h1>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Real patterns detected from operational signals — each includes evidence</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{patterns.length} patterns</span>
            <button onClick={() => refetch()} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
              <RefreshCw style={{ width: 14, height: 14 }} />
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          {STATUS_FILTERS.map((s) => (
            <button key={s} onClick={() => setStatusFilter(s)}
              style={{ padding: '4px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer', border: '1px solid var(--border)',
                background: statusFilter === s ? 'var(--bg-elevated)' : 'transparent',
                color: statusFilter === s ? 'var(--text-primary)' : 'var(--text-muted)',
              }}>{s}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 20, flexWrap: 'wrap' }}>
          {PATTERN_TYPES.map((t) => (
            <button key={t} onClick={() => setTypeFilter(t)}
              style={{ padding: '3px 8px', borderRadius: 5, fontSize: 11, cursor: 'pointer', border: '1px solid var(--border)',
                background: typeFilter === t ? 'var(--bg-elevated)' : 'transparent',
                color: typeFilter === t ? 'var(--text-primary)' : 'var(--text-muted)',
              }}>{t.replace(/_/g, ' ')}</button>
          ))}
        </div>

        {isLoading && <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading patterns…</p>}
        {!isLoading && patterns.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
            <TrendingUp style={{ width: 32, height: 32, margin: '0 auto 12px', opacity: 0.4 }} />
            <p style={{ fontSize: 13 }}>No {statusFilter} patterns{typeFilter !== 'all' ? ` of type "${typeFilter.replace(/_/g, ' ')}"` : ''}</p>
          </div>
        )}

        {patterns.map((p) => <PatternCard key={p.id} pattern={p} />)}
      </div>
    </div>
  )
}
