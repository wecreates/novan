/**
 * FrontierLedgerPage — R146.108 — inspect the Novan frontier loop.
 *
 * Three tabs:
 *   - Findings: ranked AI-research findings ingested from arxiv / HF /
 *     GitHub / labs. Composite score, status badge, click for details.
 *   - Capabilities: catalog of every AI system Novan knows about. Status
 *     ladder (unknown → learning → basics_known → integrated → advancing
 *     → permanent) + realism/quality/efficiency bars.
 *   - Advancements: proposed improvements per capability, with "apply"
 *     deltas.
 *
 * No new components — uses the same minimal table + badge style as
 * BrainTasksPage. Reads via /api/brain/op.
 */
import { useEffect, useState, useCallback } from 'react'
import { API_BASE as BASE } from '../api.js'
import { Activity, BookOpen, Sparkles, RefreshCw } from 'lucide-react'

type Tab = 'findings' | 'capabilities' | 'advancements'

interface Finding {
  id: string; title: string; technique?: string; status: string
  scoreComposite: number; scoreRecency: number; scoreImpact: number
  scoreReplicability: number; scoreApplicability: number
  externalUrl: string; claimedCapability?: string; integrationVector?: string
}

interface Capability {
  id: string; name: string; category: string; status: string
  realismScore: number; qualityScore: number; efficiencyScore: number
  currentVersion: number; advancementCount: number; description?: string
}

interface Advancement {
  id: string; capabilityId: string; kind: string; proposal: string
  expectedGain: number; proposedAt: number; appliedAt?: number
}

interface Stats {
  total: number
  byStatus: Record<string, number>
  byCategory: Record<string, number>
  avgRealism: number; avgQuality: number; avgEfficiency: number
}

