/**
 * Operator Input — forms for revenue, horizons, preferences,
 * webhook setup, and the cron failure tile.
 *
 * Consolidates everything that previously required curl.
 */
import React, { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  DollarSign, Target, Server, Webhook, AlertCircle, CheckCircle2, RefreshCw,
} from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

interface ProviderPref {
  workspaceId: string; taskType: string; preferredProvider: string
  status: string; setBy: string; reason: string | null; updatedAt: number
}
interface WorkerOverride {
  workspaceId: string; queueName: string; factor: number
  setBy: string; reason: string | null; updatedAt: number
}
interface CronFailures {
  total: number; byTask: Record<string, number>
  recent: Array<{ task: string; error: string; at: number }>
}

export default function OperatorInputPage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  // Forms state
  const [rev, setRev] = useState({ source: 'stripe', amount: '', customerRef: '', workflowRunId: '' })
  const [hz, setHz]   = useState({ horizon: '90d', title: '', objective: '' })
  const [wc, setWc]   = useState({ queue: 'ai', factor: '1.0' })

  // Queries
  const prefs = useQuery({
    queryKey: ['prefs-providers', workspaceId],
    queryFn:  () => api.get<{ data: ProviderPref[] }>(`/api/v1/self/preferences/providers?workspace_id=${workspaceId}`),
    refetchInterval: 60_000,
  })
  const workers = useQuery({
    queryKey: ['prefs-workers', workspaceId],
    queryFn:  () => api.get<{ data: WorkerOverride[] }>(`/api/v1/self/preferences/workers?workspace_id=${workspaceId}`),
    refetchInterval: 60_000,
  })
  const cronFails = useQuery({
    queryKey: ['cron-fails'],
    queryFn:  () => api.get<{ data: CronFailures }>(`/api/v1/self/cron-failures?hours=24`),
    refetchInterval: 30_000,
  })

  // Mutations
  const recordRevenue = useMutation({
    mutationFn: () => api.post(`/api/v1/autonomy/revenue`, {
      workspace_id: workspaceId,
      source: rev.source,
      amount_usd: Number(rev.amount),
      customer_ref:   rev.customerRef   || undefined,
      workflow_run_id: rev.workflowRunId || undefined,
    }),
    onSuccess: () => setRev({ source: 'stripe', amount: '', customerRef: '', workflowRunId: '' }),
  })

  const createHorizon = useMutation({
    mutationFn: () => api.post(`/api/v1/autonomy/horizons`, {
      workspace_id: workspaceId,
      horizon: hz.horizon,
      title: hz.title,
      objectives: hz.objective ? [{ id: 'obj-1', statement: hz.objective, metric: '', target: '', status: 'on_track' }] : [],
    }),
    onSuccess: () => setHz({ horizon: '90d', title: '', objective: '' }),
  })

  const setPrefStatus = useMutation({
    mutationFn: ({ taskType, status }: { taskType: string; status: string }) =>
      api.post(`/api/v1/self/preferences/providers/status`, { workspace_id: workspaceId, task_type: taskType, status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['prefs-providers', workspaceId] }),
  })

  const setWorker = useMutation({
    mutationFn: () => api.post(`/api/v1/self/preferences/workers/set`, {
      workspace_id: workspaceId, queue_name: wc.queue, factor: Number(wc.factor), reason: 'manual override',
    }),
    onSuccess: () => { setWc({ queue: 'ai', factor: '1.0' }); qc.invalidateQueries({ queryKey: ['prefs-workers', workspaceId] }) },
  })

  return (
    <div className="p-6 space-y-4 max-w-6xl mx-auto">
      <h1 className="text-xl font-semibold">Operator Input</h1>

      {/* Cron failures */}
      <Section title="Cron failures (last 24h)" icon={<AlertCircle className="w-4 h-4 text-amber-400" />}>
        {cronFails.data?.data ? (
          (cronFails.data.data.total === 0 ? (
            <div className="px-5 py-3 text-xs text-emerald-300 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" /> No cron failures.
            </div>
          ) : (
            <div>
              <div className="px-5 py-2 text-xs text-amber-300">
                {cronFails.data.data.total} failures across {Object.keys(cronFails.data.data.byTask).length} tasks.
              </div>
              <ul className="divide-y divide-[var(--border)]">
                {cronFails.data.data.recent.slice(0, 6).map((r, i) => (
                  <li key={i} className="px-5 py-1.5 text-xs flex items-center gap-3">
                    <span className="font-mono text-muted w-32">{new Date(r.at).toLocaleString().replace(',', '')}</span>
                    <span className="font-mono text-amber-300 w-32">{r.task}</span>
                    <span className="text-muted truncate flex-1" title={r.error}>{r.error}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))
        ) : <Empty msg="loading…" />}
      </Section>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Revenue form */}
        <Section title="Record revenue event" icon={<DollarSign className="w-4 h-4 text-emerald-400" />}>
          <div className="p-4 space-y-2">
            <Field label="Source"><input value={rev.source} onChange={(e) => setRev({...rev, source: e.target.value})} className={inputCls} /></Field>
            <Field label="Amount USD"><input type="number" step="0.01" value={rev.amount} onChange={(e) => setRev({...rev, amount: e.target.value})} className={inputCls} /></Field>
            <Field label="Customer ref (optional)"><input value={rev.customerRef} onChange={(e) => setRev({...rev, customerRef: e.target.value})} className={inputCls} /></Field>
            <Field label="Workflow run id (optional, enables ROI attribution)"><input value={rev.workflowRunId} onChange={(e) => setRev({...rev, workflowRunId: e.target.value})} className={inputCls} /></Field>
            <button onClick={() => recordRevenue.mutate()} disabled={!rev.amount || recordRevenue.isPending}
              className="px-3 py-1.5 text-xs rounded border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 disabled:opacity-50">
              {recordRevenue.isPending ? 'Recording…' : 'Record'}
            </button>
            {recordRevenue.isSuccess && <span className="text-xs text-emerald-400 ml-2">Recorded.</span>}
          </div>
        </Section>

        {/* Horizon form */}
        <Section title="Create strategic horizon" icon={<Target className="w-4 h-4 text-purple-400" />}>
          <div className="p-4 space-y-2">
            <Field label="Horizon">
              <select value={hz.horizon} onChange={(e) => setHz({...hz, horizon: e.target.value})} className={inputCls}>
                {['90d', '180d', '1y', '3y'].map(h => <option key={h}>{h}</option>)}
              </select>
            </Field>
            <Field label="Title"><input value={hz.title} onChange={(e) => setHz({...hz, title: e.target.value})} className={inputCls} placeholder="e.g. Reach $10k MRR" /></Field>
            <Field label="First objective"><textarea value={hz.objective} onChange={(e) => setHz({...hz, objective: e.target.value})} className={inputCls} rows={2} placeholder="e.g. Grow weekly revenue from $200 to $2000 by end of Q3" /></Field>
            <button onClick={() => createHorizon.mutate()} disabled={!hz.title || createHorizon.isPending}
              className="px-3 py-1.5 text-xs rounded border border-purple-500/40 bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 disabled:opacity-50">
              {createHorizon.isPending ? 'Creating…' : 'Create'}
            </button>
            {createHorizon.isSuccess && <span className="text-xs text-emerald-400 ml-2">Created.</span>}
          </div>
        </Section>
      </div>

      {/* Provider preferences */}
      <Section title="Provider preferences" icon={<Server className="w-4 h-4 text-sky-400" />}>
        {(prefs.data?.data ?? []).length === 0 ? <Empty msg="No preferences yet. Autonomous mind writes pending ones; approve to activate." /> : (
          <ul className="divide-y divide-[var(--border)]">
            {prefs.data!.data.map(p => (
              <li key={p.taskType} className="px-5 py-2 flex items-center gap-3 text-sm">
                <span className="font-mono">{p.taskType}</span>
                <span className="text-muted">→ {p.preferredProvider}</span>
                <span className="text-[10px] text-muted italic flex-1" title={p.reason ?? ''}>{p.reason ?? ''}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${p.status === 'active' ? 'text-emerald-300 bg-emerald-500/10' : p.status === 'rejected' ? 'text-red-300 bg-red-500/10' : 'text-amber-300 bg-amber-500/10'}`}>{p.status}</span>
                {p.status === 'pending' && (
                  <>
                    <button onClick={() => setPrefStatus.mutate({ taskType: p.taskType, status: 'active' })} className="px-2 py-0.5 text-[10px] rounded border border-emerald-500/40 hover:bg-emerald-500/10 text-emerald-300">Activate</button>
                    <button onClick={() => setPrefStatus.mutate({ taskType: p.taskType, status: 'rejected' })} className="px-2 py-0.5 text-[10px] rounded border border-red-500/40 hover:bg-red-500/10 text-red-300">Reject</button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Worker concurrency */}
      <Section title="Worker concurrency overrides" icon={<RefreshCw className="w-4 h-4 text-amber-400" />}>
        <div className="p-4 flex items-center gap-2">
          <Field label="Queue">
            <select value={wc.queue} onChange={(e) => setWc({...wc, queue: e.target.value})} className={inputCls}>
              {['ai', 'browser', 'remote', 'workflow'].map(q => <option key={q}>{q}</option>)}
            </select>
          </Field>
          <Field label="Factor (0=pause, 1=normal, 2=double)">
            <input type="number" step="0.1" min="0" max="2" value={wc.factor} onChange={(e) => setWc({...wc, factor: e.target.value})} className={inputCls} />
          </Field>
          <button onClick={() => setWorker.mutate()} className="self-end px-3 py-1.5 text-xs rounded border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300">Set</button>
        </div>
        {(workers.data?.data ?? []).length > 0 && (
          <ul className="divide-y divide-[var(--border)] border-t border-border">
            {workers.data!.data.map(w => (
              <li key={w.queueName} className="px-5 py-2 text-sm flex items-center gap-3">
                <span className="font-mono">{w.queueName}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${w.factor < 1 ? 'text-amber-300 bg-amber-500/10' : w.factor > 1 ? 'text-sky-300 bg-sky-500/10' : 'text-slate-300 bg-slate-500/10'}`}>×{w.factor}</span>
                <span className="text-muted text-xs flex-1" title={w.reason ?? ''}>{w.reason ?? ''}</span>
                <span className="text-[10px] text-muted font-mono">{w.setBy}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Webhook setup */}
      <Section title="Inbound webhook setup" icon={<Webhook className="w-4 h-4 text-sky-400" />}>
        <div className="p-4 text-xs space-y-2 text-muted">
          <p>Send inbound messages (Slack, Discord, email-to-webhook gateways, custom integrations) to:</p>
          <pre className="bg-[var(--bg)] border border-border rounded p-2 font-mono text-emerald-300 select-all">
            POST {origin}/api/v1/autonomy/inbound
          </pre>
          <p>Body:</p>
          <pre className="bg-[var(--bg)] border border-border rounded p-2 font-mono text-primary text-[10px] overflow-x-auto">
{`{
  "workspace_id": "${workspaceId}",
  "channel": "slack" | "email" | "discord" | "webhook",
  "external_id": "<upstream id for dedupe>",
  "from_addr": "user@example.com",
  "subject": "optional",
  "body": "the message text",
  "metadata": { "anything": "useful" }
}`}
          </pre>
          <p>Intent is auto-classified (alert/question/task/fyi). See /audit-trail for inbound.intent_classified events.</p>
        </div>
      </Section>
    </div>
  )
}

function Section({ title, icon, children }: { title: string; icon?: JSX.Element; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-medium text-primary">{title}</h3>
      </div>
      {children}
    </div>
  )
}

const inputCls = 'w-full bg-[var(--bg)] border border-border rounded px-2 py-1 text-sm'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-wider text-muted mb-0.5">{label}</div>
      {children}
    </label>
  )
}

function Empty({ msg }: { msg: string }) {
  return <div className="px-5 py-3 text-xs text-muted italic">{msg}</div>
}
