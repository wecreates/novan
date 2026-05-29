/**
 * Settings — workspace overview, configuration, and system status.
 */
import { useState }                    from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Settings as SettingsIcon, Database, Cpu, Globe, Shield, AlertTriangle, Activity, Key, Copy, Check, Trash2, Plus, Webhook as WebhookIcon, CalendarClock, RefreshCw, Play } from 'lucide-react'
import { warRoomApi, authApi, webhookApi, schedulerApi, setAuthToken, API_BASE, type ApiToken, type Webhook, type ScheduledTrigger } from '../api.js'
import { SectionPanel } from '../components/SectionPanel.js'

// ─── Feature flags ────────────────────────────────────────────────────────────

const FEATURE_FLAGS = [
  { label: 'Real-time SSE',          enabled: true,  desc: 'Server-sent events for live updates' },
  { label: 'Memory Vector Search',   enabled: true,  desc: 'Semantic similarity search over memories' },
  { label: 'Browser Automation',     enabled: true,  desc: 'Headless browser capture sessions' },
  { label: 'Executive Briefings',    enabled: true,  desc: 'AI-generated operational briefings' },
  { label: 'Opportunity Tracking',   enabled: true,  desc: 'Automated opportunity identification' },
]

// ─── Data retention config ────────────────────────────────────────────────────

