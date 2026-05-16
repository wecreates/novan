/**
 * AgentsPage — Agent Registry: list, register, heartbeat, status-change, deregister.
 */
import { useState }                                    from 'react'
import { useQuery, useMutation, useQueryClient }       from '@tanstack/react-query'
import { Bot, Plus, X, RefreshCw, ChevronDown, Inbox } from 'lucide-react'
import { agentApi, type Agent, type AgentStatus }      from '../api.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60)   return s + 's ago'
  if (s < 3600) return Math.floor(s / 60) + 'm ago'
  return Math.floor(s / 3600) + 'h ago'
}

const STATUS_FILTERS = ['all', 'idle', 'running', 'paused', 'offline', 'error'] as const
type FilterValue = typeof STATUS_FILTERS[number]

const STATUS_COLOR: Record<AgentStatus, string> = {
  idle:    'var(--color-green, #22c55e)',
  running: 'var(--color-blue,  #3b82f6)',
  paused:  'var(--color-yellow,#eab308)',
  offline: 'var(--color-gray,  #6b7280)',
  error:   'var(--color-red,   #ef4444)',
}

const STATUS_LABEL: Record<AgentStatus, string> = {
  idle:    'Idle',
  running: 'Running',
  paused:  'Paused',
  offline: 'Offline',
  error:   'Error',
}

// ─── Register form state ──────────────────────────────────────────────────────

interface RegisterForm {
  name:           string
  type:           string
  capabilities:   string
  maxConcurrency: string
  metadata:       string
}

