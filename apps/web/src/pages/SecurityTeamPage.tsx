/**
 * SecurityTeamPage — Cyber Security Force Team War Room view.
 *
 * Shows:
 * - 10 registered security agents + role + findings produced
 * - Severity-bucketed findings with launch-blocker flag
 * - Acknowledge / Resolve / Mark False Positive actions
 * - Scan-on-demand button
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Shield, ShieldAlert, ShieldCheck, AlertOctagon, AlertTriangle,
  Info, ChevronDown, ChevronUp, RefreshCcw, Zap, Lock,
  CheckCircle2, XCircle, UserX, FileCode2,
} from 'lucide-react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

const API = (p: string) => `/api/v1/security-team${p}`

async function fetchAgents()              { return (await (await fetch(API('/agents'))).json()).data as Agent[] }
async function fetchFindings(ws: string, status?: string) {
  const q = new URLSearchParams({ workspace_id: ws }); if (status) q.set('status', status)
  return (await (await fetch(`${API('/findings')}?${q}`)).json()).data as Finding[]
}
async function fetchStats(ws: string)     { return (await (await fetch(`${API('/findings/stats')}?workspace_id=${ws}`)).json()).data as Stats }
async function postScan(ws: string)       { return (await (await fetch(API('/scan'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace_id: ws }) })).json()).data }
async function postAction(id: string, action: string, body: object) {
  const r = await fetch(API(`/findings/${id}/${action}`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error((await r.json()).error)
  return r.json()
}

interface Agent {
  id: string; name: string; role: string; description: string
  capabilities: string[]; isActive: boolean
  lastRunAt: number | null; findingsProduced: number
}

interface Finding {
  id: string; agentId: string; agentRole: string
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical'
  category: string
  title: string; description: string
  evidenceRefs: Array<{ table: string; id: string }>
  affectedResource: string | null
  recommendedAction: string
  status: 'open' | 'acknowledged' | 'mitigating' | 'resolved' | 'false_positive'
  requiresApproval: boolean; blocksLaunch: boolean
  reviewedBy: string | null; resolutionNote: string | null
  detectedAt: number
}

interface Stats {
  total: number; open: number; resolved: number
  critical: number; high: number; medium: number; low: number
  blocksLaunch: number
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-red-600/25 text-red-300 border border-red-600/40',
  high:     'bg-red-500/20 text-red-400 border border-red-500/30',
  medium:   'bg-orange-500/20 text-orange-400 border border-orange-500/30',
  low:      'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
  info:     'bg-blue-500/20 text-blue-400 border border-blue-500/30',
}

const SEVERITY_ICONS: Record<string, React.ReactNode> = {
  critical: <AlertOctagon className="w-3 h-3" />,
  high:     <ShieldAlert className="w-3 h-3" />,
  medium:   <AlertTriangle className="w-3 h-3" />,
  low:      <Info className="w-3 h-3" />,
  info:     <Info className="w-3 h-3" />,
}

const ROLE_ICONS: Record<string, React.ReactNode> = {
  cso:        <Shield className="w-4 h-4 text-purple-400" />,
  appsec:     <FileCode2 className="w-4 h-4 text-blue-400" />,
  cloud:      <ShieldCheck className="w-4 h-4 text-cyan-400" />,
  secrets:    <Lock className="w-4 h-4 text-yellow-400" />,
  runtime:    <Zap className="w-4 h-4 text-orange-400" />,
  tenant:     <UserX className="w-4 h-4 text-pink-400" />,
  patch:      <FileCode2 className="w-4 h-4 text-green-400" />,
  red:        <ShieldAlert className="w-4 h-4 text-red-400" />,
  blue:       <ShieldCheck className="w-4 h-4 text-blue-400" />,
  compliance: <CheckCircle2 className="w-4 h-4 text-emerald-400" />,
}

function StatCard({ label, value, color, icon }: { label: string; value: number; color?: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-[var(--bg-surface)] px-4 py-3">
      <div className="flex items-center gap-1.5">
        {icon}
        <p className="text-xs text-muted">{label}</p>
      </div>
      <p className={`text-2xl font-semibold mt-1 ${color ?? 'text-primary'}`}>{value}</p>
    </div>
  )
}

function FindingCard({ f }: { f: Finding }) {
  const [open, setOpen]   = useState(false)
  const [action, setAction] = useState<'ack' | 'resolve' | 'fp' | null>(null)
  const [note, setNote]   = useState('')
  const [err, setErr]     = useState<string | null>(null)
  const qc = useQueryClient()

  const mut = useMutation({
    mutationFn: ({ a, n }: { a: string; n: string }) => {
      const body: Record<string, string> = { reviewer: 'ops-user' }
      if (n) body['note'] = n
      if ((a === 'resolve' || a === 'false-positive') && !n.trim()) {
        throw new Error('Note required')
      }
      return postAction(f.id, a, body)
    },
    onSuccess: () => { setAction(null); setNote(''); setErr(null); qc.invalidateQueries({ queryKey: ['st-findings'] }); qc.invalidateQueries({ queryKey: ['st-stats'] }) },
    onError: (e: Error) => setErr(e.message),
  })

  const active = f.status === 'open' || f.status === 'acknowledged' || f.status === 'mitigating'

  return (
    <div className={`rounded-lg border ${f.blocksLaunch && f.status === 'open' ? 'border-red-500/40' : 'border-border'} bg-[var(--bg-surface)]`}>
      <div className="px-4 py-3 flex items-start gap-3">
        <span className={`mt-0.5 flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${SEVERITY_COLORS[f.severity] ?? ''}`}>
          {SEVERITY_ICONS[f.severity]}
          <span className="uppercase">{f.severity}</span>
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-medium text-primary">{f.title}</p>
            {f.blocksLaunch && (
              <span title="Blocks launch"><Lock className="w-3.5 h-3.5 text-red-400" /></span>
            )}
            {f.requiresApproval && !f.blocksLaunch && (
              <span title="Requires approval"><Shield className="w-3.5 h-3.5 text-yellow-400" /></span>
            )}
          </div>
          <p className="text-xs text-muted mt-0.5 flex items-center gap-1">
            {ROLE_ICONS[f.agentRole]}
            <span className="font-mono">{f.agentRole}</span>
            <span>·</span>
            <span>{f.category}</span>
            {f.affectedResource && <><span>·</span><span className="font-mono truncate">{f.affectedResource}</span></>}
            <span>·</span>
            <span>{new Date(f.detectedAt).toLocaleTimeString()}</span>
          </p>
        </div>

        <span className={`px-2 py-0.5 rounded text-xs capitalize ${f.status === 'open' ? 'bg-yellow-500/20 text-yellow-400' : f.status === 'resolved' ? 'bg-green-500/20 text-green-400' : f.status === 'false_positive' ? 'bg-gray-500/20 text-gray-400' : 'bg-blue-500/20 text-blue-400'}`}>
          {f.status.replace('_', ' ')}
        </span>

        <button onClick={() => setOpen((p) => !p)} className="text-muted hover:text-secondary">
          {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </div>

      {open && (
        <div className="border-t border-border px-4 py-3 space-y-3">
          <p className="text-sm text-secondary">{f.description}</p>

          <div className="rounded bg-purple-500/10 border border-purple-500/20 p-2">
            <p className="text-xs text-purple-400 font-medium">Recommended Action</p>
            <p className="text-sm text-secondary mt-0.5">{f.recommendedAction}</p>
          </div>

          {f.evidenceRefs.length > 0 && (
            <div>
              <p className="text-xs text-muted uppercase mb-1">Evidence ({f.evidenceRefs.length})</p>
              <div className="space-y-0.5">
                {f.evidenceRefs.slice(0, 5).map((e, i) => (
                  <p key={i} className="text-xs font-mono text-muted">
                    {e.table} → {e.id.slice(0, 16)}
                  </p>
                ))}
              </div>
            </div>
          )}

          {f.resolutionNote && (
            <div>
              <p className="text-xs text-muted uppercase mb-1">Reviewer note</p>
              <p className="text-sm text-secondary italic">{f.resolutionNote}</p>
            </div>
          )}

          {active && (
            <div>
              {action === null ? (
                <div className="flex gap-2 flex-wrap">
                  {f.status === 'open' && (
                    <button onClick={() => setAction('ack')}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border border-blue-500/30">
                      <CheckCircle2 className="w-3 h-3" /> Acknowledge
                    </button>
                  )}
                  <button onClick={() => setAction('resolve')}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-green-500/20 text-green-400 hover:bg-green-500/30 border border-green-500/30">
                    <ShieldCheck className="w-3 h-3" /> Resolve
                  </button>
                  <button onClick={() => setAction('fp')}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-gray-500/20 text-gray-400 hover:bg-gray-500/30 border border-gray-500/30">
                    <XCircle className="w-3 h-3" /> False Positive
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
                    placeholder={action === 'ack' ? 'Optional note' : 'Note (required)'}
                    className="w-full text-xs rounded border border-border bg-bg text-primary px-2 py-1.5 resize-none outline-none focus:border-blue-500/50" />
                  {err && <p className="text-xs text-red-400">{err}</p>}
                  <div className="flex gap-2">
                    <button onClick={() => {
                      const a = action === 'ack' ? 'acknowledge' : action === 'resolve' ? 'resolve' : 'false-positive'
                      mut.mutate({ a, n: note })
                    }} disabled={mut.isPending}
                      className="px-3 py-1.5 rounded text-xs bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border border-blue-500/30 disabled:opacity-50">
                      Confirm
                    </button>
                    <button onClick={() => { setAction(null); setNote(''); setErr(null) }}
                      className="px-3 py-1.5 rounded text-xs text-muted">Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function SecurityTeamPage() {
  const { workspaceId } = useWorkspace()
  const [tab, setTab] = useState<'findings' | 'agents'>('findings')
  const [filter, setFilter] = useState<string | undefined>('open')
  const qc = useQueryClient()

  const { data: agents = [] }   = useQuery({ queryKey: ['st-agents'],                queryFn: fetchAgents })
  const { data: stats }         = useQuery({ queryKey: ['st-stats',    workspaceId], queryFn: () => fetchStats(workspaceId),    enabled: !!workspaceId, refetchInterval: 30_000 })
  const { data: findings = [] } = useQuery({ queryKey: ['st-findings', workspaceId, filter], queryFn: () => fetchFindings(workspaceId, filter), enabled: !!workspaceId && tab === 'findings', refetchInterval: 30_000 })

  const scanMut = useMutation({
    mutationFn: () => postScan(workspaceId),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['st-findings'] }); qc.invalidateQueries({ queryKey: ['st-stats'] }); qc.invalidateQueries({ queryKey: ['st-agents'] }) },
  })

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="shrink-0 px-6 pt-5 pb-4 border-b border-border">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-primary flex items-center gap-2">
              <Shield className="w-4 h-4 text-purple-400" /> Cyber Security Force Team
            </h1>
            <p className="text-xs text-muted mt-0.5">
              10 specialized agents · evidence-backed findings · launch-blocking on critical issues
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => scanMut.mutate()} disabled={scanMut.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 border border-purple-500/30 disabled:opacity-50">
              <Zap className="w-3 h-3" /> {scanMut.isPending ? 'Scanning…' : 'Run Team Scan'}
            </button>
            <button onClick={() => qc.invalidateQueries({ queryKey: ['st-stats'] })} className="text-muted hover:text-secondary">
              <RefreshCcw className="w-4 h-4" />
            </button>
          </div>
        </div>

        {scanMut.data && (
          <div className="mt-3 text-xs text-purple-300 bg-purple-500/10 border border-purple-500/20 rounded px-3 py-2">
            Scan complete: {scanMut.data.findingsCreated} finding(s), {scanMut.data.blockingCount} launch-blocking
          </div>
        )}

        {stats && (
          <div className="grid grid-cols-8 gap-2 mt-4">
            <StatCard label="Total"          value={stats.total} />
            <StatCard label="Open"           value={stats.open}     color="text-yellow-400" />
            <StatCard label="Resolved"       value={stats.resolved} color="text-green-400" icon={<ShieldCheck className="w-3 h-3 text-green-400" />} />
            <StatCard label="Critical"       value={stats.critical} color="text-red-300"   icon={<AlertOctagon className="w-3 h-3 text-red-300" />} />
            <StatCard label="High"           value={stats.high}     color="text-red-400" />
            <StatCard label="Medium"         value={stats.medium}   color="text-orange-400" />
            <StatCard label="Low"            value={stats.low}      color="text-yellow-400" />
            <StatCard label="Blocks launch"  value={stats.blocksLaunch} color="text-red-300" icon={<Lock className="w-3 h-3 text-red-300" />} />
          </div>
        )}

        <div className="flex gap-1 mt-3">
          {[
            { v: 'findings', l: 'Findings' },
            { v: 'agents',   l: 'Agents' },
          ].map((t) => (
            <button key={t.v} onClick={() => setTab(t.v as typeof tab)}
              className={`px-3 py-1 rounded text-xs ${tab === t.v ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'text-muted hover:text-secondary hover:bg-elevated'}`}>
              {t.l}
            </button>
          ))}
          {tab === 'findings' && (
            <div className="ml-auto flex gap-1">
              {[undefined, 'open', 'acknowledged', 'resolved', 'false_positive'].map((s) => (
                <button key={s ?? 'all'} onClick={() => setFilter(s)}
                  className={`px-2 py-1 rounded text-xs ${filter === s ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'text-muted hover:text-secondary'}`}>
                  {s ?? 'all'}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {tab === 'findings' && (
          <div className="space-y-2 max-w-5xl">
            {stats && stats.blocksLaunch > 0 && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-red-600/15 border border-red-600/40">
                <Lock className="w-4 h-4 text-red-300 shrink-0" />
                <p className="text-sm text-red-300 font-medium">
                  {stats.blocksLaunch} security finding(s) currently block production launch
                </p>
              </div>
            )}
            {findings.length === 0 && (
              <div className="text-center py-12 text-muted">
                <ShieldCheck className="w-8 h-8 mx-auto mb-2 opacity-40 text-green-400" />
                <p className="text-sm">No security findings</p>
                <p className="text-xs mt-1 opacity-60">Run "Team Scan" to evaluate this workspace</p>
              </div>
            )}
            {findings.map((f) => <FindingCard key={f.id} f={f} />)}
          </div>
        )}

        {tab === 'agents' && (
          <div className="grid grid-cols-2 gap-3 max-w-5xl">
            {agents.map((a) => (
              <div key={a.id} className="rounded-lg border border-border bg-[var(--bg-surface)] p-4">
                <div className="flex items-start gap-3">
                  <div className="shrink-0">{ROLE_ICONS[a.role]}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-primary">{a.name}</p>
                      <span className="text-xs font-mono text-muted">{a.role}</span>
                    </div>
                    <p className="text-xs text-muted mt-1">{a.description}</p>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {a.capabilities.map((c) => (
                        <span key={c} className="px-1.5 py-0.5 rounded text-xs bg-elevated text-muted">{c}</span>
                      ))}
                    </div>
                    <p className="text-xs text-muted mt-2">
                      {a.findingsProduced} finding(s) produced
                      {a.lastRunAt && <> · last run {new Date(a.lastRunAt).toLocaleTimeString()}</>}
                    </p>
                  </div>
                  <span className={`px-2 py-0.5 rounded text-xs ${a.isActive ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-400'}`}>
                    {a.isActive ? 'active' : 'disabled'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
