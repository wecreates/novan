/**
 * Provider Settings — manage API provider configs, remote endpoints,
 * and view/configure fallback chain and routing priority.
 */
import { useState }                              from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow }                   from 'date-fns'
import { RefreshCw, Plus, Trash2, Server, Zap, ChevronDown, ChevronRight } from 'lucide-react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

const API = '/api/v1/ai-router'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProviderConfig {
  id: string; workspaceId: string; providerId: string; label: string
  hasApiKey: boolean; enabled: boolean; priority: number
  maxCostPerReqUsd: number | null; notes: string | null
  createdAt: number; updatedAt: number
}

interface RemoteEndpoint {
  id: string; workspaceId: string; name: string; type: string; baseUrl: string
  hasApiKey: boolean; modelIds: string[]; enabled: boolean; priority: number
  healthStatus: string; lastHealthCheck: number | null; latencyMs: number | null
  notes: string | null; createdAt: number; updatedAt: number
}

// ─── API helpers ──────────────────────────────────────────────────────────────

function makeApi(ws: string) {
  return {
    configs:  () => fetch(`${API}/configs?workspace_id=${ws}`).then((r) => r.json()) as Promise<{ success: true; data: ProviderConfig[] }>,
    endpoints: () => fetch(`${API}/endpoints?workspace_id=${ws}`).then((r) => r.json()) as Promise<{ success: true; data: RemoteEndpoint[] }>,
    addConfig:    (body: Record<string, unknown>) => fetch(`${API}/configs`,   { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()),
    delConfig:    (id: string)                    => fetch(`${API}/configs/${id}`, { method: 'DELETE' }).then((r) => r.json()),
    addEndpoint:  (body: Record<string, unknown>) => fetch(`${API}/endpoints`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()),
    delEndpoint:  (id: string)                    => fetch(`${API}/endpoints/${id}`, { method: 'DELETE' }).then((r) => r.json()),
    checkEndpoint:(id: string)                    => fetch(`${API}/endpoints/${id}/check`, { method: 'POST' }).then((r) => r.json()),
  }
}

const PROVIDER_OPTIONS = ['groq', 'openai', 'anthropic', 'gemini', 'openrouter', 'ollama_remote']
const ENDPOINT_TYPES   = ['ollama', 'vllm', 'openai_compat', 'runpod', 'vastai', 'lambda']

// ─── Small components ─────────────────────────────────────────────────────────

function HealthDot({ status }: { status: string }) {
  const color = status === 'healthy' ? '#10b981' : status === 'degraded' ? '#f59e0b' : status === 'down' ? '#f43f5e' : '#64748b'
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color, marginRight: 4 }} />
}

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: `${color}22`, color, border: `1px solid ${color}44`, textTransform: 'uppercase' }}>
      {text}
    </span>
  )
}

// ─── Add Config Modal ─────────────────────────────────────────────────────────

function AddConfigForm({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({ provider_id: 'groq', label: '', api_key: '', priority: '50' })
  const qc = useQueryClient()
  const { workspaceId } = useWorkspace()
  const api = makeApi(workspaceId)
  const mut = useMutation({
    mutationFn: () => api.addConfig({ ...form, workspace_id: workspaceId, priority: parseInt(form.priority) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['rc-configs'] }); onDone() },
  })

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }))

  return (
    <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: 16, marginBottom: 12 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>Add API Provider</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
        <div>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Provider</label>
          <select value={form.provider_id} onChange={set('provider_id')} style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13 }}>
            {PROVIDER_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Label</label>
          <input value={form.label} onChange={set('label')} placeholder="e.g. Production Groq" style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13, boxSizing: 'border-box' }} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>API Key</label>
          <input type="password" value={form.api_key} onChange={set('api_key')} placeholder="sk-..." style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13, boxSizing: 'border-box' }} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Priority (lower = preferred)</label>
          <input type="number" value={form.priority} onChange={set('priority')} min="1" max="999" style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13, boxSizing: 'border-box' }} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => mut.mutate()} disabled={!form.label || mut.isPending} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#6366f1', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
          {mut.isPending ? 'Adding…' : 'Add Provider'}
        </button>
        <button onClick={onDone} style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
      </div>
    </div>
  )
}

