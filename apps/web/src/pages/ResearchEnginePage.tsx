/**
 * ResearchEnginePage — operator surface for /api/v1/research-engine
 *
 * Lets the operator:
 *   - See topics + their status, last run, next due
 *   - Add a new topic
 *   - Run / pause / resume / kill topics
 *   - Browse recent findings
 *   - Seed the 10 research agents
 *
 * Companion to autonomous research: the cron runs due topics every 15 min;
 * this page exposes everything to the operator on demand.
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useWorkspace } from '../contexts/WorkspaceContext.js'
import {
  Search, Play, Pause, Skull, Plus, RefreshCw, FileText, Bot, Loader2,
} from 'lucide-react'
import { API_BASE as BASE } from '../api.js'
import { safeHref } from '../components/Markdown.js'

interface Topic {
  id:              string
  topic:           string
  description:     string | null
  status:          'active' | 'paused' | 'killed'
  approvedSources: string[]
  pollIntervalSec: number
  lastRunAt:       number | null
  nextRunAt:       number | null
  totalRuns:       number
  totalFindings:   number
}

interface Finding {
  id:        string
  topicId:   string
  title:     string
  summary:   string
  url:       string | null
  source:    string
  agentType: string
  confidence: number
  createdAt: number
}

interface ResearchAgent {
  id:           string
  name:         string
  type:         string
  status:       'idle' | 'running' | 'paused' | 'error' | 'offline'
  lastActiveAt: number | null
  heartbeatAt:  number | null
}

const STATUS_BADGE: Record<Topic['status'], string> = {
  active: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
  paused: 'bg-amber-500/15  text-amber-400  border-amber-500/25',
  killed: 'bg-rose-500/15   text-rose-400   border-rose-500/25',
}

export default function ResearchEnginePage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null)

  const topics = useQuery({
    queryKey: ['research-topics', workspaceId],
    queryFn: async (): Promise<Topic[]> => {
      const r = await fetch(`${BASE}/api/v1/research-engine/topics?workspace_id=${workspaceId}`).then(r => r.json())
      return r.data ?? []
    },
    refetchInterval: 30_000,
  })

  const findings = useQuery({
    queryKey: ['research-findings', workspaceId, selectedTopic],
    queryFn: async (): Promise<Finding[]> => {
      const q = selectedTopic ? `&topic_id=${selectedTopic}` : ''
      const r = await fetch(`${BASE}/api/v1/research-engine/findings?workspace_id=${workspaceId}&limit=50${q}`).then(r => r.json())
      return r.data ?? []
    },
  })

  const researchAgents = useQuery({
    queryKey: ['research-agents', workspaceId],
    queryFn: async (): Promise<ResearchAgent[]> => {
      const r = await fetch(`${BASE}/api/v1/research-engine/agents?workspace_id=${workspaceId}`).then(r => r.json())
      return r.data ?? []
    },
    refetchInterval: 30_000,
  })

  const runDue = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/v1/research-engine/run-due`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId }),
      }).then(r => r.json())
      return r.data as { ran: number }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['research-topics'] })
      void qc.invalidateQueries({ queryKey: ['research-findings'] })
    },
  })

  const seedAgents = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/v1/research-engine/seed-agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId }),
      }).then(r => r.json())
      return r.data
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['research-agents'] }),
  })

  const runTopic = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`${BASE}/api/v1/research-engine/topics/${id}/run`, { method: 'POST' }).then(r => r.json())
      return r.data
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['research-topics'] })
      void qc.invalidateQueries({ queryKey: ['research-findings'] })
    },
  })

  const setStatus = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'pause' | 'resume' | 'kill' }) => {
      await fetch(`${BASE}/api/v1/research-engine/topics/${id}/${action}`, { method: 'POST' })
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['research-topics'] }),
  })

  return (
    <div className="min-h-screen bg-bg text-primary p-6 max-w-6xl mx-auto">
      <header className="mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Search className="w-6 h-6 text-[var(--accent)]" /> Research Engine
          </h1>
          <span className="text-xs text-muted">
            {topics.data?.length ?? 0} topics · {findings.data?.length ?? 0} recent findings · {researchAgents.data?.filter(a => a.status !== 'offline').length ?? 0} agents online
          </span>
        </div>
        <p className="text-sm text-muted mt-1">
          Topics poll on a per-topic interval. The cron runs all due topics every 15 minutes; this page is the on-demand interface.
        </p>
      </header>

      <div className="flex items-center gap-2 mb-4">
        <button onClick={() => setShowAdd(s => !s)} className="px-3 py-1.5 text-sm rounded bg-[var(--accent)] text-white flex items-center gap-1.5 hover:opacity-90">
          <Plus className="w-3.5 h-3.5" /> Add topic
        </button>
        <button onClick={() => runDue.mutate()} disabled={runDue.isPending} className="px-3 py-1.5 text-sm rounded bg-[var(--surface)] border border-[var(--border)] flex items-center gap-1.5 hover:border-[var(--accent)]">
          {runDue.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Run all due
        </button>
        <button onClick={() => seedAgents.mutate()} disabled={seedAgents.isPending} className="px-3 py-1.5 text-sm rounded bg-[var(--surface)] border border-[var(--border)] flex items-center gap-1.5 hover:border-[var(--accent)]">
          {seedAgents.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bot className="w-3.5 h-3.5" />}
          Seed 10 research agents
        </button>
      </div>

      {showAdd && <AddTopicForm workspaceId={workspaceId} onClose={() => setShowAdd(false)} onAdded={() => { setShowAdd(false); void qc.invalidateQueries({ queryKey: ['research-topics'] }) }} />}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Topics */}
        <section className="lg:col-span-2 border border-[var(--border)] rounded-lg p-3 bg-[var(--surface)]">
          <h2 className="text-xs font-medium text-muted uppercase tracking-wider mb-2">Topics</h2>
          {topics.isLoading && <div className="text-sm text-muted py-4">Loading…</div>}
          {topics.data?.length === 0 && (
            <div className="text-sm text-muted py-6 text-center">
              No topics yet. Add one above to start autonomous research.
            </div>
          )}
          <ul className="space-y-2">
            {topics.data?.map(t => (
              <li key={t.id}
                className={`border rounded p-2.5 text-xs cursor-pointer transition-colors ${selectedTopic === t.id ? 'border-[var(--accent)] bg-[var(--surface-elev)]' : 'border-[var(--border)] hover:border-[var(--text-muted)]'}`}
                onClick={() => setSelectedTopic(t.id === selectedTopic ? null : t.id)}>
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider border ${STATUS_BADGE[t.status]}`}>{t.status}</span>
                  <span className="font-medium flex-1 truncate">{t.topic}</span>
                  <span className="text-[10px] text-faint">{t.totalRuns} runs · {t.totalFindings} findings</span>
                </div>
                {t.description && <div className="text-muted mt-1 truncate">{t.description}</div>}
                <div className="flex items-center gap-2 mt-2">
                  <button onClick={(e) => { e.stopPropagation(); runTopic.mutate(t.id) }} disabled={runTopic.isPending || t.status === 'killed'}
                    className="px-2 py-0.5 rounded bg-[var(--bg-elevated)] border border-[var(--border)] hover:border-[var(--success)] flex items-center gap-1 text-[10px] disabled:opacity-40">
                    <Play className="w-2.5 h-2.5" /> Run
                  </button>
                  {t.status === 'active' ? (
                    <button onClick={(e) => { e.stopPropagation(); setStatus.mutate({ id: t.id, action: 'pause' }) }}
                      className="px-2 py-0.5 rounded bg-[var(--bg-elevated)] border border-[var(--border)] hover:border-[var(--warning)] flex items-center gap-1 text-[10px]">
                      <Pause className="w-2.5 h-2.5" /> Pause
                    </button>
                  ) : t.status === 'paused' ? (
                    <button onClick={(e) => { e.stopPropagation(); setStatus.mutate({ id: t.id, action: 'resume' }) }}
                      className="px-2 py-0.5 rounded bg-[var(--bg-elevated)] border border-[var(--border)] hover:border-[var(--info)] flex items-center gap-1 text-[10px]">
                      <Play className="w-2.5 h-2.5" /> Resume
                    </button>
                  ) : null}
                  {t.status !== 'killed' && (
                    <button onClick={(e) => { e.stopPropagation(); if (confirm(`Kill topic "${t.topic}"?`)) setStatus.mutate({ id: t.id, action: 'kill' }) }}
                      className="px-2 py-0.5 rounded bg-[var(--bg-elevated)] border border-[var(--border)] hover:border-[var(--error)] flex items-center gap-1 text-[10px]">
                      <Skull className="w-2.5 h-2.5" /> Kill
                    </button>
                  )}
                  <span className="text-[10px] text-faint ml-auto">
                    next: {t.nextRunAt ? new Date(t.nextRunAt).toLocaleTimeString() : '—'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* Agents */}
        <section className="border border-[var(--border)] rounded-lg p-3 bg-[var(--surface)]">
          <h2 className="text-xs font-medium text-muted uppercase tracking-wider mb-2">Research agents</h2>
          {researchAgents.data?.length === 0 && (
            <div className="text-xs text-muted py-3">
              No research agents registered. Click <strong>Seed 10 research agents</strong>.
            </div>
          )}
          <ul className="text-xs space-y-1">
            {researchAgents.data?.map(a => (
              <li key={a.id} className="flex items-center gap-2">
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${a.status === 'running' ? 'bg-emerald-400' : a.status === 'idle' ? 'bg-slate-400' : 'bg-rose-400'}`} />
                <span className="font-mono truncate flex-1">{a.type}</span>
                <span className="text-faint text-[10px]">{a.status}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* Findings */}
      <section className="mt-6 border border-[var(--border)] rounded-lg p-3 bg-[var(--surface)]">
        <h2 className="text-xs font-medium text-muted uppercase tracking-wider mb-2 flex items-center gap-2">
          <FileText className="w-3.5 h-3.5" />
          Recent findings {selectedTopic && <span className="text-[var(--accent)]">· filtered to topic</span>}
        </h2>
        {findings.data?.length === 0 && (
          <div className="text-xs text-muted py-3">No findings yet. Run a topic or wait for the next due poll.</div>
        )}
        <ul className="space-y-2">
          {findings.data?.slice(0, 20).map(f => (
            <li key={f.id} className="text-xs border border-[var(--border)] rounded p-2 hover:border-[var(--text-muted)]">
              <div className="flex items-center gap-2">
                <span className="text-[10px] px-1 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-muted)] font-mono">{f.agentType}</span>
                <span className="font-medium truncate flex-1">{f.title}</span>
                <span className="text-[10px] text-faint">conf {(f.confidence * 100).toFixed(0)}%</span>
              </div>
              {f.summary && <div className="text-muted mt-1 line-clamp-2">{f.summary}</div>}
              {f.url && <a href={safeHref(f.url)} target="_blank" rel="noreferrer" className="text-[10px] text-[var(--accent)] hover:underline">{new URL(f.url).hostname}</a>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function AddTopicForm({ workspaceId, onClose, onAdded }: { workspaceId: string; onClose: () => void; onAdded: () => void }) {
  const [topic, setTopic] = useState('')
  const [description, setDescription] = useState('')
  const [pollMinutes, setPollMinutes] = useState(60)
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!topic.trim()) return
    setBusy(true)
    try {
      await fetch(`${BASE}/api/v1/research-engine/topics`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: workspaceId,
          topic: topic.trim(),
          description: description.trim() || undefined,
          poll_interval_sec: pollMinutes * 60,
          created_by: 'operator',
        }),
      })
      onAdded()
    } finally { setBusy(false) }
  }

  return (
    <div className="border border-[var(--accent)] rounded-lg p-3 bg-[var(--surface-elev)] mb-4 space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium text-muted">New research topic</div>
      <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. competitor pricing in dev-tools market"
        className="w-full px-3 py-2 text-sm bg-[var(--bg-elevated)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)]" />
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="(optional) what specifically to look for"
        rows={2}
        className="w-full px-3 py-2 text-sm bg-[var(--bg-elevated)] border border-[var(--border)] rounded resize-none focus:outline-none focus:border-[var(--accent)]" />
      <div className="flex items-center gap-2 text-xs">
        <label className="text-muted">Poll every</label>
        <input type="number" min={5} max={1440} value={pollMinutes} onChange={(e) => setPollMinutes(Number(e.target.value))}
          className="w-20 px-2 py-1 bg-[var(--bg-elevated)] border border-[var(--border)] rounded" />
        <span className="text-muted">min</span>
        <div className="ml-auto flex gap-2">
          <button onClick={onClose} className="px-3 py-1 rounded border border-[var(--border)] hover:bg-[var(--bg-elevated)]">Cancel</button>
          <button onClick={() => void submit()} disabled={busy || !topic.trim()} className="px-3 py-1 rounded bg-[var(--accent)] text-white disabled:opacity-40">
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
