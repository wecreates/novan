/**
 * Launch Gate — Production Deployment Control
 *
 * Shows readiness score, blocking issues, deploy controls,
 * deployment history and rollback. All actions call real API routes.
 * Dangerous actions require inline confirmation.
 */
import { useState, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle, XCircle, AlertTriangle, Clock, RefreshCw,
  Rocket, Shield, ShieldCheck, ShieldAlert,
  ChevronRight, Loader2, AlertOctagon,
} from 'lucide-react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

const API = '/api/v1/launch'

// ─── Types ────────────────────────────────────────────────────────────────────

interface GateCheck {
  name:     string
  status:   'pass' | 'fail' | 'warn' | 'skip'
  message:  string
  blocking: boolean
}

interface ReadinessReport {
  ready:     boolean
  score:     number
  checks:    GateCheck[]
  blockers:  GateCheck[]
  warnings:  GateCheck[]
  checkedAt: number
}

type DeployStatus =
  | 'pending_approval' | 'pre_validating' | 'deploying'
  | 'post_validating'  | 'completed'      | 'failed' | 'rolled_back'

interface DeploymentRecord {
  id:                string
  workspaceId:       string
  description:       string
  status:            DeployStatus
  readinessReport:   ReadinessReport
  triggeredBy:       string
  approvedBy?:       string
  rollbackReason?:   string
  startedAt:         number
  completedAt?:      number
  rollbackTriggered: boolean
}

// ─── API ─────────────────────────────────────────────────────────────────────

const get  = (url: string) => fetch(url).then((r) => r.json())
const post = (url: string, body: object) =>
  fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) }).then((r) => r.json())

function makeApi(ws: string) {
  return {
    readiness:   () => get(`${API}/readiness?workspaceId=${ws}`) as Promise<{ report: ReadinessReport }>,
    checklist:   () => get(`${API}/checklist?workspaceId=${ws}`),
    deployments: () => get(`${API}/deployments?workspaceId=${ws}`) as Promise<{ deployments: DeploymentRecord[] }>,
    start:       (desc: string, requiresApproval: boolean) =>
      post(`${API}/deployments`, { workspaceId: ws, description: desc, requiresApproval, triggeredBy: 'ui' }),
    approve:     (id: string, approvedBy: string) =>
      post(`${API}/deployments/${id}/approve`, { workspaceId: ws, approvedBy }),
    complete:    (id: string, success: boolean) =>
      post(`${API}/deployments/${id}/complete`, { workspaceId: ws, success }),
    rollback:    (id: string, reason: string) =>
      post(`${API}/deployments/${id}/rollback`, { workspaceId: ws, reason }),
  }
}

// ─── Shared primitives ────────────────────────────────────────────────────────

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background:'var(--bg-elevated)', border:'1px solid var(--border)',
      borderRadius:10, padding:16, ...style }}>
      {children}
    </div>
  )
}

function StatusIcon({ status }: { status: GateCheck['status'] }) {
  if (status === 'pass') return <CheckCircle style={{ width:15, height:15, color:'#10b981', flexShrink:0 }} />
  if (status === 'fail') return <XCircle     style={{ width:15, height:15, color:'#f43f5e', flexShrink:0 }} />
  if (status === 'warn') return <AlertTriangle style={{ width:15, height:15, color:'#f59e0b', flexShrink:0 }} />
  return <Clock style={{ width:15, height:15, color:'#64748b', flexShrink:0 }} />
}

function Badge({ label, color = '#64748b' }: { label: string; color?: string }) {
  return (
    <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:4,
      background:`${color}22`, color, border:`1px solid ${color}44`, letterSpacing:'0.04em' }}>
      {label.toUpperCase()}
    </span>
  )
}

