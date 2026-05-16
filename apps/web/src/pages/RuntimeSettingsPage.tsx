/**
 * Runtime Settings — configure cloud/local/hybrid execution mode,
 * connected API providers, remote endpoints, and user-level credentials.
 */
import { useState }                              from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Cloud, Server, Cpu, Key, CheckCircle, XCircle, AlertCircle,
  Plus, Trash2, RefreshCw, Lock, ToggleLeft, ToggleRight,
} from 'lucide-react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

const API    = '/api/v1'
const USER   = 'user-local'

// ─── Types ────────────────────────────────────────────────────────────────────

type RuntimeMode = 'local' | 'hybrid' | 'cloud-api-only'

interface RuntimeSettings {
  id: string; workspaceId: string; mode: RuntimeMode
  allowLocalGpu: boolean; allowLocalBrowser: boolean
  preferredProviders: string[]; updatedAt: number
}

interface ProviderConfig {
  id: string; providerId: string; label: string
  hasApiKey: boolean; enabled: boolean; priority: number
  maxCostPerReqUsd: number | null
}

interface UserCred {
  id: string; providerId: string; label: string
  hasApiKey: boolean; enabled: boolean
  validationStatus: 'unknown' | 'valid' | 'invalid'
  lastValidatedAt: number | null
}

interface RemoteEndpoint {
  id: string; name: string; type: string; baseUrl: string
  healthStatus: string; latencyMs: number | null
  enabled: boolean; hasApiKey: boolean
}

// ─── API helpers ──────────────────────────────────────────────────────────────

function makeApi(ws: string) {
  return {
    getMode:      () => fetch(`${API}/cloud-runtime/mode?workspaceId=${ws}`).then((r) => r.json()) as Promise<{ settings: RuntimeSettings }>,
    setMode:      (body: object) => fetch(`${API}/cloud-runtime/mode`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()),
    validateKey:  (body: object) => fetch(`${API}/cloud-runtime/validate-key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()),
    getUserCreds: () => fetch(`${API}/cloud-runtime/user-creds?workspaceId=${ws}&userId=${USER}`).then((r) => r.json()) as Promise<{ creds: UserCred[] }>,
    addUserCred:  (body: object) => fetch(`${API}/cloud-runtime/user-creds`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()),
    delUserCred:  (id: string)   => fetch(`${API}/cloud-runtime/user-creds/${id}?workspaceId=${ws}&userId=${USER}`, { method: 'DELETE' }).then((r) => r.json()),
    getConfigs:   () => fetch(`${API}/ai-router/configs?workspace_id=${ws}`).then((r) => r.json()) as Promise<{ success: true; data: ProviderConfig[] }>,
    addConfig:    (body: object) => fetch(`${API}/ai-router/configs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()),
    delConfig:    (id: string)   => fetch(`${API}/ai-router/configs/${id}`, { method: 'DELETE' }).then((r) => r.json()),
    getEndpoints: () => fetch(`${API}/ai-router/endpoints?workspace_id=${ws}`).then((r) => r.json()) as Promise<{ success: true; data: RemoteEndpoint[] }>,
    checkEndpoint:(id: string)   => fetch(`${API}/ai-router/endpoints/${id}/check`, { method: 'POST' }).then((r) => r.json()),
    routePreflight: (body: object) => fetch(`${API}/cloud-runtime/route-preflight`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()),
  }
}

// ─── Shared small components ──────────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  const color = status === 'healthy' || status === 'valid'  ? '#10b981'
    : status === 'degraded' || status === 'unknown'         ? '#f59e0b'
    : '#f43f5e'
  return (
    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color }} />
  )
}

function Tag({ children, color = '#64748b' }: { children: React.ReactNode; color?: string }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 4,
      background: `${color}20`, color, border: `1px solid ${color}40`, textTransform: 'uppercase' }}>
      {children}
    </span>
  )
}

// ─── Mode Selector ────────────────────────────────────────────────────────────

const MODES: { id: RuntimeMode; label: string; desc: string; icon: React.ElementType; color: string }[] = [
  { id: 'local',          label: 'Local',          icon: Cpu,    color: '#64748b', desc: 'All compute runs locally. No external API calls required.' },
  { id: 'hybrid',         label: 'Hybrid',         icon: Server, color: '#3b82f6', desc: 'Local compute preferred; remote providers available as fallback.' },
  { id: 'cloud-api-only', label: 'Cloud API Only',  icon: Cloud,  color: '#8b5cf6', desc: 'All AI/LLM routed through connected API providers. Local GPU/browser disabled.' },
]

