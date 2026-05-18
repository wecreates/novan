/**
 * Strategic War Room — master operational intelligence dashboard.
 *
 * Panels:
 *   - Top bar: overall status + key metrics
 *   - Approvals Console: pending human-in-the-loop gates
 *   - Workflow Monitor: active + recent runs with rollback
 *   - Queue Depths: real-time queue health
 *   - Event Timeline: live event log
 */
import { useState }                                                  from 'react'
import { useQuery, useMutation, useQueryClient }                     from '@tanstack/react-query'
import { formatDistanceToNow }                                       from 'date-fns'
import { CheckCircle, XCircle, RefreshCw, Activity, AlertTriangle, RotateCcw, Zap, Globe, Camera, Brain, Search, Plus, ChevronDown, ChevronRight, ArrowRight, Target, Users, Shield } from 'lucide-react'
import { warRoomApi, briefingApi, opportunityApi, riskApi, insightApi, goalApi, agentApi, analyticsApi, notificationApi, workersApi, type Approval, type WorkflowRun, type OpsEvent, type BrowserSession, type Memory, type MemorySearchResult, type BriefingItem, type Opportunity, type OpportunityStatus, type OpportunityType, type AgentStatus, type Notification, type QueueStat } from '../api.js'
import { GlobalSearch }  from '../components/GlobalSearch.js'
import { StatusBadge }   from '../components/StatusBadge.js'
import { MetricCard }    from '../components/MetricCard.js'
import { SectionPanel }  from '../components/SectionPanel.js'

// ─── Approvals Console ────────────────────────────────────────────────────────

function ApprovalsConsole() {
  const qc       = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['approvals'],
    queryFn:  () => warRoomApi.getApprovals(),
    refetchInterval: 15_000,
  })

  const approve = useMutation({
    mutationFn: (id: string) => warRoomApi.approve(id),
    onSuccess:  () => { void qc.invalidateQueries({ queryKey: ['approvals'] }) },
  })

  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => warRoomApi.reject(id, reason),
    onSuccess:  () => { void qc.invalidateQueries({ queryKey: ['approvals'] }) },
  })

  const approvals = data?.data ?? []
  const pending   = approvals.filter((a) => a.status === 'pending')

  return (
    <SectionPanel
      title="Approval Gates"
      subtitle={`${pending.length} pending`}
      loading={isLoading}
      actions={
        <span className={pending.length > 0 ? 'text-amber-400 text-xs font-medium' : 'text-muted text-xs'}>
          {pending.length > 0 ? `${pending.length} awaiting` : 'All clear'}
        </span>
      }
    >
      {pending.length === 0 ? (
        <div className="flex items-center gap-2 px-4 py-6 text-muted text-sm">
          <CheckCircle className="w-4 h-4 text-emerald-500" />
          No pending approvals
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {pending.map((a) => (
            <ApprovalRow
              key={a.id}
              approval={a}
              onApprove={() => approve.mutate(a.id)}
              onReject={() => reject.mutate({ id: a.id, reason: 'Rejected by operator' })}
              loading={approve.isPending || reject.isPending}
            />
          ))}
        </ul>
      )}
    </SectionPanel>
  )
}

