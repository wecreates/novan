/**
 * ConnectorsPage — operator control surface for the connector foundation.
 *
 * Four tabs:
 *   - Library          : registered connector kinds (github, slack, …)
 *   - Accounts         : workspace's linked accounts
 *   - Approvals        : pending action queue with approve / reject
 *   - Activity         : recent connector_actions audit log
 *
 * Plus a persistent emergency-controls bar showing the kill-switch
 * state with one-click "pause all" / "resume all".
 *
 * All actions wire to /api/v1/connectors/* — no client-side state lives
 * outside the existing query cache.
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Plug, ShieldAlert, Activity, ListChecks, Pause, Play,
  CheckCircle2, XCircle, AlertTriangle, RefreshCw, Loader2,
} from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'
import { PageHeader } from '../components/PageHeader.js'

// ── Types ──────────────────────────────────────────────────────────────

interface Connector {
  id: string; name: string; category: string; description: string
  authType: string; supportedActions: string[]; blockedActions: string[]
  riskLevel: string; implemented: boolean
  officialWebsiteUrl: string | null
  signupUrl: string | null
  loginUrl: string | null
  apiKeyCreationUrl: string | null
  developerAppSetupUrl: string | null
  docsUrl: string | null
  pricingUrl: string | null
  statusPageUrl: string | null
  permissionExplanation: string | null
  accountRequired: boolean
  supportsOauth: boolean
  supportsApiKey: boolean
  supportsSessionAuth: boolean
  freeTierAvailable: boolean
  metadataVerifiedAt: number | null
}
interface Account {
  id: string; workspaceId: string; connectorId: string; label: string
  externalAccount: string | null; permission: string
  grantedScopes: string[]; status: string; health: string
  lastActionAt: number | null
}
interface ActionRow {
  id: string; accountId: string; connectorId: string
  action: string; intent: string; phase: string; riskLevel: string
  blockedReason: string | null; errorMessage: string | null
  dryRunPreview: { summary: string; affected?: Record<string, unknown> } | null
  requiresApproval: boolean
  createdAt: number; completedAt: number | null
}
interface KillSwitch {
  allBlocked: boolean
  categoryBlocked: string[]
  connectorBlocked: string[]
  reason: string | null
}

const PHASE_COLOR: Record<string, string> = {
  queued: 'var(--text-muted)',
  awaiting_approval: 'var(--accent-warning)',
  approved: 'var(--accent-active)',
  executing: 'var(--accent-active)',
  completed: 'var(--accent-healthy)',
  failed: 'var(--accent-critical)',
  blocked: 'var(--accent-critical)',
  rejected: 'var(--text-muted)',
}

type Tab = 'library' | 'accounts' | 'approvals' | 'activity'

export default function ConnectorsPage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('library')

  const kill = useQuery({
    queryKey: ['conn-kill', workspaceId],
    queryFn: () => api.get<{ data: KillSwitch }>(`/api/v1/connectors/kill-switch?workspace_id=${workspaceId}`).then(r => r.data),
    refetchInterval: 15_000,
  })

  const setKill = useMutation({
    mutationFn: (patch: Partial<KillSwitch>) =>
      api.post<{ data: KillSwitch }>(`/api/v1/connectors/kill-switch`, { workspace_id: workspaceId, ...patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['conn-kill', workspaceId] }),
  })

  const pending = useQuery({
    queryKey: ['conn-pending', workspaceId],
    queryFn: () => api.get<{ data: ActionRow[] }>(`/api/v1/connectors/approvals/pending?workspace_id=${workspaceId}`).then(r => r.data),
    refetchInterval: 10_000,
  })

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <PageHeader
        breadcrumb="Brain · Connectors"
        title="Connectors"
        subtitle="Universal connector foundation. All actions route through the 7-stage pipeline (intent → permission → policy → dry-run → approval → execute → audit)."
      />

      {/* Emergency controls */}
      <section className="panel p-3 mb-4 flex items-center gap-3 flex-wrap">
        <ShieldAlert className="w-4 h-4 text-[var(--accent-critical)]" />
        <div className="flex-1 min-w-[200px]">
          <div className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">Kill switch</div>
          {kill.data?.allBlocked
            ? <div className="text-[12px] text-[var(--accent-critical)] font-medium">
                ALL CONNECTOR ACTIONS PAUSED{kill.data.reason && ` — ${kill.data.reason}`}
              </div>
            : <div className="text-[12px] text-[var(--text-secondary)]">All actions allowed (pipeline still enforces hard-block patterns + approval gates)</div>}
          {(kill.data?.categoryBlocked.length ?? 0) > 0 && (
            <div className="text-[10px] text-[var(--text-muted)] mt-0.5">paused categories: {kill.data!.categoryBlocked.join(', ')}</div>
          )}
          {(kill.data?.connectorBlocked.length ?? 0) > 0 && (
            <div className="text-[10px] text-[var(--text-muted)] mt-0.5">paused connectors: {kill.data!.connectorBlocked.join(', ')}</div>
          )}
        </div>
        {kill.data?.allBlocked
          ? <button onClick={() => setKill.mutate({ allBlocked: false, reason: null })}
              disabled={setKill.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--accent-healthy)]/15 border border-[var(--accent-healthy)]/40 hover:bg-[var(--accent-healthy)]/25 text-[12px] text-[var(--accent-healthy)] focus-ring">
              <Play className="w-3.5 h-3.5" /> Resume all
            </button>
          : <button onClick={() => {
              const reason = prompt('Reason for emergency pause?') ?? 'operator pause'
              setKill.mutate({ allBlocked: true, reason })
            }}
              disabled={setKill.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--accent-critical)]/15 border border-[var(--accent-critical)]/40 hover:bg-[var(--accent-critical)]/25 text-[12px] text-[var(--accent-critical)] focus-ring">
              <Pause className="w-3.5 h-3.5" /> EMERGENCY PAUSE
            </button>}
      </section>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-[var(--border)]">
        <TabButton active={tab === 'library'}  onClick={() => setTab('library')}  icon={<Plug className="w-3.5 h-3.5" />}>Library</TabButton>
        <TabButton active={tab === 'accounts'} onClick={() => setTab('accounts')} icon={<Activity className="w-3.5 h-3.5" />}>Accounts</TabButton>
        <TabButton active={tab === 'approvals'} onClick={() => setTab('approvals')} icon={<ListChecks className="w-3.5 h-3.5" />}>
          Approvals
          {(pending.data?.length ?? 0) > 0 && (
            <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-[var(--accent-warning)]/20 text-[var(--accent-warning)] text-[10px]">{pending.data!.length}</span>
          )}
        </TabButton>
        <TabButton active={tab === 'activity'}  onClick={() => setTab('activity')}  icon={<RefreshCw className="w-3.5 h-3.5" />}>Activity</TabButton>
      </div>

      {tab === 'library'   && <LibraryTab />}
      {tab === 'accounts'  && <AccountsTab />}
      {tab === 'approvals' && <ApprovalsTab />}
      {tab === 'activity'  && <ActivityTab />}
    </div>
  )
}

