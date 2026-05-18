/**
 * Identity — traits + communication audit drift report + ad-hoc auditor.
 */
import React, { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { Wand2, AlertTriangle, CheckCircle2, Activity } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

interface Profile {
  workspaceId: string
  traits: Record<string, number>
  toneSettings: Record<string, unknown>
  version: number
}
interface Drift {
  total: number; failed: number; failureRate: number
  avgHypeScore: number
  missingUncertainty: number; factEstimateBlur: number
  topSources: Array<{ source: string; failed: number; total: number }>
}
interface AuditResult {
  hypeScore: number
  uncertaintyHandling: string
  factEstimateOk: boolean
  violations: Array<{ kind: string; detail: string }>
  passed: boolean
}

export default function IdentityPage() {
  const { workspaceId } = useWorkspace()
  const [auditText, setAuditText] = useState('')
  const [auditType, setAuditType] = useState<'incident' | 'brief' | 'research' | 'patch' | 'risk' | 'rec' | 'social' | 'support'>('rec')
  const [auditResult, setAuditResult] = useState<AuditResult | null>(null)

  const profile = useQuery({
    queryKey: ['identity', workspaceId],
    queryFn: () => api.get<{ data: { profile: Profile; defaults: Record<string, number> } }>(`/api/v1/identity/profile?workspace_id=${workspaceId}`),
    refetchInterval: 60_000,
  })

  const drift = useQuery({
    queryKey: ['identity-drift', workspaceId],
    queryFn: () => api.get<{ data: Drift }>(`/api/v1/identity/drift?workspace_id=${workspaceId}&hours=24`),
    refetchInterval: 60_000,
  })

  const audit = useMutation({
    mutationFn: () => api.post<{ data: AuditResult }>(`/api/v1/identity/audit`, { text: auditText, output_type: auditType }),
    onSuccess: (r) => setAuditResult((r as { data: AuditResult }).data),
  })

  const p = profile.data?.data
  const d = drift.data?.data
  return (
    <div className="p-6 space-y-4 max-w-5xl mx-auto">
      <div className="flex items-center gap-3">
        <Wand2 className="w-5 h-5 text-purple-400" />
        <h1 className="text-xl font-semibold">Identity & Communication</h1>
        <span className="text-xs text-muted ml-1">calm · elite · tactical · trustworthy · confidence-aware</span>
      </div>

      {/* Traits */}
      {p && (
        <Section title={`Active traits (v${p.profile?.version ?? 1})`} icon={<Activity className="w-4 h-4 text-sky-400" />}>
          <div className="p-4 grid grid-cols-2 md:grid-cols-5 gap-3">
            {Object.entries(p.profile?.traits ?? p.defaults).map(([k, v]) => (
              <div key={k} className="rounded border border-border bg-[var(--bg)] px-2 py-1.5">
                <div className="text-[10px] uppercase tracking-wider text-muted">{k.replace(/_/g, ' ')}</div>
                <div className="font-mono text-sm mt-0.5">{(Number(v) * 100).toFixed(0)}%</div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Drift report */}
      {d && (
        <Section title="Communication drift (24h)" icon={<AlertTriangle className="w-4 h-4 text-amber-400" />}>
          <div className="p-4 grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
            <Stat label="Total audited" v={String(d.total)} />
            <Stat label="Failed" v={String(d.failed)} color={d.failed > 0 ? 'amber' : 'emerald'} />
            <Stat label="Failure rate" v={`${(d.failureRate * 100).toFixed(0)}%`} color={d.failureRate > 0.2 ? 'amber' : 'emerald'} />
            <Stat label="Avg hype" v={d.avgHypeScore.toFixed(2)} color={d.avgHypeScore > 0.3 ? 'amber' : 'emerald'} />
            <Stat label="Missing uncertainty" v={String(d.missingUncertainty)} color={d.missingUncertainty > 0 ? 'amber' : 'emerald'} />
          </div>
          {d.topSources.length > 0 && (
            <div className="px-5 pb-3 text-xs">
              <div className="text-[10px] uppercase tracking-wider text-muted mb-1">Top offending sources</div>
              <ul className="space-y-0.5">
                {d.topSources.map(s => (
                  <li key={s.source} className="flex gap-3">
                    <span className="font-mono">{s.source}</span>
                    <span className="text-muted">{s.failed}/{s.total} failed</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Section>
      )}

      {/* Ad-hoc auditor */}
      <Section title="Audit text now" icon={<Wand2 className="w-4 h-4 text-purple-400" />}>
        <div className="p-4 space-y-2">
          <div className="flex gap-2">
            <select value={auditType} onChange={(e) => setAuditType(e.target.value as typeof auditType)}
              className="bg-[var(--bg)] border border-border rounded px-2 py-1 text-sm">
              {['incident', 'brief', 'research', 'patch', 'risk', 'rec', 'social', 'support'].map(t => <option key={t}>{t}</option>)}
            </select>
            <button onClick={() => audit.mutate()} disabled={!auditText || audit.isPending}
              className="px-3 py-1 text-xs rounded border border-border hover:bg-[var(--surface-hover)]">
              {audit.isPending ? 'Auditing…' : 'Audit'}
            </button>
          </div>
          <textarea value={auditText} onChange={(e) => setAuditText(e.target.value)}
            placeholder="paste text to audit for hype, fake certainty, missing uncertainty, fact/estimate blur…"
            className="w-full bg-[var(--bg)] border border-border rounded p-2 text-sm font-mono" rows={4} />
          {auditResult && (
            <div className="text-xs space-y-1">
              <div className="flex items-center gap-2">
                {auditResult.passed
                  ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  : <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />}
                <span className="font-medium">{auditResult.passed ? 'PASSED' : 'FAILED'}</span>
                <span className="text-muted">hype {auditResult.hypeScore.toFixed(2)}</span>
                <span className="text-muted">uncertainty {auditResult.uncertaintyHandling}</span>
                <span className="text-muted">fact/estimate {auditResult.factEstimateOk ? 'ok' : 'blurred'}</span>
              </div>
              {auditResult.violations.length > 0 && (
                <ul className="text-amber-300 ml-5 space-y-0.5">
                  {auditResult.violations.map((v, i) => <li key={i}>• {v.kind}: {v.detail}</li>)}
                </ul>
              )}
            </div>
          )}
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

function Stat({ label, v, color }: { label: string; v: string; color?: 'emerald' | 'amber' }) {
  const c = color === 'amber' ? 'text-amber-300' : color === 'emerald' ? 'text-emerald-300' : ''
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`font-mono mt-0.5 ${c}`}>{v}</div>
    </div>
  )
}
