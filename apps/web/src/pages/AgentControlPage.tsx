/**
 * Agent Control Page
 *
 * Operational dashboard for the 7 engineering agents.
 * Real-time state, job queue, safety controls, patch pipeline.
 */
import { useState, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Bot, Play, Pause, AlertTriangle, CheckCircle,
  Zap, Shield, GitBranch, RotateCcw,
  Lock, Square, RefreshCw, Activity,
} from 'lucide-react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

const API = '/api/v1/eng-agents'

// ─── Primitives ───────────────────────────────────────────────────────────────

type AgentType = 'planner' | 'coder' | 'reviewer' | 'tester' | 'security' | 'reliability' | 'cto'
type AgentState = 'idle' | 'running' | 'paused' | 'locked' | 'error'
type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'rolled_back' | 'awaiting_approval'

interface AgentRecord {
  id: string; type: AgentType; state: AgentState
  safetyLocked: boolean; pausedReason: string | null
  consecutiveFailures: number; totalJobsRun: number
  totalPatchesApplied: number; lastJobAt: number | null
}

interface AgentJob {
  id: string; agentType: AgentType; status: JobStatus
  description: string; targetFiles: string[]
  requiresApproval: boolean; approvedAt: number | null
  stage: string; errorMessage: string | null
  createdAt: number; completedAt: number | null
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...opts?.headers },
    ...opts,
  })
  const json = await res.json().catch(() => null) as
    | { success: true; data: T }
    | { success: false; error: string }
    | null
  if (!res.ok || !json || json.success === false) {
    const msg = json && json.success === false ? json.error : `${res.status} ${res.statusText}`
    throw new Error(msg)
  }
  // All eng-agents routes return the { success, data } envelope — unwrap it.
  return json.data
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, {
    method: 'POST',
    body: body ? JSON.stringify(body) : null,
  })
}

// ─── State colors / icons ────────────────────────────────────────────────────

function stateColor(s: AgentState | JobStatus): string {
  return s === 'idle' || s === 'completed' ? '#10b981'
       : s === 'running'                   ? '#3b82f6'
       : s === 'paused'                    ? '#f59e0b'
       : s === 'locked' || s === 'failed'  ? '#f43f5e'
       : s === 'awaiting_approval'         ? '#a855f7'
       : '#64748b'
}

function StateDot({ state }: { state: AgentState | JobStatus }) {
  return (
    <span style={{
      display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
      background: stateColor(state), flexShrink: 0,
    }} />
  )
}

const AGENT_ICONS: Record<AgentType, typeof Bot> = {
  planner:     GitBranch,
  coder:       Zap,
  reviewer:    CheckCircle,
  tester:      Shield,
  security:    Lock,
  reliability: RotateCcw,
  cto:         Bot,
}

// ─── Confirm button ───────────────────────────────────────────────────────────

function ConfirmAction({
  label, confirmLabel, onClick, danger, busy = false,
}: {
  label: string; confirmLabel: string; danger?: boolean
  onClick: () => void; busy?: boolean
}) {
  const [confirming, setConfirming] = useState(false)
  if (confirming) {
    return (
      <span style={{ display: 'inline-flex', gap: 4 }}>
        <button
          disabled={busy}
          onClick={() => { setConfirming(false); onClick() }}
          style={{
            fontSize: 11, padding: '2px 8px', borderRadius: 4, border: 'none',
            background: danger ? '#f43f5e' : '#3b82f6', color: '#fff', cursor: 'pointer',
          }}
        >{busy ? '…' : confirmLabel}</button>
        <button
          onClick={() => setConfirming(false)}
          style={{
            fontSize: 11, padding: '2px 8px', borderRadius: 4, border: 'none',
            background: 'var(--bg-elevated)', color: 'var(--text-muted)', cursor: 'pointer',
          }}
        >cancel</button>
      </span>
    )
  }
  return (
    <button
      disabled={busy}
      onClick={() => setConfirming(true)}
      style={{
        fontSize: 11, padding: '2px 8px', borderRadius: 4,
        border: '1px solid var(--border)', background: 'transparent',
        color: danger ? '#f43f5e' : 'var(--text-secondary)', cursor: 'pointer',
      }}
    >{label}</button>
  )
}

