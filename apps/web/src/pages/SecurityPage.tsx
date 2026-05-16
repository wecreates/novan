/**
 * SecurityPage — War Room enterprise security console.
 *
 * Shows:
 * - Security audit log (auth failures, permission denials, secret access)
 * - Secret vault (REDACTED — no plaintext shown)
 * - Suspicious activity detection
 * - Compliance: audit integrity + exports
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Shield, KeyRound, AlertOctagon, FileSearch,
  CheckCircle2, XCircle, AlertTriangle, RefreshCcw, Lock,
  Eye, Download, RotateCcw,
} from 'lucide-react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

const API = (p: string) => `/api/v1/security${p}`

async function fetchAudits(ws: string, severity?: string)         { const q = new URLSearchParams({ workspace_id: ws }); if (severity) q.set('severity', severity); return (await (await fetch(`${API('/audits')}?${q}`)).json()).data as Audit[] }
async function fetchStats(ws: string)                              { return (await (await fetch(`${API('/audits/stats')}?workspace_id=${ws}`)).json()).data as Stats }
async function fetchSecrets(ws: string)                            { return (await (await fetch(`${API('/secrets')}?workspace_id=${ws}`)).json()).data as Secret[] }
async function fetchExports(ws: string)                            { return (await (await fetch(`${API('/audits/exports')}?workspace_id=${ws}`)).json()).data as Exp[] }
async function fetchIntegrity(ws: string)                          { return (await (await fetch(`${API('/audits/integrity')}?workspace_id=${ws}`)).json()).data as Integrity }
async function postScan(ws: string)                                { return (await (await fetch(API('/audits/scan'),  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace_id: ws }) })).json()).data }
async function postExport(ws: string, requestedBy: string)         { return (await (await fetch(API('/audits/export'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace_id: ws, requested_by: requestedBy, from_ts: Date.now() - 30 * 24 * 3600_000, to_ts: Date.now() }) })).json()).data }
async function reveal(id: string, requestedBy: string, reason: string) { const r = await fetch(API(`/secrets/${id}/reveal`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requested_by: requestedBy, reason }) }); if (!r.ok) throw new Error((await r.json()).error); return (await r.json()).data as { value: string } }
async function rotate(id: string, newValue: string, rotatedBy: string) { const r = await fetch(API(`/secrets/${id}/rotate`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ new_value: newValue, rotated_by: rotatedBy }) }); if (!r.ok) throw new Error((await r.json()).error); return r.json() }

interface Audit {
  id: string; eventType: string; severity: 'info' | 'warning' | 'critical'
  resource: string | null; action: string | null; outcome: string
  userId: string | null; context: Record<string, unknown>; createdAt: number
}

interface Stats {
  total7d: number; critical7d: number; deniedActions7d: number
  authFailures7d: number; permissionDenied7d: number; secretAccess7d: number
  suspiciousEvents7d: number; unsafePatchBlocked7d: number
}

interface Secret {
  id: string; name: string; provider: string | null
  valueRedacted: string; keyVersion: number
  rotatedAt: number | null; lastAccessedAt: number | null
  accessCount: number; createdAt: number
}

interface Exp {
  id: string; format: string; status: string
  recordCount: number; fromTs: number; toTs: number
  downloadRef: string | null; createdAt: number
}

interface Integrity { total: number; immutable: number; mutable: number }

const SEVERITY_COLORS: Record<string, string> = {
  info:     'bg-blue-500/20 text-blue-400 border border-blue-500/30',
  warning:  'bg-orange-500/20 text-orange-400 border border-orange-500/30',
  critical: 'bg-red-500/20 text-red-400 border border-red-500/30',
}

const OUTCOME_COLORS: Record<string, string> = {
  allowed:  'text-green-400',
  denied:   'text-red-400',
  recorded: 'text-[var(--text-muted)]',
}

function StatCard({ label, value, color, icon }: { label: string; value: number; color?: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-4 py-3">
      <div className="flex items-center gap-1.5">
        {icon}
        <p className="text-xs text-[var(--text-muted)]">{label}</p>
      </div>
      <p className={`text-2xl font-semibold mt-1 ${color ?? 'text-[var(--text-primary)]'}`}>{value}</p>
    </div>
  )
}

function SecretRow({ s }: { s: Secret }) {
  const [revealed, setRevealed] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [showReveal, setShowReveal] = useState(false)
  const [rotateValue, setRotateValue] = useState('')
  const [showRotate, setShowRotate] = useState(false)

  const revealMut = useMutation({
    mutationFn: () => reveal(s.id, 'ops-admin', reason),
    onSuccess:  (d) => { setRevealed(d.value); setShowReveal(false); setReason('') },
  })
  const rotateMut = useMutation({
    mutationFn: () => rotate(s.id, rotateValue, 'ops-admin'),
    onSuccess: () => { setShowRotate(false); setRotateValue('') },
  })

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-4 py-3">
      <div className="flex items-center gap-3">
        <KeyRound className="w-4 h-4 text-yellow-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-[var(--text-primary)]">{s.name}</p>
            {s.provider && <span className="text-xs text-[var(--text-muted)]">· {s.provider}</span>}
            <span className="text-xs text-[var(--text-muted)]">· v{s.keyVersion}</span>
          </div>
          <p className="text-xs font-mono text-[var(--text-secondary)] mt-0.5">{revealed ?? s.valueRedacted}</p>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            {s.accessCount} access(es){s.lastAccessedAt ? ` · last ${new Date(s.lastAccessedAt).toLocaleString()}` : ''}
            {s.rotatedAt ? ` · rotated ${new Date(s.rotatedAt).toLocaleDateString()}` : ' · never rotated'}
          </p>
        </div>
        <div className="flex gap-1 shrink-0">
          <button onClick={() => setShowReveal((p) => !p)} title="Reveal (audited)"
            className="px-2 py-1 rounded text-xs text-[var(--text-muted)] hover:text-yellow-400 hover:bg-yellow-500/10 transition-colors">
            <Eye className="w-3 h-3" />
          </button>
          <button onClick={() => setShowRotate((p) => !p)} title="Rotate"
            className="px-2 py-1 rounded text-xs text-[var(--text-muted)] hover:text-blue-400 hover:bg-blue-500/10 transition-colors">
            <RotateCcw className="w-3 h-3" />
          </button>
        </div>
      </div>

      {showReveal && (
        <div className="mt-3 pt-3 border-t border-[var(--border)] space-y-2">
          <p className="text-xs text-yellow-400">Reveal will be audited. Provide reason (≥5 chars):</p>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why reveal this secret?"
            className="w-full text-xs rounded border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] px-2 py-1.5 outline-none focus:border-yellow-500/50" />
          <div className="flex gap-2">
            <button onClick={() => revealMut.mutate()} disabled={reason.trim().length < 5 || revealMut.isPending}
              className="px-3 py-1.5 rounded text-xs bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 border border-yellow-500/30 disabled:opacity-50">
              Confirm Reveal
            </button>
            <button onClick={() => { setShowReveal(false); setReason('') }}
              className="px-3 py-1.5 rounded text-xs text-[var(--text-muted)]">Cancel</button>
          </div>
          {revealMut.error && <p className="text-xs text-red-400">{(revealMut.error as Error).message}</p>}
        </div>
      )}

      {showRotate && (
        <div className="mt-3 pt-3 border-t border-[var(--border)] space-y-2">
          <p className="text-xs text-blue-400">Rotate: enter new secret value</p>
          <input value={rotateValue} onChange={(e) => setRotateValue(e.target.value)} type="password" placeholder="New value"
            className="w-full text-xs rounded border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] px-2 py-1.5 outline-none focus:border-blue-500/50" />
          <div className="flex gap-2">
            <button onClick={() => rotateMut.mutate()} disabled={rotateValue.length === 0 || rotateMut.isPending}
              className="px-3 py-1.5 rounded text-xs bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border border-blue-500/30 disabled:opacity-50">
              Rotate
            </button>
            <button onClick={() => { setShowRotate(false); setRotateValue('') }}
              className="px-3 py-1.5 rounded text-xs text-[var(--text-muted)]">Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function SecurityPage() {
  const { workspaceId } = useWorkspace()
  const [tab, setTab] = useState<'audits' | 'secrets' | 'compliance'>('audits')
  const [filter, setFilter] = useState<string | undefined>(undefined)
  const qc = useQueryClient()

  const { data: stats }       = useQuery({ queryKey: ['sec-stats',  workspaceId], queryFn: () => fetchStats(workspaceId), enabled: !!workspaceId, refetchInterval: 30_000 })
  const { data: audits = [] } = useQuery({ queryKey: ['sec-audits', workspaceId, filter], queryFn: () => fetchAudits(workspaceId, filter), enabled: !!workspaceId && tab === 'audits', refetchInterval: 30_000 })
  const { data: secrets = [] } = useQuery({ queryKey: ['sec-secrets', workspaceId], queryFn: () => fetchSecrets(workspaceId), enabled: !!workspaceId && tab === 'secrets', refetchInterval: 30_000 })
  const { data: exps = [] }   = useQuery({ queryKey: ['sec-exports', workspaceId], queryFn: () => fetchExports(workspaceId), enabled: !!workspaceId && tab === 'compliance' })
  const { data: integrity }   = useQuery({ queryKey: ['sec-int',    workspaceId], queryFn: () => fetchIntegrity(workspaceId), enabled: !!workspaceId && tab === 'compliance' })

  const scanMut = useMutation({ mutationFn: () => postScan(workspaceId),     onSuccess: () => qc.invalidateQueries({ queryKey: ['sec-stats'] }) })
  const expMut  = useMutation({ mutationFn: () => postExport(workspaceId, 'ops-admin'), onSuccess: () => qc.invalidateQueries({ queryKey: ['sec-exports'] }) })

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="shrink-0 px-6 pt-5 pb-4 border-b border-[var(--border)]">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-[var(--text-primary)] flex items-center gap-2">
              <Shield className="w-4 h-4 text-purple-400" /> Enterprise Security
            </h1>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Encrypted secrets · RBAC audit · immutable compliance log
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => scanMut.mutate()} disabled={scanMut.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 border border-purple-500/30 disabled:opacity-50">
              <FileSearch className="w-3 h-3" /> {scanMut.isPending ? 'Scanning…' : 'Scan Abuse'}
            </button>
            <button onClick={() => qc.invalidateQueries({ queryKey: ['sec-stats'] })} className="text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
              <RefreshCcw className="w-4 h-4" />
            </button>
          </div>
        </div>

        {stats && (
          <div className="grid grid-cols-8 gap-2 mt-4">
            <StatCard label="Events 7d"     value={stats.total7d} />
            <StatCard label="Critical"      value={stats.critical7d}        color="text-red-400"    icon={<AlertOctagon className="w-3 h-3 text-red-400" />} />
            <StatCard label="Denied"        value={stats.deniedActions7d}   color="text-orange-400" icon={<XCircle className="w-3 h-3 text-orange-400" />} />
            <StatCard label="Auth fails"    value={stats.authFailures7d}    color="text-orange-400" />
            <StatCard label="Perm denied"   value={stats.permissionDenied7d} color="text-orange-400" />
            <StatCard label="Secret access" value={stats.secretAccess7d}    color="text-yellow-400" icon={<KeyRound className="w-3 h-3 text-yellow-400" />} />
            <StatCard label="Suspicious"    value={stats.suspiciousEvents7d} color="text-red-400"   icon={<AlertTriangle className="w-3 h-3 text-red-400" />} />
            <StatCard label="Patches blocked" value={stats.unsafePatchBlocked7d} color="text-red-400" icon={<Lock className="w-3 h-3 text-red-400" />} />
          </div>
        )}

        <div className="flex gap-1 mt-3">
          {[
            { v: 'audits',     l: 'Audit Log',  i: <Shield className="w-3 h-3" /> },
            { v: 'secrets',    l: 'Secret Vault', i: <KeyRound className="w-3 h-3" /> },
            { v: 'compliance', l: 'Compliance', i: <FileSearch className="w-3 h-3" /> },
          ].map((t) => (
            <button key={t.v} onClick={() => setTab(t.v as typeof tab)}
              className={`px-3 py-1 rounded text-xs flex items-center gap-1.5 transition-colors ${
                tab === t.v
                  ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)]'
              }`}>{t.i}{t.l}</button>
          ))}
          {tab === 'audits' && (
            <div className="ml-auto flex gap-1">
              {[undefined, 'info', 'warning', 'critical'].map((s) => (
                <button key={s ?? 'all'} onClick={() => setFilter(s)}
                  className={`px-2 py-1 rounded text-xs ${filter === s ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'}`}>
                  {s ?? 'all'}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {tab === 'audits' && (
          <div className="space-y-1.5 max-w-5xl">
            {audits.length === 0 && <p className="text-sm text-[var(--text-muted)]">No security events recorded.</p>}
            {audits.map((a) => (
              <div key={a.id} className="rounded border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2 flex items-center gap-3">
                <span className={`px-1.5 py-0.5 rounded text-xs ${SEVERITY_COLORS[a.severity] ?? ''}`}>{a.severity}</span>
                <span className={`text-xs font-medium ${OUTCOME_COLORS[a.outcome] ?? ''}`}>{a.outcome}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-[var(--text-primary)]">{a.eventType.replace(/_/g, ' ')}{a.action && ` · ${a.action}`}</p>
                  {a.resource && <p className="text-xs font-mono text-[var(--text-muted)] truncate">{a.resource}</p>}
                </div>
                {a.userId && <span className="text-xs font-mono text-[var(--text-muted)]">{a.userId.slice(0, 12)}</span>}
                <span className="text-xs text-[var(--text-muted)]">{new Date(a.createdAt).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        )}

        {tab === 'secrets' && (
          <div className="space-y-2 max-w-4xl">
            {secrets.length === 0 && (
              <div className="text-center py-12 text-[var(--text-muted)]">
                <KeyRound className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-sm">No secrets stored</p>
                <p className="text-xs mt-1 opacity-60">POST to /api/v1/security/secrets to add an encrypted secret.</p>
              </div>
            )}
            {secrets.map((s) => <SecretRow key={s.id} s={s} />)}
          </div>
        )}

        {tab === 'compliance' && (
          <div className="max-w-4xl space-y-4">
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-4">
              <p className="text-sm font-medium text-[var(--text-primary)] mb-2 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-green-400" /> Audit Log Integrity
              </p>
              {integrity ? (
                <div className="grid grid-cols-3 gap-3 text-xs">
                  <div><span className="text-[var(--text-muted)]">Total:</span> <span className="font-mono ml-2">{integrity.total}</span></div>
                  <div><span className="text-[var(--text-muted)]">Immutable:</span> <span className="font-mono ml-2 text-green-400">{integrity.immutable}</span></div>
                  <div><span className="text-[var(--text-muted)]">Mutable:</span> <span className={`font-mono ml-2 ${integrity.mutable > 0 ? 'text-red-400' : 'text-green-400'}`}>{integrity.mutable}</span></div>
                </div>
              ) : <p className="text-xs text-[var(--text-muted)]">Loading…</p>}
              <p className="text-xs text-[var(--text-muted)] italic mt-2">
                Critical audit events are written with `immutable=true` and never updated by service code.
              </p>
            </div>

            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-medium text-[var(--text-primary)] flex items-center gap-2">
                  <Download className="w-4 h-4" /> Audit Exports
                </p>
                <button onClick={() => expMut.mutate()} disabled={expMut.isPending}
                  className="px-3 py-1.5 rounded text-xs bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border border-blue-500/30 disabled:opacity-50">
                  {expMut.isPending ? 'Exporting…' : 'Export Last 30 Days'}
                </button>
              </div>
              {exps.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)]">No exports yet.</p>
              ) : (
                <div className="space-y-1">
                  {exps.map((e) => (
                    <div key={e.id} className="flex items-center gap-3 text-xs border-t border-[var(--border)] py-2 first:border-t-0 first:pt-0">
                      <span className={`px-1.5 py-0.5 rounded ${e.status === 'complete' ? 'bg-green-500/20 text-green-400' : e.status === 'failed' ? 'bg-red-500/20 text-red-400' : 'bg-yellow-500/20 text-yellow-400'}`}>
                        {e.status}
                      </span>
                      <span className="font-mono text-[var(--text-secondary)]">{e.recordCount} records · {e.format}</span>
                      <span className="text-[var(--text-muted)]">{new Date(e.fromTs).toLocaleDateString()} → {new Date(e.toTs).toLocaleDateString()}</span>
                      {e.downloadRef && <span className="font-mono text-[var(--text-muted)] ml-auto">{e.downloadRef}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
