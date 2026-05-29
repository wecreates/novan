/**
 * BrainTaskBar — directive interface for the brain.
 *
 * Operator types a task in plain English (or shift-enter for multi-line);
 * the brain plans + executes via /api/v1/brain/task.
 *
 * Modes:
 *   - Run        → plans + executes (default)
 *   - Plan only  → shows the operation plan without executing
 *
 * High-risk ops (desktop.exec, desktop.write_file, desktop.kill) require
 * the operator to flip the "Approve high-risk" toggle on this turn.
 */
import { useState, useRef, useEffect } from 'react'
import { Terminal, Loader2, ShieldAlert, Eye, Play, Trash2 } from 'lucide-react'
import { API_BASE as BASE } from '../api.js'

interface TaskOp {
  op:     string
  params: Record<string, unknown>
}
interface TaskResult {
  op:    string
  ok:    boolean
  data?: unknown
  error?: string
  durationMs: number
}
interface TaskRun {
  task:       string
  plan:       TaskOp[]
  results:    TaskResult[]
  summary:    string
  startedAt:  number
  completedAt: number
  plannerReason?: string
}

export function BrainTaskBar({ workspaceId = 'default' }: { workspaceId?: string }) {
  const [task, setTask] = useState('')
  const [busy, setBusy] = useState(false)
  const [planOnly, setPlanOnly] = useState(false)
  const [highRisk, setHighRisk] = useState(false)
  const [runs, setRuns] = useState<TaskRun[]>([])
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Cmd/Ctrl+Enter to send
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void send() }
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task, planOnly, highRisk])

  async function send() {
    const t = task.trim()
    if (!t || busy) return
    setBusy(true)
    try {
      const res = await fetch(`${BASE}/api/v1/brain/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: workspaceId,
          task: t,
          auto_execute: !planOnly,
          ...(highRisk ? { approval_token: 'OPERATOR_APPROVED' } : {}),
        }),
      })
      const json = await res.json() as { success: boolean; data?: TaskRun & { reason?: string } }
      if (json.success && json.data) {
        const d = json.data
        // Plan-only path returns { task, plan, reason } without results
        const run: TaskRun = {
          task: d.task ?? t,
          plan: d.plan ?? [],
          results: d.results ?? [],
          summary: d.summary ?? (d.reason ? `Plan: ${d.reason}` : ''),
          startedAt: d.startedAt ?? Date.now(),
          completedAt: d.completedAt ?? Date.now(),
          ...(d.plannerReason ? { plannerReason: d.plannerReason } : (d.reason ? { plannerReason: d.reason } : {})),
        }
        setRuns(prev => [run, ...prev].slice(0, 8))
        setTask('')
      }
    } catch (e) {
      setRuns(prev => [{
        task: t, plan: [],
        results: [{ op: 'http', ok: false, error: (e as Error).message, durationMs: 0 }],
        summary: '', startedAt: Date.now(), completedAt: Date.now(),
      }, ...prev].slice(0, 8))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium text-[var(--text-muted)]">
        <Terminal className="w-3.5 h-3.5" />
        <span>Brain task — natural language directive</span>
        <span className="ml-auto text-[10px] text-[var(--text-faint)]">⌘+Enter to send</span>
      </div>
      <textarea
        ref={taRef}
        value={task}
        onChange={(e) => setTask(e.target.value)}
        placeholder='e.g. "list recent issues", "open example.com and tell me the h1", "search the codebase for TODO comments"'
        rows={2}
        className="w-full px-3 py-2 text-sm bg-[var(--surface-elev)] border border-[var(--border)] rounded resize-none focus:outline-none focus:border-[var(--accent)]"
        disabled={busy}
      />
      <div className="flex items-center gap-2 text-xs">
        <button
          onClick={() => void send()}
          disabled={busy || !task.trim()}
          className="px-3 py-1.5 bg-[var(--accent)] text-white rounded hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
          {planOnly ? 'Preview plan' : 'Run'}
        </button>
        <label className="flex items-center gap-1 text-[var(--text-muted)] cursor-pointer">
          <input type="checkbox" checked={planOnly} onChange={(e) => setPlanOnly(e.target.checked)} className="accent-[var(--accent)]" />
          <Eye className="w-3 h-3" /> Plan only
        </label>
        <label className="flex items-center gap-1 text-[var(--text-muted)] cursor-pointer ml-auto">
          <input type="checkbox" checked={highRisk} onChange={(e) => setHighRisk(e.target.checked)} className="accent-[var(--warning)]" />
          <ShieldAlert className="w-3 h-3 text-[var(--warning)]" /> Approve high-risk
        </label>
        {runs.length > 0 && (
          <button onClick={() => setRuns([])} className="text-[var(--text-faint)] hover:text-[var(--text-muted)]" title="Clear history">
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>
      {runs.length > 0 && (
        <div className="space-y-2 max-h-[40vh] overflow-y-auto">
          {runs.map((run, i) => <TaskRunCard key={i} run={run} />)}
        </div>
      )}
    </div>
  )
}

function TaskRunCard({ run }: { run: TaskRun }) {
  const okCount  = run.results.filter(r => r.ok).length
  const errCount = run.results.filter(r => !r.ok).length
  return (
    <div className="text-xs border border-[var(--border)] rounded p-2 bg-[var(--surface-elev)]">
      <div className="font-medium truncate" title={run.task}>{run.task}</div>
      {run.plannerReason && <div className="text-[var(--text-muted)] italic mt-0.5">{run.plannerReason}</div>}
      <div className="mt-1.5 space-y-1">
        {run.plan.map((p, i) => {
          const r = run.results[i]
          const status = r ? (r.ok ? 'ok' : 'fail') : 'plan'
          return (
            <div key={i} className="flex items-start gap-2">
              <span className={`mt-0.5 inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                status === 'ok' ? 'bg-[var(--success)]' :
                status === 'fail' ? 'bg-[var(--error)]' :
                'bg-[var(--text-faint)]'
              }`} />
              <div className="flex-1 min-w-0">
                <div className="font-mono text-[var(--text)]">{p.op}</div>
                {r?.error && <div className="text-[var(--error)] truncate" title={r.error}>{r.error}</div>}
                {r?.ok && <div className="text-[var(--text-muted)] truncate">{formatResult(r.data)}</div>}
              </div>
              {r && <span className="text-[var(--text-faint)] text-[10px]">{r.durationMs}ms</span>}
            </div>
          )
        })}
      </div>
      {run.results.length > 0 && (
        <div className="mt-1.5 text-[10px] text-[var(--text-faint)]">
          {okCount} ok · {errCount} failed · {Math.round((run.completedAt - run.startedAt))}ms total
        </div>
      )}
    </div>
  )
}

function formatResult(data: unknown): string {
  if (data === null || data === undefined) return ''
  if (typeof data === 'string') return data.slice(0, 200)
  if (typeof data === 'object') {
    const obj = data as Record<string, unknown>
    if ('rowCount' in obj)      return `${obj['rowCount']} rows`
    if ('sessionId' in obj)     return `session=${obj['sessionId']} ${obj['url'] ?? ''}`
    if ('matchedFiles' in obj)  return `${(obj['matchedFiles'] as unknown[]).length} files matched`
    if ('text' in obj)          return String(obj['text']).slice(0, 200)
    if ('exitCode' in obj)      return `exit=${obj['exitCode']} ${String(obj['stdout'] ?? '').slice(0, 120)}`
    if ('total' in obj)         return `${obj['total']} entries`
    if ('bytes' in obj)         return `${obj['bytes']} bytes`
    if ('count' in obj)         return `${obj['count']} items`
    return JSON.stringify(data).slice(0, 200)
  }
  return String(data).slice(0, 200)
}