function DeployStatusBadge({ status }: { status: DeployStatus }) {
  const map: Record<DeployStatus, [string, string]> = {
    pending_approval: ['PENDING APPROVAL', '#6366f1'],
    pre_validating:   ['PRE-VALIDATING',   '#6366f1'],
    deploying:        ['DEPLOYING',        '#f59e0b'],
    post_validating:  ['POST-VALIDATING',  '#f59e0b'],
    completed:        ['COMPLETED',        '#10b981'],
    failed:           ['FAILED',           '#f43f5e'],
    rolled_back:      ['ROLLED BACK',      '#f43f5e'],
  }
  const [label, color] = map[status] ?? ['UNKNOWN', '#64748b']
  return <Badge label={label} color={color} />
}

function Confirm({ message, onConfirm, onCancel, busy, danger = true }: {
  message: string; onConfirm: () => void; onCancel: () => void; busy?: boolean; danger?: boolean
}) {
  return (
    <div style={{ background: danger ? '#f43f5e10' : '#6366f110',
      border: `1px solid ${danger ? '#f43f5e44' : '#6366f144'}`, borderRadius:8,
      padding:'10px 14px', display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
      <AlertTriangle style={{ width:14, height:14, color: danger ? '#f43f5e' : '#6366f1', flexShrink:0 }} />
      <span style={{ fontSize:12, color:'var(--text-secondary)', flex:1 }}>{message}</span>
      <button onClick={onCancel} disabled={busy}
        style={{ fontSize:12, padding:'4px 10px', borderRadius:6, border:'1px solid var(--border)',
          background:'var(--bg-elevated)', color:'var(--text-muted)', cursor:'pointer' }}>
        Cancel
      </button>
      <button onClick={onConfirm} disabled={busy}
        style={{ fontSize:12, padding:'4px 10px', borderRadius:6, border:'none',
          background: danger ? '#f43f5e' : '#6366f1', color:'#fff', cursor:'pointer', fontWeight:600 }}>
        {busy ? 'Working…' : 'Confirm'}
      </button>
    </div>
  )
}

// ─── Score ring ───────────────────────────────────────────────────────────────

function ScoreRing({ score, ready }: { score: number; ready: boolean }) {
  const r = 42; const c = 2 * Math.PI * r
  const dash = (score / 100) * c
  const color = !ready ? '#f43f5e' : score >= 80 ? '#10b981' : score >= 60 ? '#f59e0b' : '#f43f5e'
  return (
    <div style={{ position:'relative', width:110, height:110, flexShrink:0 }}>
      <svg width="110" height="110" style={{ transform:'rotate(-90deg)' }}>
        <circle cx="55" cy="55" r={r} fill="none" stroke="var(--border)" strokeWidth="8" />
        <circle cx="55" cy="55" r={r} fill="none" stroke={color} strokeWidth="8"
          strokeDasharray={`${dash} ${c}`} strokeLinecap="round"
          style={{ transition:'stroke-dasharray 0.5s ease' }} />
      </svg>
      <div style={{ position:'absolute', inset:0, display:'flex', flexDirection:'column',
        alignItems:'center', justifyContent:'center' }}>
        <span style={{ fontSize:24, fontWeight:800, color, lineHeight:1 }}>{score}</span>
        <span style={{ fontSize:10, color:'var(--text-muted)' }}>/ 100</span>
      </div>
    </div>
  )
}

// ─── Gate checklist ───────────────────────────────────────────────────────────

function GateChecklist({ checks }: { checks: GateCheck[] }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
      {checks.map((c) => (
        <div key={c.name} style={{ display:'flex', alignItems:'center', gap:10,
          padding:'8px 12px', borderRadius:8,
          background: c.status === 'fail' ? '#f43f5e08' : c.status === 'warn' ? '#f59e0b08' : 'transparent',
          border: `1px solid ${c.status === 'fail' ? '#f43f5e33' : c.status === 'warn' ? '#f59e0b33' : 'var(--border)'}` }}>
          <StatusIcon status={c.status} />
          <div style={{ flex:1 }}>
            <span style={{ fontSize:12, color:'var(--text-primary)', fontWeight:c.blocking && c.status==='fail' ? 700 : 500 }}>
              {c.name.replace(/_/g,' ')}
            </span>
            <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:1 }}>{c.message}</div>
          </div>
          {c.blocking && c.status === 'fail' && <Badge label="BLOCKING" color="#f43f5e" />}
        </div>
      ))}
    </div>
  )
}