function ModeSelector({
  current,
  onChange,
}: {
  current: RuntimeMode
  onChange: (m: RuntimeMode) => void
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
      {MODES.map(({ id, label, desc, icon: Icon, color }) => {
        const active = current === id
        return (
          <button
            key={id}
            onClick={() => onChange(id)}
            style={{
              background: active ? `${color}15` : 'var(--bg-elevated)',
              border: `1.5px solid ${active ? color : 'var(--border)'}`,
              borderRadius: 10, padding: 14, cursor: 'pointer', textAlign: 'left',
              transition: 'all 0.15s',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <Icon style={{ width: 16, height: 16, color: active ? color : 'var(--text-muted)' }} />
              <span style={{ fontWeight: 600, fontSize: 13, color: active ? color : 'var(--text-primary)' }}>{label}</span>
              {active && <Tag color={color}>Active</Tag>}
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>{desc}</p>
          </button>
        )
      })}
    </div>
  )
}

// ─── Add Provider Key Modal ───────────────────────────────────────────────────

const PROVIDERS = ['openai', 'anthropic', 'groq', 'gemini', 'openrouter', 'ollama_remote']

function AddKeyModal({
  title,
  onAdd,
  onClose,
  withValidate,
}: {
  title: string
  onAdd: (providerId: string, label: string, apiKey: string, validate: boolean) => void
  onClose: () => void
  withValidate?: boolean
}) {
  const [form, setForm] = useState({ providerId: 'openai', label: '', apiKey: '', validate: true })
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 24, width: 420 }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600 }}>{title}</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <select value={form.providerId} onChange={(e) => setForm({ ...form, providerId: e.target.value })}
            style={{ padding: '8px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: 13 }}>
            {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <input placeholder="Label (e.g. My OpenAI Key)" value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
            style={{ padding: '8px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: 13 }} />
          <input type="password" placeholder="API Key" value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            style={{ padding: '8px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: 13 }} />
          {withValidate && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={form.validate} onChange={(e) => setForm({ ...form, validate: e.target.checked })} />
              Validate key on save
            </label>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button onClick={onClose}
            style={{ flex: 1, padding: '8px 0', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13 }}>
            Cancel
          </button>
          <button
            disabled={!form.label || !form.apiKey}
            onClick={() => onAdd(form.providerId, form.label, form.apiKey, form.validate)}
            style={{ flex: 2, padding: '8px 0', borderRadius: 7, border: 'none', background: '#3b82f6', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            Save Key
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

type Tab = 'mode' | 'providers' | 'user-keys' | 'endpoints'

export default function RuntimeSettingsPage() {
  const qc  = useQueryClient()
  const { workspaceId } = useWorkspace()
  const api = makeApi(workspaceId)
  const [tab, setTab]           = useState<Tab>('mode')
  const [showAddConfig, setShowAddConfig] = useState(false)
  const [showAddCred, setShowAddCred]     = useState(false)
  const [checking, setChecking] = useState<string | null>(null)

  const { data: modeData, isLoading: modeLoading } = useQuery({
    queryKey: ['runtime-mode', workspaceId],
    queryFn:  api.getMode,
  })

  const { data: configsData } = useQuery({
    queryKey: ['ai-configs', workspaceId],
    queryFn:  api.getConfigs,
    enabled:  tab === 'providers',
  })

  const { data: credsData } = useQuery({
    queryKey: ['user-creds', workspaceId],
    queryFn:  api.getUserCreds,
    enabled:  tab === 'user-keys',
  })

  const { data: endpointsData } = useQuery({
    queryKey: ['endpoints', workspaceId],
    queryFn:  api.getEndpoints,
    enabled:  tab === 'endpoints',
  })

  const modeMut = useMutation({
    mutationFn: (body: object) => api.setMode(body),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['runtime-mode'] }),
  })

  const addConfigMut = useMutation({
    mutationFn: api.addConfig,
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['ai-configs'] }); setShowAddConfig(false) },
  })

  const delConfigMut = useMutation({
    mutationFn: api.delConfig,
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['ai-configs'] }),
  })

  const addCredMut = useMutation({
    mutationFn: api.addUserCred,
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['user-creds'] }); setShowAddCred(false) },
  })

  const delCredMut = useMutation({
    mutationFn: api.delUserCred,
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['user-creds'] }),
  })

  const settings = modeData?.settings

  const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: 'mode',      label: 'Runtime Mode',      icon: Cloud },
    { id: 'providers', label: 'Workspace Providers', icon: Key  },
    { id: 'user-keys', label: 'My API Keys',        icon: Lock },
    { id: 'endpoints', label: 'Remote Endpoints',   icon: Server },
  ]

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Runtime Settings</h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
          Configure how the platform executes compute: local, hybrid, or cloud-API-only.
        </p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 24, borderBottom: '1px solid var(--border)', paddingBottom: 0 }}>
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setTab(id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 14px', fontSize: 13, fontWeight: tab === id ? 600 : 400,
              color: tab === id ? 'var(--text-primary)' : 'var(--text-muted)',
              background: 'transparent', border: 'none',
              borderBottom: `2px solid ${tab === id ? '#3b82f6' : 'transparent'}`,
              cursor: 'pointer', marginBottom: -1,
            }}>
            <Icon style={{ width: 14, height: 14 }} />
            {label}
          </button>
        ))}
      </div>

      {/* ── Runtime Mode Tab ─────────────────────────────────────────────── */}
      {tab === 'mode' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {modeLoading ? (
            <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</p>
          ) : (
            <>
              <ModeSelector
                current={(settings?.mode ?? 'local') as RuntimeMode}
                onChange={(m) => modeMut.mutate({ workspaceId, mode: m })}
              />

              {settings?.mode === 'cloud-api-only' && (
                <div style={{ background: '#8b5cf615', border: '1px solid #8b5cf640', borderRadius: 10, padding: 16 }}>
                  <p style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 600, color: '#8b5cf6' }}>
                    Cloud-API-Only Overrides
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {[
                      { key: 'allowLocalGpu',     label: 'Allow Local GPU (exception)',     val: settings.allowLocalGpu },
                      { key: 'allowLocalBrowser',  label: 'Allow Local Browser (exception)', val: settings.allowLocalBrowser },
                    ].map(({ key, label, val }) => (
                      <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{label}</span>
                        <button
                          onClick={() => modeMut.mutate({ workspaceId, [key]: !val })}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: val ? '#10b981' : '#64748b' }}>
                          {val ? <ToggleRight style={{ width: 24, height: 24 }} /> : <ToggleLeft style={{ width: 24, height: 24 }} />}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Preflight test */}
              <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: 16 }}>
                <p style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 600 }}>Test Routing Decision</p>
                <button
                  onClick={async () => {
                    const res = await api.routePreflight({
                      workspaceId, computeType: 'ai', estimatedCostUsd: 0.01,
                      scopeType: 'workspace', scopeId: workspaceId, executionId: `test-${Date.now()}`,
                    }) as { decision: { approved: boolean; providerId: string | null; blockReason: string | null; mustUseRemote: boolean } }
                    const d = res.decision
                    alert(d.approved
                      ? `✅ Approved\nProvider: ${d.providerId ?? 'auto'}\nMust use remote: ${d.mustUseRemote}`
                      : `❌ Blocked: ${d.blockReason}`)
                  }}
                  style={{ padding: '7px 14px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12 }}>
                  Run Preflight Check
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Workspace Providers Tab ──────────────────────────────────────── */}
      {tab === 'providers' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
              Workspace-level API keys. Applied to all users unless overridden.
            </p>
            <button onClick={() => setShowAddConfig(true)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 7, border: 'none', background: '#3b82f6', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
              <Plus style={{ width: 13, height: 13 }} /> Add Provider
            </button>
          </div>

          {(configsData?.data ?? []).map((cfg) => (
            <div key={cfg.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Key style={{ width: 14, height: 14, color: 'var(--text-muted)' }} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{cfg.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {cfg.providerId} · priority {cfg.priority}
                    {cfg.maxCostPerReqUsd ? ` · max $${cfg.maxCostPerReqUsd}/req` : ''}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {cfg.hasApiKey
                  ? <CheckCircle style={{ width: 14, height: 14, color: '#10b981' }} />
                  : <AlertCircle style={{ width: 14, height: 14, color: '#f59e0b' }} />}
                <Tag color={cfg.enabled ? '#10b981' : '#64748b'}>{cfg.enabled ? 'enabled' : 'disabled'}</Tag>
                <button onClick={() => delConfigMut.mutate(cfg.id)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#f43f5e', padding: 4 }}>
                  <Trash2 style={{ width: 14, height: 14 }} />
                </button>
              </div>
            </div>
          ))}

          {!configsData?.data?.length && (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)', fontSize: 13 }}>
              No workspace providers configured.
            </div>
          )}
        </div>
      )}

      {/* ── My API Keys Tab ──────────────────────────────────────────────── */}
      {tab === 'user-keys' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
              Your personal API keys. Override workspace-level keys for your requests.
            </p>
            <button onClick={() => setShowAddCred(true)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', borderRadius: 7, border: 'none', background: '#3b82f6', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
              <Plus style={{ width: 13, height: 13 }} /> Add My Key
            </button>
          </div>

          {(credsData?.creds ?? []).map((cred) => (
            <div key={cred.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <StatusDot status={cred.validationStatus} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{cred.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {cred.providerId}
                    {cred.lastValidatedAt ? ` · validated ${new Date(cred.lastValidatedAt).toLocaleDateString()}` : ''}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {cred.validationStatus === 'valid'
                  ? <CheckCircle style={{ width: 14, height: 14, color: '#10b981' }} />
                  : cred.validationStatus === 'invalid'
                  ? <XCircle style={{ width: 14, height: 14, color: '#f43f5e' }} />
                  : <AlertCircle style={{ width: 14, height: 14, color: '#f59e0b' }} />}
                <Tag color={cred.validationStatus === 'valid' ? '#10b981' : '#f59e0b'}>{cred.validationStatus}</Tag>
                <button onClick={() => delCredMut.mutate(cred.id)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#f43f5e', padding: 4 }}>
                  <Trash2 style={{ width: 14, height: 14 }} />
                </button>
              </div>
            </div>
          ))}

          {!credsData?.creds?.length && (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)', fontSize: 13 }}>
              No personal API keys saved.
            </div>
          )}
        </div>
      )}

      {/* ── Remote Endpoints Tab ─────────────────────────────────────────── */}
      {tab === 'endpoints' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
            Private remote GPU/browser worker endpoints (Ollama, vLLM, RunPod, etc.)
            <br />
            Manage full endpoint config in <a href="/compute/settings" style={{ color: '#3b82f6' }}>Remote Compute → Provider Settings</a>.
          </p>

          {(endpointsData?.data ?? []).map((ep) => (
            <div key={ep.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <StatusDot status={ep.healthStatus} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{ep.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {ep.type} · {ep.baseUrl}
                    {ep.latencyMs ? ` · ${Math.round(ep.latencyMs)}ms` : ''}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Tag color={ep.healthStatus === 'healthy' ? '#10b981' : ep.healthStatus === 'degraded' ? '#f59e0b' : '#64748b'}>
                  {ep.healthStatus}
                </Tag>
                <button
                  disabled={checking === ep.id}
                  onClick={async () => {
                    setChecking(ep.id)
                    await api.checkEndpoint(ep.id)
                    qc.invalidateQueries({ queryKey: ['endpoints'] })
                    setChecking(null)
                  }}
                  style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6,
                    padding: '4px 8px', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 11 }}>
                  <RefreshCw style={{ width: 12, height: 12, display: 'inline', marginRight: 3 }} />
                  Check
                </button>
              </div>
            </div>
          ))}

          {!endpointsData?.data?.length && (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)', fontSize: 13 }}>
              No remote endpoints configured. Add them in Provider Settings.
            </div>
          )}
        </div>
      )}

      {/* ── Modals ───────────────────────────────────────────────────────── */}
      {showAddConfig && (
        <AddKeyModal
          title="Add Workspace Provider"
          onClose={() => setShowAddConfig(false)}
          onAdd={(providerId, label, apiKey) =>
            addConfigMut.mutate({ workspace_id: workspaceId, provider_id: providerId, label, api_key: apiKey })
          }
        />
      )}

      {showAddCred && (
        <AddKeyModal
          title="Add My API Key"
          withValidate
          onClose={() => setShowAddCred(false)}
          onAdd={(providerId, label, apiKey, validate) =>
            addCredMut.mutate({ workspaceId, userId: USER, providerId, label, apiKey, validate })
          }
        />
      )}
    </div>
  )
}