const RETENTION = [
  { label: 'Events',           days: 30,  icon: Activity,      color: 'text-blue-400',    bg: 'bg-blue-500/10 border-blue-500/20' },
  { label: 'Memory',           days: 90,  icon: Database,       color: 'text-purple-400',  bg: 'bg-purple-500/10 border-purple-500/20' },
  { label: 'Workflow Runs',    days: 180, icon: Cpu,            color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
  { label: 'Browser Sessions', days: 7,   icon: Globe,          color: 'text-cyan-400',    bg: 'bg-cyan-500/10 border-cyan-500/20' },
]

// ─── Sub-components ───────────────────────────────────────────────────────────

function InfoRow({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 border-b border-border last:border-0">
      <span className="text-xs text-muted">{label}</span>
      <span className={`text-xs text-primary ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  )
}

function ToggleDisplay({ enabled }: { enabled: boolean }) {
  return (
    <div className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-colors ${
      enabled ? 'bg-blue-500/30 border-blue-500/40' : 'bg-elevated border-border'
    }`}>
      <span className={`inline-block h-3.5 w-3.5 rounded-full transition-transform ${
        enabled
          ? 'translate-x-4 bg-blue-400'
          : 'translate-x-0.5 bg-[var(--text-muted)]'
      }`} />
    </div>
  )
}

// ─── Sections ─────────────────────────────────────────────────────────────────

export function ApiTokensSection() {
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [name, setName]         = useState('')
  const [newToken, setNewToken] = useState<{ token: string; prefix: string } | null>(null)
  const [copied, setCopied]     = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['api-tokens'],
    queryFn:  () => authApi.listTokens().then(r => r.data),
  })

  const createMut = useMutation({
    mutationFn: () => authApi.createToken(name.trim()),
    onSuccess: (res) => {
      setNewToken({ token: res.data.token, prefix: res.data.prefix })
      setAuthToken(res.data.token)   // persist to localStorage — used by all api.* calls
      setName('')
      setCreating(false)
      void qc.invalidateQueries({ queryKey: ['api-tokens'] })
    },
  })

  const revokeMut = useMutation({
    mutationFn: (id: string) => authApi.revokeToken(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['api-tokens'] }),
  })

  function handleCopy(token: string) {
    void navigator.clipboard.writeText(token).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  function fmtDate(ts?: number | null): string {
    if (ts === null || ts === undefined) return '—'
    return new Date(ts).toLocaleDateString()
  }

  return (
    <SectionPanel
      title="API Tokens"
      loading={isLoading}
      actions={<Key className="w-4 h-4 text-muted" />}
    >
      {/* New-token banner */}
      {newToken && (
        <div className="mx-4 mt-3 mb-1 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
          <div className="flex items-center gap-1.5 text-xs text-amber-400 font-medium">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            Token saved as active — it won't be shown again. Store it safely.
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs font-mono text-primary bg-elevated rounded px-2 py-1.5 break-all">
              {newToken.token}
            </code>
            <button
              onClick={() => handleCopy(newToken.token)}
              className="shrink-0 p-1.5 rounded hover:bg-elevated text-muted hover:text-primary transition-colors"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          </div>
          <button
            onClick={() => setNewToken(null)}
            className="text-[10px] text-muted hover:text-secondary transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Token list */}
      {(data ?? []).length > 0 ? (
        <ul className="divide-y divide-[var(--border)] mt-1">
          {(data ?? []).map((t: ApiToken) => (
            <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <div className="text-xs font-medium text-primary truncate">{t.name}</div>
                <div className="text-[10px] text-muted mt-0.5 font-mono">
                  {t.prefix}… · {t.scopes.join(', ')}
                  {t.lastUsedAt !== null && t.lastUsedAt !== undefined ? ` · last used ${fmtDate(t.lastUsedAt)}` : ' · never used'}
                </div>
              </div>
              <button
                onClick={() => revokeMut.mutate(t.id)}
                disabled={revokeMut.isPending}
                className="shrink-0 p-1.5 rounded hover:bg-red-500/10 text-muted hover:text-red-400 transition-colors disabled:opacity-40"
                title="Revoke token"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : !isLoading ? (
        <div className="px-4 py-3 text-xs text-muted">No active tokens.</div>
      ) : null}

      {/* Create form */}
      {creating ? (
        <div className="flex items-center gap-2 px-4 py-3 border-t border-border">
          <input
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && name.trim()) createMut.mutate() }}
            placeholder="Token name…"
            className="flex-1 text-xs bg-elevated border border-border rounded px-2.5 py-1.5 text-primary placeholder:text-muted focus:outline-none focus:border-blue-500/50"
          />
          <button
            onClick={() => createMut.mutate()}
            disabled={!name.trim() || createMut.isPending}
            className="text-xs px-3 py-1.5 rounded bg-blue-500/20 border border-blue-500/30 text-blue-400 hover:bg-blue-500/30 transition-colors disabled:opacity-40"
          >
            {createMut.isPending ? 'Creating…' : 'Create'}
          </button>
          <button
            onClick={() => { setCreating(false); setName('') }}
            className="text-xs px-2 py-1.5 rounded text-muted hover:text-secondary transition-colors"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="px-4 py-2.5 border-t border-border">
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-1.5 text-xs text-muted hover:text-secondary transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Create token
          </button>
        </div>
      )}

      {/* Paste existing token — for tokens issued out-of-band (e.g. seed script).
          Saves to localStorage so all subsequent api.* calls authenticate. */}
      <PasteExistingToken />
    </SectionPanel>
  )
}

function PasteExistingToken() {
  const [val, setVal]    = useState('')
  const [done, setDone]  = useState(false)
  const apply = () => {
    const trimmed = val.trim()
    if (!trimmed.startsWith('ops_')) return
    setAuthToken(trimmed)
    setDone(true)
    setVal('')
    setTimeout(() => setDone(false), 2000)
  }
  return (
    <div className="px-4 py-2.5 border-t border-border space-y-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted">
        Paste an existing token (e.g. from the seed script output)
      </div>
      <div className="flex items-center gap-2">
        <input
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') apply() }}
          placeholder="ops_..."
          spellCheck={false}
          type="password"
          className="flex-1 text-xs font-mono bg-elevated border border-border rounded px-2.5 py-1.5 text-primary placeholder:text-muted focus:outline-none focus:border-blue-500/50"
        />
        <button
          onClick={apply}
          disabled={!val.trim().startsWith('ops_')}
          className="text-xs px-3 py-1.5 rounded bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/30 transition-colors disabled:opacity-40"
        >
          {done ? 'Saved ✓' : 'Set active'}
        </button>
      </div>
      <div className="text-[10px] text-muted">
        Token is stored in browser localStorage and sent as <code>Authorization: Bearer …</code> on every API call.
      </div>
    </div>
  )
}

// ─── Webhooks section ─────────────────────────────────────────────────────────

export function WebhooksSection() {
  const qc = useQueryClient()
  const [creating, setCreating]       = useState(false)
  const [whName, setWhName]           = useState('')
  const [whEvents, setWhEvents]       = useState('')
  const [whWorkflowId, setWhWorkflowId] = useState('')
  const [newSecret, setNewSecret]     = useState<{ id: string; secret: string } | null>(null)
  const [copiedId, setCopiedId]       = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['webhooks'],
    queryFn:  () => webhookApi.list().then(r => r.data),
  })

  const createMut = useMutation({
    mutationFn: () => webhookApi.create({
      name:   whName.trim(),
      events: whEvents.split(',').map(s => s.trim()).filter(Boolean),
      ...(whWorkflowId.trim() ? { workflowId: whWorkflowId.trim() } : {}),
    }),
    onSuccess: (res) => {
      setNewSecret({ id: res.data.id, secret: res.data.secret })
      setWhName(''); setWhEvents(''); setWhWorkflowId(''); setCreating(false)
      void qc.invalidateQueries({ queryKey: ['webhooks'] })
    },
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => webhookApi.remove(id),
    onSuccess:  () => void qc.invalidateQueries({ queryKey: ['webhooks'] }),
  })

  const rotateMut = useMutation({
    mutationFn: (id: string) => webhookApi.rotateSecret(id),
    onSuccess:  (res, id) => setNewSecret({ id, secret: res.data.secret }),
  })

  function handleCopy(text: string, key: string) {
    void navigator.clipboard.writeText(text).then(() => {
      setCopiedId(key)
      setTimeout(() => setCopiedId(null), 2000)
    })
  }

  const BASE_API = API_BASE

  return (
    <SectionPanel title="Webhooks" loading={isLoading} actions={<WebhookIcon className="w-4 h-4 text-muted" />}>
      {/* New secret banner */}
      {newSecret && (
        <div className="mx-4 mt-3 mb-1 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
          <div className="flex items-center gap-1.5 text-xs text-amber-400 font-medium">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            Copy this secret now — it won't be shown again.
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs font-mono text-primary bg-elevated rounded px-2 py-1.5 break-all">
              {newSecret.secret}
            </code>
            <button
              onClick={() => handleCopy(newSecret.secret, 'secret')}
              className="shrink-0 p-1.5 rounded hover:bg-elevated text-muted hover:text-primary transition-colors"
            >
              {copiedId === 'secret' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          </div>
          <button onClick={() => setNewSecret(null)} className="text-[10px] text-muted hover:text-secondary transition-colors">
            Dismiss
          </button>
        </div>
      )}

      {/* Webhook list */}
      {(data ?? []).length > 0 ? (
        <ul className="divide-y divide-[var(--border)] mt-1">
          {(data ?? []).map((wh: Webhook) => (
            <li key={wh.id} className="px-4 py-2.5 space-y-1">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-primary truncate">{wh.name}</div>
                  <div className="text-[10px] text-muted mt-0.5 font-mono break-all">
                    {`${BASE_API}/api/v1/webhooks/${wh.id}/trigger`}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => rotateMut.mutate(wh.id)}
                    disabled={rotateMut.isPending}
                    title="Rotate secret"
                    className="p-1.5 rounded hover:bg-elevated text-muted hover:text-secondary transition-colors disabled:opacity-40"
                  >
                    <RefreshCw className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => deleteMut.mutate(wh.id)}
                    disabled={deleteMut.isPending}
                    title="Delete webhook"
                    className="p-1.5 rounded hover:bg-red-500/10 text-muted hover:text-red-400 transition-colors disabled:opacity-40"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {wh.events.length > 0
                  ? wh.events.map((ev: string) => (
                    <span key={ev} className="text-[10px] px-1.5 py-0.5 rounded bg-elevated border border-border text-muted font-mono">
                      {ev}
                    </span>
                  ))
                  : <span className="text-[10px] text-muted italic">all events</span>
                }
                <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded border font-medium ${wh.active ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-elevated border-border text-muted'}`}>
                  {wh.active ? 'active' : 'inactive'}
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : !isLoading ? (
        <div className="px-4 py-3 text-xs text-muted">No webhooks configured.</div>
      ) : null}

      {/* Create form */}
      {creating ? (
        <div className="px-4 py-3 border-t border-border space-y-2">
          <input
            autoFocus
            value={whName}
            onChange={e => setWhName(e.target.value)}
            placeholder="Name…"
            className="w-full text-xs bg-elevated border border-border rounded px-2.5 py-1.5 text-primary placeholder:text-muted focus:outline-none focus:border-blue-500/50"
          />
          <input
            value={whEvents}
            onChange={e => setWhEvents(e.target.value)}
            placeholder="Events (comma-separated, e.g. workflow.completed,risk.created)"
            className="w-full text-xs bg-elevated border border-border rounded px-2.5 py-1.5 text-primary placeholder:text-muted focus:outline-none focus:border-blue-500/50"
          />
          <input
            value={whWorkflowId}
            onChange={e => setWhWorkflowId(e.target.value)}
            placeholder="Workflow ID to trigger (optional)"
            className="w-full text-xs bg-elevated border border-border rounded px-2.5 py-1.5 text-primary placeholder:text-muted focus:outline-none focus:border-blue-500/50"
          />
          <div className="text-[10px] text-muted">HMAC secret will be auto-generated and shown once.</div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => createMut.mutate()}
              disabled={!whName.trim() || createMut.isPending}
              className="text-xs px-3 py-1.5 rounded bg-blue-500/20 border border-blue-500/30 text-blue-400 hover:bg-blue-500/30 transition-colors disabled:opacity-40"
            >
              {createMut.isPending ? 'Creating…' : 'Create Webhook'}
            </button>
            <button
              onClick={() => { setCreating(false); setWhName(''); setWhEvents(''); setWhWorkflowId('') }}
              className="text-xs px-2 py-1.5 rounded text-muted hover:text-secondary transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="px-4 py-2.5 border-t border-border">
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-1.5 text-xs text-muted hover:text-secondary transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Create Webhook
          </button>
        </div>
      )}
    </SectionPanel>
  )
}

// ─── Scheduler section ────────────────────────────────────────────────────────

export function SchedulerSection() {
  const qc = useQueryClient()
  const [creating, setCreating]     = useState(false)
  const [scName, setScName]         = useState('')
  const [scWorkflowId, setScWorkflowId] = useState('')
  const [scCron, setScCron]         = useState('')
  const [scTimezone, setScTimezone] = useState('UTC')
  const [scDesc, setScDesc]         = useState('')
  const [toast, setToast]           = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['scheduler-triggers'],
    queryFn:  () => schedulerApi.list().then(r => r.data).catch(() => [] as ScheduledTrigger[]),
  })

  const createMut = useMutation({
    mutationFn: () => schedulerApi.create({
      name:           scName.trim(),
      workflowId:     scWorkflowId.trim(),
      cronExpression: scCron.trim(),
      ...(scTimezone.trim() && scTimezone.trim() !== 'UTC' ? { timezone: scTimezone.trim() } : {}),
      ...(scDesc.trim() ? { description: scDesc.trim() } : {}),
    }),
    onSuccess: () => {
      setScName(''); setScWorkflowId(''); setScCron(''); setScTimezone('UTC'); setScDesc(''); setCreating(false)
      void qc.invalidateQueries({ queryKey: ['scheduler-triggers'] })
    },
  })

  const enableMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      enabled ? schedulerApi.enable(id) : schedulerApi.disable(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['scheduler-triggers'] }),
  })

  const triggerMut = useMutation({
    mutationFn: (id: string) => schedulerApi.trigger(id),
    onSuccess: () => {
      setToast('Triggered!')
      setTimeout(() => setToast(null), 2500)
    },
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => schedulerApi.delete(id),
    onSuccess:  () => void qc.invalidateQueries({ queryKey: ['scheduler-triggers'] }),
  })

  function statusColor(status?: string | null) {
    if (!status) return 'text-muted'
    if (status === 'completed') return 'text-emerald-400'
    if (status === 'failed')    return 'text-red-400'
    if (status === 'running')   return 'text-blue-400'
    return 'text-muted'
  }

  return (
    <SectionPanel title="Scheduler" loading={isLoading} actions={<CalendarClock className="w-4 h-4 text-muted" />}>
      {/* Toast */}
      {toast && (
        <div className="mx-4 mt-3 mb-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">
          {toast}
        </div>
      )}

      {/* Trigger list */}
      {(data ?? []).length > 0 ? (
        <ul className="divide-y divide-[var(--border)] mt-1">
          {(data ?? []).map((t: ScheduledTrigger) => (
            <li key={t.id} className="px-4 py-2.5 space-y-1">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-primary truncate">{t.name}</div>
                  <div className="text-[10px] text-muted mt-0.5 font-mono">
                    {t.cronExpression} · {t.timezone} · {t.runCount} runs
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {/* Enable/disable toggle */}
                  <button
                    onClick={() => enableMut.mutate({ id: t.id, enabled: !t.enabled })}
                    disabled={enableMut.isPending}
                    title={t.enabled ? 'Disable' : 'Enable'}
                    className="p-0.5 disabled:opacity-40"
                  >
                    <div className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-colors ${
                      t.enabled ? 'bg-blue-500/30 border-blue-500/40' : 'bg-elevated border-border'
                    }`}>
                      <span className={`inline-block h-3.5 w-3.5 rounded-full transition-transform ${
                        t.enabled ? 'translate-x-4 bg-blue-400' : 'translate-x-0.5 bg-[var(--text-muted)]'
                      }`} />
                    </div>
                  </button>
                  {/* Manual trigger */}
                  <button
                    onClick={() => triggerMut.mutate(t.id)}
                    disabled={triggerMut.isPending}
                    title="Run now"
                    className="p-1.5 rounded hover:bg-elevated text-muted hover:text-blue-400 transition-colors disabled:opacity-40"
                  >
                    <Play className="w-3 h-3" />
                  </button>
                  {/* Delete */}
                  <button
                    onClick={() => deleteMut.mutate(t.id)}
                    disabled={deleteMut.isPending}
                    title="Delete trigger"
                    className="p-1.5 rounded hover:bg-red-500/10 text-muted hover:text-red-400 transition-colors disabled:opacity-40"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              {t.lastRunStatus && (
                <div className={`text-[10px] ${statusColor(t.lastRunStatus)}`}>
                  Last run: {t.lastRunStatus}
                  {t.lastRunAt !== null && t.lastRunAt !== undefined ? ` · ${new Date(t.lastRunAt).toLocaleString()}` : ''}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : !isLoading ? (
        <div className="px-4 py-3 text-xs text-muted">No scheduled triggers.</div>
      ) : null}

      {/* Create form */}
      {creating ? (
        <div className="px-4 py-3 border-t border-border space-y-2">
          <input
            autoFocus
            value={scName}
            onChange={e => setScName(e.target.value)}
            placeholder="Name…"
            className="w-full text-xs bg-elevated border border-border rounded px-2.5 py-1.5 text-primary placeholder:text-muted focus:outline-none focus:border-blue-500/50"
          />
          <input
            value={scWorkflowId}
            onChange={e => setScWorkflowId(e.target.value)}
            placeholder="Workflow ID…"
            className="w-full text-xs bg-elevated border border-border rounded px-2.5 py-1.5 text-primary placeholder:text-muted focus:outline-none focus:border-blue-500/50"
          />
          <div className="flex gap-2">
            <input
              value={scCron}
              onChange={e => setScCron(e.target.value)}
              placeholder="Cron expression (e.g. 0 9 * * 1)"
              className="flex-1 text-xs bg-elevated border border-border rounded px-2.5 py-1.5 text-primary placeholder:text-muted focus:outline-none focus:border-blue-500/50"
            />
            <input
              value={scTimezone}
              onChange={e => setScTimezone(e.target.value)}
              placeholder="Timezone"
              className="w-28 text-xs bg-elevated border border-border rounded px-2.5 py-1.5 text-primary placeholder:text-muted focus:outline-none focus:border-blue-500/50"
            />
          </div>
          <textarea
            value={scDesc}
            onChange={e => setScDesc(e.target.value)}
            placeholder="Description (optional)"
            rows={2}
            className="w-full text-xs bg-elevated border border-border rounded px-2.5 py-1.5 text-primary placeholder:text-muted focus:outline-none focus:border-blue-500/50 resize-none"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => createMut.mutate()}
              disabled={!scName.trim() || !scWorkflowId.trim() || !scCron.trim() || createMut.isPending}
              className="text-xs px-3 py-1.5 rounded bg-blue-500/20 border border-blue-500/30 text-blue-400 hover:bg-blue-500/30 transition-colors disabled:opacity-40"
            >
              {createMut.isPending ? 'Creating…' : 'Add Trigger'}
            </button>
            <button
              onClick={() => { setCreating(false); setScName(''); setScWorkflowId(''); setScCron(''); setScTimezone('UTC'); setScDesc('') }}
              className="text-xs px-2 py-1.5 rounded text-muted hover:text-secondary transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="px-4 py-2.5 border-t border-border">
          <button
            onClick={() => setCreating(true)}
            className="flex items-center gap-1.5 text-xs text-muted hover:text-secondary transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Trigger
          </button>
        </div>
      )}
    </SectionPanel>
  )
}

function WorkspaceSection() {
  return (
    <SectionPanel
      title="Workspace"
      actions={<SettingsIcon className="w-4 h-4 text-muted" />}
    >
      <div className="px-4 py-1">
        <InfoRow label="Workspace ID"  value="default" mono />
        <InfoRow label="Plan"          value={
          <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-zinc-500/15 text-zinc-400 border border-zinc-500/20">
            Free
          </span>
        } />
        <InfoRow label="Environment"   value={import.meta.env.MODE} />
        <InfoRow label="Region"        value={new URL(API_BASE).host} mono />
      </div>
    </SectionPanel>
  )
}

function ApiConfigSection() {
  const baseUrl = API_BASE

  const { data, isLoading } = useQuery({
    queryKey: ['settings-health'],
    queryFn:  () => warRoomApi.getRunStats(),
    retry:    1,
    refetchInterval: 30_000,
  })

  const isHealthy = data !== undefined && !isLoading

  return (
    <SectionPanel
      title="API Configuration"
      actions={<Globe className="w-4 h-4 text-muted" />}
    >
      <div className="px-4 py-1">
        <InfoRow label="Base URL" value={baseUrl} mono />
        <InfoRow
          label="Connection Status"
          value={
            <div className="flex items-center gap-1.5">
              <div className={`w-1.5 h-1.5 rounded-full ${isLoading ? 'bg-amber-400 animate-pulse' : isHealthy ? 'bg-emerald-400' : 'bg-red-400'}`} />
              <span className={`text-xs ${isLoading ? 'text-amber-400' : isHealthy ? 'text-emerald-400' : 'text-red-400'}`}>
                {isLoading ? 'Checking…' : isHealthy ? 'Connected' : 'Unreachable'}
              </span>
            </div>
          }
        />
        <InfoRow label="Auth"     value="Bearer token" />
        <InfoRow label="Protocol" value="HTTP/REST + SSE" />
      </div>
    </SectionPanel>
  )
}

function QueueHealthSection() {
  const { data, isLoading } = useQuery({
    queryKey: ['settings-metrics'],
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
    retry: 1,
    refetchInterval: 30_000,
  })

  const entries = Object.entries(data ?? {})

  return (
    <SectionPanel
      title="Queue Health"
      loading={isLoading}
      actions={<Activity className="w-4 h-4 text-muted" />}
    >
      {entries.length === 0 ? (
        <div className="px-4 py-4 text-xs text-muted">
          Prometheus metrics available at{' '}
          <code className="font-mono text-secondary">/metrics</code>
          {' '}on the API server.
        </div>
      ) : (
        <div className="p-4 grid grid-cols-2 gap-3">
          {entries.map(([name, m]) => (
            <div key={name} className="rounded-lg border border-border p-3 space-y-1">
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

function DataRetentionSection() {
  return (
    <SectionPanel
      title="Data Retention"
      actions={<Database className="w-4 h-4 text-muted" />}
    >
      <div className="p-4 grid grid-cols-2 gap-3">
        {RETENTION.map(({ label, days, icon: Icon, color, bg }) => (
          <div key={label} className={`rounded-lg border p-3 flex items-start gap-3 ${bg}`}>
            <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${color}`} />
            <div>
              <div className={`text-xs font-medium ${color}`}>{label}</div>
              <div className="text-[10px] text-muted mt-0.5">
                {days} {days === 1 ? 'day' : 'days'}
              </div>
            </div>
          </div>
        ))}
      </div>
    </SectionPanel>
  )
}