// ─── Add Endpoint Form ────────────────────────────────────────────────────────

function AddEndpointForm({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({ name: '', type: 'ollama', base_url: '', api_key: '', model_ids: '', priority: '10' })
  const qc = useQueryClient()
  const { workspaceId } = useWorkspace()
  const api = makeApi(workspaceId)
  const mut = useMutation({
    mutationFn: () => api.addEndpoint({
      ...form, workspace_id: workspaceId,
      model_ids: form.model_ids.split(',').map((s) => s.trim()).filter(Boolean),
      priority: parseInt(form.priority),
      ...(form.api_key ? {} : { api_key: undefined }),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['rc-endpoints'] }); onDone() },
  })

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }))

  return (
    <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: 16, marginBottom: 12 }}>
      <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>Add Remote Endpoint</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
        <div>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Name</label>
          <input value={form.name} onChange={set('name')} placeholder="RunPod GPU #1" style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13, boxSizing: 'border-box' }} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Type</label>
          <select value={form.type} onChange={set('type')} style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13 }}>
            {ENDPOINT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div style={{ gridColumn: 'span 2' }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Base URL</label>
          <input value={form.base_url} onChange={set('base_url')} placeholder="https://..." style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13, boxSizing: 'border-box' }} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>API Key (optional)</label>
          <input type="password" value={form.api_key} onChange={set('api_key')} placeholder="optional" style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13, boxSizing: 'border-box' }} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Models (comma-sep)</label>
          <input value={form.model_ids} onChange={set('model_ids')} placeholder="llama3:70b, mistral:7b" style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13, boxSizing: 'border-box' }} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>Priority (lower = preferred)</label>
          <input type="number" value={form.priority} onChange={set('priority')} min="1" max="999" style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13, boxSizing: 'border-box' }} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => mut.mutate()} disabled={!form.name || !form.base_url || mut.isPending} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#0ea5e9', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
          {mut.isPending ? 'Adding…' : 'Add Endpoint'}
        </button>
        <button onClick={onDone} style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ProviderSettingsPage() {
  const [showAddConfig,   setShowAddConfig]   = useState(false)
  const [showAddEndpoint, setShowAddEndpoint] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const qc = useQueryClient()
  const { workspaceId } = useWorkspace()
  const api = makeApi(workspaceId)

  const { data: configData,   isLoading: cl, refetch: refetchC } = useQuery({ queryKey: ['rc-configs', workspaceId],    queryFn: api.configs,    refetchInterval: 30_000 })
  const { data: endpointData, isLoading: el, refetch: refetchE } = useQuery({ queryKey: ['rc-endpoints', workspaceId],  queryFn: api.endpoints,  refetchInterval: 30_000 })

  const delConfig   = useMutation({ mutationFn: api.delConfig,   onSuccess: () => qc.invalidateQueries({ queryKey: ['rc-configs'] }) })
  const delEndpoint = useMutation({ mutationFn: api.delEndpoint, onSuccess: () => qc.invalidateQueries({ queryKey: ['rc-endpoints'] }) })
  const checkEp     = useMutation({ mutationFn: api.checkEndpoint, onSuccess: () => qc.invalidateQueries({ queryKey: ['rc-endpoints'] }) })

  const configs   = configData?.data   ?? []
  const endpoints = endpointData?.data ?? []

  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--bg-primary)' }}>
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '24px 20px' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Provider Settings</h1>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>API keys are AES-256-GCM encrypted at rest. Keys shown as ••• after storage.</p>
          </div>
          <button onClick={() => { refetchC(); refetchE() }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
            <RefreshCw style={{ width: 14, height: 14 }} />
          </button>
        </div>

        {/* API Providers */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <h2 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', margin: 0 }}>
            <Zap style={{ width: 12, height: 12, display: 'inline', marginRight: 6 }} />API Providers
          </h2>
          <button onClick={() => setShowAddConfig((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer' }}>
            <Plus style={{ width: 12, height: 12 }} /> Add Provider
          </button>
        </div>

        {showAddConfig && <AddConfigForm onDone={() => setShowAddConfig(false)} />}

        <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 24 }}>
          {cl && <p style={{ padding: 16, color: 'var(--text-muted)', fontSize: 13 }}>Loading…</p>}
          {!cl && configs.length === 0 && (
            <p style={{ padding: 16, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>No API providers configured. Add one above.</p>
          )}
          {configs.map((c, i) => (
            <div key={c.id} style={{ padding: '12px 16px', borderBottom: i < configs.length - 1 ? '1px solid var(--border)' : 'none', display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{c.label}</span>
                  <Badge text={c.providerId} color="#6366f1" />
                  {!c.enabled && <Badge text="disabled" color="#f43f5e" />}
                  {c.hasApiKey && <Badge text="key set" color="#10b981" />}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  priority {c.priority} · updated {formatDistanceToNow(c.updatedAt, { addSuffix: true })}
                  {c.maxCostPerReqUsd !== null && ` · max $${c.maxCostPerReqUsd}/req`}
                </div>
              </div>
              <button onClick={() => delConfig.mutate(c.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
                <Trash2 style={{ width: 13, height: 13 }} />
              </button>
            </div>
          ))}
        </div>

        {/* Remote Endpoints */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <h2 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', margin: 0 }}>
            <Server style={{ width: 12, height: 12, display: 'inline', marginRight: 6 }} />Remote Endpoints
          </h2>
          <button onClick={() => setShowAddEndpoint((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer' }}>
            <Plus style={{ width: 12, height: 12 }} /> Add Endpoint
          </button>
        </div>

        {showAddEndpoint && <AddEndpointForm onDone={() => setShowAddEndpoint(false)} />}

        <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10 }}>
          {el && <p style={{ padding: 16, color: 'var(--text-muted)', fontSize: 13 }}>Loading…</p>}
          {!el && endpoints.length === 0 && (
            <p style={{ padding: 16, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>No remote endpoints. Add RunPod, Vast.ai, self-hosted Ollama, etc.</p>
          )}
          {endpoints.map((ep, i) => (
            <div key={ep.id}>
              <div style={{ padding: '12px 16px', borderBottom: i < endpoints.length - 1 && expanded !== ep.id ? '1px solid var(--border)' : 'none', display: 'flex', alignItems: 'center', gap: 12 }}>
                <button onClick={() => setExpanded(expanded === ep.id ? null : ep.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0 }}>
                  {expanded === ep.id ? <ChevronDown style={{ width: 12, height: 12 }} /> : <ChevronRight style={{ width: 12, height: 12 }} />}
                </button>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                    <HealthDot status={ep.healthStatus} />
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{ep.name}</span>
                    <Badge text={ep.type} color="#0ea5e9" />
                    {!ep.enabled && <Badge text="disabled" color="#f43f5e" />}
                    {ep.latencyMs !== null && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{ep.latencyMs.toFixed(0)}ms</span>}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    priority {ep.priority}
                    {ep.lastHealthCheck && ` · checked ${formatDistanceToNow(ep.lastHealthCheck, { addSuffix: true })}`}
                  </div>
                </div>
                <button onClick={() => checkEp.mutate(ep.id)} title="Health check" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
                  <RefreshCw style={{ width: 13, height: 13 }} />
                </button>
                <button onClick={() => delEndpoint.mutate(ep.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
                  <Trash2 style={{ width: 13, height: 13 }} />
                </button>
              </div>
              {expanded === ep.id && (
                <div style={{ padding: '8px 16px 12px 40px', background: 'var(--bg-primary)', borderBottom: i < endpoints.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
                    <strong>URL:</strong> <code style={{ fontSize: 11 }}>{ep.baseUrl}</code>
                  </div>
                  {ep.modelIds.length > 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
                      <strong>Models:</strong> {ep.modelIds.join(', ')}
                    </div>
                  )}
                  {ep.notes && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{ep.notes}</div>}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Fallback chain note */}
        <div style={{ marginTop: 20, padding: '10px 14px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8 }}>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
            <strong style={{ color: 'var(--text-secondary)' }}>Fallback chain:</strong> Requests route by task type. Private endpoints (lower priority) are preferred when healthy; API providers used as fallback. Hard stop when budget exceeded.
          </p>
        </div>

      </div>
    </div>
  )
}