const EMPTY_FORM: RegisterForm = {
  name:           '',
  type:           '',
  capabilities:   '',
  maxConcurrency: '1',
  metadata:       '',
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusDot({ status }: { status: AgentStatus }) {
  return (
    <span
      style={{
        display:         'inline-block',
        width:           8,
        height:          8,
        borderRadius:    '50%',
        backgroundColor: STATUS_COLOR[status],
        flexShrink:      0,
      }}
    />
  )
}

function Badge({ label }: { label: string }) {
  return (
    <span style={{
      fontSize:        11,
      padding:         '2px 7px',
      borderRadius:    4,
      background:      'var(--bg-elevated)',
      border:          '1px solid var(--border)',
      color:           'var(--text-muted)',
      whiteSpace:      'nowrap',
    }}>
      {label}
    </span>
  )
}

// ─── Agent card ───────────────────────────────────────────────────────────────

function AgentCard({ agent }: { agent: Agent }) {
  const qc = useQueryClient()
  const [statusOpen,    setStatusOpen]    = useState(false)
  const [pendingStatus, setPendingStatus] = useState<AgentStatus>(agent.status)

  const heartbeatMut = useMutation({
    mutationFn: () => agentApi.heartbeat(agent.id),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['agents'] }),
  })

  const setStatusMut = useMutation({
    mutationFn: (s: AgentStatus) => agentApi.setStatus(agent.id, s),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['agents'] })
      setStatusOpen(false)
    },
  })

  const removeMut = useMutation({
    mutationFn: () => agentApi.remove(agent.id),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['agents'] }),
  })

  const heartbeat = agent.heartbeatAt ?? agent.lastActiveAt ?? null

  return (
    <div style={{
      background:   'var(--bg-card, var(--bg-elevated))',
      border:       '1px solid var(--border)',
      borderRadius: 10,
      padding:      '16px 18px',
      display:      'flex',
      flexDirection:'column',
      gap:          12,
    }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>{agent.name}</span>
            <Badge label={agent.type} />
          </div>
          {agent.description && (
            <p style={{ marginTop: 2, fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {agent.description}
            </p>
          )}
        </div>
        {/* Status badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
          <StatusDot status={agent.status} />
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{STATUS_LABEL[agent.status]}</span>
        </div>
      </div>

      {/* Heartbeat */}
      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        Last heartbeat: {heartbeat ? timeAgo(heartbeat) : 'never'}
      </div>

      {/* Capabilities */}
      {agent.capabilities.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {agent.capabilities.map(c => <Badge key={c} label={c} />)}
        </div>
      )}

      {/* Current task (running) */}
      {agent.status === 'running' && typeof agent.config['currentTask'] === 'string' && (
        <div style={{
          fontSize:     12,
          color:        'var(--color-blue, #3b82f6)',
          background:   'rgba(59,130,246,0.08)',
          border:       '1px solid rgba(59,130,246,0.2)',
          borderRadius: 6,
          padding:      '5px 10px',
        }}>
          Task: {agent.config['currentTask'] as string}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
        {/* Heartbeat */}
        <button
          onClick={() => heartbeatMut.mutate()}
          disabled={heartbeatMut.isPending}
          style={actionBtn}
        >
          <RefreshCw size={12} style={{ flexShrink: 0 }} />
          {heartbeatMut.isPending ? 'Pinging…' : 'Heartbeat'}
        </button>

        {/* Status change */}
        <div style={{ position: 'relative' }}>
          <button onClick={() => setStatusOpen(o => !o)} style={actionBtn}>
            <ChevronDown size={12} style={{ flexShrink: 0 }} />
            Set Status
          </button>
          {statusOpen && (
            <div style={{
              position:   'absolute',
              top:        '110%',
              left:       0,
              zIndex:     50,
              background: 'var(--bg-elevated)',
              border:     '1px solid var(--border)',
              borderRadius: 8,
              padding:    4,
              minWidth:   140,
              boxShadow:  '0 4px 16px rgba(0,0,0,0.25)',
            }}>
              {(['idle', 'running', 'paused', 'offline'] as AgentStatus[]).map(s => (
                <button
                  key={s}
                  onClick={() => {
                    setPendingStatus(s)
                    setStatusMut.mutate(s)
                  }}
                  disabled={setStatusMut.isPending && pendingStatus === s}
                  style={{
                    ...dropdownItem,
                    color: s === agent.status ? 'var(--text-primary)' : 'var(--text-muted)',
                    fontWeight: s === agent.status ? 600 : 400,
                  }}
                >
                  <StatusDot status={s} />
                  {STATUS_LABEL[s]}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Deregister */}
        <button
          onClick={() => { if (confirm(`Deregister agent "${agent.name}"?`)) removeMut.mutate() }}
          disabled={removeMut.isPending}
          style={{ ...actionBtn, color: 'var(--color-red, #ef4444)', borderColor: 'rgba(239,68,68,0.25)' }}
        >
          <X size={12} style={{ flexShrink: 0 }} />
          {removeMut.isPending ? 'Removing…' : 'Deregister'}
        </button>
      </div>
    </div>
  )
}

// ─── Register drawer ──────────────────────────────────────────────────────────

function RegisterDrawer({ onClose }: { onClose: () => void }) {
  const qc   = useQueryClient()
  const [form, setForm] = useState<RegisterForm>(EMPTY_FORM)
  const [err,  setErr]  = useState('')

  const set = (k: keyof RegisterForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  const mut = useMutation({
    mutationFn: () => {
      const caps = form.capabilities.split(',').map(s => s.trim()).filter(Boolean)
      let config: Record<string, unknown> = {}
      if (form.metadata.trim()) {
        try { config = JSON.parse(form.metadata) as Record<string, unknown> }
        catch { throw new Error('Metadata is not valid JSON') }
      }
      const maxC = parseInt(form.maxConcurrency, 10)
      if (!isNaN(maxC) && maxC > 1) config['maxConcurrency'] = maxC
      return agentApi.register({
        name:         form.name.trim(),
        type:         form.type.trim(),
        ...(caps.length > 0 ? { capabilities: caps } : {}),
        ...(Object.keys(config).length > 0 ? { config } : {}),
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] })
      onClose()
    },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : 'Registration failed'),
  })

  return (
    <div style={{
      position:   'fixed',
      inset:      0,
      zIndex:     100,
      background: 'rgba(0,0,0,0.55)',
      display:    'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background:   'var(--bg-elevated)',
        border:       '1px solid var(--border)',
        borderRadius: 12,
        padding:      28,
        width:        460,
        maxWidth:     '95vw',
        display:      'flex',
        flexDirection:'column',
        gap:          16,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>Register Agent</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
            <X size={16} />
          </button>
        </div>

        {err && (
          <div style={{ fontSize: 12, color: 'var(--color-red, #ef4444)', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 6, padding: '6px 10px' }}>
            {err}
          </div>
        )}

        <label style={labelStyle}>
          Name *
          <input value={form.name}   onChange={set('name')}   placeholder="my-agent" style={inputStyle} />
        </label>
        <label style={labelStyle}>
          Type *
          <input value={form.type}   onChange={set('type')}   placeholder="worker / browser / llm…" style={inputStyle} />
        </label>
        <label style={labelStyle}>
          Capabilities <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(comma-separated)</span>
          <input value={form.capabilities} onChange={set('capabilities')} placeholder="scraping, summarization" style={inputStyle} />
        </label>
        <label style={labelStyle}>
          Max Concurrency
          <input value={form.maxConcurrency} onChange={set('maxConcurrency')} type="number" min={1} style={inputStyle} />
        </label>
        <label style={labelStyle}>
          Metadata <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(JSON, optional)</span>
          <textarea
            value={form.metadata}
            onChange={set('metadata')}
            placeholder='{"region":"us-east-1"}'
            rows={3}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }}
          />
        </label>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button onClick={onClose} style={actionBtn}>Cancel</button>
          <button
            onClick={() => { setErr(''); mut.mutate() }}
            disabled={!form.name.trim() || !form.type.trim() || mut.isPending}
            style={{ ...actionBtn, background: 'var(--accent, #3b82f6)', color: '#fff', borderColor: 'transparent', opacity: (!form.name.trim() || !form.type.trim() || mut.isPending) ? 0.5 : 1 }}
          >
            {mut.isPending ? 'Registering…' : 'Register'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const actionBtn: React.CSSProperties = {
  display:      'inline-flex',
  alignItems:   'center',
  gap:          5,
  fontSize:     12,
  padding:      '5px 10px',
  borderRadius: 6,
  border:       '1px solid var(--border)',
  background:   'var(--bg-elevated)',
  color:        'var(--text-muted)',
  cursor:       'pointer',
  whiteSpace:   'nowrap',
}

const dropdownItem: React.CSSProperties = {
  display:      'flex',
  alignItems:   'center',
  gap:          8,
  width:        '100%',
  fontSize:     13,
  padding:      '6px 10px',
  borderRadius: 6,
  border:       'none',
  background:   'none',
  cursor:       'pointer',
  textAlign:    'left',
}

const labelStyle: React.CSSProperties = {
  display:       'flex',
  flexDirection: 'column',
  gap:           5,
  fontSize:      13,
  fontWeight:    500,
  color:         'var(--text-primary)',
}

const inputStyle: React.CSSProperties = {
  padding:      '7px 10px',
  borderRadius: 6,
  border:       '1px solid var(--border)',
  background:   'var(--bg-surface, var(--bg-elevated))',
  color:        'var(--text-primary)',
  fontSize:     13,
  outline:      'none',
  width:        '100%',
  boxSizing:    'border-box',
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AgentsPage() {
  const [filter,       setFilter]       = useState<FilterValue>('all')
  const [showRegister, setShowRegister] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey:       ['agents', filter],
    queryFn:        () =>
      agentApi.list(filter !== 'all' ? { status: filter as AgentStatus } : undefined)
        .then(r => r.data),
    refetchInterval: 10_000,
  })

  const agents = data ?? []

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1200, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Bot size={22} style={{ color: 'var(--text-muted)' }} />
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>Agent Registry</h1>
          {!isLoading && (
            <span style={{
              fontSize: 12, padding: '2px 8px', borderRadius: 99,
              background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-muted)',
            }}>
              {agents.length}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {/* Status filter */}
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {STATUS_FILTERS.map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                style={{
                  ...actionBtn,
                  background:  filter === f ? 'var(--accent, #3b82f6)' : 'var(--bg-elevated)',
                  color:       filter === f ? '#fff'                    : 'var(--text-muted)',
                  borderColor: filter === f ? 'transparent'             : 'var(--border)',
                }}
              >
                {f === 'all' ? 'All' : STATUS_LABEL[f as AgentStatus]}
              </button>
            ))}
          </div>

          <button
            onClick={() => setShowRegister(true)}
            style={{ ...actionBtn, background: 'var(--accent, #3b82f6)', color: '#fff', borderColor: 'transparent' }}
          >
            <Plus size={13} />
            Register Agent
          </button>
        </div>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)', fontSize: 14 }}>Loading agents…</div>
      ) : agents.length === 0 ? (
        /* Empty state */
        <div style={{
          display:       'flex',
          flexDirection: 'column',
          alignItems:    'center',
          justifyContent:'center',
          gap:           12,
          padding:       80,
          color:         'var(--text-muted)',
        }}>
          <Inbox size={40} strokeWidth={1.2} />
          <span style={{ fontSize: 15, fontWeight: 500 }}>No agents registered</span>
          <span style={{ fontSize: 13 }}>Click "Register Agent" to add your first agent.</span>
        </div>
      ) : (
        <div style={{
          display:             'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          gap:                 16,
        }}>
          {agents.map(a => <AgentCard key={a.id} agent={a} />)}
        </div>
      )}

      {/* Register drawer */}
      {showRegister && <RegisterDrawer onClose={() => setShowRegister(false)} />}
    </div>
  )
}
