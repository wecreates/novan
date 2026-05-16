/**
 * Recommendation Queue — approved insights ranked by evidence + feedback.
 * Each recommendation shows: evidence, confidence, expected impact, risk, action.
 * All recommendations are suggestions only. No auto-execution.
 */
import { useState }          from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import { RefreshCw, Zap, ThumbsUp, ThumbsDown, Minus, ChevronDown, ChevronRight } from 'lucide-react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Insight {
  id:             string
  title:          string
  body:           string
  category:       string
  confidence:     number
  evidence:       unknown[]
  actionRequired: boolean
  status:         string
  createdAt:      number
}

interface Score {
  entityId:   string
  scoreValue: number
  sampleCount: number
}

// ─── API ──────────────────────────────────────────────────────────────────────

const API = '/api/v1/learning'

function makeApi(ws: string) {
  return {
    list: () =>
      fetch(`${API}/insights?workspace_id=${ws}&status=approved&limit=100`).then((r) => r.json()) as Promise<{ success: true; data: Insight[] }>,
    scores: () =>
      fetch(`${API}/scores?workspace_id=${ws}&entity_type=insight&score_type=quality&limit=200`).then((r) => r.json()) as Promise<{ success: true; data: Score[] }>,
    feedback: (insightId: string, action: string) =>
      fetch(`${API}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: ws, recommendation_id: insightId, insight_id: insightId, action }) }).then((r) => r.json()),
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  reliability: '#f59e0b', operational: '#6366f1', performance: '#0ea5e9',
  content: '#10b981', revenue: '#8b5cf6', security: '#f43f5e',
}

function RiskBadge({ confidence }: { confidence: number }) {
  if (confidence >= 0.8) return <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#10b98122', color: '#10b981', border: '1px solid #10b98144' }}>LOW RISK</span>
  if (confidence >= 0.6) return <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#f59e0b22', color: '#f59e0b', border: '1px solid #f59e0b44' }}>MEDIUM RISK</span>
  return <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#f43f5e22', color: '#f43f5e', border: '1px solid #f43f5e44' }}>HIGH RISK — REVIEW CAREFULLY</span>
}

// ─── Card ─────────────────────────────────────────────────────────────────────

function RecommendationCard({ insight, score, onFeedback }: { insight: Insight; score?: Score; onFeedback: (action: string) => void }) {
  const [expanded, setExpanded] = useState(false)
  const color    = CATEGORY_COLORS[insight.category] ?? '#64748b'
  const confPct  = Math.round(insight.confidence * 100)
  const rankScore = score ? Math.round(score.scoreValue * 100) : null

  return (
    <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: 16, marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: `${color}22`, color, border: `1px solid ${color}44`, textTransform: 'uppercase' }}>{insight.category}</span>
            <span style={{ fontSize: 11, color: confPct >= 80 ? '#10b981' : '#f59e0b' }}>{confPct}% confidence</span>
            {rankScore !== null && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>rank score: {rankScore}</span>}
            <RiskBadge confidence={insight.confidence} />
            {insight.actionRequired && <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#f43f5e22', color: '#f43f5e', border: '1px solid #f43f5e44' }}>ACTION REQUIRED</span>}
          </div>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 6px 0' }}>{insight.title}</h3>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 8px 0', lineHeight: 1.5 }}>{insight.body}</p>
          <div style={{ marginBottom: 6, fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
            ⚠ This is a suggestion only — no action will be taken automatically. Human approval required.
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <button onClick={() => setExpanded(!expanded)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, padding: 0 }}>
              {expanded ? <ChevronDown style={{ width: 12, height: 12 }} /> : <ChevronRight style={{ width: 12, height: 12 }} />}
              Evidence ({Array.isArray(insight.evidence) ? insight.evidence.length : 0})
            </button>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{formatDistanceToNow(insight.createdAt, { addSuffix: true })}</span>
          </div>
          {expanded && (
            <pre style={{ fontSize: 11, color: 'var(--text-secondary)', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: 10, marginTop: 8, overflow: 'auto', maxHeight: 160 }}>
              {JSON.stringify(insight.evidence, null, 2)}
            </pre>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
          <button onClick={() => onFeedback('accepted')}
            style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 6, background: '#10b98122', border: '1px solid #10b98144', color: '#10b981', fontSize: 11, cursor: 'pointer' }}>
            <ThumbsUp style={{ width: 11, height: 11 }} /> Accept
          </button>
          <button onClick={() => onFeedback('rejected')}
            style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 6, background: '#f43f5e22', border: '1px solid #f43f5e44', color: '#f43f5e', fontSize: 11, cursor: 'pointer' }}>
            <ThumbsDown style={{ width: 11, height: 11 }} /> Reject
          </button>
          <button onClick={() => onFeedback('ignored')}
            style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 6, background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer' }}>
            <Minus style={{ width: 11, height: 11 }} /> Ignore
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RecommendationQueuePage() {
  const qc = useQueryClient()
  const { workspaceId } = useWorkspace()
  const recApi = makeApi(workspaceId)

  const { data, isLoading, refetch } = useQuery({ queryKey: ['recommendations', workspaceId], queryFn: recApi.list, refetchInterval: 30_000 })
  const { data: scoresData }         = useQuery({ queryKey: ['rec-scores', workspaceId], queryFn: recApi.scores })

  const scoreMap = new Map<string, Score>((scoresData?.data ?? []).map((s) => [s.entityId, s]))

  const feedback = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) => recApi.feedback(id, action),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['recommendations'] }),
  })

  const insights = (data?.data ?? []).sort((a, b) => {
    const sa = scoreMap.get(a.id)?.scoreValue ?? a.confidence
    const sb = scoreMap.get(b.id)?.scoreValue ?? b.confidence
    return sb - sa
  })

  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--bg-primary)' }}>
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '24px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Recommendation Queue</h1>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Approved insights ranked by evidence strength + feedback history. Suggestions only.</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{insights.length} recommendations</span>
            <button onClick={() => refetch()} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
              <RefreshCw style={{ width: 14, height: 14 }} />
            </button>
          </div>
        </div>

        {isLoading && <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading recommendations…</p>}
        {!isLoading && insights.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
            <Zap style={{ width: 32, height: 32, margin: '0 auto 12px', opacity: 0.4 }} />
            <p style={{ fontSize: 13 }}>No approved recommendations yet</p>
            <p style={{ fontSize: 12, marginTop: 4 }}>Approve insights in Insight Review to surface them here</p>
          </div>
        )}

        {insights.map((insight) => (
          <RecommendationCard
            key={insight.id}
            insight={insight}
            {...(scoreMap.has(insight.id) ? { score: scoreMap.get(insight.id)! } : {})}
            onFeedback={(action) => feedback.mutate({ id: insight.id, action })}
          />
        ))}
      </div>
    </div>
  )
}