function FeatureFlagsSection() {
  return (
    <SectionPanel
      title="Feature Flags"
      actions={<Shield className="w-4 h-4 text-muted" />}
    >
      <ul className="divide-y divide-[var(--border)]">
        {FEATURE_FLAGS.map(({ label, enabled, desc }) => (
          <li key={label} className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <div className="text-xs font-medium text-primary">{label}</div>
              <div className="text-[10px] text-muted mt-0.5">{desc}</div>
            </div>
            <ToggleDisplay enabled={enabled} />
          </li>
        ))}
      </ul>
    </SectionPanel>
  )
}

// ─── Settings page ────────────────────────────────────────────────────────────

export default function Settings() {
  return (
    <div className="flex flex-col h-screen overflow-hidden bg-bg">

      {/* Header */}
      <header className="shrink-0 flex items-center gap-3 px-6 py-3 border-b border-border bg-[var(--bg-surface)]">
        <div className="w-7 h-7 rounded-lg bg-zinc-500/15 border border-zinc-500/20 flex items-center justify-center">
          <SettingsIcon className="w-3.5 h-3.5 text-zinc-400" />
        </div>
        <div>
          <div className="text-sm font-semibold text-primary">Settings</div>
          <div className="text-xs text-secondary">Workspace overview &amp; configuration</div>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        <div className="max-w-2xl mx-auto space-y-4">
          <WorkspaceSection />
          <ApiConfigSection />
          <ApiTokensSection />
          <WebhooksSection />
          <SchedulerSection />
          <QueueHealthSection />
          <DataRetentionSection />
          <FeatureFlagsSection />
        </div>
      </div>
    </div>
  )
}