function ApprovalRow({ approval: a, onApprove, onReject, loading }: {
  approval:  Approval
  onApprove: () => void
  onReject:  () => void
  loading:   boolean
}) {
  const expiresSoon = a.expiresAt - Date.now() < 60 * 60 * 1000  // < 1h

  return (
    <li className="px-4 py-3 hover:bg-elevated transition-colors">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-sm font-medium text-primary truncate">{a.operationLabel}</span>
            <StatusBadge status={a.risk} label={a.risk} />
          </div>
          <div className="text-xs text-secondary">
            Run: {a.runId.slice(0, 8)}… · Step: {a.stepId.slice(0, 8)}…
          </div>
          {expiresSoon && (
            <div className="flex items-center gap-1 text-xs text-amber-400 mt-0.5">
              <AlertTriangle className="w-3 h-3" />
              Expires {formatDistanceToNow(a.expiresAt, { addSuffix: true })}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onApprove}
            disabled={loading}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-400 text-xs font-medium border border-emerald-500/20 hover:bg-emerald-500/20 disabled:opacity-50 transition-colors"
          >
            <CheckCircle className="w-3 h-3" />
            Approve
          </button>
          <button
            onClick={onReject}
            disabled={loading}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-red-500/10 text-red-400 text-xs font-medium border border-red-500/20 hover:bg-red-500/20 disabled:opacity-50 transition-colors"
          >
            <XCircle className="w-3 h-3" />
            Reject
          </button>
        </div>
      </div>
    </li>
  )
}

// ─── Workflow Monitor ─────────────────────────────────────────────────────────

function WorkflowMonitor() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['workflow-runs'],
    queryFn:  () => warRoomApi.getWorkflowRuns(),
    refetchInterval: 10_000,
  })

  const runs   = (data?.data ?? []).slice(0, 20)
  const active = runs.filter((r) => r.status === 'running' || r.status === 'awaiting_approval').length
  const failed = runs.filter((r) => r.status === 'failed').length

  return (
    <SectionPanel
      title="Workflow Runs"
      subtitle="Last 20"
      loading={isLoading}
      actions={
        <div className="flex items-center gap-2">
          {active > 0 && <StatusBadge status="running" label={`${active} active`} pulse />}
          {failed > 0 && <StatusBadge status="failed"  label={`${failed} failed`} />}
        </div>
      }
    >
      {runs.length === 0 ? (
        <div className="px-4 py-6 text-muted text-sm">No runs yet</div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border">
              {['Run ID', 'Workflow', 'Status', 'Started', 'Duration', ''].map((h, i) => (
                <th key={i} className="px-4 py-2 text-left text-muted font-medium uppercase tracking-wider">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {runs.map((r) => (
              <WorkflowRunRow
                key={r.id}
                run={r}
                onRollback={() => void qc.invalidateQueries({ queryKey: ['workflow-runs'] })}
              />
            ))}
          </tbody>
        </table>
      )}
    </SectionPanel>
  )
}

function WorkflowRunRow({ run: r, onRollback }: { run: WorkflowRun; onRollback: () => void }) {
  const [rolling, setRolling] = useState(false)
  const [rolled,  setRolled]  = useState(false)

  const duration = r.completedAt && r.startedAt
    ? `${((r.completedAt - r.startedAt) / 1000).toFixed(1)}s`
    : r.startedAt ? formatDistanceToNow(r.startedAt, { addSuffix: false }) + ' ago' : '—'

  const canRollback = r.status === 'failed' || r.status === 'completed'

  const handleRollback = async () => {
    if (!canRollback || rolling) return
    setRolling(true)
    try {
      await warRoomApi.rollback(r.id, 'Manual rollback from War Room')
      setRolled(true)
      onRollback()
    } catch {
      // leave rolling=false to allow retry
    } finally {
      setRolling(false)
    }
  }

  return (
    <tr className="hover:bg-elevated transition-colors">
      <td className="px-4 py-2.5 font-mono text-secondary">{r.id.slice(0, 8)}…</td>
      <td className="px-4 py-2.5 text-secondary truncate max-w-[8rem]">{r.workflowId.slice(0, 8)}…</td>
      <td className="px-4 py-2.5"><StatusBadge status={r.status} pulse={r.status === 'running'} /></td>
      <td className="px-4 py-2.5 text-secondary">
        {r.triggeredAt ? formatDistanceToNow(r.triggeredAt, { addSuffix: true }) : '—'}
      </td>
      <td className="px-4 py-2.5 text-secondary tabular-nums">{duration}</td>
      <td className="px-4 py-2.5">
        {canRollback && (
          <button
            onClick={() => void handleRollback()}
            disabled={rolling || rolled}
            title={rolled ? 'Rollback requested' : 'Request rollback'}
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border transition-colors disabled:opacity-50
              ${rolled
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                : 'bg-amber-500/10 text-amber-400 border-amber-500/20 hover:bg-amber-500/20'
              }`}
          >
            <RotateCcw className={`w-3 h-3 ${rolling ? 'animate-spin' : ''}`} />
            {rolled ? 'Rolled back' : rolling ? 'Rolling…' : 'Rollback'}
          </button>
        )}
      </td>
    </tr>
  )
}

// ─── Queue Health ──────────────────────────────────────────────────────────────

function QueueHealth() {
  const { data, isLoading } = useQuery({
    queryKey: ['metrics'],
    queryFn:  async () => {
      const text = await warRoomApi.getMetrics() as string
      const queues: Record<string, { waiting: number; active: number; failed: number }> = {}
      const lines = text.split('\n')
      for (const line of lines) {
        if (line.startsWith('#') || !line.trim()) continue
        const match = /ops_queue_(\w+)\{queue="([^"]+)"\}\s+(\d+)/.exec(line)
        if (match) {
          const [, metric, queue, value] = match
          if (!queues[queue!]) queues[queue!] = { waiting: 0, active: 0, failed: 0 }
          if (metric === 'waiting') queues[queue!]!.waiting = Number(value)
          if (metric === 'active')  queues[queue!]!.active  = Number(value)
          if (metric === 'failed')  queues[queue!]!.failed  = Number(value)
        }
      }
      return queues
    },
    refetchInterval: 15_000,
  })

  const queues = Object.entries(data ?? {})

  return (
    <SectionPanel title="Queue Depths" subtitle="Real-time" loading={isLoading}>
      {queues.length === 0 ? (
        <div className="px-4 py-6 text-muted text-sm">No data</div>
      ) : (
        <div className="p-4 grid grid-cols-2 gap-3">
          {queues.map(([name, m]) => (
            <div key={name} className="flex flex-col gap-1 rounded-lg border border-border p-3">
              <div className="text-xs font-medium text-primary capitalize">{name}</div>
              <div className="flex gap-3 text-xs">
                <span className="text-amber-400">{m.waiting} waiting</span>
                <span className="text-blue-400">{m.active} active</span>
                {m.failed > 0 && <span className="text-red-400">{m.failed} failed</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionPanel>
  )
}

// ─── Event Timeline ────────────────────────────────────────────────────────────

function EventTimeline() {
  const since = Date.now() - 30 * 60 * 1000  // last 30 min

  const { data, isLoading } = useQuery({
    queryKey: ['events', since],
    queryFn:  () => warRoomApi.getEvents({ since, limit: 50 }),
    refetchInterval: 8_000,
  })

  const events = data?.data ?? []

  return (
    <SectionPanel
      title="Event Timeline"
      subtitle="Last 30 min"
      loading={isLoading}
      actions={
        <span className="text-muted text-xs">{events.length} events</span>
      }
    >
      {events.length === 0 ? (
        <div className="flex items-center gap-2 px-4 py-6 text-muted text-sm">
          <Zap className="w-4 h-4" />
          No events yet
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border)] overflow-auto max-h-[280px]">
          {events.map((e) => (
            <EventRow key={e.id} event={e} />
          ))}
        </ul>
      )}
    </SectionPanel>
  )
}

function EventRow({ event: e }: { event: OpsEvent }) {
  const isFailure = e.type.includes('failed') || e.type.includes('failure')
  const isSuccess = e.type.includes('completed') || e.type.includes('created')

  return (
    <li className="px-4 py-2 hover:bg-elevated transition-colors">
      <div className="flex items-center gap-3">
        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          isFailure ? 'bg-red-400' : isSuccess ? 'bg-emerald-400' : 'bg-blue-400'
        }`} />
        <span className="font-mono text-xs text-secondary flex-1 truncate">{e.type}</span>
        <span className="text-xs text-muted shrink-0 tabular-nums">
          {formatDistanceToNow(e.createdAt, { addSuffix: true })}
        </span>
      </div>
      <div className="ml-4.5 mt-0.5 text-xs text-muted font-mono truncate">
        {e.source} · {e.traceId.slice(0, 8)}…
      </div>
    </li>
  )
}

// ─── Browser Panel ────────────────────────────────────────────────────────────

function BrowserPanel() {
  const qc = useQueryClient()
  const [url, setUrl]           = useState('')
  const [submitting, setSubmit] = useState(false)
  const [lastError, setError]   = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['browser-sessions'],
    queryFn:  () => warRoomApi.getBrowserSessions(),
    refetchInterval: 10_000,
  })

  const sessions: BrowserSession[] = data?.data ?? []

  async function handleCapture() {
    if (!url.trim()) return
    setSubmit(true)
    setError(null)
    try {
      await warRoomApi.submitBrowserTask(url.trim())
      setUrl('')
      void qc.invalidateQueries({ queryKey: ['browser-sessions'] })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmit(false)
    }
  }

  return (
    <SectionPanel
      title="Browser Capture"
      subtitle={`${sessions.length} sessions`}
      loading={isLoading}
      actions={
        <Globe className="w-4 h-4 text-muted" />
      }
    >
      {/* Input row */}
      <div className="p-3 border-b border-border flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => { setUrl(e.target.value) }}
          onKeyDown={(e) => { if (e.key === 'Enter') { void handleCapture() } }}
          placeholder="https://example.com"
          className="flex-1 bg-elevated border border-border rounded px-3 py-1.5 text-sm text-primary placeholder-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-blue-500/40"
        />
        <button
          onClick={() => { void handleCapture() }}
          disabled={submitting || !url.trim()}
          className="px-3 py-1.5 rounded text-xs font-medium bg-blue-500/15 text-blue-400 border border-blue-500/25 hover:bg-blue-500/25 disabled:opacity-50 transition-colors"
        >
          {submitting ? 'Queuing…' : 'Capture'}
        </button>
      </div>

      {lastError && (
        <div className="px-4 py-2 text-xs text-red-400 bg-red-500/5 border-b border-border">
          {lastError}
        </div>
      )}

      {/* Session list */}
      {sessions.length === 0 ? (
        <div className="flex items-center gap-2 px-4 py-6 text-muted text-sm">
          <Camera className="w-4 h-4" />
          No capture sessions yet
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border)] overflow-auto max-h-[280px]">
          {sessions.map((s) => (
            <BrowserSessionRow key={s.id} session={s} />
          ))}
        </ul>
      )}
    </SectionPanel>
  )
}

function BrowserSessionRow({ session: s }: { session: BrowserSession }) {
  const statusColor =
    s.status === 'completed' ? 'bg-emerald-400' :
    s.status === 'failed'    ? 'bg-red-400'     :
    'bg-amber-400'

  const age = formatDistanceToNow(s.startedAt, { addSuffix: true })

  return (
    <li className="px-4 py-2.5 hover:bg-elevated transition-colors">
      <div className="flex items-start gap-3">
        <div className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${statusColor}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs text-secondary truncate flex-1">
              {s.pageTitle ?? s.url}
            </span>
            <span className="text-xs text-muted shrink-0 tabular-nums">{age}</span>
          </div>
          <div className="text-xs text-muted truncate">{s.url}</div>
          {s.status === 'failed' && s.errorMessage && (
            <div className="text-xs text-red-400 mt-0.5 truncate">{s.errorMessage}</div>
          )}
          {s.status === 'completed' && s.pageText && (
            <div className="text-xs text-muted mt-0.5 line-clamp-1 italic">
              {s.pageText.slice(0, 200)}
            </div>
          )}
          {s.screenshotPath && (
            <div className="text-xs text-blue-400/70 mt-0.5 truncate">
              📸 {s.screenshotPath.split(/[\\/]/).pop()}
            </div>
          )}
        </div>
      </div>
    </li>
  )
}

