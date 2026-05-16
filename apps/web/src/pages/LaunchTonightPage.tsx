/**
 * LaunchTonightPage — One-screen launch-tonight readiness console.
 *
 * - Big READY / NOT READY indicator
 * - Tonight Mode toggle + per-flag controls
 * - Provider validation button
 * - Live runtime status (agents, learning loop, sandbox health)
 * - Full launch checklist
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Rocket, ShieldCheck, ShieldAlert, AlertTriangle, CheckCircle2,
  XCircle, RefreshCcw, Zap, Lock, Activity, Brain,
} from 'lucide-react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

const API = (p: string) => `/api/v1/launch-tonight${p}`

async function fetchFlags(ws: string)         { return (await (await fetch(`${API('/flags')}?workspace_id=${ws}`)).json()).data as Flags }
async function fetchChecklist(ws: string)     { return (await (await fetch(`${API('/checklist')}?workspace_id=${ws}`)).json()).data as Checklist }
async function fetchRuntime(ws: string)       { return (await (await fetch(`${API('/runtime-status')}?workspace_id=${ws}`)).json()).data as Runtime }
async function fetchAgentsReady(ws: string)   { return (await (await fetch(`${API('/agents-ready')}?workspace_id=${ws}`)).json()).data as AgentsReady }
async function postValidateProviders(ws: string) {
  return (await (await fetch(API('/validate-providers'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace_id: ws }) })).json()).data as ProvResult
}
async function postFlag(ws: string, key: string, value: boolean) {
  const r = await fetch(API('/flags'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace_id: ws, key, value, actor: 'ops-admin' }) })
  if (!r.ok) throw new Error((await r.json()).error)
  return r.json()
}
async function postEnable(ws: string)  { await fetch(API('/tonight-mode/enable'),  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace_id: ws, actor: 'ops-admin' }) }) }

interface Flags {
  tonightModeActive: boolean
  autonomousDeployAllowed: boolean
  selfEditLoopsAllowed: boolean
  autonomousDepsUpgradesAllowed: boolean
  destructiveMigrationsAllowed: boolean
  internetLearningSwarmAllowed: boolean
  approvalGatedPatchesEnabled: boolean
  failureLearningEnabled: boolean
  observabilityEnabled: boolean
  warRoomEnabled: boolean
  cronScansEnabled: boolean
  incidentAlertsEnabled: boolean
}

interface Check { name: string; status: 'pass' | 'fail' | 'warn'; reason: string }
interface Checklist {
  readyToLaunch: boolean
  tonightModeActive: boolean
  launchBlockers: string[]
  tonightChecks: Check[]
  productionReadinessAudit: { score: number; passedCount: number; failedCount: number; unverifiedCount: number; criticalBlockers: number }
  providerSummary: { configured: number; reachable: number; probes: ProviderProbe[] }
  securityFindings: { open: number; critical: number; blocksLaunch: number }
}

interface ProviderProbe {
  provider: string; configured: boolean; reachable: boolean | null
  status: string; latencyMs: number | null; errorMessage?: string
}

interface ProvResult { results: ProviderProbe[]; configuredCount: number; reachableCount: number }

interface Runtime {
  eventsLastHour: number
  agents: { orchestratorActive: number; orchestratorDown: number; orchestratorTotal: number; securityTeamCount: number }
  learningLoop: { failuresLastHour: number; blockedSignatures: number; loopActive: boolean }
  sandbox: { completed: number; failed: number; totalLastHour: number }
  incidents: { openCount: number }
}

interface AgentsReady {
  orchestrationAgents: Array<{ id: string; name: string; status: string; readyToAct: boolean }>
  securityAgents: Array<{ id: string; name: string; role: string; active: boolean; readyToScan: boolean }>
  safetyConstraints: Record<string, boolean>
}

const STATUS_DOT: Record<string, string> = {
  pass: 'bg-green-400',
  fail: 'bg-red-400',
  warn: 'bg-yellow-400',
}

function Toggle({ on, danger, label, onChange, disabled }: { on: boolean; danger?: boolean; label: string; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`flex items-center justify-between gap-3 px-3 py-2 rounded border ${on ? (danger ? 'border-red-500/30 bg-red-500/5' : 'border-green-500/30 bg-green-500/5') : 'border-[var(--border)] bg-[var(--bg-surface)]'} ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <span className="text-sm text-[var(--text-primary)]">{label}</span>
      <input type="checkbox" checked={on} disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4 rounded" />
    </label>
  )
}

export default function LaunchTonightPage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const [validating, setValidating] = useState(false)

  const { data: flags }    = useQuery({ queryKey: ['lt-flags',    workspaceId], queryFn: () => fetchFlags(workspaceId),    enabled: !!workspaceId, refetchInterval: 15_000 })
  const { data: checklist }= useQuery({ queryKey: ['lt-checklist', workspaceId], queryFn: () => fetchChecklist(workspaceId), enabled: !!workspaceId, refetchInterval: 30_000 })
  const { data: runtime }  = useQuery({ queryKey: ['lt-runtime',   workspaceId], queryFn: () => fetchRuntime(workspaceId),   enabled: !!workspaceId, refetchInterval: 15_000 })
  const { data: agents }   = useQuery({ queryKey: ['lt-agents',    workspaceId], queryFn: () => fetchAgentsReady(workspaceId), enabled: !!workspaceId, refetchInterval: 30_000 })

  const flagMut    = useMutation({ mutationFn: ({ k, v }: { k: string; v: boolean }) => postFlag(workspaceId, k, v),  onSuccess: () => { qc.invalidateQueries({ queryKey: ['lt-flags'] }); qc.invalidateQueries({ queryKey: ['lt-checklist'] }) } })
  const enableMut  = useMutation({ mutationFn: () => postEnable(workspaceId),  onSuccess: () => { qc.invalidateQueries({ queryKey: ['lt-flags'] }); qc.invalidateQueries({ queryKey: ['lt-checklist'] }) } })
  const validateMut = useMutation({
    mutationFn: () => { setValidating(true); return postValidateProviders(workspaceId).finally(() => setValidating(false)) },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lt-checklist'] }),
  })

  const ready = checklist?.readyToLaunch ?? false

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="shrink-0 px-6 pt-5 pb-4 border-b border-[var(--border)]">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-[var(--text-primary)] flex items-center gap-2">
              <Rocket className="w-4 h-4 text-purple-400" /> Launch Tonight
            </h1>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Safe-defaults console · Tonight Mode keeps dangerous autonomy disabled
            </p>
          </div>
          <button onClick={() => { qc.invalidateQueries({ queryKey: ['lt-flags'] }); qc.invalidateQueries({ queryKey: ['lt-checklist'] }); qc.invalidateQueries({ queryKey: ['lt-runtime'] }) }}
            className="text-[var(--text-muted)] hover:text-[var(--text-secondary)]"><RefreshCcw className="w-4 h-4" /></button>
        </div>

        {/* Big indicator */}
        <div className={`mt-4 rounded-lg border-2 p-5 flex items-center gap-4 ${
          ready ? 'border-green-500/40 bg-green-500/5' : 'border-red-500/40 bg-red-500/5'
        }`}>
          {ready ? <ShieldCheck className="w-10 h-10 text-green-400" />
                : <ShieldAlert className="w-10 h-10 text-red-400" />}
          <div className="flex-1">
            <p className={`text-2xl font-bold ${ready ? 'text-green-400' : 'text-red-400'}`}>
              {ready ? 'READY TO LAUNCH' : 'NOT READY'}
            </p>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              {ready
                ? 'All tonight-mode checks pass. Safe to expose to production traffic.'
                : `${checklist?.launchBlockers.length ?? 0} blocker(s). Resolve before launch.`}
            </p>
          </div>
          {checklist?.productionReadinessAudit && (
            <div className="text-right">
              <p className="text-xs text-[var(--text-muted)]">Readiness Score</p>
              <p className={`text-3xl font-bold ${checklist.productionReadinessAudit.score >= 80 ? 'text-green-400' : checklist.productionReadinessAudit.score >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>
                {checklist.productionReadinessAudit.score}
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="max-w-5xl grid grid-cols-2 gap-4">

          {/* Tonight Mode flags */}
          <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-2">
                <Lock className="w-4 h-4 text-blue-400" /> Tonight Mode
              </h2>
              <button onClick={() => enableMut.mutate()} disabled={enableMut.isPending || flags?.tonightModeActive}
                className="px-3 py-1 rounded text-xs bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border border-blue-500/30 disabled:opacity-50">
                {flags?.tonightModeActive ? 'Active' : 'Enable'}
              </button>
            </div>
            {flags && (
              <div className="space-y-1.5">
                <p className="text-xs text-[var(--text-muted)] mb-1 uppercase">Dangerous — must be OFF tonight</p>
                <Toggle on={flags.autonomousDeployAllowed} danger label="Autonomous deploy"
                  onChange={(v) => flagMut.mutate({ k: 'autonomousDeployAllowed', v })} />
                <Toggle on={flags.selfEditLoopsAllowed} danger label="Self-edit loops"
                  onChange={(v) => flagMut.mutate({ k: 'selfEditLoopsAllowed', v })} />
                <Toggle on={flags.autonomousDepsUpgradesAllowed} danger label="Autonomous dep upgrades"
                  onChange={(v) => flagMut.mutate({ k: 'autonomousDepsUpgradesAllowed', v })} />
                <Toggle on={flags.destructiveMigrationsAllowed} danger label="Destructive migrations"
                  onChange={(v) => flagMut.mutate({ k: 'destructiveMigrationsAllowed', v })} />
                <Toggle on={flags.internetLearningSwarmAllowed} danger label="Internet learning swarm"
                  onChange={(v) => flagMut.mutate({ k: 'internetLearningSwarmAllowed', v })} />
                <p className="text-xs text-[var(--text-muted)] mt-3 mb-1 uppercase">Safe — should be ON</p>
                <Toggle on={flags.approvalGatedPatchesEnabled} label="Approval-gated patches"
                  onChange={(v) => flagMut.mutate({ k: 'approvalGatedPatchesEnabled', v })} />
                <Toggle on={flags.failureLearningEnabled} label="Failure-memory learning"
                  onChange={(v) => flagMut.mutate({ k: 'failureLearningEnabled', v })} />
                <Toggle on={flags.observabilityEnabled} label="Observability + telemetry"
                  onChange={(v) => flagMut.mutate({ k: 'observabilityEnabled', v })} />
                <Toggle on={flags.cronScansEnabled} label="Background cron scans"
                  onChange={(v) => flagMut.mutate({ k: 'cronScansEnabled', v })} />
                <Toggle on={flags.incidentAlertsEnabled} label="Incident alerts"
                  onChange={(v) => flagMut.mutate({ k: 'incidentAlertsEnabled', v })} />
              </div>
            )}
          </section>

          {/* Runtime + agents */}
          <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-4 space-y-3">
            <h2 className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-2">
              <Activity className="w-4 h-4 text-blue-400" /> Runtime Status (1h)
            </h2>
            {runtime && (
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded bg-[var(--bg-primary)] px-3 py-2">
                  <p className="text-[var(--text-muted)]">Events</p>
                  <p className="text-lg font-semibold text-[var(--text-primary)]">{runtime.eventsLastHour}</p>
                </div>
                <div className="rounded bg-[var(--bg-primary)] px-3 py-2">
                  <p className="text-[var(--text-muted)]">Open incidents</p>
                  <p className={`text-lg font-semibold ${runtime.incidents.openCount === 0 ? 'text-green-400' : 'text-yellow-400'}`}>{runtime.incidents.openCount}</p>
                </div>
                <div className="rounded bg-[var(--bg-primary)] px-3 py-2">
                  <p className="text-[var(--text-muted)]">Orchestration agents</p>
                  <p className="text-lg font-semibold text-[var(--text-primary)]">
                    {runtime.agents.orchestratorActive} <span className="text-xs text-[var(--text-muted)]">/ {runtime.agents.orchestratorTotal}</span>
                  </p>
                </div>
                <div className="rounded bg-[var(--bg-primary)] px-3 py-2">
                  <p className="text-[var(--text-muted)]">Security agents</p>
                  <p className="text-lg font-semibold text-[var(--text-primary)]">{runtime.agents.securityTeamCount}</p>
                </div>
                <div className="rounded bg-[var(--bg-primary)] px-3 py-2 col-span-2 flex items-center gap-2">
                  <Brain className="w-4 h-4 text-purple-400" />
                  <div className="flex-1">
                    <p className="text-[var(--text-muted)]">Learning loop</p>
                    <p className="text-sm text-[var(--text-secondary)]">
                      {runtime.learningLoop.failuresLastHour} failure(s) · {runtime.learningLoop.blockedSignatures} blocked signature(s)
                    </p>
                  </div>
                  <span className={`px-2 py-0.5 rounded text-xs ${runtime.learningLoop.loopActive ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                    {runtime.learningLoop.loopActive ? 'ACTIVE' : 'OFF'}
                  </span>
                </div>
                <div className="rounded bg-[var(--bg-primary)] px-3 py-2 col-span-2">
                  <p className="text-[var(--text-muted)]">Sandbox</p>
                  <p className="text-sm text-[var(--text-secondary)]">
                    {runtime.sandbox.completed} ok · {runtime.sandbox.failed} failed · {runtime.sandbox.totalLastHour} total
                  </p>
                </div>
              </div>
            )}
          </section>

          {/* Providers */}
          <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-2">
                <Zap className="w-4 h-4 text-yellow-400" /> Provider Connections
              </h2>
              <button onClick={() => validateMut.mutate()} disabled={validating}
                className="px-3 py-1 rounded text-xs bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 border border-yellow-500/30 disabled:opacity-50">
                {validating ? 'Probing…' : 'Validate'}
              </button>
            </div>
            {checklist?.providerSummary && (
              <div className="space-y-1.5">
                <p className="text-xs text-[var(--text-muted)]">
                  {checklist.providerSummary.configured} configured · {checklist.providerSummary.reachable} reachable
                </p>
                {checklist.providerSummary.probes.map((p) => (
                  <div key={p.provider} className="flex items-center gap-2 text-xs">
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      p.status === 'healthy' ? 'bg-green-400'
                      : p.status === 'degraded' ? 'bg-yellow-400'
                      : p.status === 'down' ? 'bg-red-400'
                      : 'bg-gray-500'
                    }`} />
                    <span className="font-mono w-20">{p.provider}</span>
                    <span className="text-[var(--text-muted)] flex-1">
                      {p.status === 'unconfigured' ? 'not configured'
                        : p.reachable ? `reachable · ${p.latencyMs}ms`
                        : (p.errorMessage ?? 'unreachable')}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Agents ready */}
          <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-4">
            <h2 className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-2 mb-3">
              <CheckCircle2 className="w-4 h-4 text-green-400" /> Active Agents
            </h2>
            {agents && (
              <div className="space-y-2">
                <div>
                  <p className="text-xs text-[var(--text-muted)] uppercase mb-1">Orchestration ({agents.orchestrationAgents.length})</p>
                  {agents.orchestrationAgents.length === 0 && <p className="text-xs text-[var(--text-muted)] italic">None registered yet</p>}
                  {agents.orchestrationAgents.slice(0, 5).map((a) => (
                    <p key={a.id} className="text-xs text-[var(--text-secondary)] flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full ${a.readyToAct ? 'bg-green-400' : 'bg-red-400'}`} />
                      <span className="font-mono">{a.name}</span>
                      <span className="text-[var(--text-muted)] ml-auto">{a.status}</span>
                    </p>
                  ))}
                </div>
                <div>
                  <p className="text-xs text-[var(--text-muted)] uppercase mb-1">Security Team ({agents.securityAgents.length}/10)</p>
                  {agents.securityAgents.map((a) => (
                    <p key={a.id} className="text-xs text-[var(--text-secondary)] flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full ${a.readyToScan ? 'bg-green-400' : 'bg-red-400'}`} />
                      <span className="font-mono">{a.role}</span>
                      <span className="text-[var(--text-muted)] flex-1">{a.name}</span>
                    </p>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* Checklist (spans both columns) */}
          {checklist && (
            <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-4 col-span-2">
              <h2 className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-2 mb-3">
                <CheckCircle2 className="w-4 h-4 text-blue-400" /> Tonight Launch Checklist
              </h2>
              <div className="space-y-1.5">
                {checklist.tonightChecks.map((c) => (
                  <div key={c.name} className="flex items-center gap-3 text-xs">
                    <span className={`w-2 h-2 rounded-full ${STATUS_DOT[c.status]}`} />
                    <span className="font-mono w-56">{c.name}</span>
                    <span className="flex-1 text-[var(--text-secondary)]">{c.reason}</span>
                    <span className={`uppercase text-xs font-medium ${
                      c.status === 'pass' ? 'text-green-400' : c.status === 'fail' ? 'text-red-400' : 'text-yellow-400'
                    }`}>{c.status}</span>
                  </div>
                ))}
              </div>
              {checklist.launchBlockers.length > 0 && (
                <div className="mt-4 pt-4 border-t border-red-500/20">
                  <p className="text-sm font-medium text-red-400 mb-2 flex items-center gap-1.5">
                    <XCircle className="w-4 h-4" /> Launch Blockers ({checklist.launchBlockers.length})
                  </p>
                  <ul className="space-y-1">
                    {checklist.launchBlockers.map((b, i) => (
                      <li key={i} className="text-xs text-[var(--text-secondary)] flex items-start gap-1.5">
                        <span className="text-red-400">•</span>{b}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {/* Audit summary */}
          {checklist?.productionReadinessAudit && (
            <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-4 col-span-2">
              <h2 className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-2 mb-3">
                <AlertTriangle className="w-4 h-4 text-orange-400" /> Production Readiness Audit Summary
              </h2>
              <div className="grid grid-cols-4 gap-3 text-xs">
                <div className="rounded bg-[var(--bg-primary)] px-3 py-2"><span className="text-[var(--text-muted)]">Passed</span><p className="text-lg text-green-400">{checklist.productionReadinessAudit.passedCount}</p></div>
                <div className="rounded bg-[var(--bg-primary)] px-3 py-2"><span className="text-[var(--text-muted)]">Failed</span><p className="text-lg text-red-400">{checklist.productionReadinessAudit.failedCount}</p></div>
                <div className="rounded bg-[var(--bg-primary)] px-3 py-2"><span className="text-[var(--text-muted)]">Unverified</span><p className="text-lg text-orange-400">{checklist.productionReadinessAudit.unverifiedCount}</p></div>
                <div className="rounded bg-[var(--bg-primary)] px-3 py-2"><span className="text-[var(--text-muted)]">Critical blockers</span><p className="text-lg text-red-300">{checklist.productionReadinessAudit.criticalBlockers}</p></div>
              </div>
              <p className="text-xs text-[var(--text-muted)] mt-3 italic">
                Run a full audit anytime via War Room → Launch Lock → Run Audit.
              </p>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
