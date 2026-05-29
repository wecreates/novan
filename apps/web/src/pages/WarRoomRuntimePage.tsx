/**
 * War Room Runtime Control
 *
 * Full operational dashboard for the distributed runtime.
 * 6 panels: Overview · Providers · Workers · Budget+KillSwitches · Recovery · Events
 *
 * All data from real API endpoints. All actions emit runtime events.
 * Dangerous actions require inline confirmation.
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity, Cpu, Server, ShieldAlert, RotateCcw, Zap,
  AlertTriangle, XCircle, RefreshCw,
  Power, Pause, Play, AlertOctagon,
  Radio, Network, Bug,
} from 'lucide-react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

const API = '/api/v1'

// ─── Tiny shared primitives ───────────────────────────────────────────────────

function Dot({ ok, warn }: { ok?: boolean; warn?: boolean }) {
  const c = ok ? '#10b981' : warn ? '#f59e0b' : '#f43f5e'
  return <span style={{ display:'inline-block', width:8, height:8, borderRadius:'50%', background:c, flexShrink:0 }} />
}

function Badge({ label, color = '#64748b' }: { label: string; color?: string }) {
  return (
    <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:4,
      background:`${color}22`, color, border:`1px solid ${color}44`, letterSpacing:'0.04em' }}>
      {label.toUpperCase()}
    </span>
  )
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background:'var(--bg-elevated)', border:'1px solid var(--border)',
      borderRadius:10, padding:16, ...style }}>
      {children}
    </div>
  )
}

function Kpi({ label, value, sub, color = 'var(--text-primary)' }: {
  label: string; value: string | number; sub?: string; color?: string
}) {
  return (
    <Card>
      <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:4 }}>{label}</div>
      <div style={{ fontSize:26, fontWeight:700, color, lineHeight:1 }}>{value}</div>
      {sub && <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:4 }}>{sub}</div>}
    </Card>
  )
}

function SectionHeader({ title, onRefresh, loading }: { title: string; onRefresh?: () => void; loading?: boolean }) {
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
      <h2 style={{ margin:0, fontSize:15, fontWeight:700, color:'var(--text-primary)' }}>{title}</h2>
      {onRefresh && (
        <button onClick={onRefresh} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-muted)', padding:4 }}>
          <RefreshCw style={{ width:14, height:14, animation: loading ? 'spin 1s linear infinite' : 'none' }} />
        </button>
      )}
    </div>
  )
}

function Confirm({ message, onConfirm, onCancel, busy }: {
  message: string; onConfirm: () => void; onCancel: () => void; busy?: boolean
}) {
  return (
    <div style={{ background:'#f43f5e15', border:'1px solid #f43f5e44', borderRadius:8, padding:'10px 14px',
      display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
      <AlertTriangle style={{ width:14, height:14, color:'#f43f5e', flexShrink:0 }} />
      <span style={{ fontSize:12, color:'var(--text-secondary)', flex:1 }}>{message}</span>
      <button onClick={onCancel} disabled={busy}
        style={{ fontSize:12, padding:'4px 10px', borderRadius:6, border:'1px solid var(--border)',
          background:'var(--bg-elevated)', color:'var(--text-muted)', cursor:'pointer' }}>
        Cancel
      </button>
      <button onClick={onConfirm} disabled={busy}
        style={{ fontSize:12, padding:'4px 10px', borderRadius:6, border:'none',
          background:'#f43f5e', color:'#fff', cursor:'pointer', fontWeight:600 }}>
        {busy ? 'Working…' : 'Confirm'}
      </button>
    </div>
  )
}

// ─── API layer ────────────────────────────────────────────────────────────────

const post  = (url: string, body?: object) =>
  fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: body ? JSON.stringify(body) : null }).then((r) => r.json())
const del   = (url: string) => fetch(url, { method:'DELETE' }).then((r) => r.json())
const get   = (url: string) => fetch(url).then((r) => r.json())

// ─── Data hooks ───────────────────────────────────────────────────────────────

function useWorkerHealth() {
  return useQuery({ queryKey:['wroom-worker-health'], queryFn: () => get(`${API}/workers/health`), refetchInterval:15_000 })
}
function useWorkerQueues() {
  return useQuery({ queryKey:['wroom-worker-queues'], queryFn: () => get(`${API}/workers/queues`), refetchInterval:15_000 })
}
function useExecutionFabric() {
  const { workspaceId } = useWorkspace()
  return useQuery({
    queryKey:['wroom-fabric', workspaceId],
    queryFn: () => get(`${API}/runtime/fabric?workspace_id=${workspaceId}`),
    refetchInterval: 10_000,
  })
}
function useWorkerCosts() {
  const { workspaceId } = useWorkspace()
  return useQuery({
    queryKey:['wroom-worker-costs', workspaceId],
    queryFn: () => get(`${API}/runtime/workers/costs?workspace_id=${workspaceId}`),
    refetchInterval: 15_000,
  })
}
function useProviderHealth() {
  const { workspaceId } = useWorkspace()
  return useQuery({ queryKey:['wroom-prov-health', workspaceId], queryFn: () => get(`${API}/ai-router/health?workspace_id=${workspaceId}`), refetchInterval:20_000 })
}
function useRuntimeMode() {
  const { workspaceId } = useWorkspace()
  return useQuery({ queryKey:['wroom-mode', workspaceId], queryFn: () => get(`${API}/cloud-runtime/mode?workspaceId=${workspaceId}`), refetchInterval:30_000 })
}
function useBudgetCaps() {
  const { workspaceId } = useWorkspace()
  return useQuery({ queryKey:['wroom-caps', workspaceId], queryFn: () => get(`${API}/protection/budget-caps?workspaceId=${workspaceId}`), refetchInterval:60_000 })
}
function useKillSwitches() {
  const { workspaceId } = useWorkspace()
  return useQuery({ queryKey:['wroom-ks', workspaceId], queryFn: () => get(`${API}/protection/kill-switches?workspaceId=${workspaceId}`), refetchInterval:15_000 })
}
function useQueuePauses() {
  const { workspaceId } = useWorkspace()
  return useQuery({ queryKey:['wroom-qp', workspaceId], queryFn: () => get(`${API}/protection/queue-pauses?workspaceId=${workspaceId}`), refetchInterval:15_000 })
}
function useQuarantine() {
  const { workspaceId } = useWorkspace()
  return useQuery({ queryKey:['wroom-quarantine', workspaceId], queryFn: () => get(`${API}/protection/quarantine?workspaceId=${workspaceId}`), refetchInterval:20_000 })
}
function useReplayRuns() {
  const { workspaceId } = useWorkspace()
  return useQuery({ queryKey:['wroom-replays', workspaceId], queryFn: () => get(`${API}/recovery/replay-runs?workspaceId=${workspaceId}`), refetchInterval:30_000 })
}
function useStabilityHealth() {
  const { workspaceId } = useWorkspace()
  return useQuery({ queryKey:['wroom-stability', workspaceId], queryFn: () => get(`${API}/stability/health?workspaceId=${workspaceId}`), refetchInterval:20_000 })
}
function useRuntimeEvents() {
  const token = typeof localStorage !== 'undefined' ? (localStorage.getItem('ops_auth_token') ?? '') : ''
  return useQuery({
    queryKey:['wroom-events'],
    queryFn: () => fetch(`${API}/events`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json()),
    refetchInterval: 10_000,
  })
}

// ─── Tab: Overview ────────────────────────────────────────────────────────────

function OverviewTab() {
  const { data: wh, refetch: rWh, isFetching: fWh } = useWorkerHealth()
  const { data: ph }   = useProviderHealth()
  const { data: rm }   = useRuntimeMode()
  const { data: stab } = useStabilityHealth()

  const mode    = rm?.settings?.mode ?? 'unknown'
  const totals  = wh?.data?.totals ?? { waiting:0, active:0, completed:0, failed:0 }
  const providers = (ph?.data?.providers ?? []) as Array<{ provider:string; status:string; latencyMs:number|null; errorRate:number }>
  const activeP   = providers.filter((p) => p.status === 'healthy').length
  const offlineP  = providers.filter((p) => p.status !== 'healthy').length
  const health    = stab?.report

  const modeColor = mode === 'cloud-api-only' ? '#6366f1' : mode === 'hybrid' ? '#f59e0b' : '#10b981'
  const modeLabel = mode === 'cloud-api-only' ? 'CLOUD ONLY' : mode === 'hybrid' ? 'HYBRID' : mode === 'local' ? 'LOCAL' : mode.toUpperCase()

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      {/* Mode banner */}
      <div style={{ background:`${modeColor}15`, border:`1px solid ${modeColor}44`, borderRadius:10,
        padding:'12px 16px', display:'flex', alignItems:'center', gap:12 }}>
        <Cpu style={{ width:16, height:16, color:modeColor }} />
        <div style={{ flex:1 }}>
          <span style={{ fontSize:12, fontWeight:700, color:modeColor }}>Runtime Mode: {modeLabel}</span>
          {mode === 'cloud-api-only' && (
            <span style={{ fontSize:11, color:modeColor, marginLeft:12 }}>
              · No local GPU or browser compute active
            </span>
          )}
        </div>
        <Badge label={modeLabel} color={modeColor} />
      </div>

      {/* Health score */}
      {health && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(120px,1fr))', gap:10 }}>
          <Kpi label="Health Score" value={`${health.overall}/100`}
            color={health.overall > 70 ? '#10b981' : health.overall > 40 ? '#f59e0b' : '#f43f5e'} />
          <Kpi label="Stuck Workflows" value={health.stuckWorkflows}
            color={health.stuckWorkflows > 0 ? '#f43f5e' : 'var(--text-primary)'} />
          <Kpi label="Orphan Leases" value={health.orphanLeases}
            color={health.orphanLeases > 0 ? '#f59e0b' : 'var(--text-primary)'} />
          <Kpi label="Dead Workers" value={health.deadWorkers}
            color={health.deadWorkers > 0 ? '#f43f5e' : 'var(--text-primary)'} />
        </div>
      )}

      {/* Queue KPIs */}
      <SectionHeader title="Queue Totals" onRefresh={() => rWh()} loading={fWh} />
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(120px,1fr))', gap:10 }}>
        <Kpi label="Queued Jobs"       value={totals.waiting}   color="#6366f1" />
        <Kpi label="Active Executions" value={totals.active}    color="#10b981" />
        <Kpi label="Completed"         value={totals.completed} color="var(--text-muted)" />
        <Kpi label="Failed"            value={totals.failed}    color={totals.failed > 0 ? '#f43f5e' : 'var(--text-muted)'} />
        <Kpi label="Active Providers"  value={activeP}          color="#10b981" />
        <Kpi label="Offline Providers" value={offlineP}         color={offlineP > 0 ? '#f43f5e' : 'var(--text-muted)'} />
      </div>

      {/* Alerts */}
      {health && health.alerts.length > 0 && (
        <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
          <div style={{ fontSize:11, fontWeight:700, color:'var(--text-muted)', textTransform:'uppercase' }}>Active Alerts</div>
          {health.alerts.map((a: { level:string; component:string; message:string; value?:number }, i: number) => (
            <div key={i} style={{
              display:'flex', alignItems:'center', gap:10, padding:'8px 12px', borderRadius:8,
              background: a.level === 'critical' ? '#f43f5e15' : '#f59e0b15',
              border: `1px solid ${a.level === 'critical' ? '#f43f5e44' : '#f59e0b44'}`,
            }}>
              <AlertTriangle style={{ width:13, height:13, color: a.level === 'critical' ? '#f43f5e' : '#f59e0b', flexShrink:0 }} />
              <span style={{ fontSize:12, color:'var(--text-secondary)', flex:1 }}>{a.message}</span>
              <Badge label={a.level} color={a.level === 'critical' ? '#f43f5e' : '#f59e0b'} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Tab: Providers ───────────────────────────────────────────────────────────

function ProvidersTab() {
  const qc = useQueryClient()
  const { workspaceId: WS } = useWorkspace()
  const { data: ph, refetch, isFetching } = useProviderHealth()
  const { data: qd } = useQuarantine()
  const [confirm, setConfirm] = useState<{ providerId: string; action: 'quarantine'|'release' } | null>(null)
  const [busy, setBusy] = useState(false)

  const providers = (ph?.data?.providers ?? []) as Array<{ provider:string; status:string; latencyMs:number|null; errorRate:number }>
  const endpoints = (ph?.data?.endpoints ?? []) as Array<{ id:string; name:string; healthStatus:string; latencyMs:number|null }>
  const quarantined = new Set(((qd?.quarantine ?? []) as Array<{providerId:string}>).map((q) => q.providerId))

  const doQuarantine = async (providerId: string) => {
    setBusy(true)
    try {
      await post(`${API}/protection/quarantine/${providerId}`, { workspaceId: WS })
      void qc.invalidateQueries({ queryKey: ['wroom-quarantine'] })
      void refetch()
    } finally { setBusy(false); setConfirm(null) }
  }

  const doRelease = async (providerId: string) => {
    setBusy(true)
    try {
      await del(`${API}/protection/quarantine/${providerId}?workspaceId=${WS}`)
      void qc.invalidateQueries({ queryKey: ['wroom-quarantine'] })
      void refetch()
    } finally { setBusy(false); setConfirm(null) }
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      <SectionHeader title="Provider Health" onRefresh={() => refetch()} loading={isFetching} />

      {confirm && (
        <Confirm
          message={`${confirm.action === 'quarantine' ? 'Quarantine' : 'Release'} provider "${confirm.providerId}"? This affects routing immediately.`}
          onCancel={() => setConfirm(null)}
          onConfirm={() => confirm.action === 'quarantine' ? doQuarantine(confirm.providerId) : doRelease(confirm.providerId)}
          busy={busy}
        />
      )}

      <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
        {providers.length === 0 && (
          <Card><span style={{ fontSize:12, color:'var(--text-muted)' }}>No providers registered. Add providers in Provider Settings.</span></Card>
        )}
        {providers.map((p) => {
          const isQuar = quarantined.has(p.provider)
          const isOk   = p.status === 'healthy'
          return (
            <Card key={p.provider} style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
              <Dot ok={isOk && !isQuar} warn={!isOk && !isQuar} />
              <span style={{ fontSize:13, fontWeight:600, color:'var(--text-primary)', minWidth:100 }}>{p.provider}</span>
              <Badge label={isQuar ? 'QUARANTINED' : p.status} color={isQuar ? '#f43f5e' : isOk ? '#10b981' : '#f59e0b'} />
              <span style={{ fontSize:11, color:'var(--text-muted)', marginLeft:4 }}>
                {typeof p.latencyMs === 'number' ? `${p.latencyMs}ms` : 'no data'} · err {((p.errorRate ?? 0)*100).toFixed(1)}%
              </span>
              <div style={{ flex:1 }} />
              {isQuar ? (
                <button onClick={() => setConfirm({ providerId: p.provider, action: 'release' })}
                  style={{ fontSize:11, padding:'3px 10px', borderRadius:6, border:'1px solid #10b98144',
                    background:'#10b98115', color:'#10b981', cursor:'pointer' }}>
                  Release
                </button>
              ) : (
                <button onClick={() => setConfirm({ providerId: p.provider, action: 'quarantine' })}
                  style={{ fontSize:11, padding:'3px 10px', borderRadius:6, border:'1px solid #f43f5e44',
                    background:'#f43f5e15', color:'#f43f5e', cursor:'pointer' }}>
                  Quarantine
                </button>
              )}
            </Card>
          )
        })}
      </div>

      {endpoints.length > 0 && (
        <>
          <SectionHeader title="Remote Endpoints" />
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {endpoints.map((e) => (
              <Card key={e.id} style={{ display:'flex', alignItems:'center', gap:12 }}>
                <Dot ok={e.healthStatus === 'healthy'} warn={e.healthStatus === 'degraded'} />
                <span style={{ fontSize:13, fontWeight:600, color:'var(--text-primary)', flex:1 }}>{e.name}</span>
                <Badge label={e.healthStatus} color={e.healthStatus === 'healthy' ? '#10b981' : '#f59e0b'} />
                <span style={{ fontSize:11, color:'var(--text-muted)' }}>{typeof e.latencyMs === 'number' ? `${e.latencyMs}ms` : '—'}</span>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ─── Tab: Workers ─────────────────────────────────────────────────────────────

function WorkersTab() {
  const qc = useQueryClient()
  const { workspaceId: WS } = useWorkspace()
  const { data: wh, refetch, isFetching } = useWorkerHealth()
  const { data: wq } = useWorkerQueues()
  const [drBusy, setDrBusy]   = useState(false)
  const [drResult, setDrResult] = useState<{stuckWorkflows:number;orphanLeases:number;deadWorkers:number} | null>(null)
  const [confirmDr, setConfirmDr] = useState(false)

  const queues = (wh?.data?.queues ?? []) as Array<{ name:string; waiting:number; active:number; completed:number; failed:number; delayed:number }>
  const totals = wh?.data?.totals ?? { waiting:0, active:0, completed:0, failed:0 }

  const runDr = async () => {
    setDrBusy(true); setConfirmDr(false)
    try {
      const r = await post(`${API}/recovery/disaster-recovery/run`, { workspaceId: WS })
      setDrResult(r.report)
      void qc.invalidateQueries({ queryKey: ['wroom-worker-health'] })
    } finally { setDrBusy(false) }
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      <SectionHeader title="Queue Status" onRefresh={() => refetch()} loading={isFetching} />

      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(110px,1fr))', gap:10 }}>
        <Kpi label="Queued"    value={totals.waiting}   color="#6366f1" />
        <Kpi label="Active"    value={totals.active}    color="#10b981" />
        <Kpi label="Completed" value={totals.completed} color="var(--text-muted)" />
        <Kpi label="Failed"    value={totals.failed}    color={totals.failed > 0 ? '#f43f5e' : 'var(--text-muted)'} />
      </div>

      <div style={{ overflowX:'auto' }}>
        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
          <thead>
            <tr style={{ borderBottom:'1px solid var(--border)' }}>
              {['Queue','Waiting','Active','Failed','Delayed'].map((h) => (
                <th key={h} style={{ textAlign:'left', padding:'6px 10px', color:'var(--text-muted)', fontWeight:600, fontSize:11 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {queues.map((q) => (
              <tr key={q.name} style={{ borderBottom:'1px solid var(--border)' }}>
                <td style={{ padding:'7px 10px', color:'var(--text-primary)', fontWeight:600 }}>{q.name}</td>
                <td style={{ padding:'7px 10px', color: q.waiting > 0 ? '#6366f1' : 'var(--text-muted)' }}>{q.waiting}</td>
                <td style={{ padding:'7px 10px', color: q.active  > 0 ? '#10b981' : 'var(--text-muted)' }}>{q.active}</td>
                <td style={{ padding:'7px 10px', color: q.failed  > 0 ? '#f43f5e' : 'var(--text-muted)' }}>{q.failed}</td>
                <td style={{ padding:'7px 10px', color:'var(--text-muted)' }}>{q.delayed}</td>
              </tr>
            ))}
            {queues.length === 0 && (
              <tr><td colSpan={5} style={{ padding:'12px 10px', color:'var(--text-muted)', textAlign:'center' }}>No queue data available</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {(wq?.data ?? []).length > 0 && (
        <>
          <SectionHeader title="Recent Failures" />
          {(wq.data as Array<{name:string;recentFailures:Array<{id:string|undefined;name:string;failedReason:string;attemptsMade:number}>}>).map((q) =>
            q.recentFailures.map((f) => (
              <Card key={f.id ?? f.name} style={{ display:'flex', alignItems:'center', gap:10 }}>
                <XCircle style={{ width:13, height:13, color:'#f43f5e', flexShrink:0 }} />
                <span style={{ fontSize:12, color:'var(--text-secondary)', flex:1 }}>{q.name}/{f.name}</span>
                <span style={{ fontSize:11, color:'#f43f5e' }}>{f.failedReason?.slice(0,60) ?? 'Unknown'}</span>
                <span style={{ fontSize:11, color:'var(--text-muted)' }}>×{f.attemptsMade}</span>
              </Card>
            ))
          )}
        </>
      )}

      <SectionHeader title="Disaster Recovery" />
      {confirmDr ? (
        <Confirm
          message="Run disaster recovery? This will reclaim stale leases, mark dead workers offline, and recover stuck workflows."
          onCancel={() => setConfirmDr(false)}
          onConfirm={runDr}
          busy={drBusy}
        />
      ) : (
        <button onClick={() => setConfirmDr(true)} disabled={drBusy}
          style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, padding:'8px 14px',
            borderRadius:8, border:'1px solid var(--border)', background:'var(--bg-elevated)',
            color:'var(--text-secondary)', cursor:'pointer', width:'fit-content' }}>
          <RotateCcw style={{ width:13, height:13 }} />
          {drBusy ? 'Running…' : 'Run Disaster Recovery'}
        </button>
      )}
      {drResult && (
        <Card style={{ background:'#10b98115', border:'1px solid #10b98144' }}>
          <div style={{ fontSize:12, color:'#10b981', fontWeight:600, marginBottom:6 }}>✓ Recovery Complete</div>
          <div style={{ display:'flex', gap:16, fontSize:12, color:'var(--text-secondary)' }}>
            <span>Stuck workflows: <strong>{drResult.stuckWorkflows}</strong></span>
            <span>Orphan leases: <strong>{drResult.orphanLeases}</strong></span>
            <span>Dead workers: <strong>{drResult.deadWorkers}</strong></span>
          </div>
        </Card>
      )}
    </div>
  )
}

// ─── Tab: Budget + Kill Switches ──────────────────────────────────────────────

const KILL_SWITCH_TYPES = [
  { type:'remote_worker', label:'Remote Workers',  desc:'Stop all remote GPU / compute jobs'   },
  { type:'provider',      label:'AI Providers',    desc:'Block all cloud AI provider requests'  },
  { type:'browser_job',   label:'Browser Jobs',    desc:'Halt all automated browser sessions'   },
  { type:'ai_request',    label:'AI Requests',     desc:'Block all AI chat / embed requests'    },
] as const

const QUEUE_NAMES = ['workflow','browser','memory','analytics','recovery','optimization','notifications','briefing'] as const

function BudgetKillTab() {
  const qc = useQueryClient()
  const { workspaceId: WS } = useWorkspace()
  const { data: caps }        = useBudgetCaps()
  const { data: ksData, refetch: rKs } = useKillSwitches()
  const { data: qpData, refetch: rQp } = useQueuePauses()
  const [confirm, setConfirm] = useState<string | null>(null)
  const [busy, setBusy]       = useState<Record<string, boolean>>({})

  const switches = (ksData?.switches ?? []) as Array<{ switchType:string; enabled:boolean; reason:string|null }>
  const pauses   = (qpData?.pauses   ?? []) as Array<{ queueName:string; paused:boolean }>
  const budgetCaps = (caps?.caps     ?? []) as Array<{ id:string; scopeType:string; scopeId:string; maxDailyUsd:number|null; currentDailyUsd:number|null; enabled:boolean }>

  const switchMap = Object.fromEntries(switches.map((s) => [s.switchType, s]))
  const pauseMap  = Object.fromEntries(pauses.map((p) => [p.queueName, p]))

  const toggleSwitch = async (switchType: string, enable: boolean) => {
    if (enable && confirm !== switchType) { setConfirm(switchType); return }
    setBusy((b) => ({ ...b, [switchType]: true }))
    try {
      await post(`${API}/protection/kill-switches`, { workspaceId: WS, switchType, enabled: enable })
      void rKs()
      void qc.invalidateQueries({ queryKey: ['wroom-stability'] })
    } finally { setBusy((b) => ({ ...b, [switchType]: false })); setConfirm(null) }
  }

  const emergencyStop = async (enable: boolean) => {
    if (enable && confirm !== 'emergency') { setConfirm('emergency'); return }
    setBusy((b) => ({ ...b, emergency: true }))
    try {
      if (enable) await post(`${API}/protection/emergency-stop`, { workspaceId: WS })
      else        await del(`${API}/protection/emergency-stop?workspaceId=${WS}`)
      void rKs()
      void qc.invalidateQueries({ queryKey: ['wroom-stability'] })
    } finally { setBusy((b) => ({ ...b, emergency: false })); setConfirm(null) }
  }

  const toggleQueue = async (queueName: string, pause: boolean) => {
    setBusy((b) => ({ ...b, [`q-${queueName}`]: true }))
    try {
      const action = pause ? 'pause' : 'resume'
      await post(`${API}/protection/queue-pauses/${queueName}/${action}`, { workspaceId: WS })
      void rQp()
    } finally { setBusy((b) => ({ ...b, [`q-${queueName}`]: false })) }
  }

  const anyEnabled = switches.some((s) => s.enabled)

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:20 }}>

      {/* Emergency Stop */}
      <Card style={{ background: anyEnabled ? '#f43f5e10' : 'var(--bg-elevated)', border: anyEnabled ? '1px solid #f43f5e44' : '1px solid var(--border)' }}>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <Power style={{ width:18, height:18, color: anyEnabled ? '#f43f5e' : 'var(--text-muted)' }} />
          <div style={{ flex:1 }}>
            <div style={{ fontSize:14, fontWeight:700, color:'var(--text-primary)' }}>Emergency Stop</div>
            <div style={{ fontSize:11, color:'var(--text-muted)' }}>Activate all kill switches simultaneously</div>
          </div>
          {anyEnabled
            ? <button onClick={() => emergencyStop(false)} disabled={busy['emergency']}
                style={{ fontSize:12, padding:'6px 14px', borderRadius:8, border:'1px solid #10b98144',
                  background:'#10b98115', color:'#10b981', cursor:'pointer', fontWeight:600 }}>
                Clear All
              </button>
            : <button onClick={() => emergencyStop(true)} disabled={busy['emergency']}
                style={{ fontSize:12, padding:'6px 14px', borderRadius:8, border:'none',
                  background:'#f43f5e', color:'#fff', cursor:'pointer', fontWeight:700 }}>
                EMERGENCY STOP
              </button>
          }
        </div>
        {confirm === 'emergency' && (
          <div style={{ marginTop:12 }}>
            <Confirm message="This will block ALL remote workers, AI providers, browser jobs, and AI requests immediately."
              onCancel={() => setConfirm(null)} onConfirm={() => emergencyStop(true)} busy={busy['emergency'] ?? false} />
          </div>
        )}
      </Card>

      {/* Kill Switches */}
      <div>
        <SectionHeader title="Kill Switches" />
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {KILL_SWITCH_TYPES.map(({ type, label, desc }) => {
            const sw      = switchMap[type]
            const enabled = sw?.enabled ?? false
            return (
              <Card key={type} style={{ display:'flex', alignItems:'center', gap:12 }}>
                <Dot ok={!enabled} warn={false} />
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:13, fontWeight:600, color:'var(--text-primary)' }}>{label}</div>
                  <div style={{ fontSize:11, color:'var(--text-muted)' }}>{desc}</div>
                  {confirm === type && enabled === false && (
                    <div style={{ marginTop:8 }}>
                      <Confirm message={`Enable kill switch for "${label}"? This will immediately block those job types.`}
                        onCancel={() => setConfirm(null)} onConfirm={() => toggleSwitch(type, true)} busy={busy[type] ?? false} />
                    </div>
                  )}
                </div>
                {enabled
                  ? <button onClick={() => toggleSwitch(type, false)} disabled={busy[type]}
                      style={{ fontSize:11, padding:'4px 10px', borderRadius:6, border:'1px solid #10b98144',
                        background:'#10b98115', color:'#10b981', cursor:'pointer' }}>
                      Disable
                    </button>
                  : <button onClick={() => toggleSwitch(type, true)} disabled={busy[type]}
                      style={{ fontSize:11, padding:'4px 10px', borderRadius:6, border:'1px solid #f43f5e44',
                        background:'#f43f5e15', color:'#f43f5e', cursor:'pointer' }}>
                      Enable
                    </button>
                }
              </Card>
            )
          })}
        </div>
      </div>

      {/* Queue pauses */}
      <div>
        <SectionHeader title="Queue Control" />
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))', gap:8 }}>
          {QUEUE_NAMES.map((name) => {
            const paused = pauseMap[name]?.paused ?? false
            return (
              <Card key={name} style={{ display:'flex', alignItems:'center', gap:8 }}>
                <span style={{ fontSize:12, fontWeight:600, color:'var(--text-primary)', flex:1 }}>{name}</span>
                <button onClick={() => toggleQueue(name, !paused)} disabled={busy[`q-${name}`]}
                  title={paused ? 'Resume' : 'Pause'}
                  style={{ padding:4, borderRadius:6, border:'none', background:'none', cursor:'pointer',
                    color: paused ? '#10b981' : '#f59e0b' }}>
                  {paused ? <Play style={{ width:13, height:13 }} /> : <Pause style={{ width:13, height:13 }} />}
                </button>
              </Card>
            )
          })}
        </div>
      </div>

      {/* Budget caps */}
      {budgetCaps.length > 0 && (
        <div>
          <SectionHeader title="Budget Caps" />
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
              <thead>
                <tr style={{ borderBottom:'1px solid var(--border)' }}>
                  {['Scope','Type','Daily Limit','Daily Spent','Status'].map((h) => (
                    <th key={h} style={{ textAlign:'left', padding:'6px 10px', color:'var(--text-muted)', fontWeight:600, fontSize:11 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {budgetCaps.map((cap) => {
                  const pct     = cap.maxDailyUsd && typeof cap.currentDailyUsd === 'number'
                    ? Math.min(100, Math.round((cap.currentDailyUsd / cap.maxDailyUsd) * 100)) : null
                  const danger  = pct !== null && pct >= 90
                  return (
                    <tr key={cap.id} style={{ borderBottom:'1px solid var(--border)' }}>
                      <td style={{ padding:'7px 10px', color:'var(--text-primary)', fontWeight:600 }}>{cap.scopeId}</td>
                      <td style={{ padding:'7px 10px', color:'var(--text-muted)' }}>{cap.scopeType}</td>
                      <td style={{ padding:'7px 10px', color:'var(--text-secondary)' }}>${cap.maxDailyUsd ?? '—'}</td>
                      <td style={{ padding:'7px 10px', color: danger ? '#f43f5e' : 'var(--text-secondary)' }}>
                        ${cap.currentDailyUsd ?? 0}
                        {pct !== null && <span style={{ marginLeft:4, fontSize:10, color:'var(--text-muted)' }}>({pct}%)</span>}
                      </td>
                      <td style={{ padding:'7px 10px' }}>
                        <Badge label={cap.enabled ? (danger ? 'NEAR LIMIT' : 'ACTIVE') : 'DISABLED'}
                          color={cap.enabled ? (danger ? '#f43f5e' : '#10b981') : '#64748b'} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Tab: Recovery ────────────────────────────────────────────────────────────

function RecoveryTab() {
  const { workspaceId: WS } = useWorkspace()
  const { data: replays, refetch: rRep, isFetching: fRep } = useReplayRuns()
  const [replayBusy, setReplayBusy] = useState(false)
  const [replayMsg, setReplayMsg]   = useState<string | null>(null)

  const replayRuns = (replays?.runs ?? []) as Array<{
    id:string; sourceRunId:string; status:string;
    totalEvents:number; divergenceCount:number; startedAt:number; completedAt:number|null
  }>

  const startDr = async () => {
    setReplayBusy(true); setReplayMsg(null)
    try {
      const r = await post(`${API}/recovery/disaster-recovery/run`, { workspaceId: WS })
      setReplayMsg(`Recovery complete: ${r.report?.stuckWorkflows ?? 0} stuck, ${r.report?.orphanLeases ?? 0} orphans, ${r.report?.deadWorkers ?? 0} dead workers`)
    } catch { setReplayMsg('Recovery failed') }
    finally { setReplayBusy(false) }
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      <SectionHeader title="Replay Runs" onRefresh={() => rRep()} loading={fRep} />

      {replayRuns.length === 0 ? (
        <Card><span style={{ fontSize:12, color:'var(--text-muted)' }}>No replay runs recorded yet.</span></Card>
      ) : (
        <div style={{ overflowX:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
            <thead>
              <tr style={{ borderBottom:'1px solid var(--border)' }}>
                {['Source Run','Status','Events','Divergences','Started'].map((h) => (
                  <th key={h} style={{ textAlign:'left', padding:'6px 10px', color:'var(--text-muted)', fontWeight:600, fontSize:11 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {replayRuns.map((r) => (
                <tr key={r.id} style={{ borderBottom:'1px solid var(--border)' }}>
                  <td style={{ padding:'7px 10px', color:'var(--text-primary)', fontFamily:'monospace', fontSize:11 }}>{r.sourceRunId.slice(-12)}</td>
                  <td style={{ padding:'7px 10px' }}>
                    <Badge label={r.status} color={r.status === 'completed' ? '#10b981' : r.status === 'diverged' ? '#f59e0b' : '#6366f1'} />
                  </td>
                  <td style={{ padding:'7px 10px', color:'var(--text-secondary)' }}>{r.totalEvents}</td>
                  <td style={{ padding:'7px 10px', color: r.divergenceCount > 0 ? '#f43f5e' : 'var(--text-muted)' }}>{r.divergenceCount}</td>
                  <td style={{ padding:'7px 10px', color:'var(--text-muted)' }}>{new Date(r.startedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SectionHeader title="Disaster Recovery" />
      <button onClick={startDr} disabled={replayBusy}
        style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, padding:'8px 14px',
          borderRadius:8, border:'1px solid var(--border)', background:'var(--bg-elevated)',
          color:'var(--text-secondary)', cursor:'pointer', width:'fit-content' }}>
        <RotateCcw style={{ width:13, height:13 }} />
        {replayBusy ? 'Running…' : 'Run Disaster Recovery Now'}
      </button>
      {replayMsg && (
        <Card style={{ background:'#10b98115', border:'1px solid #10b98144' }}>
          <span style={{ fontSize:12, color:'#10b981' }}>{replayMsg}</span>
        </Card>
      )}
    </div>
  )
}

// ─── Tab: Event Timeline ──────────────────────────────────────────────────────

const RUNTIME_EVENT_TYPES = [
  'router.approved','router.blocked.mode','router.blocked.kill_switch','router.blocked.budget',
  'kill_switch.enabled','kill_switch.disabled','runtime.mode_changed',
  'user_cred.saved','user_cred.deleted','provider.key_validated',
  'chaos.simulation.started','run.cancelled','lease.cancelled',
  'recovery.stuck_workflows','recovery.orphan_leases','recovery.dead_workers',
  'replay.started','replay.completed','replay.diverged',
]

const EVENT_COLORS: Record<string, string> = {
  'router.approved':          '#10b981',
  'router.blocked.mode':      '#f43f5e',
  'router.blocked.kill_switch':'#f43f5e',
  'router.blocked.budget':    '#f59e0b',
  'kill_switch.enabled':      '#f43f5e',
  'kill_switch.disabled':     '#10b981',
  'runtime.mode_changed':     '#6366f1',
  'chaos.simulation.started': '#a855f7',
  'run.cancelled':            '#f59e0b',
  'lease.cancelled':          '#f59e0b',
  'replay.diverged':          '#f43f5e',
}

function EventsTab() {
  const { data, refetch, isFetching } = useRuntimeEvents()
  const [filter, setFilter] = useState<string>('all')

  const allEvents = (data?.data ?? []) as Array<{ id:string; type:string; payload:unknown; source:string; createdAt:number }>
  const filtered  = filter === 'all'
    ? allEvents.filter((e) => RUNTIME_EVENT_TYPES.some((t) => e.type.startsWith(t.split('.')[0]!)))
    : allEvents.filter((e) => e.type.startsWith(filter))

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
      <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
        <SectionHeader title="Runtime Event Timeline" onRefresh={() => refetch()} loading={isFetching} />
        <select value={filter} onChange={(e) => setFilter(e.target.value)}
          style={{ fontSize:12, padding:'4px 8px', borderRadius:6, border:'1px solid var(--border)',
            background:'var(--bg-elevated)', color:'var(--text-secondary)', marginLeft:'auto' }}>
          <option value="all">All Runtime Events</option>
          <option value="router">Router</option>
          <option value="kill_switch">Kill Switch</option>
          <option value="runtime">Runtime Mode</option>
          <option value="replay">Replay</option>
          <option value="run">Cancellation</option>
          <option value="chaos">Chaos</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <Card><span style={{ fontSize:12, color:'var(--text-muted)' }}>No runtime events yet. Events appear as routing decisions, kill switches, and recovery actions execute.</span></Card>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:6, maxHeight:500, overflowY:'auto' }}>
          {filtered.slice(0, 100).map((e) => {
            const color = EVENT_COLORS[e.type] ?? '#64748b'
            return (
              <div key={e.id} style={{ display:'flex', alignItems:'flex-start', gap:10, padding:'8px 12px',
                borderRadius:8, background:'var(--bg-elevated)', border:'1px solid var(--border)' }}>
                <Radio style={{ width:12, height:12, color, flexShrink:0, marginTop:2 }} />
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:2 }}>
                    <span style={{ fontSize:12, fontWeight:600, color }}>{e.type}</span>
                    <span style={{ fontSize:10, color:'var(--text-muted)' }}>{e.source}</span>
                  </div>
                  <div style={{ fontSize:11, color:'var(--text-muted)', fontFamily:'monospace',
                    whiteSpace:'pre-wrap', wordBreak:'break-all' }}>
                    {JSON.stringify(e.payload).slice(0, 200)}
                  </div>
                </div>
                <span style={{ fontSize:10, color:'var(--text-muted)', flexShrink:0, whiteSpace:'nowrap' }}>
                  {new Date(e.createdAt).toLocaleTimeString()}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

const TABS = [
  { id:'overview',  label:'Overview',       Icon: Activity    },
  { id:'providers', label:'Providers',      Icon: Server      },
  { id:'workers',   label:'Workers',        Icon: Cpu         },
  { id:'budget',    label:'Budget / KS',    Icon: ShieldAlert },
  { id:'recovery',  label:'Recovery',       Icon: RotateCcw   },
  { id:'fabric',    label:'Exec Fabric',    Icon: Network     },
  { id:'issues',    label:'Issues',         Icon: Bug         },
  { id:'events',    label:'Event Timeline', Icon: Zap         },
] as const

type TabId = typeof TABS[number]['id']

export default function WarRoomRuntimePage() {
  const [tab, setTab] = useState<TabId>('overview')

  const { data: stab } = useStabilityHealth()
  const health = stab?.report?.overall ?? null
  const healthColor = health === null ? '#64748b' : health > 70 ? '#10b981' : health > 40 ? '#f59e0b' : '#f43f5e'

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden', background:'var(--bg-primary)' }}>

      {/* Header */}
      <div style={{ flexShrink:0, borderBottom:'1px solid var(--border)', padding:'12px 20px',
        display:'flex', alignItems:'center', gap:16, background:'var(--bg-surface)' }}>
        <AlertOctagon style={{ width:18, height:18, color:'var(--text-secondary)' }} />
        <h1 style={{ margin:0, fontSize:16, fontWeight:700, color:'var(--text-primary)' }}>War Room — Runtime Control</h1>
        {health !== null && (
          <div style={{ display:'flex', alignItems:'center', gap:6, marginLeft:'auto' }}>
            <span style={{ fontSize:11, color:'var(--text-muted)' }}>System Health</span>
            <span style={{ fontSize:15, fontWeight:700, color: healthColor }}>{health}/100</span>
          </div>
        )}
      </div>

      {/* Tab bar */}
      <div style={{ flexShrink:0, display:'flex', borderBottom:'1px solid var(--border)',
        background:'var(--bg-surface)', overflowX:'auto' }}>
        {TABS.map(({ id, label, Icon }) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ display:'flex', alignItems:'center', gap:6, padding:'10px 16px',
              fontSize:12, fontWeight: tab === id ? 700 : 500, cursor:'pointer',
              border:'none', borderBottom: tab === id ? '2px solid #6366f1' : '2px solid transparent',
              background:'none', color: tab === id ? '#6366f1' : 'var(--text-muted)',
              whiteSpace:'nowrap' }}>
            <Icon style={{ width:13, height:13 }} />
            {label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex:1, overflow:'auto', padding:20 }}>
        {tab === 'overview'  && <OverviewTab />}
        {tab === 'providers' && <ProvidersTab />}
        {tab === 'workers'   && <WorkersTab />}
        {tab === 'budget'    && <BudgetKillTab />}
        {tab === 'recovery'  && <RecoveryTab />}
        {tab === 'fabric'    && <FabricTab />}
        {tab === 'issues'    && <IssuesTab />}
        {tab === 'events'    && <EventsTab />}
      </div>
    </div>
  )
}

// ─── Execution Fabric Tab ─────────────────────────────────────────────────────
// Shows what's local vs remote: local hardware (CPU load, memory), worker
// pool (alive count, by type, capability union), and which heavy job kinds
// have NO remote worker yet — i.e. would be blocked if requested.

interface FabricData {
  policy: string
  hardware: {
    cpuLoad1m: number; processMemMb: number; systemMemPct: number; cores: number
    cpuOverLimit: boolean; memOverLimit: boolean
  }
  workers: {
    total: number; alive: number
    byType: Record<string, number>
    capabilities: string[]
  }
  heavyKindsCovered:   string[]
  heavyKindsUncovered: string[]
}

interface WorkerCostRow {
  workerId: string; workerName: string; workerType: string
  endpointUrl: string | null; alive: boolean
  totalCostUsd: number; leases: number; completed: number; failed: number
}

function FabricTab() {
  const { data, isFetching, refetch } = useExecutionFabric() as {
    data?: { data?: FabricData }; isFetching: boolean; refetch: () => void
  }
  const { data: costData } = useWorkerCosts() as { data?: { data?: WorkerCostRow[] } }
  const costs = costData?.data ?? []
  const f = data?.data
  if (!f) {
    return <div style={{ color:'var(--text-muted)', fontSize:12 }}>Loading fabric snapshot…</div>
  }

  const policyOk    = f.policy === 'block'
  const cpuPct      = Math.round(f.hardware.cpuLoad1m * 100)
  const cpuColor    = f.hardware.cpuOverLimit ? '#f43f5e' : cpuPct > 50 ? '#f59e0b' : '#10b981'
  const memColor    = f.hardware.memOverLimit ? '#f43f5e' : f.hardware.systemMemPct > 60 ? '#f59e0b' : '#10b981'
  const coverColor  = f.heavyKindsUncovered.length === 0 ? '#10b981' : '#f59e0b'

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      {/* Policy banner */}
      <div style={{ background: policyOk ? '#10b98115' : '#f5970015',
        border: `1px solid ${policyOk ? '#10b98144' : '#f59e0b44'}`, borderRadius:10,
        padding:'12px 16px', display:'flex', alignItems:'center', gap:12 }}>
        <Network style={{ width:16, height:16, color: policyOk ? '#10b981' : '#f59e0b' }} />
        <div style={{ flex:1 }}>
          <span style={{ fontSize:12, fontWeight:700, color: policyOk ? '#10b981' : '#f59e0b' }}>
            Heavy-compute policy: {f.policy.toUpperCase()}
          </span>
          <span style={{ fontSize:11, color:'var(--text-muted)', marginLeft:10 }}>
            {policyOk
              ? 'Heavy jobs route to remote workers; local fallback is blocked.'
              : 'Heavy jobs may fall back to local execution if no remote worker is found.'}
          </span>
        </div>
        <button onClick={() => refetch()} disabled={isFetching}
          style={{ background:'var(--bg-elevated)', border:'1px solid var(--border)', borderRadius:6,
            padding:'4px 10px', fontSize:11, color:'var(--text-primary)', cursor:'pointer' }}>
          {isFetching ? '…' : 'Refresh'}
        </button>
      </div>

      {/* Local hardware */}
      <div>
        <h3 style={{ fontSize:10, fontWeight:700, letterSpacing:'0.08em', color:'var(--text-muted)',
          textTransform:'uppercase', margin:'0 0 8px 0' }}>Local hardware</h3>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(140px,1fr))', gap:10 }}>
          <Kpi label="CPU load (1m)" value={`${cpuPct}%`} color={cpuColor} />
          <Kpi label="System memory" value={`${f.hardware.systemMemPct}%`} color={memColor} />
          <Kpi label="API process RSS" value={`${f.hardware.processMemMb} MB`} color="var(--text-primary)" />
          <Kpi label="Cores" value={f.hardware.cores} color="var(--text-primary)" />
        </div>
        {(f.hardware.cpuOverLimit || f.hardware.memOverLimit) && (
          <div style={{ marginTop:8, fontSize:11, color:'#f43f5e' }}>
            ⚠ Local hardware over configured limits — heavy jobs will block until usage drops.
          </div>
        )}
      </div>

      {/* Worker pool */}
      <div>
        <h3 style={{ fontSize:10, fontWeight:700, letterSpacing:'0.08em', color:'var(--text-muted)',
          textTransform:'uppercase', margin:'0 0 8px 0' }}>Remote worker pool</h3>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(140px,1fr))', gap:10 }}>
          <Kpi label="Alive workers" value={f.workers.alive} color={f.workers.alive > 0 ? '#10b981' : '#f43f5e'} />
          <Kpi label="Registered total" value={f.workers.total} color="var(--text-primary)" />
          {Object.entries(f.workers.byType).map(([t, n]) => (
            <Kpi key={t} label={`type: ${t}`} value={n} color="var(--text-primary)" />
          ))}
        </div>
        {f.workers.capabilities.length > 0 && (
          <div style={{ marginTop:8, display:'flex', flexWrap:'wrap', gap:6 }}>
            {f.workers.capabilities.map(c =>
              <span key={c} style={{ fontSize:10, padding:'3px 8px', borderRadius:4,
                background:'#6366f122', color:'#a5b4fc', border:'1px solid #6366f144' }}>{c}</span>
            )}
          </div>
        )}
        {f.workers.alive === 0 && (
          <div style={{ marginTop:8, fontSize:11, color:'var(--text-muted)' }}>
            No remote workers registered. Register one with
            <code style={{ margin:'0 4px', padding:'1px 5px', background:'var(--bg-elevated)',
              borderRadius:3, fontSize:10 }}>POST /api/v1/runtime/workers</code>
            advertising the capabilities below.
          </div>
        )}
      </div>

      {/* Per-worker cost rollup */}
      {costs.length > 0 && (
        <div>
          <h3 style={{ fontSize:10, fontWeight:700, letterSpacing:'0.08em', color:'var(--text-muted)',
            textTransform:'uppercase', margin:'0 0 8px 0' }}>Cost by worker (lifetime)</h3>
          <div style={{ background:'var(--bg-elevated)', border:'1px solid var(--border)', borderRadius:8, overflow:'hidden' }}>
            <table style={{ width:'100%', fontSize:11, borderCollapse:'collapse' }}>
              <thead style={{ background:'var(--bg-surface)' }}>
                <tr>
                  <th style={{ textAlign:'left', padding:'6px 10px', color:'var(--text-muted)', fontWeight:600 }}>Worker</th>
                  <th style={{ textAlign:'left', padding:'6px 10px', color:'var(--text-muted)', fontWeight:600 }}>Type</th>
                  <th style={{ textAlign:'right', padding:'6px 10px', color:'var(--text-muted)', fontWeight:600 }}>Leases</th>
                  <th style={{ textAlign:'right', padding:'6px 10px', color:'var(--text-muted)', fontWeight:600 }}>Done / Failed</th>
                  <th style={{ textAlign:'right', padding:'6px 10px', color:'var(--text-muted)', fontWeight:600 }}>Total $</th>
                </tr>
              </thead>
              <tbody>
                {costs
                  .slice()
                  .sort((a, b) => b.totalCostUsd - a.totalCostUsd)
                  .map(w => (
                    <tr key={w.workerId} style={{ borderTop:'1px solid var(--border)' }}>
                      <td style={{ padding:'6px 10px', color:'var(--text-primary)' }}>
                        <Dot ok={w.alive} warn={!w.alive} /> <span style={{ marginLeft:6 }}>{w.workerName}</span>
                      </td>
                      <td style={{ padding:'6px 10px', color:'var(--text-secondary)' }}>{w.workerType}</td>
                      <td style={{ padding:'6px 10px', textAlign:'right', color:'var(--text-secondary)' }}>{w.leases}</td>
                      <td style={{ padding:'6px 10px', textAlign:'right', color:'var(--text-secondary)' }}>
                        <span style={{ color:'#10b981' }}>{w.completed}</span>
                        <span style={{ color:'var(--text-muted)' }}> / </span>
                        <span style={{ color: w.failed > 0 ? '#f43f5e' : 'var(--text-muted)' }}>{w.failed}</span>
                      </td>
                      <td style={{ padding:'6px 10px', textAlign:'right', color:'var(--text-primary)', fontWeight:600 }}>
                        ${w.totalCostUsd.toFixed(4)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Capability coverage */}
      <div>
        <h3 style={{ fontSize:10, fontWeight:700, letterSpacing:'0.08em', color:'var(--text-muted)',
          textTransform:'uppercase', margin:'0 0 8px 0' }}>Heavy-job coverage</h3>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
          <div style={{ background:'var(--bg-elevated)', border:'1px solid var(--border)',
            borderRadius:8, padding:12 }}>
            <div style={{ fontSize:11, fontWeight:600, color:'#10b981', marginBottom:6 }}>
              Covered ({f.heavyKindsCovered.length})
            </div>
            {f.heavyKindsCovered.length === 0
              ? <div style={{ fontSize:11, color:'var(--text-muted)' }}>—</div>
              : f.heavyKindsCovered.map(k =>
                  <div key={k} style={{ fontSize:11, color:'var(--text-secondary)', marginBottom:2 }}>● {k}</div>
                )}
          </div>
          <div style={{ background:'var(--bg-elevated)', border:'1px solid var(--border)',
            borderRadius:8, padding:12 }}>
            <div style={{ fontSize:11, fontWeight:600, color: coverColor, marginBottom:6 }}>
              No remote worker ({f.heavyKindsUncovered.length})
            </div>
            {f.heavyKindsUncovered.length === 0
              ? <div style={{ fontSize:11, color:'var(--text-muted)' }}>All covered.</div>
              : f.heavyKindsUncovered.map(k =>
                  <div key={k} style={{ fontSize:11, color:'var(--text-secondary)', marginBottom:2 }}>○ {k}</div>
                )}
          </div>
        </div>
        <div style={{ marginTop:8, fontSize:11, color:'var(--text-muted)' }}>
          Uncovered kinds are blocked locally by current policy. Register a worker that advertises
          the matching capability to enable them.
        </div>
      </div>
    </div>
  )
}

// ─── Issues Tab ───────────────────────────────────────────────────────────────
// Unified engineering ledger — symptom → diagnosis → patch → verification.

interface IssueRow {
  id: string; symptom: string; status: string; severity: string; source: string
  rootCause: string | null; affectedSystems: string[]
  proposalId: string | null; patchId: string | null; commitSha: string | null
  detectedAt: number; updatedAt: number
  evidence: Array<{ type: string; ref: string; summary: string; at: number }>
}

function useIssues(filters: { status?: string; severity?: string }) {
  const { workspaceId } = useWorkspace()
  const q = new URLSearchParams({ workspace_id: workspaceId })
  if (filters.status)   q.set('status',   filters.status)
  if (filters.severity) q.set('severity', filters.severity)
  return useQuery({
    queryKey:['wroom-issues', workspaceId, filters.status, filters.severity],
    queryFn: () => get(`${API}/issues?${q.toString()}`),
    refetchInterval: 15_000,
  })
}
function useIssueStats() {
  const { workspaceId } = useWorkspace()
  return useQuery({
    queryKey:['wroom-issue-stats', workspaceId],
    queryFn: () => get(`${API}/issues/stats?workspace_id=${workspaceId}`),
    refetchInterval: 30_000,
  })
}

function IssuesTab() {
  const { workspaceId } = useWorkspace()
  const [statusFilter, setStatusFilter] = useState<string>('')
  const { data: issuesData, refetch } = useIssues({ status: statusFilter }) as { data?: { data?: IssueRow[] }; refetch: () => void }
  const { data: statsData } = useIssueStats() as { data?: { data?: Array<{ status: string; severity: string; count: number }> } }
  const issues = issuesData?.data ?? []
  const stats  = statsData?.data ?? []

  // Roll stats into status totals + open-severity totals
  const byStatus = new Map<string, number>()
  const bySev    = new Map<string, number>()
  for (const s of stats) {
    byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + s.count)
    if (s.status !== 'closed' && s.status !== 'rejected') {
      bySev.set(s.severity, (bySev.get(s.severity) ?? 0) + s.count)
    }
  }

  async function ingestNow() {
    await fetch(`${API}/issues/auto-ingest`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace_id: workspaceId }),
    })
    refetch()
  }

  const statusColors: Record<string, string> = {
    open: '#f43f5e', triaged: '#f59e0b', diagnosed: '#6366f1',
    patched: '#a78bfa', verified: '#10b981', closed: '#64748b', rejected: '#475569',
  }
  const sevColors: Record<string, string> = {
    emergency: '#f43f5e', critical: '#f43f5e', warning: '#f59e0b', info: '#6366f1',
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      {/* Header w/ stats + actions */}
      <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          {['open','triaged','diagnosed','patched','verified','closed'].map(s => (
            <button key={s} onClick={() => setStatusFilter(statusFilter === s ? '' : s)}
              style={{ background: statusFilter === s ? `${statusColors[s]}33` : 'var(--bg-elevated)',
                border: `1px solid ${statusFilter === s ? statusColors[s] : 'var(--border)'}`,
                borderRadius: 6, padding: '4px 10px', fontSize: 11, color: 'var(--text-primary)',
                cursor: 'pointer', display:'flex', alignItems:'center', gap:6 }}>
              <span style={{ width:6, height:6, borderRadius:'50%', background: statusColors[s] }} />
              {s} <span style={{ color:'var(--text-muted)' }}>{byStatus.get(s) ?? 0}</span>
            </button>
          ))}
        </div>
        <button onClick={ingestNow}
          style={{ marginLeft:'auto', background:'#6366f122', border:'1px solid #6366f144',
            borderRadius:6, padding:'4px 10px', fontSize:11, color:'#a5b4fc', cursor:'pointer' }}>
          <RefreshCw style={{ width:11, height:11, marginRight:4, display:'inline' }} /> Auto-ingest now
        </button>
      </div>

      {/* Open-by-severity strip */}
      {bySev.size > 0 && (
        <div style={{ display:'flex', gap:10, fontSize:11 }}>
          <span style={{ color:'var(--text-muted)' }}>Open by severity:</span>
          {['emergency','critical','warning','info'].map(sev =>
            (bySev.get(sev) ?? 0) > 0 && (
              <span key={sev} style={{ color: sevColors[sev] }}>
                ● {sev} <strong>{bySev.get(sev)}</strong>
              </span>
            ),
          )}
        </div>
      )}

      {/* Issues table */}
      <div style={{ background:'var(--bg-elevated)', border:'1px solid var(--border)', borderRadius:8, overflow:'hidden' }}>
        <table style={{ width:'100%', fontSize:11, borderCollapse:'collapse' }}>
          <thead style={{ background:'var(--bg-surface)' }}>
            <tr>
              <th style={{ textAlign:'left', padding:'6px 10px', color:'var(--text-muted)', fontWeight:600, width:90 }}>Status</th>
              <th style={{ textAlign:'left', padding:'6px 10px', color:'var(--text-muted)', fontWeight:600, width:90 }}>Severity</th>
              <th style={{ textAlign:'left', padding:'6px 10px', color:'var(--text-muted)', fontWeight:600 }}>Symptom</th>
              <th style={{ textAlign:'left', padding:'6px 10px', color:'var(--text-muted)', fontWeight:600, width:120 }}>Source</th>
              <th style={{ textAlign:'right', padding:'6px 10px', color:'var(--text-muted)', fontWeight:600, width:90 }}>Evidence</th>
              <th style={{ textAlign:'right', padding:'6px 10px', color:'var(--text-muted)', fontWeight:600, width:120 }}>Detected</th>
            </tr>
          </thead>
          <tbody>
            {issues.length === 0 && (
              <tr><td colSpan={6} style={{ padding:'20px', textAlign:'center', color:'var(--text-muted)' }}>
                No issues match this filter.
              </td></tr>
            )}
            {issues.map(i => (
              <tr key={i.id} style={{ borderTop:'1px solid var(--border)' }}>
                <td style={{ padding:'6px 10px' }}>
                  <span style={{ fontSize:10, fontWeight:600, padding:'2px 6px', borderRadius:3,
                    background: `${statusColors[i.status] ?? '#64748b'}22`,
                    color: statusColors[i.status] ?? 'var(--text-secondary)' }}>{i.status}</span>
                </td>
                <td style={{ padding:'6px 10px', color: sevColors[i.severity] ?? 'var(--text-secondary)' }}>{i.severity}</td>
                <td style={{ padding:'6px 10px', color:'var(--text-primary)' }}>
                  {i.symptom}
                  {i.rootCause && (
                    <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:2 }}>
                      <strong>RC:</strong> {i.rootCause.slice(0, 120)}
                    </div>
                  )}
                  {i.affectedSystems.length > 0 && (
                    <div style={{ marginTop:3, display:'flex', gap:4, flexWrap:'wrap' }}>
                      {i.affectedSystems.slice(0, 5).map(s =>
                        <span key={s} style={{ fontSize:9, padding:'1px 5px', borderRadius:3,
                          background:'#6366f122', color:'#a5b4fc' }}>{s}</span>
                      )}
                    </div>
                  )}
                </td>
                <td style={{ padding:'6px 10px', color:'var(--text-secondary)', fontSize:10 }}>{i.source}</td>
                <td style={{ padding:'6px 10px', textAlign:'right', color:'var(--text-muted)' }}>
                  {i.evidence?.length ?? 0}
                </td>
                <td style={{ padding:'6px 10px', textAlign:'right', color:'var(--text-muted)', fontSize:10 }}>
                  {new Date(i.detectedAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize:11, color:'var(--text-muted)' }}>
        Auto-ingestion runs every 5 minutes from <code style={{ background:'var(--bg-elevated)', padding:'1px 4px', borderRadius:3 }}>cron.error</code> events
        and new incidents. Same-fingerprint events append evidence to the existing open issue instead of creating duplicates.
      </div>
    </div>
  )
}