// ─── Memory Panel ─────────────────────────────────────────────────────────────

function MemoryPanel() {
  const qc               = useQueryClient()
  const [searchQ, setSearchQ] = useState('')
  const [searched, setSearched] = useState(false)
  const [content, setContent]   = useState('')
  const [type, setType]         = useState('observation')
  const [addError, setAddError] = useState<string | null>(null)
  const [adding, setAdding]     = useState(false)
  const [warning, setWarning]   = useState<string | null>(null)

  const { data: listData, isLoading: listLoading } = useQuery({
    queryKey: ['memories'],
    queryFn:  () => warRoomApi.listMemories({ limit: 20 }),
    refetchInterval: 30_000,
  })

  const { data: searchData, isLoading: searchLoading, refetch: doSearch } = useQuery({
    queryKey:  ['memory-search', searchQ],
    queryFn:   () => warRoomApi.searchMemory(searchQ, { limit: 20 }),
    enabled:   false,
  })

  const markStale = useMutation({
    mutationFn: (id: string) => warRoomApi.markMemoryStale(id),
    onSuccess:  () => { void qc.invalidateQueries({ queryKey: ['memories'] }) },
  })

  const handleSearch = () => {
    if (!searchQ.trim()) return
    setSearched(true)
    void doSearch()
  }

  const handleAdd = async () => {
    if (!content.trim()) return
    setAdding(true)
    setAddError(null)
    setWarning(null)
    try {
      const res = await warRoomApi.createMemory({ type, content: content.trim() })
      if (res.warning) setWarning(res.warning)
      setContent('')
      void qc.invalidateQueries({ queryKey: ['memories'] })
    } catch (err) {
      setAddError((err as Error).message)
    } finally {
      setAdding(false)
    }
  }

  const displayList: (Memory | MemorySearchResult)[] =
    searched && searchData?.data ? searchData.data : (listData?.data ?? [])
  const loading = searched ? searchLoading : listLoading

  return (
    <SectionPanel
      title="Memory"
      subtitle={`${displayList.length} records`}
      loading={loading}
      actions={<Brain className="w-4 h-4 text-muted" />}
    >
      {/* Search bar */}
      <div className="p-3 border-b border-border flex gap-2">
        <input
          type="text"
          value={searchQ}
          onChange={(e) => { setSearchQ(e.target.value); setSearched(false) }}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSearch() }}
          placeholder="Search memories…"
          className="flex-1 bg-elevated border border-border rounded px-3 py-1.5 text-sm text-primary placeholder-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-blue-500/40"
        />
        <button
          onClick={handleSearch}
          disabled={!searchQ.trim()}
          className="px-3 py-1.5 rounded text-xs font-medium bg-blue-500/15 text-blue-400 border border-blue-500/25 hover:bg-blue-500/25 disabled:opacity-50 transition-colors flex items-center gap-1"
        >
          <Search className="w-3 h-3" />
          Search
        </button>
        {searched && (
          <button
            onClick={() => { setSearched(false); setSearchQ('') }}
            className="px-2 py-1.5 rounded text-xs text-muted hover:text-primary transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Add form */}
      <div className="p-3 border-b border-border flex flex-col gap-2">
        <div className="flex gap-2">
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="bg-elevated border border-border rounded px-2 py-1.5 text-xs text-primary focus:outline-none"
          >
            {['observation','decision','lesson','goal','idea','fact','strategic','operational'].map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="New memory content…"
            rows={2}
            className="flex-1 bg-elevated border border-border rounded px-3 py-1.5 text-sm text-primary placeholder-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-blue-500/40 resize-none"
          />
          <button
            onClick={() => { void handleAdd() }}
            disabled={adding || !content.trim()}
            className="px-3 py-1.5 rounded text-xs font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 hover:bg-emerald-500/25 disabled:opacity-50 transition-colors flex items-center gap-1 self-start"
          >
            <Plus className="w-3 h-3" />
            {adding ? 'Adding…' : 'Add'}
          </button>
        </div>
        {warning  && <div className="text-xs text-amber-400">{warning}</div>}
        {addError && <div className="text-xs text-red-400">{addError}</div>}
      </div>

      {/* Results */}
      {displayList.length === 0 ? (
        <div className="flex items-center gap-2 px-4 py-6 text-muted text-sm">
          <Brain className="w-4 h-4" />
          No memories yet
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border)] overflow-auto max-h-[320px]">
          {displayList.map((m) => (
            <MemoryRow
              key={m.id}
              memory={m}
              onMarkStale={() => markStale.mutate(m.id)}
              stalePending={markStale.isPending}
            />
          ))}
        </ul>
      )}
    </SectionPanel>
  )
}

function MemoryRow({ memory: m, onMarkStale, stalePending }: {
  memory:       Memory | MemorySearchResult
  onMarkStale:  () => void
  stalePending: boolean
}) {
  const score         = 'score' in m ? m.score : undefined
  const lowConfidence = m.confidence < 0.7

  return (
    <li className={`px-4 py-2.5 hover:bg-elevated transition-colors ${m.isStale ? 'opacity-50' : ''}`}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-elevated border border-border text-muted">
              {m.type}
            </span>
            <span className={`text-xs font-medium tabular-nums ${lowConfidence ? 'text-amber-400' : 'text-emerald-400'}`}>
              {Math.round(m.confidence * 100)}%
            </span>
            {score !== undefined && (
              <span className="text-xs text-blue-400 tabular-nums">{(score * 100).toFixed(0)}% match</span>
            )}
            {m.isStale && (
              <span className="text-xs text-muted italic">(stale)</span>
            )}
            {m.tags.length > 0 && m.tags.slice(0, 3).map((t) => (
              <span key={t} className="text-xs px-1 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">{t}</span>
            ))}
          </div>
          <p className="text-sm text-primary line-clamp-2 leading-snug">
            {m.content.slice(0, 150)}{m.content.length > 150 ? '…' : ''}
          </p>
          <div className="flex items-center gap-2 mt-0.5 text-xs text-muted">
            <span>{m.source}</span>
            {'sourceRef' in m && m.sourceRef && <span>· {String(m.sourceRef)}</span>}
            <span>· {formatDistanceToNow(m.createdAt, { addSuffix: true })}</span>
          </div>
        </div>
        {!m.isStale && (
          <button
            onClick={onMarkStale}
            disabled={stalePending}
            title="Mark stale"
            className="shrink-0 px-2 py-1 rounded text-xs text-muted border border-border hover:text-amber-400 hover:border-amber-500/30 disabled:opacity-50 transition-colors"
          >
            Stale
          </button>
        )}
      </div>
    </li>
  )
}

// ─── KPI strip ────────────────────────────────────────────────────────────────

function KpiStrip() {
  const { data } = useQuery({
    queryKey: ['run-stats'],
    queryFn:  () => warRoomApi.getRunStats(),
    refetchInterval: 15_000,
  })

  const s = data?.data ?? {}
  const activeRuns   = (s.running ?? 0) + (s.pending ?? 0) + (s.awaiting_approval ?? 0)
  const pendingAppr  = s.awaiting_approval ?? 0
  const failed24h    = s.failed ?? 0
  const completed24h = s.completed ?? 0

  return (
    <div className="col-span-12 grid grid-cols-4 gap-4">
      <MetricCard label="Active Runs"       value={String(activeRuns)}   sub="running + pending"   accent="blue"   />
      <MetricCard label="Pending Approvals" value={String(pendingAppr)}  sub="awaiting action"     accent="yellow" />
      <MetricCard label="Failed (24h)"      value={String(failed24h)}    sub="workflow.failed"     accent="red"    />
      <MetricCard label="Completed (24h)"   value={String(completed24h)} sub="workflow.completed"  accent="green"  />
    </div>
  )
}

