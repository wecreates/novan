/**
 * Memory Quality — embedding coverage, score distribution, stale memory stats.
 * Shows real quality metrics. No fake scores. Confidence always displayed.
 */
import { useQuery }          from '@tanstack/react-query'
import { RefreshCw, Database, AlertTriangle, CheckCircle, TrendingDown } from 'lucide-react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Score {
  id:          string
  entityType:  string
  entityId:    string
  scoreType:   string
  scoreValue:  number
  sampleCount: number
  updatedAt:   number
}

// ─── API ──────────────────────────────────────────────────────────────────────

const API = '/api/v1/learning'

function makeApi(ws: string) {
  return {
    memoryScores: () =>
      fetch(`${API}/scores?workspace_id=${ws}&entity_type=memory&score_type=relevance&limit=500`).then((r) => r.json()) as Promise<{ success: true; data: Score[] }>,
    workflowScores: () =>
      fetch(`${API}/scores?workspace_id=${ws}&entity_type=workflow&score_type=reliability&limit=200`).then((r) => r.json()) as Promise<{ success: true; data: Score[] }>,
  }
}

// ─── Histogram ────────────────────────────────────────────────────────────────

function ScoreHistogram({ scores }: { scores: Score[] }) {
  const buckets = [0, 0, 0, 0, 0]  // 0-20, 20-40, 40-60, 60-80, 80-100
  scores.forEach((s) => { const idx = Math.min(Math.floor(s.scoreValue * 5), 4); buckets[idx]!++ })
  const maxVal = Math.max(...buckets, 1)
  const labels = ['0-20%', '20-40%', '40-60%', '60-80%', '80-100%']
  const colors  = ['#f43f5e', '#fb923c', '#f59e0b', '#6366f1', '#10b981']

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', height: 80, padding: '0 4px' }}>
      {buckets.map((count, i) => (
        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
          <div style={{ height: `${Math.round((count / maxVal) * 60)}px`, width: '100%', background: colors[i], borderRadius: '3px 3px 0 0', minHeight: count > 0 ? 4 : 0, transition: 'height 0.3s' }} />
          <span style={{ fontSize: 9, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{labels[i]}</span>
          <span style={{ fontSize: 9, color: 'var(--text-secondary)' }}>{count}</span>
        </div>
      ))}
    </div>
  )
}

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({ label, value, sublabel, color, icon: Icon }: { label: string; value: string | number; sublabel?: string; color: string; icon: React.ElementType }) {
  return (
    <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Icon style={{ width: 14, height: 14, color }} />
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color }}>{value}</div>
      {sublabel && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{sublabel}</div>}
    </div>
  )
}

// ─── Score Row ────────────────────────────────────────────────────────────────

function ScoreRow({ score }: { score: Score }) {
  const pct   = Math.round(score.scoreValue * 100)
  const color = pct >= 80 ? '#10b981' : pct >= 60 ? '#f59e0b' : '#f43f5e'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <code style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{score.entityId.slice(0, 24)}…</code>
      </div>
      <div style={{ width: 80, height: 4, background: 'var(--bg-primary)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 2 }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 600, color, width: 36, textAlign: 'right' }}>{pct}%</span>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 60, textAlign: 'right' }}>{score.sampleCount}x</span>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MemoryQualityPage() {
  const { workspaceId } = useWorkspace()
  const memQualityApi = makeApi(workspaceId)
  const { data: memData, refetch } = useQuery({ queryKey: ['mem-scores', workspaceId], queryFn: memQualityApi.memoryScores, refetchInterval: 60_000 })
  const { data: wfData }           = useQuery({ queryKey: ['wf-scores',  workspaceId], queryFn: memQualityApi.workflowScores, refetchInterval: 60_000 })

  const memScores = memData?.data ?? []
  const wfScores  = wfData?.data  ?? []

  const avgMemScore  = memScores.length === 0 ? null : memScores.reduce((s, r) => s + r.scoreValue, 0) / memScores.length
  const staleCount   = memScores.filter((s) => s.scoreValue < 0.3).length
  const highCount    = memScores.filter((s) => s.scoreValue >= 0.8).length
  const avgWfScore   = wfScores.length === 0 ? null : wfScores.reduce((s, r) => s + r.scoreValue, 0) / wfScores.length

  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--bg-primary)' }}>
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Memory Quality</h1>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Real quality scores computed from retrieval frequency, age, and confidence</p>
          </div>
          <button onClick={() => refetch()} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
            <RefreshCw style={{ width: 14, height: 14 }} />
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 28 }}>
          <StatCard label="Memories Scored"  value={memScores.length}                                    sublabel="total scored" color="#6366f1" icon={Database} />
          <StatCard label="Avg Memory Score" value={avgMemScore !== null ? `${Math.round(avgMemScore * 100)}%` : '—'} color={avgMemScore !== null && avgMemScore >= 0.6 ? '#10b981' : '#f59e0b'} icon={CheckCircle} />
          <StatCard label="High Quality"     value={highCount}                                            sublabel="score >= 80%" color="#10b981" icon={TrendingDown} />
          <StatCard label="Low Quality"      value={staleCount}                                           sublabel="score < 30%"  color="#f43f5e" icon={AlertTriangle} />
          <StatCard label="Workflows Scored" value={wfScores.length}                                      sublabel="total scored" color="#f59e0b" icon={Database} />
          <StatCard label="Avg WF Reliability" value={avgWfScore !== null ? `${Math.round(avgWfScore * 100)}%` : '—'} color={avgWfScore !== null && avgWfScore >= 0.7 ? '#10b981' : '#f59e0b'} icon={CheckCircle} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 28 }}>
          <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: 16 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', margin: '0 0 16px 0' }}>Memory Score Distribution</h3>
            {memScores.length > 0 ? <ScoreHistogram scores={memScores} /> : <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No scored memories yet</p>}
          </div>
          <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: 16 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', margin: '0 0 16px 0' }}>Workflow Reliability Distribution</h3>
            {wfScores.length > 0 ? <ScoreHistogram scores={wfScores} /> : <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No scored workflows yet</p>}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: 16 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', margin: '0 0 12px 0' }}>Lowest Quality Memories</h3>
            {memScores.sort((a, b) => a.scoreValue - b.scoreValue).slice(0, 15).map((s) => <ScoreRow key={s.id} score={s} />)}
          </div>
          <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: 16 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', margin: '0 0 12px 0' }}>Lowest Reliability Workflows</h3>
            {wfScores.sort((a, b) => a.scoreValue - b.scoreValue).slice(0, 15).map((s) => <ScoreRow key={s.id} score={s} />)}
          </div>
        </div>
      </div>
    </div>
  )
}
