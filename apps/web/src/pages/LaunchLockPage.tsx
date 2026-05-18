/**
 * LaunchLockPage — War Room production readiness console.
 *
 * Shows:
 * - Readiness score (0-100)
 * - Launch locked/unlocked state with blockers
 * - Per-check results with evidence pointers
 * - Override controls (with required reason)
 * - Recommended fixes
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Lock, Unlock, CheckCircle2, XCircle, AlertTriangle,
  HelpCircle, RefreshCcw, ShieldOff, Zap, ShieldAlert,
} from 'lucide-react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

const API = (p: string) => `/api/v1/production-readiness${p}`

async function fetchLock(ws: string) {
  const r = await fetch(`${API('/lock')}?workspace_id=${ws}`)
  return (await r.json()).data as LaunchLock | null
}
async function fetchLatestAudit(ws: string) {
  const r = await fetch(`${API('/audit/latest')}?workspace_id=${ws}`)
  return (await r.json()).data as Audit | null
}
async function runAudit(ws: string) {
  const r = await fetch(API('/audit'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace_id: ws, triggered_by: 'ops-user' }),
  })
  return (await r.json()).data as AuditResult
}
async function applyOverride(ws: string, reason: string) {
  const r = await fetch(API('/lock/override'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace_id: ws, admin_id: 'ops-admin', reason }),
  })
  if (!r.ok) throw new Error((await r.json()).error)
  return r.json()
}
async function revokeOverride(ws: string) {
  await fetch(API('/lock/override/revoke'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace_id: ws, admin_id: 'ops-admin' }),
  })
}

interface LaunchLock {
  id:                string
  locked:            boolean
  blockingReasons:   string[]
  lastAuditId:       string | null
  lastAuditScore:    number | null
  overrideActive:    boolean
  overrideBy:        string | null
  overrideReason:    string | null
  overrideAt:        number | null
  overrideExpiresAt: number | null
}

interface CheckResult {
  name:     string
  status:   'passed' | 'failed' | 'unverified' | 'skipped'
  severity: 'critical' | 'high' | 'medium' | 'low'
  reason:   string
  evidence: string[]
}

interface AuditResult {
  auditId:          string
  readinessScore:   number
  passedCount:      number
  failedCount:      number
  unverifiedCount:  number
  skippedCount:     number
  criticalBlockers: number
  results:          CheckResult[]
  recommendedFixes: string[]
}

interface Audit {
  id:               string
  readinessScore:   number
  passedCount:      number
  failedCount:      number
  unverifiedCount:  number
  skippedCount:     number
  criticalBlockers: number
  checkResults:     CheckResult[]
  recommendedFixes: string[]
  createdAt:        number
}

const STATUS_COLORS: Record<string, string> = {
  passed:     'text-green-400',
  failed:     'text-red-400',
  unverified: 'text-orange-400',
  skipped:    'text-gray-400',
}

const STATUS_ICONS: Record<string, React.ReactNode> = {
  passed:     <CheckCircle2 className="w-4 h-4" />,
  failed:     <XCircle className="w-4 h-4" />,
  unverified: <HelpCircle className="w-4 h-4" />,
  skipped:    <AlertTriangle className="w-4 h-4" />,
}

const SEVERITY_BADGE: Record<string, string> = {
  critical: 'bg-red-500/20 text-red-400 border border-red-500/30',
  high:     'bg-orange-500/20 text-orange-400 border border-orange-500/30',
  medium:   'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
  low:      'bg-blue-500/20 text-blue-400 border border-blue-500/30',
}

export default function LaunchLockPage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const [overrideReason, setOverrideReason] = useState('')
  const [showOverride, setShowOverride] = useState(false)

  const { data: lock }   = useQuery({ queryKey: ['ll-lock',  workspaceId], queryFn: () => fetchLock(workspaceId),         enabled: !!workspaceId, refetchInterval: 15_000 })
  const { data: audit }  = useQuery({ queryKey: ['ll-audit', workspaceId], queryFn: () => fetchLatestAudit(workspaceId),  enabled: !!workspaceId, refetchInterval: 30_000 })

  const auditMut = useMutation({
    mutationFn: () => runAudit(workspaceId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ll-lock'] })
      qc.invalidateQueries({ queryKey: ['ll-audit'] })
    },
  })

  const overrideMut = useMutation({
    mutationFn: (reason: string) => applyOverride(workspaceId, reason),
    onSuccess: () => {
      setShowOverride(false); setOverrideReason('')
      qc.invalidateQueries({ queryKey: ['ll-lock'] })
    },
  })

  const revokeMut = useMutation({
    mutationFn: () => revokeOverride(workspaceId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ll-lock'] }),
  })

  const checks: CheckResult[] = audit?.checkResults ?? []
  const score = lock?.lastAuditScore ?? audit?.readinessScore ?? 0
  const scoreColor = score >= 90 ? 'text-green-400' : score >= 70 ? 'text-yellow-400' : 'text-red-400'

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="shrink-0 px-6 pt-5 pb-4 border-b border-border">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-primary flex items-center gap-2">
              {lock?.locked
                ? <Lock className="w-4 h-4 text-red-400" />
                : <Unlock className="w-4 h-4 text-green-400" />}
              Launch Lock
            </h1>
            <p className="text-xs text-muted mt-0.5">Production readiness audit · evidence-backed · blocking</p>
          </div>
          <button onClick={() => auditMut.mutate()} disabled={auditMut.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border border-blue-500/30 transition-colors disabled:opacity-50">
            <Zap className="w-3 h-3" />
            {auditMut.isPending ? 'Auditing…' : 'Run Audit'}
          </button>
        </div>

        {/* Big lock state row */}
        <div className="mt-4 flex items-stretch gap-3">
          {/* Lock card */}
          <div className={`flex-1 rounded-lg border p-4 ${lock?.locked ? 'border-red-500/40 bg-red-500/5' : 'border-green-500/40 bg-green-500/5'}`}>
            <div className="flex items-center gap-3">
              {lock?.locked
                ? <Lock className="w-6 h-6 text-red-400" />
                : <Unlock className="w-6 h-6 text-green-400" />}
              <div className="flex-1">
                <p className={`text-base font-semibold ${lock?.locked ? 'text-red-400' : 'text-green-400'}`}>
                  {lock?.locked ? 'LAUNCH LOCKED' : 'LAUNCH UNLOCKED'}
                </p>
                <p className="text-xs text-muted mt-0.5">
                  {lock?.locked
                    ? `${lock.blockingReasons.length} blocker(s) preventing launch`
                    : lock?.overrideActive
                    ? 'Override active — proceed with caution'
                    : 'All critical checks passed'}
                </p>
              </div>
            </div>
          </div>

          {/* Score card */}
          <div className="rounded-lg border border-border bg-[var(--bg-surface)] px-6 py-4">
            <p className="text-xs text-muted">Readiness Score</p>
            <p className={`text-3xl font-semibold mt-0.5 ${scoreColor}`}>{score}</p>
            <p className="text-xs text-muted">/ 100</p>
          </div>

          {/* Counts card */}
          {audit && (
            <div className="rounded-lg border border-border bg-[var(--bg-surface)] px-6 py-4">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <div className="text-green-400">✓ {audit.passedCount} passed</div>
                <div className="text-red-400">✗ {audit.failedCount} failed</div>
                <div className="text-orange-400">? {audit.unverifiedCount} unverified</div>
                <div className="text-gray-400">– {audit.skippedCount} skipped</div>
              </div>
              {audit.criticalBlockers > 0 && (
                <p className="text-xs text-red-400 mt-2 font-medium">
                  <ShieldAlert className="w-3 h-3 inline mr-1" />
                  {audit.criticalBlockers} critical blocker(s)
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="max-w-4xl space-y-4">
          {/* Blocking reasons */}
          {lock?.locked && lock.blockingReasons.length > 0 && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-4">
              <p className="text-sm font-medium text-red-400 mb-2 flex items-center gap-1.5">
                <ShieldAlert className="w-4 h-4" /> Blocking Reasons
              </p>
              <ul className="space-y-1">
                {lock.blockingReasons.map((reason, i) => (
                  <li key={i} className="text-xs text-secondary flex items-start gap-1.5">
                    <span className="text-red-400">•</span>
                    {reason}
                  </li>
                ))}
              </ul>

              {/* Override controls */}
              <div className="mt-4 pt-4 border-t border-red-500/20">
                {!showOverride && !lock.overrideActive && (
                  <button onClick={() => setShowOverride(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 border border-yellow-500/30 transition-colors">
                    <ShieldOff className="w-3 h-3" /> Apply Admin Override
                  </button>
                )}
                {showOverride && (
                  <div className="space-y-2">
                    <p className="text-xs text-secondary">Override reason (required, min 5 chars):</p>
                    <textarea value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)}
                      rows={2} placeholder="Why override the launch lock?"
                      className="w-full text-xs rounded border border-border bg-bg text-primary px-2 py-1.5 resize-none outline-none focus:border-yellow-500/50" />
                    <div className="flex gap-2">
                      <button onClick={() => overrideMut.mutate(overrideReason)}
                        disabled={overrideMut.isPending || overrideReason.trim().length < 5}
                        className="px-3 py-1.5 rounded text-xs bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 border border-yellow-500/30 transition-colors disabled:opacity-50">
                        {overrideMut.isPending ? 'Applying…' : 'Confirm Override (1h)'}
                      </button>
                      <button onClick={() => { setShowOverride(false); setOverrideReason('') }}
                        className="px-3 py-1.5 rounded text-xs text-muted hover:text-secondary transition-colors">
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Active override */}
          {lock?.overrideActive && (
            <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/5 p-4">
              <div className="flex items-start gap-2">
                <ShieldOff className="w-4 h-4 text-yellow-400 mt-0.5 shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-yellow-400">Override Active</p>
                  <p className="text-xs text-secondary mt-1">
                    By <span className="font-mono">{lock.overrideBy}</span> at {lock.overrideAt && new Date(lock.overrideAt).toLocaleString()}
                  </p>
                  {lock.overrideExpiresAt && (
                    <p className="text-xs text-muted mt-0.5">
                      Expires {new Date(lock.overrideExpiresAt).toLocaleString()}
                    </p>
                  )}
                  <p className="text-xs text-secondary mt-1 italic">"{lock.overrideReason}"</p>
                </div>
                <button onClick={() => revokeMut.mutate()} disabled={revokeMut.isPending}
                  className="px-3 py-1.5 rounded text-xs bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30 transition-colors disabled:opacity-50">
                  Revoke
                </button>
              </div>
            </div>
          )}

          {/* Recommended fixes */}
          {audit && audit.recommendedFixes.length > 0 && (
            <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-4">
              <p className="text-sm font-medium text-orange-400 mb-2">Recommended Fixes</p>
              <ul className="space-y-1">
                {audit.recommendedFixes.map((fix, i) => (
                  <li key={i} className="text-xs text-secondary flex items-start gap-1.5">
                    <span className="text-orange-400">→</span>{fix}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Check results */}
          <div>
            <p className="text-sm font-medium text-primary mb-2">Final Launch Checklist</p>
            <div className="space-y-1.5">
              {checks.length === 0 && !audit && (
                <p className="text-sm text-muted">No audit run yet. Click "Run Audit" to evaluate.</p>
              )}
              {checks.map((c) => (
                <div key={c.name} className="rounded-lg border border-border bg-[var(--bg-surface)] px-4 py-2.5 flex items-center gap-3">
                  <span className={STATUS_COLORS[c.status]}>{STATUS_ICONS[c.status]}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-mono text-primary">{c.name}</p>
                      <span className={`px-1.5 py-0.5 rounded text-xs ${SEVERITY_BADGE[c.severity] ?? ''}`}>
                        {c.severity}
                      </span>
                    </div>
                    <p className="text-xs text-muted mt-0.5">{c.reason}</p>
                    {c.evidence.length > 0 && (
                      <p className="text-xs text-muted mt-0.5 font-mono">
                        Evidence: {c.evidence.length} row ID(s) → {c.evidence.slice(0, 2).map((e) => e.slice(0, 8)).join(', ')}
                      </p>
                    )}
                  </div>
                  <span className={`text-xs uppercase font-medium ${STATUS_COLORS[c.status]}`}>{c.status}</span>
                </div>
              ))}
            </div>
          </div>

          {audit && (
            <p className="text-xs text-muted mt-4">
              Last audit: {new Date(audit.createdAt).toLocaleString()} · audit ID <span className="font-mono">{audit.id.slice(0, 8)}</span>
            </p>
          )}

          <div className="mt-2 flex items-center gap-1 text-xs text-muted">
            <RefreshCcw className="w-3 h-3" /> Auto-refreshes every 30s
          </div>
        </div>
      </div>
    </div>
  )
}