// ─── War Room page ────────────────────────────────────────────────────────────

// ─── Briefing Panel ───────────────────────────────────────────────────────────

const SECTION_LABELS: Record<string, string> = {
  top_priorities:    'Top Priorities',
  blocked_workflows: 'Blocked Workflows',
  risks:             'Risks',
  opportunities:     'Opportunities',
  recovery:          'Recovery Items',
  next_actions:      'Next Actions',
}

const SECTION_COLORS: Record<string, string> = {
  top_priorities:    'text-red-400',
  blocked_workflows: 'text-orange-400',
  risks:             'text-yellow-400',
  opportunities:     'text-green-400',
  recovery:          'text-purple-400',
  next_actions:      'text-blue-400',
}

function ConfidenceBadge({ value, isLow }: { value: number; isLow: boolean }) {
  const pct = Math.round(value * 100)
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-mono ${
      isLow ? 'bg-yellow-500/15 text-yellow-400 border border-yellow-500/30' : 'bg-elevated text-[var(--text-tertiary)]'
    }`}>
      {isLow && <AlertTriangle className="w-2.5 h-2.5" />}
      {pct}%
    </span>
  )
}

function BriefingItemRow({
  item,
  onConvert,
  converting,
}: {
  item: BriefingItem
  onConvert: (item: BriefingItem) => void
  converting: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className={`border border-border rounded-lg overflow-hidden ${item.isLowConfidence ? 'border-yellow-500/20' : ''}`}>
      <div
        className="flex items-start gap-3 px-3 py-2.5 hover:bg-elevated cursor-pointer select-none"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="mt-0.5 shrink-0 text-[var(--text-tertiary)]">
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-primary truncate">{item.title}</span>
            <ConfidenceBadge value={item.confidence} isLow={item.isLowConfidence} />
            {item.converted && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/15 text-green-400 border border-green-500/30">
                converted → task
              </span>
            )}
          </div>
          {item.sourceLabel && (
            <div className="text-[10px] text-[var(--text-tertiary)] mt-0.5">
              Source: {item.sourceLabel}
            </div>
          )}
        </div>
        {!item.converted && (
          <button
            onClick={(e) => { e.stopPropagation(); onConvert(item) }}
            disabled={converting}
            className="shrink-0 flex items-center gap-1 text-[10px] px-2 py-1 rounded border border-blue-500/40 text-blue-400 hover:bg-blue-500/10 transition-colors disabled:opacity-40"
          >
            <ArrowRight className="w-3 h-3" />
            {converting ? 'Creating…' : 'Create task'}
          </button>
        )}
      </div>
      {expanded && (
        <div className="px-8 pb-3 text-xs text-secondary border-t border-border pt-2">
          {item.body}
          {item.isLowConfidence && (
            <div className="mt-1.5 flex items-center gap-1 text-yellow-400 text-[10px]">
              <AlertTriangle className="w-2.5 h-2.5" />
              Low confidence — verify before acting
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function BriefingDetail({ briefingId }: { briefingId: string }) {
  const _qc = useQueryClient()

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['briefing', briefingId],
    queryFn:  () => briefingApi.get(briefingId),
    refetchInterval: (d) => (d.state.data?.data.status === 'generating' ? 2_000 : false),
  })

  const briefing = data?.data

  const convertMut = useMutation({
    mutationFn: ({ itemId }: { itemId: string }) =>
      briefingApi.convertItem(briefingId, itemId, { convertedBy: 'user' }),
    onSuccess: () => { void refetch() },
  })

  if (isLoading) return <div className="p-4 text-xs text-[var(--text-tertiary)]">Loading…</div>
  if (!briefing) return <div className="p-4 text-xs text-red-400">Failed to load</div>

  if (briefing.status === 'generating') {
    return (
      <div className="p-4 flex items-center gap-2 text-xs text-secondary">
        <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
        Generating briefing…
      </div>
    )
  }

  if (briefing.status === 'failed') {
    return <div className="p-4 text-xs text-red-400">Generation failed: {briefing.errorMessage}</div>
  }

  // Group items by section
  const sections = briefing.items.reduce<Record<string, BriefingItem[]>>((acc, item) => {
    if (!acc[item.section]) acc[item.section] = []
    acc[item.section]!.push(item)
    return acc
  }, {})

  const sectionOrder = ['top_priorities', 'blocked_workflows', 'risks', 'opportunities', 'recovery', 'next_actions']

  return (
    <div className="p-3 space-y-4">
      {briefing.summary && (
        <div className="text-[11px] text-secondary bg-elevated rounded-lg px-3 py-2 border border-border">
          {briefing.summary}
        </div>
      )}
      {sectionOrder
        .filter((s) => sections[s] && sections[s]!.length > 0)
        .map((section) => (
          <div key={section}>
            <div className={`text-[11px] font-semibold mb-2 ${SECTION_COLORS[section] ?? 'text-secondary'}`}>
              {SECTION_LABELS[section] ?? section}
            </div>
            <div className="space-y-1.5">
              {sections[section]!.map((item) => (
                <BriefingItemRow
                  key={item.id}
                  item={item}
                  onConvert={(i) => convertMut.mutate({ itemId: i.id })}
                  converting={convertMut.isPending && convertMut.variables?.itemId === item.id}
                />
              ))}
            </div>
          </div>
        ))}
      {briefing.items.length === 0 && (
        <div className="text-xs text-[var(--text-tertiary)] text-center py-4">
          No briefing items found for this time window.
        </div>
      )}
    </div>
  )
}

function BriefingPanel() {
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const { data: listData, refetch: refetchList } = useQuery({
    queryKey: ['briefings'],
    queryFn:  () => briefingApi.list(5),
    refetchInterval: 15_000,
  })

  const requestMut = useMutation({
    mutationFn: () => briefingApi.request({ requestedBy: 'user' }),
    onSuccess:  (res) => {
      void refetchList()
      setSelectedId(res.data.briefingId)
    },
  })

  const briefings = listData?.data ?? []
  const latest = briefings[0]

  // Auto-select latest ready briefing
  if (!selectedId && latest?.status === 'ready') {
    setSelectedId(latest.id)
  }

  return (
    <SectionPanel
      title="Executive Briefing"
      actions={
        <button
          onClick={() => requestMut.mutate()}
          disabled={requestMut.isPending}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs bg-blue-500/15 border border-blue-500/30 text-blue-400 hover:bg-blue-500/20 transition-colors disabled:opacity-50"
        >
          <Plus className="w-3 h-3" />
          {requestMut.isPending ? 'Requesting…' : 'New Briefing'}
        </button>
      }
    >
      <div className="grid grid-cols-12 divide-x divide-[var(--border)] min-h-[320px]">
        {/* Left: briefing list */}
        <div className="col-span-3 p-2 space-y-1 overflow-y-auto">
          {briefings.length === 0 && (
            <div className="text-xs text-[var(--text-tertiary)] px-2 py-4 text-center">
              No briefings yet.<br />Click &ldquo;New Briefing&rdquo; to generate.
            </div>
          )}
          {briefings.map((b) => (
            <button
              key={b.id}
              onClick={() => setSelectedId(b.id)}
              className={`w-full text-left px-2.5 py-2 rounded-lg transition-colors ${
                selectedId === b.id
                  ? 'bg-blue-500/15 border border-blue-500/30'
                  : 'hover:bg-elevated border border-transparent'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                  b.status === 'ready'      ? 'bg-green-500/15 text-green-400' :
                  b.status === 'generating' ? 'bg-blue-500/15 text-blue-400 animate-pulse' :
                  'bg-red-500/15 text-red-400'
                }`}>
                  {b.status}
                </span>
              </div>
              <div className="text-[10px] text-[var(--text-tertiary)] mt-1">
                {formatDistanceToNow(new Date(b.createdAt), { addSuffix: true })}
              </div>
            </button>
          ))}
        </div>

        {/* Right: selected briefing detail */}
        <div className="col-span-9 overflow-y-auto">
          {selectedId ? (
            <BriefingDetail briefingId={selectedId} />
          ) : (
            <div className="flex items-center justify-center h-full text-xs text-[var(--text-tertiary)]">
              Select a briefing or generate a new one
            </div>
          )}
        </div>
      </div>
    </SectionPanel>
  )
}

// ─── Opportunity Panel ────────────────────────────────────────────────────────

const OPP_TYPE_LABELS: Record<string, string> = {
  revenue: 'Revenue', content: 'Content', seo: 'SEO',
  automation: 'Automation', business: 'Business',
  operational: 'Operational', strategic: 'Strategic',
}

const STATUS_COLORS: Record<string, string> = {
  identified: 'bg-blue-500/15 text-blue-400',
  evaluating: 'bg-yellow-500/15 text-yellow-400',
  active:     'bg-green-500/15 text-green-400',
  accepted:   'bg-emerald-500/15 text-emerald-400',
  rejected:   'bg-red-500/15 text-red-400',
  stale:      'bg-zinc-500/15 text-zinc-400',
  completed:  'bg-purple-500/15 text-purple-400',
  won:        'bg-green-500/15 text-green-400',
  lost:       'bg-red-500/15 text-red-400',
  deferred:   'bg-zinc-500/15 text-zinc-400',
}

function ScoreBar({ score, breakdown }: { score?: number; breakdown?: Record<string, number> }) {
  if (score === undefined) return <span className="text-[10px] text-[var(--text-tertiary)]">Not scored</span>
  const pct = Math.round(score * 100)
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-elevated rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${pct >= 70 ? 'bg-green-400' : pct >= 40 ? 'bg-yellow-400' : 'bg-red-400'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] text-secondary font-mono shrink-0">{pct}%</span>
      {breakdown && (
        <span className="text-[9px] text-[var(--text-tertiary)] hidden xl:inline">
          ROI:{Math.round((breakdown['roi'] ?? 0)*100)}% · Eff:{Math.round((breakdown['effort'] ?? 0)*100)}% · Risk:{Math.round((breakdown['risk'] ?? 0)*100)}%
        </span>
      )}
    </div>
  )
}

function OppRow({
  opp, onStatusChange, onConvert, statusPending, convertPending,
}: {
  opp: Opportunity
  onStatusChange: (status: OpportunityStatus) => void
  onConvert: () => void
  statusPending: boolean
  convertPending: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const isTerminal = ['rejected', 'lost', 'stale', 'deferred', 'completed', 'won'].includes(opp.status)

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-3 px-3 py-2.5 hover:bg-elevated cursor-pointer select-none"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="shrink-0 text-[var(--text-tertiary)]">
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </div>
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-primary truncate">{opp.title}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${STATUS_COLORS[opp.status] ?? 'bg-zinc-500/15 text-zinc-400'}`}>
              {opp.status}
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-elevated text-[var(--text-tertiary)]">
              {OPP_TYPE_LABELS[opp.type] ?? opp.type}
            </span>
            {opp.confidence < 0.6 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-400 border border-yellow-500/20 flex items-center gap-1">
                <AlertTriangle className="w-2.5 h-2.5" />Low confidence
              </span>
            )}
          </div>
          <ScoreBar
            {...(opp.score !== undefined ? { score: opp.score } : {})}
            {...(opp.scoreBreakdown !== undefined ? { breakdown: opp.scoreBreakdown } : {})}
          />
        </div>
        {/* Quick actions */}
        {!isTerminal && (
          <div className="shrink-0 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
            {!opp.convertedRunId && (
              <button
                onClick={onConvert}
                disabled={convertPending}
                className="text-[10px] px-2 py-1 rounded border border-blue-500/40 text-blue-400 hover:bg-blue-500/10 transition-colors disabled:opacity-40 flex items-center gap-1"
              >
                <ArrowRight className="w-2.5 h-2.5" />
                {convertPending ? '…' : 'Convert'}
              </button>
            )}
            <button
              onClick={() => onStatusChange('accepted')}
              disabled={statusPending}
              className="text-[10px] px-2 py-1 rounded border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-40"
            >✓</button>
            <button
              onClick={() => onStatusChange('rejected')}
              disabled={statusPending}
              className="text-[10px] px-2 py-1 rounded border border-red-500/40 text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40"
            >✕</button>
          </div>
        )}
      </div>
      {expanded && (
        <div className="px-8 pb-3 border-t border-border pt-2 space-y-2">
          {opp.description && (
            <p className="text-xs text-secondary">{opp.description}</p>
          )}
          <div className="grid grid-cols-3 gap-3 text-[10px]">
            {opp.estimatedROI !== undefined && (
              <div><span className="text-[var(--text-tertiary)]">Est. ROI </span><span className="text-primary font-mono">{opp.estimatedROI}x</span><span className="text-[var(--text-tertiary)]"> (estimated)</span></div>
            )}
            {opp.estimatedEffort && (
              <div><span className="text-[var(--text-tertiary)]">Effort </span><span className="text-primary">{opp.estimatedEffort}</span></div>
            )}
            {opp.riskLevel && (
              <div><span className="text-[var(--text-tertiary)]">Risk </span><span className="text-primary">{opp.riskLevel}</span></div>
            )}
            {opp.strategicAlignment !== undefined && (
              <div><span className="text-[var(--text-tertiary)]">Alignment </span><span className="text-primary font-mono">{Math.round(opp.strategicAlignment * 100)}%</span></div>
            )}
            {opp.convertedRunId && (
              <div><span className="text-[var(--text-tertiary)]">Run </span><span className="text-primary font-mono truncate">{opp.convertedRunId.slice(0, 8)}…</span></div>
            )}
          </div>
          {!isTerminal && (
            <div className="flex items-center gap-2 pt-1" onClick={(e) => e.stopPropagation()}>
              {(['stale', 'completed'] as OpportunityStatus[]).map((s) => (
                <button
                  key={s}
                  onClick={() => onStatusChange(s)}
                  disabled={statusPending}
                  className="text-[10px] px-2 py-1 rounded border border-border text-secondary hover:bg-elevated transition-colors disabled:opacity-40"
                >
                  Mark {s}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function CreateOpportunityForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const [title, setTitle]     = useState('')
  const [type,  setType]      = useState<OpportunityType>('operational')
  const [desc,  setDesc]      = useState('')
  const [roi,   setRoi]       = useState('')
  const [effort, setEffort]   = useState('medium')
  const [risk,  setRisk]      = useState('medium')
  const [conf,  setConf]      = useState('0.7')
  const [align, setAlign]     = useState('0.5')

  const createMut = useMutation({
    mutationFn: () => opportunityApi.create({
      title, type,
      ...(desc   ? { description:      desc           } : {}),
      ...(roi    ? { estimatedROI:      Number(roi)   } : {}),
      estimatedEffort:    effort as 'low' | 'medium' | 'high' | 'very_high',
      riskLevel:          risk   as 'low' | 'medium' | 'high' | 'critical',
      confidence:         Number(conf),
      strategicAlignment: Number(align),
    }),
    onSuccess: () => { setOpen(false); setTitle(''); setDesc(''); setRoi(''); onCreated() },
  })

  if (!open) return (
    <button onClick={() => setOpen(true)}
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs bg-blue-500/15 border border-blue-500/30 text-blue-400 hover:bg-blue-500/20 transition-colors">
      <Plus className="w-3 h-3" />New Opportunity
    </button>
  )

  return (
    <div className="absolute right-4 top-10 z-50 w-80 bg-[var(--bg-surface)] border border-border rounded-xl shadow-xl p-4 space-y-3">
      <div className="text-xs font-semibold text-primary">New Opportunity</div>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title *"
        className="w-full text-xs bg-elevated border border-border rounded-lg px-3 py-2 text-primary outline-none focus:border-blue-500/50" />
      <textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description"
        rows={2}
        className="w-full text-xs bg-elevated border border-border rounded-lg px-3 py-2 text-primary outline-none focus:border-blue-500/50 resize-none" />
      <div className="grid grid-cols-2 gap-2">
        <select value={type} onChange={(e) => setType(e.target.value as OpportunityType)}
          className="text-xs bg-elevated border border-border rounded-lg px-2 py-1.5 text-primary outline-none">
          {['revenue','content','seo','automation','business','operational','strategic'].map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <input value={roi} onChange={(e) => setRoi(e.target.value)} placeholder="Est. ROI (e.g. 3.5)"
          type="number" min="0" step="0.1"
          className="text-xs bg-elevated border border-border rounded-lg px-2 py-1.5 text-primary outline-none focus:border-blue-500/50" />
        <select value={effort} onChange={(e) => setEffort(e.target.value)}
          className="text-xs bg-elevated border border-border rounded-lg px-2 py-1.5 text-primary outline-none">
          {['low','medium','high','very_high'].map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <select value={risk} onChange={(e) => setRisk(e.target.value)}
          className="text-xs bg-elevated border border-border rounded-lg px-2 py-1.5 text-primary outline-none">
          {['low','medium','high','critical'].map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <input value={conf} onChange={(e) => setConf(e.target.value)} placeholder="Confidence 0-1"
          type="number" min="0" max="1" step="0.05"
          className="text-xs bg-elevated border border-border rounded-lg px-2 py-1.5 text-primary outline-none focus:border-blue-500/50" />
        <input value={align} onChange={(e) => setAlign(e.target.value)} placeholder="Alignment 0-1"
          type="number" min="0" max="1" step="0.05"
          className="text-xs bg-elevated border border-border rounded-lg px-2 py-1.5 text-primary outline-none focus:border-blue-500/50" />
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={() => setOpen(false)}
          className="text-xs px-3 py-1.5 rounded-lg border border-border text-secondary hover:bg-elevated">
          Cancel
        </button>
        <button onClick={() => createMut.mutate()} disabled={!title.trim() || createMut.isPending}
          className="text-xs px-3 py-1.5 rounded-lg bg-blue-500/20 border border-blue-500/40 text-blue-400 hover:bg-blue-500/30 disabled:opacity-40">
          {createMut.isPending ? 'Creating…' : 'Create'}
        </button>
      </div>
    </div>
  )
}

function OpportunityPanel() {
  const qc = useQueryClient()
  const [statusFilter, setStatusFilter] = useState<OpportunityStatus | 'all'>('all')

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['opportunities', statusFilter],
    queryFn:  () => opportunityApi.list({
      ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
      limit: 30,
    }),
    refetchInterval: 20_000,
  })

  const statusMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: OpportunityStatus }) =>
      opportunityApi.setStatus(id, status),
    onSuccess: () => void refetch(),
  })

  const convertMut = useMutation({
    mutationFn: ({ id }: { id: string }) => opportunityApi.convert(id, { convertedBy: 'user' }),
    onSuccess: () => { void refetch(); void qc.invalidateQueries({ queryKey: ['workflow-runs'] }) },
  })

  const opps = data?.data ?? []
  const activeStatuses: (OpportunityStatus | 'all')[] = ['all', 'identified', 'evaluating', 'active', 'accepted', 'rejected', 'stale', 'completed']

  return (
    <SectionPanel
      title="Opportunities"
      {...(data?.meta.count !== undefined ? { subtitle: `${data.meta.count} total` } : {})}
      actions={
        <div className="relative flex items-center gap-2">
          <CreateOpportunityForm onCreated={() => void refetch()} />
        </div>
      }
      loading={isLoading}
    >
      {/* Status filter tabs */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border overflow-x-auto">
        {activeStatuses.map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`text-[10px] px-2.5 py-1 rounded-lg whitespace-nowrap transition-colors ${
              statusFilter === s
                ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                : 'text-[var(--text-tertiary)] hover:bg-elevated'
            }`}
          >
            {s === 'all' ? 'All' : s}
          </button>
        ))}
      </div>

      <div className="p-3 space-y-2">
        {opps.length === 0 && !isLoading && (
          <div className="text-xs text-[var(--text-tertiary)] text-center py-6">
            No opportunities. Click &ldquo;New Opportunity&rdquo; to create one.
          </div>
        )}
        {opps.map((opp) => (
          <OppRow
            key={opp.id}
            opp={opp}
            onStatusChange={(status) => statusMut.mutate({ id: opp.id, status })}
            onConvert={() => convertMut.mutate({ id: opp.id })}
            statusPending={statusMut.isPending && (statusMut.variables as { id: string } | undefined)?.id === opp.id}
            convertPending={convertMut.isPending && (convertMut.variables as { id: string } | undefined)?.id === opp.id}
          />
        ))}
      </div>
    </SectionPanel>
  )
}

// ─── Risk Panel ───────────────────────────────────────────────────────────────

function RiskPanel() {
  const [filter, setFilter] = useState<'open' | 'mitigating' | 'resolved' | 'all'>('open')
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['risks', filter],
    queryFn: () => riskApi.list({ ...(filter !== 'all' ? { status: filter } : {}), limit: 30 }),
    refetchInterval: 30_000,
  })
  const resolveMut = useMutation({
    mutationFn: (id: string) => riskApi.resolve(id),
    onSuccess: () => void refetch(),
  })
  const risks = data?.data ?? []
  const severityColor: Record<string, string> = {
    low: 'text-emerald-400', medium: 'text-amber-400', high: 'text-orange-400', critical: 'text-red-400',
  }
  const statuses = ['open', 'mitigating', 'resolved', 'all'] as const

  return (
    <SectionPanel
      title="Risk Register"
      {...(data?.meta.count !== undefined ? { subtitle: `${data.meta.count} total` } : {})}
      loading={isLoading}
      actions={
        <div className="flex gap-1">
          {statuses.map((s) => (
            <button key={s} onClick={() => setFilter(s)}
              className={`text-[10px] px-2 py-0.5 rounded capitalize transition-colors ${filter === s ? 'bg-red-500/20 text-red-400 border border-red-500/30' : 'text-muted hover:text-secondary'}`}>
              {s}
            </button>
          ))}
        </div>
      }
    >
      {risks.length === 0 ? (
        <div className="flex items-center gap-2 px-4 py-6 text-muted text-sm">
          <Shield className="w-4 h-4 text-emerald-500" /> No risks in this view
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {risks.map((risk) => (
            <li key={risk.id} className="px-4 py-3 flex items-start justify-between gap-3 hover:bg-elevated">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-medium ${severityColor[risk.severity] ?? 'text-gray-400'}`}>{risk.severity.toUpperCase()}</span>
                  <span className="text-xs text-secondary truncate">{risk.title}</span>
                </div>
                <div className="text-[10px] text-muted mt-0.5">
                  Score: {(risk.riskScore * 100).toFixed(0)}% · P:{(risk.probability * 100).toFixed(0)}% × I:{(risk.impact * 100).toFixed(0)}% · {risk.category}
                </div>
              </div>
              {risk.status === 'open' && (
                <button onClick={() => resolveMut.mutate(risk.id)} disabled={resolveMut.isPending}
                  className="shrink-0 text-[10px] px-2 py-0.5 rounded border border-border text-muted hover:text-emerald-400 hover:border-emerald-500/40 transition-colors">
                  Resolve
                </button>
              )}
              {risk.status !== 'open' && (
                <span className={`shrink-0 text-[10px] capitalize ${risk.status === 'resolved' ? 'text-emerald-400' : 'text-amber-400'}`}>{risk.status}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionPanel>
  )
}

// ─── Goal Panel ───────────────────────────────────────────────────────────────

function GoalPanel() {
  const [filter, setFilter] = useState<'active' | 'draft' | 'completed' | 'all'>('active')
  const { data, isLoading, refetch: _refetch } = useQuery({
    queryKey: ['goals', filter],
    queryFn: () => goalApi.list({ ...(filter !== 'all' ? { status: filter } : {}), limit: 20 }),
    refetchInterval: 60_000,
  })
  const goals = data?.data ?? []
  const statusColor: Record<string, string> = {
    draft: 'text-gray-400', active: 'text-blue-400', paused: 'text-amber-400',
    completed: 'text-emerald-400', abandoned: 'text-red-400',
  }
  const statuses = ['active', 'draft', 'completed', 'all'] as const

  return (
    <SectionPanel
      title="Strategic Goals"
      {...(data?.meta.count !== undefined ? { subtitle: `${data.meta.count} total` } : {})}
      loading={isLoading}
      actions={
        <div className="flex gap-1">
          {statuses.map((s) => (
            <button key={s} onClick={() => setFilter(s)}
              className={`text-[10px] px-2 py-0.5 rounded capitalize transition-colors ${filter === s ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'text-muted hover:text-secondary'}`}>
              {s}
            </button>
          ))}
        </div>
      }
    >
      {goals.length === 0 ? (
        <div className="flex items-center gap-2 px-4 py-6 text-muted text-sm">
          <Target className="w-4 h-4" /> No goals in this view
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {goals.map((goal) => (
            <li key={goal.id} className="px-4 py-3 hover:bg-elevated">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-primary truncate">{goal.title}</span>
                <span className={`shrink-0 text-[10px] capitalize ${statusColor[goal.status] ?? 'text-gray-400'}`}>{goal.status}</span>
              </div>
              <div className="flex items-center gap-3 mt-1.5">
                <div className="flex-1 h-1.5 bg-elevated rounded-full overflow-hidden">
                  <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${Math.round(goal.progress * 100)}%` }} />
                </div>
                <span className="text-[10px] text-muted shrink-0">{Math.round(goal.progress * 100)}%</span>
                <span className="text-[10px] text-muted shrink-0 capitalize">{goal.horizon}</span>
              </div>
              {goal.keyResults.length > 0 && (
                <div className="text-[10px] text-muted mt-1">{goal.keyResults.length} key result{goal.keyResults.length !== 1 ? 's' : ''}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionPanel>
  )
}

// ─── Insight Panel ────────────────────────────────────────────────────────────

function InsightPanel() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['insights'],
    queryFn: () => insightApi.list({ dismissed: false, limit: 20 }),
    refetchInterval: 60_000,
  })
  const dismissMut = useMutation({
    mutationFn: (id: string) => insightApi.dismiss(id),
    onSuccess: () => void refetch(),
  })
  const actMut = useMutation({
    mutationFn: (id: string) => insightApi.actOn(id),
    onSuccess: () => void refetch(),
  })
  const insights = data?.data ?? []
  const confColor = (c: number) => c >= 0.8 ? 'text-emerald-400' : c >= 0.6 ? 'text-amber-400' : 'text-red-400'

  return (
    <SectionPanel
      title="Intelligence Insights"
      {...(data?.meta.count !== undefined ? { subtitle: `${data.meta.count} active` } : {})}
      loading={isLoading}
    >
      {insights.length === 0 ? (
        <div className="flex items-center gap-2 px-4 py-6 text-muted text-sm">
          <Brain className="w-4 h-4" /> No active insights
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {insights.map((insight) => (
            <li key={insight.id} className="px-4 py-3 hover:bg-elevated">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] font-medium ${confColor(insight.confidence)}`}>{Math.round(insight.confidence * 100)}%</span>
                    <span className="text-xs text-primary truncate">{insight.title}</span>
                  </div>
                  <div className="text-[10px] text-muted mt-0.5 line-clamp-1">{insight.body}</div>
                  <div className="text-[10px] text-muted mt-0.5">{insight.category} · {insight.source}</div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button onClick={() => actMut.mutate(insight.id)} disabled={insight.actedOn || actMut.isPending}
                    className="text-[10px] px-2 py-0.5 rounded border border-blue-500/30 text-blue-400 hover:bg-blue-500/10 disabled:opacity-40 transition-colors">
                    Act
                  </button>
                  <button onClick={() => dismissMut.mutate(insight.id)} disabled={dismissMut.isPending}
                    className="text-[10px] px-2 py-0.5 rounded border border-border text-muted hover:text-secondary transition-colors">
                    ✕
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionPanel>
  )
}

// ─── Agent Panel ──────────────────────────────────────────────────────────────

function AgentPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: () => agentApi.list({ limit: 30 }),
    refetchInterval: 15_000,
  })
  const agents = data?.data ?? []
  const statusDot: Record<AgentStatus, string> = {
    idle: 'bg-gray-400', running: 'bg-emerald-400 animate-pulse', paused: 'bg-amber-400',
    error: 'bg-red-400', offline: 'bg-gray-600',
  }

  return (
    <SectionPanel title="Agents" {...(agents.length > 0 ? { subtitle: `${agents.length} registered` } : {})} loading={isLoading}>
      {agents.length === 0 ? (
        <div className="flex items-center gap-2 px-4 py-6 text-muted text-sm">
          <Users className="w-4 h-4" /> No agents registered
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {agents.map((agent) => (
            <li key={agent.id} className="px-4 py-3 flex items-center gap-3 hover:bg-elevated">
              <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot[agent.status]}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-primary">{agent.name}</span>
                  <span className="text-[10px] text-muted bg-elevated px-1.5 py-0.5 rounded">{agent.type}</span>
                </div>
                {agent.capabilities.length > 0 && (
                  <div className="text-[10px] text-muted mt-0.5 truncate">{agent.capabilities.join(', ')}</div>
                )}
              </div>
              <span className={`text-[10px] capitalize shrink-0 ${agent.status === 'running' ? 'text-emerald-400' : agent.status === 'error' ? 'text-red-400' : 'text-muted'}`}>
                {agent.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionPanel>
  )
}

// ─── Analytics Panel ──────────────────────────────────────────────────────────

function AnalyticsPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ['analytics-ai'],
    queryFn: () => analyticsApi.aiUsage(),
    refetchInterval: 120_000,
  })
  const d = data?.data

  return (
    <SectionPanel title="AI Usage" {...(d ? { subtitle: `$${d.totalCostUsd.toFixed(4)} today` } : {})} loading={isLoading}>
      {!d ? (
        <div className="px-4 py-6 text-muted text-sm">No AI usage data</div>
      ) : (
        <div className="divide-y divide-[var(--border)]">
          <div className="px-4 py-3 grid grid-cols-4 gap-4">
            {[
              { label: 'Requests', value: d.totalRequests.toString() },
              { label: 'Prompt Tokens', value: d.totalPromptTokens.toLocaleString() },
              { label: 'Output Tokens', value: d.totalOutputTokens.toLocaleString() },
              { label: 'Cached', value: `${d.totalRequests > 0 ? Math.round(d.cachedRequests / d.totalRequests * 100) : 0}%` },
            ].map(({ label, value }) => (
              <div key={label} className="text-center">
                <div className="text-sm font-medium text-primary">{value}</div>
                <div className="text-[10px] text-muted mt-0.5">{label}</div>
              </div>
            ))}
          </div>
          {Object.keys(d.byProvider).length > 0 && (
            <div className="px-4 py-3">
              <div className="text-[10px] text-muted mb-2 uppercase tracking-wide">By Provider</div>
              <div className="space-y-1">
                {Object.entries(d.byProvider).map(([provider, stats]) => (
                  <div key={provider} className="flex items-center justify-between text-xs">
                    <span className="text-secondary capitalize">{provider}</span>
                    <span className="text-muted">{stats.requests} req · ${stats.costUsd.toFixed(4)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </SectionPanel>
  )
}

// ─── Notifications Panel ──────────────────────────────────────────────────────

function NotificationsPanel() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => notificationApi.list({ dismissed: false, limit: 20 }),
    refetchInterval: 15_000,
  })
  const readMut    = useMutation({ mutationFn: (id: string) => notificationApi.markRead(id),    onSuccess: () => void refetch() })
  const dismissMut = useMutation({ mutationFn: (id: string) => notificationApi.dismiss(id),     onSuccess: () => void refetch() })
  const readAllMut = useMutation({ mutationFn: () => notificationApi.markAllRead(),              onSuccess: () => void refetch() })

  const notifs   = data?.data ?? []
  const unread   = data?.meta.unreadCount ?? 0
  const typeIcon: Record<string, string> = { info: '🔵', warning: '🟡', error: '🔴', success: '🟢' }

  return (
    <SectionPanel
      title="Notifications"
      {...(unread > 0 ? { subtitle: `${unread} unread` } : {})}
      loading={isLoading}
      actions={
        unread > 0 ? (
          <button onClick={() => readAllMut.mutate()} disabled={readAllMut.isPending}
            className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors">
            Mark all read
          </button>
        ) : undefined
      }
    >
      {notifs.length === 0 ? (
        <div className="flex items-center gap-2 px-4 py-6 text-muted text-sm">
          <CheckCircle className="w-4 h-4 text-emerald-500" /> All caught up
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {notifs.map((n: Notification) => (
            <li key={n.id} className={`px-4 py-3 flex items-start gap-3 hover:bg-elevated transition-colors ${!n.read ? 'bg-blue-500/5' : ''}`}>
              <span className="text-sm shrink-0 mt-0.5">{typeIcon[n.type] ?? '⚪'}</span>
              <div className="flex-1 min-w-0">
                <div className={`text-xs font-medium ${n.read ? 'text-secondary' : 'text-primary'}`}>{n.title}</div>
                <div className="text-[10px] text-muted mt-0.5 line-clamp-2">{n.body}</div>
                <div className="text-[10px] text-muted mt-0.5">{n.category} · {formatDistanceToNow(n.createdAt, { addSuffix: true })}</div>
              </div>
              <div className="flex gap-1 shrink-0">
                {!n.read && (
                  <button onClick={() => readMut.mutate(n.id)} className="text-[10px] text-blue-400 hover:text-blue-300 px-1.5 py-0.5 rounded border border-blue-500/20 transition-colors">Read</button>
                )}
                <button onClick={() => dismissMut.mutate(n.id)} className="text-[10px] text-muted hover:text-secondary px-1.5 py-0.5 rounded border border-border transition-colors">✕</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionPanel>
  )
}

// ─── Workers Panel ────────────────────────────────────────────────────────────

function WorkersPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ['workers-health'],
    queryFn:  () => workersApi.health(),
    refetchInterval: 15_000,
  })

  const health = data?.data
  const queues: QueueStat[] = health?.queues ?? []
  const totals = health?.totals

  return (
    <SectionPanel
      title="Worker Health"
      {...(totals ? { subtitle: `${totals.active} active · ${totals.waiting} waiting · ${totals.failed} failed` } : {})}
      loading={isLoading}
    >
      {queues.length === 0 ? (
        <div className="px-4 py-6 text-muted text-sm">No queue data</div>
      ) : (
        <div className="p-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {queues.map((q) => (
            <div key={q.name} className="rounded-lg border border-border bg-elevated p-3 flex flex-col gap-1.5">
              <div className="text-[11px] font-semibold text-primary capitalize truncate">{q.name}</div>
              <div className="flex flex-col gap-0.5">
                <div className={`text-[10px] flex justify-between ${q.waiting > 0 ? 'text-amber-400' : 'text-muted'}`}>
                  <span>waiting</span><span className="font-mono">{q.waiting}</span>
                </div>
                <div className={`text-[10px] flex justify-between ${q.active > 0 ? 'text-blue-400' : 'text-muted'}`}>
                  <span>active</span><span className="font-mono">{q.active}</span>
                </div>
                <div className={`text-[10px] flex justify-between ${q.failed > 0 ? 'text-red-400' : 'text-muted'}`}>
                  <span>failed</span><span className="font-mono">{q.failed}</span>
                </div>
                <div className="text-[10px] flex justify-between text-muted">
                  <span>done</span><span className="font-mono">{q.completed}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionPanel>
  )
}

// ─── War Room ─────────────────────────────────────────────────────────────────

export default function WarRoom() {
  const qc = useQueryClient()

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-bg">

      {/* Top bar */}
      <header className="shrink-0 flex items-center justify-between px-6 py-3 border-b border-border bg-[var(--bg-surface)]">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-blue-500/20 border border-blue-500/30 flex items-center justify-center">
            <Activity className="w-3.5 h-3.5 text-blue-400" />
          </div>
          <div>
            <div className="text-sm font-semibold text-primary">War Room</div>
            <div className="text-xs text-secondary">Strategic Operational Intelligence</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <GlobalSearch />
          <button
            onClick={() => void qc.invalidateQueries()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-secondary border border-border hover:bg-elevated transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
            Refresh
          </button>
        </div>
      </header>

      {/* Main grid */}
      <div className="flex-1 overflow-auto p-4">
        <div className="grid grid-cols-12 gap-4" style={{ gridTemplateRows: 'auto auto auto' }}>

          {/* KPI row — real data from stats/summary */}
          <KpiStrip />

          {/* Row 2: Approvals + Queue */}
          <div className="col-span-7 min-h-[240px]">
            <ApprovalsConsole />
          </div>
          <div className="col-span-5 min-h-[240px]">
            <QueueHealth />
          </div>

          {/* Row 3: Workflow monitor + Event timeline */}
          <div className="col-span-7 min-h-[320px]">
            <WorkflowMonitor />
          </div>
          <div className="col-span-5 min-h-[320px]">
            <EventTimeline />
          </div>

          {/* Row 4: Browser capture panel */}
          <div className="col-span-12 min-h-[320px]">
            <BrowserPanel />
          </div>

          {/* Row 5: Memory panel */}
          <div className="col-span-12 min-h-[320px]">
            <MemoryPanel />
          </div>

          {/* Row 6: Opportunities panel */}
          <div className="col-span-12 min-h-[360px]">
            <OpportunityPanel />
          </div>

          {/* Row 7: Executive Briefing panel */}
          <div className="col-span-12 min-h-[400px]">
            <BriefingPanel />
          </div>

          {/* Row 8: Risks + Goals */}
          <div className="col-span-6 min-h-[300px]">
            <RiskPanel />
          </div>
          <div className="col-span-6 min-h-[300px]">
            <GoalPanel />
          </div>

          {/* Row 9: Insights + Agents */}
          <div className="col-span-7 min-h-[300px]">
            <InsightPanel />
          </div>
          <div className="col-span-5 min-h-[300px]">
            <AgentPanel />
          </div>

          {/* Row 10: AI Analytics */}
          <div className="col-span-12 min-h-[240px]">
            <AnalyticsPanel />
          </div>

          {/* Row 11: Notifications */}
          <div className="col-span-12 min-h-[280px]">
            <NotificationsPanel />
          </div>

          {/* Row 12: Worker Health */}
          <div className="col-span-12 min-h-[200px]">
            <WorkersPanel />
          </div>

        </div>
      </div>
    </div>
  )
}