// ─── Deploy controls ──────────────────────────────────────────────────────────

function DeployControls({ report, onDeploy }: { report: ReadinessReport; onDeploy: () => void }) {
  const [desc, setDesc]     = useState('')
  const [reqAppr, setReqAppr] = useState(true)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy]     = useState(false)

  const blocked = !report.ready || report.blockers.length > 0

  const handleDeploy = async () => {
    setBusy(true)
    try { await onDeploy() } finally { setBusy(false); setConfirm(false) }
  }

  return (
    <Card>
      <div style={{ fontSize:13, fontWeight:700, color:'var(--text-primary)', marginBottom:12 }}>
        Deploy Controls
      </div>
      {blocked && (
        <div style={{ padding:'8px 12px', borderRadius:8, background:'#f43f5e10',
          border:'1px solid #f43f5e33', marginBottom:12 }}>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <AlertOctagon style={{ width:13, height:13, color:'#f43f5e' }} />
            <span style={{ fontSize:12, color:'#f43f5e', fontWeight:600 }}>
              {report.blockers.length} blocking issue{report.blockers.length !== 1 ? 's' : ''} — deploy locked
            </span>
          </div>
        </div>
      )}
      <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
        <input value={desc} onChange={(e) => setDesc(e.target.value)}
          placeholder="Deployment description (required)"
          style={{ fontSize:12, padding:'8px 10px', borderRadius:8, border:'1px solid var(--border)',
            background:'var(--bg-primary)', color:'var(--text-primary)', outline:'none', width:'100%', boxSizing:'border-box' }} />
        <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer', fontSize:12, color:'var(--text-secondary)' }}>
          <input type="checkbox" checked={reqAppr} onChange={(e) => setReqAppr(e.target.checked)}
            style={{ width:13, height:13 }} />
          Require approval before deploying
        </label>
        {confirm ? (
          <Confirm
            message={`Deploy "${desc || '(no description)'}"? ${reqAppr ? 'Will require approval.' : 'Will deploy immediately.'}`}
            onCancel={() => setConfirm(false)}
            onConfirm={handleDeploy}
            busy={busy}
            danger={!reqAppr}
          />
        ) : (
          <button
            onClick={() => setConfirm(true)}
            disabled={blocked || !desc.trim() || busy}
            style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:8,
              fontSize:13, fontWeight:700, padding:'9px 16px', borderRadius:8, border:'none',
              background: blocked || !desc.trim() ? '#1e293b' : '#6366f1',
              color: blocked || !desc.trim() ? '#64748b' : '#fff', cursor: blocked || !desc.trim() ? 'not-allowed' : 'pointer',
              transition:'background 0.2s' }}>
            {busy ? <Loader2 style={{ width:13, height:13, animation:'spin 1s linear infinite' }} /> : <Rocket style={{ width:13, height:13 }} />}
            {busy ? 'Starting…' : 'Start Deployment'}
          </button>
        )}
      </div>
    </Card>
  )
}

// ─── Deployment history ───────────────────────────────────────────────────────