// ─── Agent card ───────────────────────────────────────────────────────────────

function AgentCard({ agent }: { agent: AgentRecord }) {
  const qc   = useQueryClient()
  const { workspaceId: WS } = useWorkspace()
  const Icon = AGENT_ICONS[agent.type] ?? Bot

  const pause = useMutation({
    mutationFn: () => post(`/agents/${agent.type}/pause`, { workspaceId: WS, reason: 'manual' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['eng-agents'] }) },
  })
  const resume = useMutation({
    mutationFn: () => post(`/agents/${agent.type}/resume`, { workspaceId: WS }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['eng-agents'] }) },
  })
  const unlock = useMutation({
    mutationFn: () => post(`/agents/${agent.type}/unlock`, { workspaceId: WS }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['eng-agents'] }) },
  })

  return (
    <div style={{
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '12px 14px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Icon style={{ width: 14, height: 14, color: stateColor(agent.state) }} />
        <span style={{ fontSize: 13, fontWeight: 600, textTransform: 'capitalize' }}>
          {agent.type}
        </span>
        <StateDot state={agent.state} />
        <span style={{ fontSize: 11, color: stateColor(agent.state), marginLeft: 2 }}>
          {agent.state}
        </span>
        {agent.safetyLocked && (
          <span style={{ marginLeft: 'auto', fontSize: 10, color: '#f43f5e', display: 'flex', alignItems: 'center', gap: 3 }}>
            <AlertTriangle style={{ width: 10, height: 10 }} />LOCKED
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
        <span>jobs: {agent.totalJobsRun}</span>
        <span>patches: {agent.totalPatchesApplied}</span>
        <span>failures: {agent.consecutiveFailures}</span>
      </div>

      {agent.pausedReason && (
        <div style={{ fontSize: 11, color: '#f59e0b', marginBottom: 8 }}>
          paused: {agent.pausedReason}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {agent.safetyLocked ? (
          <ConfirmAction
            label="Unlock" confirmLabel="Confirm unlock" danger
            busy={unlock.isPending}
            onClick={() => { unlock.mutate() }}
          />
        ) : agent.state === 'paused' ? (
          <button
            onClick={() => { resume.mutate() }}
            disabled={resume.isPending}
            style={{
              fontSize: 11, padding: '2px 8px', borderRadius: 4, border: 'none',
              background: '#10b981', color: '#fff', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 3,
            }}
          >
            <Play style={{ width: 9, height: 9 }} />resume
          </button>
        ) : (
          <ConfirmAction
            label="Pause" confirmLabel="Confirm pause"
            busy={pause.isPending}
            onClick={() => { pause.mutate() }}
          />
        )}
      </div>
    </div>
  )
}

// ─── Job row ──────────────────────────────────────────────────────────────────

function JobRow({ job }: { job: AgentJob }) {
  const qc = useQueryClient()

  const approve = useMutation({
    mutationFn: () => post(`/jobs/${job.id}/approve`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['eng-jobs'] }) },
  })
  const rollback = useMutation({
    mutationFn: () => post(`/jobs/${job.id}/rollback`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['eng-jobs'] }) },
  })
  const run = useMutation({
    mutationFn: () => post(`/jobs/${job.id}/run`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['eng-jobs'] })
      void qc.invalidateQueries({ queryKey: ['eng-agents'] })
    },
  })

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0',
      borderBottom: '1px solid var(--border)', fontSize: 12,
    }}>
      <StateDot state={job.status} />
      <span style={{
        width: 80, flexShrink: 0, textTransform: 'capitalize', fontSize: 11,
        color: 'var(--text-muted)',
      }}>{job.agentType}</span>
      <span style={{ flex: 1, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {job.description}
      </span>
      <span style={{ width: 120, flexShrink: 0, fontSize: 11, color: stateColor(job.status) }}>
        {job.status}
        {job.stage && job.stage !== job.status && ` · ${job.stage}`}
      </span>
      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        {job.status === 'awaiting_approval' && (
          <ConfirmAction
            label="Approve" confirmLabel="Yes, approve"
            busy={approve.isPending}
            onClick={() => { approve.mutate() }}
          />
        )}
        {job.status === 'queued' && (
          <button
            disabled={run.isPending}
            onClick={() => { run.mutate() }}
            style={{
              fontSize: 11, padding: '2px 8px', borderRadius: 4, border: 'none',
              background: '#3b82f6', color: '#fff', cursor: 'pointer',
            }}
          >{run.isPending ? '…' : 'Run'}</button>
        )}
        {job.status === 'completed' && (
          <ConfirmAction
            label="Rollback" confirmLabel="Confirm rollback" danger
            busy={rollback.isPending}
            onClick={() => { rollback.mutate() }}
          />
        )}
      </div>
    </div>
  )
}

