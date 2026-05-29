/**
 * BusinessDetailPage — `/businesses/:id`
 *
 * Single-business operator view. Shows every item linked to this business
 * in organized, editable sections:
 *   - Business header (name, stage, health, domain, industry, depts) — editable
 *   - Systems (goals, workflows, agent slots) — name/status/summary editable
 *   - Opportunities, Risks, Goals — list with details
 *   - Recent CEO delegations scoped to this business
 *   - Recent events scoped to this business
 *
 * Backed by the new `/api/v1/businesses/:id/full` aggregate endpoint.
 */
import { useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useWorkspace } from '../contexts/WorkspaceContext.js'
import { api } from '../api.js'
import { PageState } from '../components/PageState.js'
import {
  Building2, ArrowLeft, Save, Edit3, X, Layers, Target, AlertTriangle,
  Sparkles, Activity, CheckCircle2, Loader2,
} from 'lucide-react'

interface FullPayload {
  business: {
    id: string; name: string; domain: string | null; industry: string | null
    stage: string; health: string
    metadata: { responsibleDepartments?: string[] } & Record<string, unknown>
    metrics: Record<string, unknown>
    brief: string | null; vision: string | null
    dna: Record<string, unknown>
  }
  systems:       Array<{ id: string; kind: string; layer: string; name: string; summary: string | null; status: string; agentSlug: string | null }>
  opportunities: Array<{ id: string; title?: string; description?: string; impact?: number; createdAt: number }>
  risks:         Array<{ id: string; title?: string; description?: string; severity?: string; createdAt: number }>
  goals:         Array<{ id: string; title?: string; horizon?: string; status?: string; targetDate?: number | null }>
  delegations:   Array<{ id: string; department: string; task: string; status: string; createdAt: number }>
  events:        Array<{ id: string; type: string; payload: unknown; createdAt: number }>
  counts:        { systems: number; opportunities: number; risks: number; goals: number; delegations: number; events: number }
}

const STAGE_BADGE: Record<string, string> = {
  early:  'bg-slate-500/15 text-slate-300 border-slate-500/30',
  growth: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  scale:  'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
}
const HEALTH_BADGE: Record<string, string> = {
  green:  'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  yellow: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  red:    'bg-rose-500/15 text-rose-300 border-rose-500/30',
}