async function callOp<T>(op: string, params: Record<string, unknown> = {}): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}/api/brain/op`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, params }),
      credentials: 'include',
    })
    if (!res.ok) return null
    const data = await res.json() as { result?: T }
    return data.result ?? null
  } catch { return null }
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === 'permanent'    ? 'bg-emerald-100 text-emerald-700' :
    status === 'advancing'    ? 'bg-sky-100 text-sky-700' :
    status === 'integrated'   ? 'bg-blue-100 text-blue-700' :
    status === 'basics_known' ? 'bg-amber-100 text-amber-700' :
    status === 'prototyping'  ? 'bg-purple-100 text-purple-700' :
    status === 'specced'      ? 'bg-indigo-100 text-indigo-700' :
    status === 'integrated'   ? 'bg-emerald-100 text-emerald-700' :
                                'bg-gray-100 text-gray-600'
  return <span className={`inline-block px-2 py-0.5 text-xs rounded ${color}`}>{status}</span>
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-xs">
      <div className="flex justify-between text-gray-500"><span>{label}</span><span>{value}</span></div>
      <div className="bg-gray-200 h-1 rounded">
        <div className="bg-sky-500 h-1 rounded" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  )
}

export default function FrontierLedgerPage(): JSX.Element {
  const [tab, setTab] = useState<Tab>('findings')
  const [findings, setFindings] = useState<Finding[]>([])
  const [caps, setCaps] = useState<Capability[]>([])
  const [advances, setAdvances] = useState<Advancement[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    const [f, c, a, s] = await Promise.all([
      callOp<Finding[]>('frontier.ledger', { limit: 50 }),
      callOp<Capability[]>('frontier.listCapabilities', { limit: 100 }),
      callOp<Advancement[]>('frontier.listAdvancements', { limit: 50 }),
      callOp<Stats>('frontier.capabilityStats'),
    ])
    setFindings(f ?? [])
    setCaps(c ?? [])
    setAdvances(a ?? [])
    setStats(s)
    setLoading(false)
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const triggerTick = async () => {
    setLoading(true)
    await callOp('frontier.maxTick')
    await callOp('frontier.consumerTick')
    await refresh()
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">Novan Frontier Ledger</h1>
        <div className="flex gap-2">
          <button onClick={triggerTick} disabled={loading}
            className="px-3 py-1.5 bg-sky-600 text-white rounded text-sm hover:bg-sky-700 disabled:opacity-50 flex items-center gap-1">
            <Sparkles className="w-4 h-4" /> Force tick
          </button>
          <button onClick={() => void refresh()} disabled={loading}
            className="px-3 py-1.5 bg-gray-100 rounded text-sm hover:bg-gray-200 disabled:opacity-50 flex items-center gap-1">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          <div className="bg-gray-50 p-3 rounded">
            <div className="text-xs text-gray-500">Capabilities</div>
            <div className="text-2xl font-semibold">{stats.total}</div>
          </div>
          <div className="bg-gray-50 p-3 rounded">
            <div className="text-xs text-gray-500">Permanent</div>
            <div className="text-2xl font-semibold text-emerald-600">{stats.byStatus.permanent ?? 0}</div>
          </div>
          <div className="bg-gray-50 p-3 rounded">
            <div className="text-xs text-gray-500">Avg realism</div>
            <div className="text-2xl font-semibold">{Math.round(stats.avgRealism)}</div>
          </div>
          <div className="bg-gray-50 p-3 rounded">
            <div className="text-xs text-gray-500">Avg quality</div>
            <div className="text-2xl font-semibold">{Math.round(stats.avgQuality)}</div>
          </div>
          <div className="bg-gray-50 p-3 rounded">
            <div className="text-xs text-gray-500">Avg efficiency</div>
            <div className="text-2xl font-semibold">{Math.round(stats.avgEfficiency)}</div>
          </div>
        </div>
      )}

      <div className="border-b mb-4 flex gap-4">
        {(['findings', 'capabilities', 'advancements'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`pb-2 px-1 text-sm font-medium ${tab === t ? 'border-b-2 border-sky-600 text-sky-600' : 'text-gray-500 hover:text-gray-800'}`}>
            {t === 'findings' && <Activity className="w-4 h-4 inline mr-1" />}
            {t === 'capabilities' && <BookOpen className="w-4 h-4 inline mr-1" />}
            {t === 'advancements' && <Sparkles className="w-4 h-4 inline mr-1" />}
            {t}
          </button>
        ))}
      </div>

      {tab === 'findings' && (
        <div className="space-y-2">
          {findings.length === 0 && <div className="text-gray-500 text-sm">No findings yet. The cron will populate shortly, or click Force tick.</div>}
          {findings.map(f => (
            <div key={f.id} className="border rounded p-3 hover:bg-gray-50">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <a href={f.externalUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-sky-700 hover:underline truncate block">
                    {f.title}
                  </a>
                  {f.technique && <div className="text-xs text-gray-500 mt-0.5">technique: <span className="font-mono">{f.technique}</span></div>}
                  {f.claimedCapability && <div className="text-xs text-gray-700 mt-1">{f.claimedCapability}</div>}
                </div>
                <div className="flex flex-col items-end gap-1">
                  <StatusBadge status={f.status} />
                  <div className="text-xs text-gray-500">score: <span className="font-semibold text-gray-800">{f.scoreComposite}</span></div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'capabilities' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {caps.length === 0 && <div className="text-gray-500 text-sm">No capabilities cataloged yet.</div>}
          {caps.map(c => (
            <div key={c.id} className="border rounded p-3">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div>
                  <div className="text-sm font-medium font-mono">{c.name}</div>
                  <div className="text-xs text-gray-500">{c.category} · v{c.currentVersion} · {c.advancementCount} advances</div>
                </div>
                <StatusBadge status={c.status} />
              </div>
              {c.description && <div className="text-xs text-gray-700 mb-2 line-clamp-2">{c.description}</div>}
              <div className="space-y-1">
                <ScoreBar label="Realism" value={c.realismScore} />
                <ScoreBar label="Quality" value={c.qualityScore} />
                <ScoreBar label="Efficiency" value={c.efficiencyScore} />
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'advancements' && (
        <div className="space-y-2">
          {advances.length === 0 && <div className="text-gray-500 text-sm">No advancements proposed yet.</div>}
          {advances.map(a => (
            <div key={a.id} className="border rounded p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-gray-500 mb-1">
                    <span className="font-mono">{a.kind}</span> · expected gain {a.expectedGain} · proposed {new Date(a.proposedAt).toLocaleString()}
                  </div>
                  <div className="text-sm">{a.proposal}</div>
                </div>
                {a.appliedAt
                  ? <span className="px-2 py-0.5 text-xs bg-emerald-100 text-emerald-700 rounded">applied</span>
                  : <span className="px-2 py-0.5 text-xs bg-amber-100 text-amber-700 rounded">pending</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