// ─── New job form ─────────────────────────────────────────────────────────────

function NewJobForm() {
  const qc = useQueryClient()
  const { workspaceId: WS } = useWorkspace()
  const [agentType, setAgentType] = useState<AgentType>('planner')
  const [description, setDescription] = useState('')
  const [autoRun, setAutoRun] = useState(false)

  const createJob = useMutation({
    mutationFn: () => post('/jobs', {
      workspaceId: WS, agentType, description, autoRun,
    }),
    onSuccess: () => {
      setDescription('')
      void qc.invalidateQueries({ queryKey: ['eng-jobs'] })
      void qc.invalidateQueries({ queryKey: ['eng-agents'] })
    },
  })

  return (
    <div style={{
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      borderRadius: 8, padding: 14, marginBottom: 16,
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 10 }}>
        Dispatch Job
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <select
          value={agentType}
          onChange={e => { setAgentType(e.target.value as AgentType) }}
          style={{
            fontSize: 12, padding: '4px 8px', borderRadius: 4,
            border: '1px solid var(--border)', background: 'var(--bg-elevated)',
            color: 'var(--text-primary)',
          }}
        >
          {(['planner','coder','reviewer','tester','security','reliability','cto'] as AgentType[]).map(t => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <input
          value={description}
          onChange={e => { setDescription(e.target.value) }}
          placeholder="Job description…"
          style={{
            flex: 1, minWidth: 200, fontSize: 12, padding: '4px 8px',
            borderRadius: 4, border: '1px solid var(--border)',
            background: 'var(--bg-elevated)', color: 'var(--text-primary)',
          }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-muted)' }}>
          <input
            type="checkbox"
            checked={autoRun}
            onChange={e => { setAutoRun(e.target.checked) }}
          />
          auto-run
        </label>
        <button
          disabled={!description.trim() || createJob.isPending}
          onClick={() => { createJob.mutate() }}
          style={{
            fontSize: 12, padding: '4px 14px', borderRadius: 4, border: 'none',
            background: '#3b82f6', color: '#fff', cursor: 'pointer',
          }}
        >
          {createJob.isPending ? '…' : 'Dispatch'}
        </button>
      </div>
    </div>
  )
}

// ─── Safety panel ─────────────────────────────────────────────────────────────

function SafetyPanel() {
  const { data } = useQuery({
    queryKey: ['eng-safety'],
    queryFn: () => api<{ limits: Record<string, unknown> }>('/safety/limits'),
    refetchInterval: 60_000,
  })

  const limits = data?.limits
  if (!limits) return null

  return (
    <div style={{
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      borderRadius: 8, padding: 14,
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Shield style={{ width: 13, height: 13 }} />Safety Limits
      </div>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        {Object.entries(limits).filter(([, v]) => typeof v === 'number').map(([k, v]) => (
          <div key={k} style={{ fontSize: 11 }}>
            <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>
              {k.replace(/([A-Z])/g, ' $1').toLowerCase()}
            </div>
            <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{String(v)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

type Tab = 'agents' | 'jobs' | 'safety' | 'autonomous'

export default function AgentControlPage() {
  const { workspaceId: WS } = useWorkspace()
  const [tab, setTab] = useState<Tab>('agents')

  const agentsQ = useQuery({
    queryKey: ['eng-agents', WS],
    queryFn: () => api<{ agents: AgentRecord[] }>(`/agents?workspaceId=${WS}`),
    refetchInterval: 15_000,
  })

  const jobsQ = useQuery({
    queryKey: ['eng-jobs', WS],
    queryFn: () => api<{ jobs: AgentJob[] }>(`/jobs?workspaceId=${WS}`),
    refetchInterval: 10_000,
  })

  const agents = agentsQ.data?.agents ?? []
  const jobs   = jobsQ.data?.jobs ?? []

  const lockedCount  = agents.filter(a => a.safetyLocked).length
  const runningCount = agents.filter(a => a.state === 'running').length
  const pendingJobs  = jobs.filter(j => j.status === 'awaiting_approval').length

  const TAB_STYLE = useCallback((t: Tab): React.CSSProperties => ({
    fontSize: 12, fontWeight: 500, padding: '6px 14px', border: 'none',
    borderBottom: tab === t ? '2px solid #3b82f6' : '2px solid transparent',
    background: 'transparent',
    color: tab === t ? '#3b82f6' : 'var(--text-muted)',
    cursor: 'pointer',
  }), [tab])

  return (
    <div style={{
      height: '100%', overflow: 'auto', padding: 20,
      color: 'var(--text-primary)', fontFamily: 'inherit',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <Bot style={{ width: 18, height: 18, color: '#3b82f6' }} />
        <h1 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Agent Control</h1>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-muted)' }}>
          {lockedCount > 0 && (
            <span style={{ color: '#f43f5e', display: 'flex', alignItems: 'center', gap: 4 }}>
              <Lock style={{ width: 10, height: 10 }} />{lockedCount} locked
            </span>
          )}
          {runningCount > 0 && (
            <span style={{ color: '#3b82f6' }}>{runningCount} running</span>
          )}
          {pendingJobs > 0 && (
            <span style={{ color: '#a855f7' }}>
              {pendingJobs} awaiting approval
            </span>
          )}
        </div>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
        Autonomous engineering agents — 7 specialized roles, safety-gated patch pipeline
      </p>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: 16 }}>
        {(['agents', 'jobs', 'safety', 'autonomous'] as Tab[]).map(t => (
          <button key={t} style={TAB_STYLE(t)} onClick={() => { setTab(t) }}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
            {t === 'jobs' && pendingJobs > 0 && (
              <span style={{
                marginLeft: 6, background: '#a855f7', color: '#fff',
                borderRadius: 10, fontSize: 10, padding: '0 5px',
              }}>{pendingJobs}</span>
            )}
          </button>
        ))}
      </div>

      {/* Agent grid */}
      {tab === 'agents' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 10 }}>
          {agents.map(a => <AgentCard key={a.id} agent={a} />)}
          {agents.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', gridColumn: '1/-1' }}>
              Loading agents…
            </div>
          )}
        </div>
      )}

      {/* Jobs */}
      {tab === 'jobs' && (
        <div>
          <NewJobForm />
          <div style={{
            background: 'var(--bg-surface)', border: '1px solid var(--border)',
            borderRadius: 8, padding: '0 14px',
          }}>
            {jobs.length === 0 ? (
              <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
                No jobs yet — dispatch one above
              </div>
            ) : (
              [...jobs].reverse().map(j => <JobRow key={j.id} job={j} />)
            )}
          </div>
        </div>
      )}

      {/* Safety */}
      {tab === 'safety' && <SafetyPanel />}

      {/* Autonomous runs */}
      {tab === 'autonomous' && <AutonomousRunsPanel />}
    </div>
  )
}

// ─── Autonomous Runs Panel ────────────────────────────────────────────────────

const AUTO_API = '/api/v1/autonomous'

type RunStatus = 'queued' | 'running' | 'paused' | 'blocked' | 'failed' | 'complete' | 'cancelled'

interface AutonomousRun {
  id: string; workspaceId: string; status: RunStatus; phase: string | null
  masterPrompt: string; currentAgent: string | null; lastEvent: string | null
  failureReason: string | null; completedAt: number | null; createdAt: number
}

interface AutoJob {
  id: string; agentName: string; phase: string; status: string
  errorMessage: string | null; startedAt: number | null; completedAt: number | null; createdAt: number
}

function runStatusColor(s: RunStatus): string {
  if (s === 'complete')  return '#10b981'
  if (s === 'running')   return '#3b82f6'
  if (s === 'paused')    return '#f59e0b'
  if (s === 'failed')    return '#f43f5e'
  if (s === 'cancelled') return '#64748b'
  if (s === 'blocked')   return '#a855f7'
  return '#64748b'
}

function AutonomousRunsPanel() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const [prompt, setPrompt]     = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  const runsQ = useQuery({
    queryKey: ['auto-runs', workspaceId],
    queryFn:  () => fetch(`${AUTO_API}/runs?workspace_id=${workspaceId}`).then(r => r.json()) as Promise<{ success: true; data: AutonomousRun[] }>,
    refetchInterval: 5_000,
  })

  const jobsQ = useQuery({
    queryKey: ['auto-jobs', selected],
    queryFn:  () => fetch(`${AUTO_API}/runs/${selected}/jobs`).then(r => r.json()) as Promise<{ success: true; data: AutoJob[] }>,
    enabled: !!selected,
    refetchInterval: 3_000,
  })

  const startMut = useMutation({
    mutationFn: (p: string) => fetch(`${AUTO_API}/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: workspaceId, masterPrompt: p }),
    }).then(r => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['auto-runs'] }); setPrompt('') },
  })

  function mutateRun(runId: string, action: 'pause' | 'resume' | 'cancel') {
    fetch(`${AUTO_API}/runs/${runId}/${action}`, { method: 'POST' })
      .then(() => qc.invalidateQueries({ queryKey: ['auto-runs'] }))
      .catch(() => null)
  }

  const runs = runsQ.data?.data ?? []
  const jobs = jobsQ.data?.data ?? []

  return (
    <div>
      {/* Start run form */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          value={prompt}
          onChange={(e) => { setPrompt(e.target.value) }}
          placeholder="Master prompt for autonomous run… (e.g. scan for type errors and fix them)"
          style={{
            flex: 1, padding: '7px 10px', fontSize: 12, border: '1px solid var(--border)',
            borderRadius: 6, background: 'var(--bg-elevated)', color: 'var(--text-primary)',
          }}
        />
        <button
          disabled={!prompt.trim() || startMut.isPending}
          onClick={() => { if (prompt.trim()) startMut.mutate(prompt.trim()) }}
          style={{
            padding: '7px 14px', fontSize: 12, fontWeight: 600, borderRadius: 6, cursor: 'pointer',
            background: '#3b82f6', color: '#fff', border: 'none', opacity: (!prompt.trim() || startMut.isPending) ? 0.5 : 1,
          }}
        >
          <Play style={{ width: 11, height: 11, display: 'inline', marginRight: 5 }} />
          Start Run
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 1fr' : '1fr', gap: 12 }}>
        {/* Run list */}
        <div>
          {runs.length === 0 && !runsQ.isLoading && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 24 }}>
              No autonomous runs yet. Start one above.
            </p>
          )}
          {runs.map((run) => (
            <div
              key={run.id}
              onClick={() => setSelected(selected === run.id ? null : run.id)}
              style={{
                background: 'var(--bg-elevated)', border: `1px solid ${selected === run.id ? '#3b82f6' : 'var(--border)'}`,
                borderRadius: 8, padding: '10px 12px', marginBottom: 8, cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: runStatusColor(run.status), flexShrink: 0, display: 'inline-block' }} />
                <span style={{ fontSize: 11, fontWeight: 600, color: runStatusColor(run.status), textTransform: 'uppercase' }}>{run.status}</span>
                {run.phase && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>/ {run.phase}</span>}
                {run.currentAgent && <span style={{ fontSize: 10, color: '#6366f1' }}>agent: {run.currentAgent}</span>}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-primary)', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {run.masterPrompt}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {run.status === 'running' && (
                  <button onClick={(e) => { e.stopPropagation(); mutateRun(run.id, 'pause') }}
                    style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, border: '1px solid #f59e0b44', background: '#f59e0b11', color: '#f59e0b', cursor: 'pointer' }}>
                    <Pause style={{ width: 9, height: 9, display: 'inline', marginRight: 3 }} />Pause
                  </button>
                )}
                {run.status === 'paused' && (
                  <button onClick={(e) => { e.stopPropagation(); mutateRun(run.id, 'resume') }}
                    style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, border: '1px solid #3b82f644', background: '#3b82f611', color: '#3b82f6', cursor: 'pointer' }}>
                    <Play style={{ width: 9, height: 9, display: 'inline', marginRight: 3 }} />Resume
                  </button>
                )}
                {(run.status === 'running' || run.status === 'paused' || run.status === 'blocked') && (
                  <button onClick={(e) => { e.stopPropagation(); mutateRun(run.id, 'cancel') }}
                    style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, border: '1px solid #f43f5e44', background: '#f43f5e11', color: '#f43f5e', cursor: 'pointer' }}>
                    <Square style={{ width: 9, height: 9, display: 'inline', marginRight: 3 }} />Cancel
                  </button>
                )}
                {run.failureReason && (
                  <span style={{ fontSize: 10, color: '#f43f5e', marginLeft: 4 }}>{run.failureReason.slice(0, 60)}</span>
                )}
                <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 'auto' }}>
                  {new Date(run.createdAt).toLocaleTimeString()}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Job timeline */}
        {selected && (
          <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <Activity style={{ width: 13, height: 13, color: '#6366f1' }} />
              <span style={{ fontSize: 12, fontWeight: 600 }}>Agent Timeline</span>
              <button onClick={() => qc.invalidateQueries({ queryKey: ['auto-jobs'] })}
                style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2 }}>
                <RefreshCw style={{ width: 11, height: 11 }} />
              </button>
            </div>
            {jobs.length === 0 && <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>No jobs started yet.</p>}
            {jobs.map((job) => (
              <div key={job.id} style={{
                padding: '8px 0', borderBottom: '1px solid var(--border)',
                display: 'flex', gap: 8, alignItems: 'flex-start',
              }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', marginTop: 4, flexShrink: 0,
                  background: job.status === 'complete' ? '#10b981' : job.status === 'running' ? '#3b82f6' : job.status === 'failed' ? '#f43f5e' : job.status === 'unverified' ? '#f59e0b' : '#64748b' }} />
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', gap: 6, fontSize: 11 }}>
                    <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{job.agentName}</span>
                    <span style={{ color: 'var(--text-muted)' }}>/ {job.phase}</span>
                    <span style={{ marginLeft: 'auto', fontWeight: 600, fontSize: 10, textTransform: 'uppercase',
                      color: job.status === 'complete' ? '#10b981' : job.status === 'unverified' ? '#f59e0b' : job.status === 'failed' ? '#f43f5e' : 'var(--text-muted)' }}>
                      {job.status}
                    </span>
                  </div>
                  {job.errorMessage && (
                    <div style={{ fontSize: 10, color: '#f43f5e', marginTop: 2 }}>{job.errorMessage.slice(0, 120)}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