export default function BusinessDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { workspaceId } = useWorkspace()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [editingHeader, setEditingHeader] = useState(false)

  const full = useQuery({
    queryKey: ['business-full', workspaceId, id],
    queryFn:  () => api.get<{ data: FullPayload }>(`/api/v1/businesses/${id}/full?workspace_id=${workspaceId}`),
    enabled:  !!id,
    refetchInterval: 30_000,
  })

  if (full.isPending) return <PageState kind="loading" label="Loading business…" />
  if (full.isError)   return <PageState kind="error" error={full.error} onRetry={() => full.refetch()} />
  if (!full.data)     return <PageState kind="empty" label="Business not found" />

  const d = full.data.data
  const b = d.business

  return (
    <div className="min-h-screen bg-bg text-primary p-6 max-w-7xl mx-auto">
      <button onClick={() => navigate('/businesses')} className="flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] mb-3">
        <ArrowLeft className="w-3 h-3" /> All businesses
      </button>

      <BusinessHeader business={b} editing={editingHeader} setEditing={setEditingHeader}
        onSaved={() => qc.invalidateQueries({ queryKey: ['business-full', workspaceId, id] })}
        workspaceId={workspaceId} />

      {/* Section grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-4">

        {/* Systems */}
        <Section title="Systems" icon={<Layers className="w-4 h-4" />} count={d.counts.systems}>
          {d.systems.length === 0 ? <Empty label="No systems yet" /> : (
            <ul className="space-y-1.5">
              {d.systems.map(s => (
                <SystemRow key={s.id} system={s} businessId={b.id} workspaceId={workspaceId}
                  onSaved={() => qc.invalidateQueries({ queryKey: ['business-full', workspaceId, id] })} />
              ))}
            </ul>
          )}
        </Section>

        {/* Goals */}
        <Section title="Strategic goals" icon={<Target className="w-4 h-4" />} count={d.counts.goals}>
          {d.goals.length === 0 ? <Empty label="No goals defined" /> : (
            <ul className="space-y-1 text-xs">
              {d.goals.map(g => (
                <li key={g.id} className="px-2 py-1.5 rounded border border-[var(--border)]">
                  <div className="flex items-center gap-2">
                    <span className="font-medium flex-1 truncate">{g.title ?? '(untitled)'}</span>
                    {g.horizon && <span className="text-[10px] px-1 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-muted)]">{g.horizon}</span>}
                    {g.status && <span className="text-[10px] text-[var(--text-muted)]">{g.status}</span>}
                  </div>
                  {g.targetDate && <div className="text-[10px] text-[var(--text-faint)] mt-0.5">target {new Date(g.targetDate).toLocaleDateString()}</div>}
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Opportunities */}
        <Section title="Opportunities" icon={<Sparkles className="w-4 h-4" />} count={d.counts.opportunities}>
          {d.opportunities.length === 0 ? <Empty label="No opportunities tracked" /> : (
            <ul className="space-y-1 text-xs">
              {d.opportunities.slice(0, 10).map(o => (
                <li key={o.id} className="px-2 py-1.5 rounded border border-[var(--border)]">
                  <div className="flex items-center gap-2">
                    <span className="font-medium flex-1 truncate">{o.title ?? '(untitled)'}</span>
                    {o.impact != null && <span className="text-[10px] text-[var(--success)]">impact {o.impact}</span>}
                  </div>
                  {o.description && <div className="text-[10px] text-[var(--text-muted)] mt-0.5 line-clamp-2">{o.description}</div>}
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Risks */}
        <Section title="Risks" icon={<AlertTriangle className="w-4 h-4" />} count={d.counts.risks}>
          {d.risks.length === 0 ? <Empty label="No risks tracked" /> : (
            <ul className="space-y-1 text-xs">
              {d.risks.slice(0, 10).map(r => (
                <li key={r.id} className="px-2 py-1.5 rounded border border-[var(--border)]">
                  <div className="flex items-center gap-2">
                    <span className="font-medium flex-1 truncate">{r.title ?? '(untitled)'}</span>
                    {r.severity && <span className="text-[10px] text-[var(--error)]">{r.severity}</span>}
                  </div>
                  {r.description && <div className="text-[10px] text-[var(--text-muted)] mt-0.5 line-clamp-2">{r.description}</div>}
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* CEO delegations scoped to this business (last 7d) */}
        <Section title="CEO delegations (7d)" icon={<Sparkles className="w-4 h-4" />} count={d.counts.delegations}>
          {d.delegations.length === 0 ? <Empty label="CEO has not delegated work to this business in the last 7d" /> : (
            <ul className="space-y-1 text-xs">
              {d.delegations.slice(0, 8).map(dl => (
                <li key={dl.id} className="px-2 py-1.5 rounded border border-[var(--border)]">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] px-1 py-0.5 rounded bg-[var(--bg-elevated)] font-mono">{dl.department}</span>
                    <span className={`text-[10px] ${dl.status === 'succeeded' ? 'text-[var(--success)]' : dl.status === 'failed' ? 'text-[var(--error)]' : 'text-[var(--text-muted)]'}`}>{dl.status}</span>
                    <span className="text-[10px] text-[var(--text-faint)] ml-auto">{new Date(dl.createdAt).toLocaleString()}</span>
                  </div>
                  <div className="text-[var(--text-muted)] mt-1 line-clamp-2">{dl.task}</div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Events scoped to this business (last 24h) */}
        <Section title="Recent events (24h)" icon={<Activity className="w-4 h-4" />} count={d.counts.events}>
          {d.events.length === 0 ? <Empty label="No business-scoped events in 24h" /> : (
            <ul className="space-y-0.5 text-[11px] max-h-[300px] overflow-y-auto">
              {d.events.slice(0, 30).map(e => (
                <li key={e.id} className="px-2 py-1 flex items-center gap-2 hover:bg-[var(--surface-hover)] rounded">
                  <span className="font-mono text-[10px] text-[var(--text-muted)]">{e.type}</span>
                  <span className="text-[var(--text-faint)] text-[10px] ml-auto">{new Date(e.createdAt).toLocaleTimeString()}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <div className="mt-6 flex items-center gap-2 text-[10px] text-[var(--text-muted)]">
        <Link to="/agency" className="hover:text-[var(--text-primary)]">→ See all departments</Link>
        <span>·</span>
        <Link to="/businesses" className="hover:text-[var(--text-primary)]">→ All businesses</Link>
      </div>
    </div>
  )
}

// ─── Header ────────────────────────────────────────────────────────────
function BusinessHeader({ business, editing, setEditing, onSaved, workspaceId }: {
  business: FullPayload['business']; editing: boolean; setEditing: (v: boolean) => void; onSaved: () => void; workspaceId: string
}) {
  const [name, setName] = useState(business.name)
  const [domain, setDomain] = useState(business.domain ?? '')
  const [industry, setIndustry] = useState(business.industry ?? '')
  const [stage, setStage] = useState(business.stage)
  const [depts, setDepts] = useState((business.metadata?.responsibleDepartments ?? []).join(', '))

  const save = useMutation({
    mutationFn: async () => {
      return api.put(`/api/v1/businesses/${business.id}?workspace_id=${workspaceId}`, {
        name,
        domain:   domain || null,
        industry: industry || null,
        stage,
        metadata: {
          ...business.metadata,
          responsibleDepartments: depts.split(',').map(s => s.trim()).filter(Boolean),
        },
      })
    },
    onSuccess: () => { setEditing(false); onSaved() },
  })

  if (!editing) {
    return (
      <div className="panel p-4">
        <div className="flex items-start gap-3">
          <Building2 className="w-6 h-6 text-[var(--accent)] mt-1" />
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold">{business.name}</h1>
              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STAGE_BADGE[business.stage] ?? STAGE_BADGE.early}`}>{business.stage}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${HEALTH_BADGE[business.health] ?? HEALTH_BADGE.green}`}>{business.health}</span>
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-1">
              {business.domain && <span className="font-mono">{business.domain}</span>}
              {business.industry && <span> · {business.industry}</span>}
            </div>
            {business.metadata?.responsibleDepartments && business.metadata.responsibleDepartments.length > 0 && (
              <div className="text-[10px] text-[var(--text-muted)] mt-1.5 font-mono">
                depts: {business.metadata.responsibleDepartments.join(' · ')}
              </div>
            )}
            {business.brief && <p className="text-xs text-[var(--text-secondary)] mt-2">{business.brief}</p>}
          </div>
          <button onClick={() => setEditing(true)} className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center gap-1">
            <Edit3 className="w-3 h-3" /> Edit
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="panel p-4 space-y-2">
      <div className="grid grid-cols-2 gap-2 text-xs">
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} className="w-full mt-0.5 px-2 py-1 bg-[var(--bg-elevated)] border border-[var(--border)] rounded" /></label>
        <label>Domain<input value={domain} onChange={(e) => setDomain(e.target.value)} className="w-full mt-0.5 px-2 py-1 bg-[var(--bg-elevated)] border border-[var(--border)] rounded" /></label>
        <label>Industry<input value={industry} onChange={(e) => setIndustry(e.target.value)} className="w-full mt-0.5 px-2 py-1 bg-[var(--bg-elevated)] border border-[var(--border)] rounded" /></label>
        <label>Stage<select value={stage} onChange={(e) => setStage(e.target.value)} className="w-full mt-0.5 px-2 py-1 bg-[var(--bg-elevated)] border border-[var(--border)] rounded">
          <option value="early">early</option><option value="growth">growth</option><option value="scale">scale</option>
        </select></label>
        <label className="col-span-2">Responsible departments (comma-separated)<input value={depts} onChange={(e) => setDepts(e.target.value)} placeholder="engineering, marketing, operations…" className="w-full mt-0.5 px-2 py-1 bg-[var(--bg-elevated)] border border-[var(--border)] rounded font-mono" /></label>
      </div>
      <div className="flex items-center gap-2 text-xs">
        <button onClick={() => save.mutate()} disabled={save.isPending} className="px-3 py-1 rounded bg-[var(--accent)] text-white flex items-center gap-1 disabled:opacity-40">
          {save.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Save
        </button>
        <button onClick={() => setEditing(false)} className="px-3 py-1 rounded border border-[var(--border)] text-[var(--text-muted)] flex items-center gap-1">
          <X className="w-3 h-3" /> Cancel
        </button>
      </div>
    </div>
  )
}

// ─── System row (editable inline) ──────────────────────────────────────
function SystemRow({ system, businessId, workspaceId, onSaved }: {
  system: { id: string; kind: string; layer: string; name: string; summary: string | null; status: string }
  businessId: string; workspaceId: string; onSaved: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(system.name)
  const [summary, setSummary] = useState(system.summary ?? '')
  const [status, setStatus] = useState(system.status)

  const save = useMutation({
    mutationFn: async () => api.patch(`/api/v1/businesses/${businessId}/systems/${system.id}?workspace_id=${workspaceId}`, { name, summary, status }),
    onSuccess: () => { setEditing(false); onSaved() },
  })

  if (editing) {
    return (
      <li className="border border-[var(--accent)] rounded p-2 space-y-1 text-xs bg-[var(--surface-elev)]">
        <div className="flex gap-1">
          <input value={name} onChange={(e) => setName(e.target.value)} className="flex-1 px-2 py-1 bg-[var(--bg-elevated)] border border-[var(--border)] rounded" />
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="px-2 py-1 bg-[var(--bg-elevated)] border border-[var(--border)] rounded">
            <option value="forming">forming</option>
            <option value="active">active</option>
            <option value="paused">paused</option>
            <option value="archived">archived</option>
          </select>
        </div>
        <input value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Summary…" className="w-full px-2 py-1 bg-[var(--bg-elevated)] border border-[var(--border)] rounded" />
        <div className="flex gap-1">
          <button onClick={() => save.mutate()} disabled={save.isPending} className="px-2 py-0.5 rounded bg-[var(--accent)] text-white flex items-center gap-1 disabled:opacity-40">
            {save.isPending ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <CheckCircle2 className="w-2.5 h-2.5" />} Save
          </button>
          <button onClick={() => setEditing(false)} className="px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-muted)]">Cancel</button>
        </div>
      </li>
    )
  }

  return (
    <li className="border border-[var(--border)] rounded p-2 flex items-start gap-2 text-xs group">
      <span className="text-[9px] uppercase tracking-wider px-1 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-muted)] mt-0.5 font-mono flex-shrink-0">{system.kind}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{system.name}</span>
          <span className="text-[10px] text-[var(--text-muted)]">{system.layer}</span>
          <span className="text-[10px] text-[var(--text-muted)]">·</span>
          <span className="text-[10px] text-[var(--text-muted)]">{system.status}</span>
        </div>
        {system.summary && <div className="text-[10px] text-[var(--text-muted)] mt-0.5">{system.summary}</div>}
      </div>
      <button onClick={() => setEditing(true)} className="opacity-0 group-hover:opacity-100 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-opacity">
        <Edit3 className="w-3 h-3" />
      </button>
    </li>
  )
}

// ─── Section wrapper + empty ──────────────────────────────────────────
function Section({ title, icon, count, children }: { title: string; icon: React.ReactNode; count: number; children: React.ReactNode }) {
  return (
    <section className="panel p-3">
      <div className="flex items-center gap-2 mb-2 text-xs font-medium text-[var(--text-secondary)]">
        {icon}
        <span>{title}</span>
        <span className="text-[10px] text-[var(--text-muted)]">{count}</span>
      </div>
      {children}
    </section>
  )
}
function Empty({ label }: { label: string }) {
  return <div className="text-[10px] text-[var(--text-muted)] italic py-2 px-1">{label}</div>
}