function DeploymentHistory({ deployments, onApprove, onRollback, onRefresh }: {
  deployments: DeploymentRecord[]
  onApprove:   (id: string) => Promise<void>
  onRollback:  (id: string, reason: string) => Promise<void>
  onRefresh:   () => void
}) {
  const [confirm, setConfirm] = useState<{ id: string; action: 'approve' | 'rollback' } | null>(null)
  const [busy, setBusy] = useState(false)

  const act = async () => {
    if (!confirm) return
    setBusy(true)
    try {
      if (confirm.action === 'approve') await onApprove(confirm.id)
      else await onRollback(confirm.id, 'Manual rollback from War Room')
    } finally { setBusy(false); setConfirm(null); onRefresh() }
  }

  if (deployments.length === 0) {
    return (
      <Card>
        <span style={{ fontSize:12, color:'var(--text-muted)' }}>No deployments recorded yet.</span>
      </Card>
    )
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
      {confirm && (
        <Confirm
          message={confirm.action === 'approve'
            ? 'Approve this deployment? It will proceed to the deploying stage.'
            : 'Rollback this deployment? This will attempt to restore the previous state.'}
          onCancel={() => setConfirm(null)}
          onConfirm={act}
          busy={busy}
        />
      )}
      {deployments.map((d) => {
        const isActive = ['pending_approval','deploying','pre_validating','post_validating'].includes(d.status)
        return (
          <Card key={d.id} style={{ display:'flex', flexDirection:'column', gap:10 }}>
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <DeployStatusBadge status={d.status} />
              <span style={{ fontSize:13, fontWeight:600, color:'var(--text-primary)', flex:1 }}>
                {d.description}
              </span>
              <span style={{ fontSize:11, color:'var(--text-muted)' }}>
                {new Date(d.startedAt).toLocaleString()}
              </span>
            </div>
            <div style={{ display:'flex', gap:12, fontSize:11, color:'var(--text-muted)' }}>
              <span>By: {d.triggeredBy}</span>
              {d.approvedBy && <span>Approved by: {d.approvedBy}</span>}
              {d.rollbackReason && <span style={{ color:'#f43f5e' }}>Rollback: {d.rollbackReason}</span>}
              <span>Score: {d.readinessReport.score}/100</span>
            </div>
            {isActive && (
              <div style={{ display:'flex', gap:8 }}>
                {d.status === 'pending_approval' && (
                  <button onClick={() => setConfirm({ id: d.id, action: 'approve' })}
                    style={{ fontSize:11, padding:'4px 10px', borderRadius:6, border:'1px solid #10b98144',
                      background:'#10b98115', color:'#10b981', cursor:'pointer' }}>
                    Approve
                  </button>
                )}
                {['deploying','pending_approval'].includes(d.status) && (
                  <button onClick={() => setConfirm({ id: d.id, action: 'rollback' })}
                    style={{ fontSize:11, padding:'4px 10px', borderRadius:6, border:'1px solid #f43f5e44',
                      background:'#f43f5e15', color:'#f43f5e', cursor:'pointer' }}>
                    Rollback
                  </button>
                )}
              </div>
            )}
          </Card>
        )
      })}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function LaunchGatePage() {
  const qc = useQueryClient()
  const { workspaceId } = useWorkspace()
  const launchApi = makeApi(workspaceId)

  const { data: rData, refetch: refetchR, isFetching: fetchingR } = useQuery({
    queryKey: ['launch-readiness', workspaceId],
    queryFn:  launchApi.readiness,
    refetchInterval: 30_000,
  })
  const { data: dData, refetch: refetchD } = useQuery({
    queryKey: ['launch-deployments', workspaceId],
    queryFn:  launchApi.deployments,
    refetchInterval: 10_000,
  })

  const report      = rData?.report
  const deployments = dData?.deployments ?? []

  const startDeploy = useMutation({
    mutationFn: async ({ desc, requiresApproval }: { desc: string; requiresApproval: boolean }) => {
      return launchApi.start(desc, requiresApproval)
    },
    onSettled: () => { void refetchD() },
  })

  const approve = useCallback(async (id: string) => {
    await launchApi.approve(id, 'operator')
    void qc.invalidateQueries({ queryKey: ['launch-deployments', workspaceId] })
  }, [qc, workspaceId]) 
  const rollback = useCallback(async (id: string, reason: string) => {
    await launchApi.rollback(id, reason)
    void qc.invalidateQueries({ queryKey: ['launch-deployments', workspaceId] })
  }, [qc, workspaceId]) 
  // Deploy trigger called from DeployControls
  const [pendingDeploy, setPendingDeploy] = useState<{ desc: string; requiresApproval: boolean } | null>(null)

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden', background:'var(--bg-primary)' }}>

      {/* Header */}
      <div style={{ flexShrink:0, borderBottom:'1px solid var(--border)', padding:'12px 20px',
        display:'flex', alignItems:'center', gap:16, background:'var(--bg-surface)' }}>
        <Shield style={{ width:18, height:18, color:'var(--text-secondary)' }} />
        <h1 style={{ margin:0, fontSize:16, fontWeight:700, color:'var(--text-primary)' }}>Launch Gate</h1>
        {report && (
          <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:8 }}>
            {report.ready
              ? <ShieldCheck style={{ width:16, height:16, color:'#10b981' }} />
              : <ShieldAlert style={{ width:16, height:16, color:'#f43f5e' }} />}
            <span style={{ fontSize:13, fontWeight:700,
              color: report.ready ? '#10b981' : '#f43f5e' }}>
              {report.ready ? 'Ready to Deploy' : `${report.blockers.length} blocker${report.blockers.length !== 1 ? 's' : ''}`}
            </span>
          </div>
        )}
        <button onClick={() => { void refetchR(); void refetchD() }} disabled={fetchingR}
          style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-muted)', padding:4 }}>
          <RefreshCw style={{ width:14, height:14, animation: fetchingR ? 'spin 1s linear infinite' : 'none' }} />
        </button>
      </div>

      <div style={{ flex:1, overflow:'auto', padding:20, display:'flex', flexDirection:'column', gap:20 }}>

        {/* Readiness section */}
        {report ? (
          <div style={{ display:'grid', gridTemplateColumns:'auto 1fr', gap:20, alignItems:'start' }}>
            {/* Score ring */}
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:8 }}>
              <ScoreRing score={report.score} ready={report.ready} />
              <span style={{ fontSize:11, color:'var(--text-muted)' }}>
                Checked {new Date(report.checkedAt).toLocaleTimeString()}
              </span>
            </div>

            {/* Checks */}
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              {report.blockers.length > 0 && (
                <Card style={{ background:'#f43f5e08', border:'1px solid #f43f5e33' }}>
                  <div style={{ fontSize:12, fontWeight:700, color:'#f43f5e', marginBottom:8 }}>
                    🚫 {report.blockers.length} Blocking Issue{report.blockers.length !== 1 ? 's' : ''}
                  </div>
                  {report.blockers.map((b) => (
                    <div key={b.name} style={{ fontSize:12, color:'#f43f5e', display:'flex', gap:8, marginBottom:4 }}>
                      <ChevronRight style={{ width:12, height:12, flexShrink:0, marginTop:1 }} />
                      <span><strong>{b.name.replace(/_/g,' ')}</strong>: {b.message}</span>
                    </div>
                  ))}
                </Card>
              )}
              {report.warnings.length > 0 && (
                <Card style={{ background:'#f59e0b08', border:'1px solid #f59e0b33' }}>
                  <div style={{ fontSize:12, fontWeight:700, color:'#f59e0b', marginBottom:8 }}>
                    ⚠ {report.warnings.length} Warning{report.warnings.length !== 1 ? 's' : ''}
                  </div>
                  {report.warnings.map((w) => (
                    <div key={w.name} style={{ fontSize:12, color:'#f59e0b', display:'flex', gap:8, marginBottom:4 }}>
                      <ChevronRight style={{ width:12, height:12, flexShrink:0, marginTop:1 }} />
                      <span><strong>{w.name.replace(/_/g,' ')}</strong>: {w.message}</span>
                    </div>
                  ))}
                </Card>
              )}
            </div>
          </div>
        ) : (
          <Card style={{ display:'flex', alignItems:'center', gap:10 }}>
            <Loader2 style={{ width:16, height:16, color:'#6366f1', animation:'spin 1s linear infinite' }} />
            <span style={{ fontSize:12, color:'var(--text-muted)' }}>Running readiness checks…</span>
          </Card>
        )}

        {/* Gate checklist */}
        {report && (
          <div>
            <div style={{ fontSize:12, fontWeight:700, color:'var(--text-muted)',
              textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:10 }}>
              Gate Checklist
            </div>
            <GateChecklist checks={report.checks} />
          </div>
        )}

        {/* Deploy controls */}
        {report && (
          <DeployControls
            report={report}
            onDeploy={async () => {
              if (pendingDeploy) {
                await startDeploy.mutateAsync(pendingDeploy)
                setPendingDeploy(null)
              }
            }}
          />
        )}

        {/* Simplified inline deploy form when no report loading */}
        {report && (
          <Card>
            <div style={{ fontSize:13, fontWeight:700, color:'var(--text-primary)', marginBottom:12 }}>
              Quick Deploy
            </div>
            <QuickDeployForm
              blocked={!report.ready}
              onSubmit={async (desc, requiresApproval) => {
                await startDeploy.mutateAsync({ desc, requiresApproval })
                void refetchD()
              }}
            />
          </Card>
        )}

        {/* Deployment history */}
        <div>
          <div style={{ fontSize:12, fontWeight:700, color:'var(--text-muted)',
            textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:10 }}>
            Deployment History
          </div>
          <DeploymentHistory
            deployments={deployments}
            onApprove={approve}
            onRollback={rollback}
            onRefresh={() => refetchD()}
          />
        </div>
      </div>
    </div>
  )
}