function TabButton({ active, onClick, icon, children }: {
  active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode
}) {
  return (
    <button onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-2 text-[12px] focus-ring border-b-2 transition-colors ${
        active
          ? 'border-[var(--accent-active)] text-[var(--accent-active)]'
          : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
      }`}>
      {icon} {children}
    </button>
  )
}

// ── Library tab ──────────────────────────────────────────────────────

function LibraryTab() {
  const { data } = useQuery({
    queryKey: ['conn-library'],
    queryFn: () => api.get<{ data: Connector[] }>(`/api/v1/connectors`).then(r => r.data),
  })
  const [filter, setFilter] = useState<'all'|'oauth'|'api_key'|'ready'|'free'>('all')
  const connectors = data ?? []
  if (connectors.length === 0) {
    return <div className="text-[12px] text-[var(--text-muted)] p-4">No connectors registered yet. They register on API boot.</div>
  }
  const filtered = connectors.filter(c => {
    if (filter === 'oauth')   return c.supportsOauth
    if (filter === 'api_key') return c.supportsApiKey
    if (filter === 'ready')   return c.implemented
    if (filter === 'free')    return c.freeTierAvailable
    return true
  })
  const byCategory = filtered.reduce<Record<string, Connector[]>>((acc, c) => {
    (acc[c.category] = acc[c.category] ?? []).push(c)
    return acc
  }, {})
  return (
    <div className="space-y-4">
      {/* Filter pills */}
      <div className="flex gap-1.5 flex-wrap">
        {(['all','ready','oauth','api_key','free'] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className="px-2.5 py-1 rounded-md text-[11px] focus-ring"
            style={{
              background: filter === f ? 'var(--accent-active-bg)' : 'transparent',
              border: `1px solid ${filter === f ? 'var(--accent-active)' : 'var(--border)'}`,
              color: filter === f ? 'var(--accent-active)' : 'var(--text-secondary)',
            }}>
            {f.replace('_', ' ')} ({f === 'all' ? connectors.length
              : f === 'oauth'   ? connectors.filter(c => c.supportsOauth).length
              : f === 'api_key' ? connectors.filter(c => c.supportsApiKey).length
              : f === 'ready'   ? connectors.filter(c => c.implemented).length
              : connectors.filter(c => c.freeTierAvailable).length})
          </button>
        ))}
      </div>

      {Object.entries(byCategory).sort().map(([cat, list]) => (
        <section key={cat}>
          <h3 className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-2">{cat} · {list.length}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {list.map(c => <ConnectorCard key={c.id} c={c} />)}
          </div>
        </section>
      ))}
    </div>
  )
}

function ConnectorCard({ c }: { c: Connector }) {
  const unverified = !c.metadataVerifiedAt

  return (
    <div className="panel p-3 flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <h4 className="text-[13px] font-medium text-[var(--text-primary)] truncate">{c.name}</h4>
            <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0 ${
              c.implemented
                ? 'bg-[var(--accent-healthy)]/15 text-[var(--accent-healthy)]'
                : 'bg-[var(--text-muted)]/15 text-[var(--text-muted)]'
            }`}>
              {c.implemented ? 'ready' : 'declared'}
            </span>
          </div>
          <p className="text-[11px] text-[var(--text-muted)] leading-relaxed line-clamp-2">{c.description}</p>
        </div>
      </div>

      {/* Capability chips */}
      <div className="flex flex-wrap gap-1">
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-secondary)]">{c.authType}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-secondary)]">{c.supportedActions.length} actions</span>
        {c.freeTierAvailable && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-healthy)]/15 text-[var(--accent-healthy)]">free tier</span>
        )}
        {c.blockedActions.length > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-critical)]/15 text-[var(--accent-critical)]">{c.blockedActions.length} blocked</span>
        )}
      </div>

      {/* Permission explanation */}
      {c.permissionExplanation && (
        <details className="text-[10px] text-[var(--text-muted)]">
          <summary className="cursor-pointer hover:text-[var(--text-secondary)]">Permissions preview</summary>
          <div className="mt-1 p-2 bg-[var(--bg-elevated)] rounded text-[11px] leading-relaxed">{c.permissionExplanation}</div>
        </details>
      )}

      {/* Unverified warning */}
      {unverified && (
        <div className="text-[10px] p-1.5 rounded bg-[var(--accent-warning)]/15 text-[var(--accent-warning)] border border-[var(--accent-warning)]/30">
          ⚠ URLs not yet verified by maintainer — confirm before clicking.
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap gap-1 mt-1 pt-2 border-t border-[var(--border)]">
        {c.signupUrl && (
          <a href={c.signupUrl} target="_blank" rel="noopener noreferrer"
            className="text-[10px] px-2 py-1 rounded-md bg-[var(--accent-active)]/10 hover:bg-[var(--accent-active)]/20 text-[var(--accent-active)] focus-ring">
            Sign up
          </a>
        )}
        {c.loginUrl && (
          <a href={c.loginUrl} target="_blank" rel="noopener noreferrer"
            className="text-[10px] px-2 py-1 rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] focus-ring">
            Log in
          </a>
        )}
        {c.apiKeyCreationUrl && (
          <a href={c.apiKeyCreationUrl} target="_blank" rel="noopener noreferrer"
            className="text-[10px] px-2 py-1 rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] focus-ring">
            Get API key
          </a>
        )}
        {c.developerAppSetupUrl && c.developerAppSetupUrl !== c.apiKeyCreationUrl && (
          <a href={c.developerAppSetupUrl} target="_blank" rel="noopener noreferrer"
            className="text-[10px] px-2 py-1 rounded-md border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] focus-ring">
            Developer app
          </a>
        )}
        {c.docsUrl && (
          <a href={c.docsUrl} target="_blank" rel="noopener noreferrer"
            className="text-[10px] px-2 py-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-secondary)] focus-ring">
            Docs
          </a>
        )}
        {c.pricingUrl && (
          <a href={c.pricingUrl} target="_blank" rel="noopener noreferrer"
            className="text-[10px] px-2 py-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-secondary)] focus-ring">
            Pricing
          </a>
        )}
      </div>
    </div>
  )
}

// ── Accounts tab ─────────────────────────────────────────────────────

function AccountsTab() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['conn-accounts', workspaceId],
    queryFn: () => api.get<{ data: Account[] }>(`/api/v1/connectors/accounts?workspace_id=${workspaceId}`).then(r => r.data),
    refetchInterval: 20_000,
  })
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.post(`/api/v1/connectors/accounts/${id}/status`, { workspace_id: workspaceId, status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['conn-accounts', workspaceId] }),
  })
  const setPerm = useMutation({
    mutationFn: ({ id, permission }: { id: string; permission: string }) =>
      api.post(`/api/v1/connectors/accounts/${id}/permission`, { workspace_id: workspaceId, permission }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['conn-accounts', workspaceId] }),
  })

  const accounts = data ?? []
  if (accounts.length === 0) {
    return (
      <div className="panel p-6 text-center">
        <Plug className="w-8 h-8 mb-2 mx-auto opacity-40 text-[var(--text-muted)]" />
        <div className="text-[12px] text-[var(--text-muted)] mb-1">No connected accounts yet.</div>
        <div className="text-[11px] text-[var(--text-faint)]">
          Use <code className="bg-[var(--bg-elevated)] px-1 rounded">POST /api/v1/connectors/accounts</code> to link one.
        </div>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {accounts.map(a => (
        <div key={a.id} className="panel p-3 flex items-center gap-3 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-[13px] font-medium text-[var(--text-primary)]">{a.label}</span>
              <span className="text-[10px] text-[var(--text-muted)]">/ {a.connectorId}</span>
              <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                a.status === 'active' ? 'bg-[var(--accent-healthy)]/15 text-[var(--accent-healthy)]'
                : a.status === 'revoked' ? 'bg-[var(--accent-critical)]/15 text-[var(--accent-critical)]'
                : 'bg-[var(--accent-warning)]/15 text-[var(--accent-warning)]'
              }`}>{a.status}</span>
            </div>
            <div className="text-[11px] text-[var(--text-muted)]">
              {a.externalAccount && <>{a.externalAccount} · </>}
              perm: <strong className="text-[var(--text-secondary)]">{a.permission}</strong>
              {a.grantedScopes.length > 0 && <> · {a.grantedScopes.length} scopes</>}
              {a.lastActionAt && <> · last action {new Date(a.lastActionAt).toLocaleString()}</>}
            </div>
          </div>
          <select value={a.permission}
            onChange={e => setPerm.mutate({ id: a.id, permission: e.target.value })}
            className="bg-[var(--bg-elevated)] border border-[var(--border)] rounded px-2 py-1 text-[11px] text-[var(--text-primary)]">
            <option value="read">read</option>
            <option value="draft">draft</option>
            <option value="publish">publish</option>
            <option value="admin">admin</option>
          </select>
          {a.status === 'active'
            ? <button onClick={() => setStatus.mutate({ id: a.id, status: 'paused' })}
                className="text-[11px] px-2 py-1 rounded text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]">
                Pause
              </button>
            : <button onClick={() => setStatus.mutate({ id: a.id, status: 'active' })}
                className="text-[11px] px-2 py-1 rounded text-[var(--accent-healthy)] hover:bg-[var(--surface-hover)]">
                Resume
              </button>}
          <button onClick={() => {
              if (confirm(`Revoke connection to ${a.label}? This cannot be undone via UI.`))
                setStatus.mutate({ id: a.id, status: 'revoked' })
            }}
            className="text-[11px] px-2 py-1 rounded text-[var(--accent-critical)] hover:bg-[var(--surface-hover)]">
            Revoke
          </button>
        </div>
      ))}
    </div>
  )
}

// ── Approvals tab ────────────────────────────────────────────────────

function ApprovalsTab() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['conn-pending', workspaceId],
    queryFn: () => api.get<{ data: ActionRow[] }>(`/api/v1/connectors/approvals/pending?workspace_id=${workspaceId}`).then(r => r.data),
    refetchInterval: 10_000,
  })
  const approve = useMutation({
    mutationFn: (id: string) =>
      api.post(`/api/v1/connectors/actions/${id}/approve`, { workspace_id: workspaceId, approver: 'operator' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conn-pending', workspaceId] })
      qc.invalidateQueries({ queryKey: ['conn-activity', workspaceId] })
    },
  })
  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post(`/api/v1/connectors/actions/${id}/reject`, { workspace_id: workspaceId, by: 'operator', reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['conn-pending', workspaceId] }),
  })

  if (isLoading) return <div className="text-[12px] text-[var(--text-muted)]"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…</div>
  const list = data ?? []
  if (list.length === 0) {
    return (
      <div className="panel p-6 text-center">
        <CheckCircle2 className="w-8 h-8 mb-2 mx-auto opacity-40 text-[var(--text-muted)]" />
        <div className="text-[12px] text-[var(--text-muted)]">No pending approvals.</div>
      </div>
    )
  }
  return (
    <div className="space-y-3">
      {list.map(act => (
        <div key={act.id} className="panel p-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 text-[var(--accent-warning)]" />
            <span className="text-[12px] font-medium text-[var(--text-primary)]">{act.action}</span>
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--accent-warning)]/15 text-[var(--accent-warning)]">{act.riskLevel}</span>
            <span className="ml-auto text-[10px] text-[var(--text-muted)]">{new Date(act.createdAt).toLocaleString()}</span>
          </div>
          <p className="text-[12px] text-[var(--text-secondary)] mb-2">{act.intent}</p>
          {act.dryRunPreview?.summary && (
            <div className="text-[11px] text-[var(--text-muted)] bg-[var(--bg-elevated)] p-2 rounded mb-2">
              <strong>Would do:</strong> {act.dryRunPreview.summary}
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={() => approve.mutate(act.id)} disabled={approve.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--accent-healthy)]/15 border border-[var(--accent-healthy)]/40 hover:bg-[var(--accent-healthy)]/25 text-[11px] text-[var(--accent-healthy)] focus-ring">
              <CheckCircle2 className="w-3 h-3" /> Approve & execute
            </button>
            <button onClick={() => {
              const reason = prompt('Reason for rejection?')
              if (reason) reject.mutate({ id: act.id, reason })
            }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] focus-ring">
              <XCircle className="w-3 h-3" /> Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Activity tab ─────────────────────────────────────────────────────

function ActivityTab() {
  const { workspaceId } = useWorkspace()
  const [phaseFilter, setPhaseFilter] = useState<string>('')
  const { data } = useQuery({
    queryKey: ['conn-activity', workspaceId, phaseFilter],
    queryFn: () => api.get<{ data: ActionRow[] }>(
      `/api/v1/connectors/actions?workspace_id=${workspaceId}${phaseFilter ? `&phase=${phaseFilter}` : ''}&limit=100`,
    ).then(r => r.data),
    refetchInterval: 15_000,
  })
  const rows = data ?? []
  const phases = ['completed','blocked','failed','rejected','awaiting_approval'] as const

  return (
    <div>
      <div className="flex gap-1 mb-3 flex-wrap">
        <FilterPill active={phaseFilter === ''} onClick={() => setPhaseFilter('')}>all</FilterPill>
        {phases.map(p => {
          const color = PHASE_COLOR[p]
          return (
            <FilterPill key={p} active={phaseFilter === p} onClick={() => setPhaseFilter(p)} {...(color ? { color } : {})}>{p}</FilterPill>
          )
        })}
      </div>
      <div className="panel overflow-hidden">
        <table className="w-full text-[11px]">
          <thead className="bg-[var(--bg-surface)] text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
            <tr>
              <th className="text-left px-3 py-1.5">Phase</th>
              <th className="text-left px-3 py-1.5">Action</th>
              <th className="text-left px-3 py-1.5">Intent</th>
              <th className="text-left px-3 py-1.5">Reason / Error</th>
              <th className="text-right px-3 py-1.5">When</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-[var(--text-muted)]">No matching actions.</td></tr>
            )}
            {rows.map(r => (
              <tr key={r.id} className="border-t border-[var(--border)]">
                <td className="px-3 py-1.5">
                  <span style={{ color: PHASE_COLOR[r.phase] ?? 'var(--text-muted)' }}>● {r.phase}</span>
                </td>
                <td className="px-3 py-1.5 font-mono text-[var(--text-secondary)]">{r.action}</td>
                <td className="px-3 py-1.5 text-[var(--text-secondary)] truncate max-w-[260px]" title={r.intent}>{r.intent}</td>
                <td className="px-3 py-1.5 text-[var(--text-muted)] truncate max-w-[200px]" title={r.blockedReason ?? r.errorMessage ?? ''}>
                  {r.blockedReason ?? r.errorMessage ?? ''}
                </td>
                <td className="px-3 py-1.5 text-right text-[var(--text-faint)]">{new Date(r.createdAt).toLocaleTimeString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function FilterPill({ active, onClick, color, children }: {
  active: boolean; onClick: () => void; color?: string; children: React.ReactNode
}) {
  const c = color ?? 'var(--text-muted)'
  return (
    <button onClick={onClick}
      className="px-2.5 py-1 rounded-md text-[11px] focus-ring"
      style={{
        background: active ? `${c}22` : 'transparent',
        border: `1px solid ${active ? c : 'var(--border)'}`,
        color: active ? c : 'var(--text-secondary)',
      }}>
      {children}
    </button>
  )
}