// ─── Quick deploy form (inline, used in the simplified block) ─────────────────

function QuickDeployForm({ blocked, onSubmit }: {
  blocked: boolean
  onSubmit: (desc: string, requiresApproval: boolean) => Promise<void>
}) {
  const [desc, setDesc]     = useState('')
  const [reqAppr, setReqAppr] = useState(true)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy]     = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    try {
      await onSubmit(desc, reqAppr)
      setResult('Deployment started')
      setDesc('')
      setConfirm(false)
    } catch { setResult('Failed to start deployment') }
    finally { setBusy(false) }
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
      <div style={{ display:'flex', gap:8 }}>
        <input value={desc} onChange={(e) => setDesc(e.target.value)}
          placeholder="Describe this deployment…"
          style={{ flex:1, fontSize:12, padding:'8px 10px', borderRadius:8,
            border:'1px solid var(--border)', background:'var(--bg-primary)',
            color:'var(--text-primary)', outline:'none' }} />
        <label style={{ display:'flex', alignItems:'center', gap:6, cursor:'pointer',
          fontSize:12, color:'var(--text-muted)', whiteSpace:'nowrap' }}>
          <input type="checkbox" checked={reqAppr} onChange={(e) => setReqAppr(e.target.checked)} />
          Require approval
        </label>
      </div>
      {confirm ? (
        <Confirm
          message={`Deploy "${desc}"? ${reqAppr ? 'Approval required before go-live.' : 'Will deploy immediately — no gate.'}`}
          onCancel={() => setConfirm(false)}
          onConfirm={submit}
          busy={busy}
          danger={!reqAppr}
        />
      ) : (
        <button onClick={() => setConfirm(true)}
          disabled={blocked || !desc.trim() || busy}
          style={{ display:'flex', alignItems:'center', gap:8, fontSize:12, padding:'7px 14px',
            borderRadius:8, border:'none', width:'fit-content',
            background: blocked || !desc.trim() ? '#1e293b' : '#6366f1',
            color: blocked || !desc.trim() ? '#64748b' : '#fff',
            cursor: blocked || !desc.trim() ? 'not-allowed' : 'pointer', fontWeight:600 }}>
          <Rocket style={{ width:12, height:12 }} />
          {busy ? 'Starting…' : blocked ? 'Blocked — fix issues first' : 'Deploy'}
        </button>
      )}
      {result && (
        <div style={{ fontSize:11, color:'#10b981', padding:'4px 0' }}>{result}</div>
      )}
    </div>
  )
}
