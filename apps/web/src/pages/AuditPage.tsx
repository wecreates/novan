/**
 * Strategic War Room Audit View
 *
 * Runs a full-repo audit and shows:
 *   - Summary: total gaps, critical blockers, unsafe mocks, missing tests
 *   - Findings by category with severity badges
 *   - Prioritised build task queue
 *   - Approval-required tasks highlighted
 *
 * Every finding references a real file + line number.
 * No fake data displayed.
 */
import { useState }                          from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ScanSearch, AlertTriangle, XCircle,
  ShieldAlert, RefreshCw, Play, ChevronDown, ChevronRight,
  FileCode, TestTube, Wrench, Lock,
} from 'lucide-react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

const API = '/api/v1/audit'

// ─── Types ────────────────────────────────────────────────────────────────────

type Severity = 'critical' | 'high' | 'medium' | 'low'
type Category =
  | 'critical_runtime' | 'security' | 'budget_cost' | 'replay_rollback'
  | 'provider_routing' | 'ui_wiring' | 'testing' | 'polish'

interface AuditRun {
  id: string; workspaceId: string; status: string
  filesScanned: number; findingCount: number; criticalCount: number
  highCount: number; taskCount: number; completedAt: number | null
  createdAt: number; errorMessage: string | null
}

interface Finding {
  id: string; category: Category; severity: Severity; patternId: string
  filePath: string; lineNumber: number; matchedText: string
  description: string; suggestion: string
}

interface BuildTask {
  id: string; title: string; description: string; category: Category
  severity: Severity; priority: number; status: string
  requiresApproval: boolean; assignedAgent: string | null
  blastRadius: string; filePath: string | null
}

interface AuditSummary {
  runId: string; filesScanned: number; findingCount: number
  criticalCount: number; highCount: number; taskCount: number
  byCategory: Record<string, number>; bySeverity: Record<string, number>
  topTasks: Array<{ id: string; title: string; severity: string; priority: number; requiresApproval: boolean }>
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SEV_COLOR: Record<Severity, string> = {
  critical: '#f43f5e', high: '#f97316', medium: '#f59e0b', low: '#6b7280',
}

const CAT_LABEL: Record<Category, string> = {
  critical_runtime: 'Critical Runtime', security: 'Security',
  budget_cost: 'Budget/Cost', replay_rollback: 'Replay/Rollback',
  provider_routing: 'Provider Routing', ui_wiring: 'UI Wiring',
  testing: 'Testing Gap', polish: 'Polish',
}

const CAT_ICON: Record<Category, typeof ScanSearch> = {
  critical_runtime: XCircle, security: ShieldAlert, budget_cost: AlertTriangle,
  replay_rollback: RefreshCw, provider_routing: AlertTriangle,
  ui_wiring: FileCode, testing: TestTube, polish: Wrench,
}

function SevBadge({ severity }: { severity: Severity | string }) {
  const color = SEV_COLOR[severity as Severity] ?? '#6b7280'
  return (
    <span style={{
      fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 4,
      background: `${color}22`, color, border: `1px solid ${color}44`,
      textTransform: 'uppercase', letterSpacing: '0.06em', flexShrink: 0,
    }}>{severity}</span>
  )
}

function shortPath(p: string | null): string {
  if (!p) return ''
  const parts = p.replace(/\\/g, '/').split('/')
  return parts.slice(-3).join('/')
}

// ─── Summary Cards ────────────────────────────────────────────────────────────

function SummaryCard({ label, value, color, icon: Icon }: {
  label: string; value: number | string; color: string; icon: typeof ScanSearch
}) {
  return (
    <div style={{
      background: 'var(--bg-elevated)', border: `1px solid ${color}33`,
      borderRadius: 10, padding: '12px 16px', flex: 1, minWidth: 120,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <Icon style={{ width: 13, height: 13, color }} />
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</span>
      </div>
      <div style={{ fontSize: 28, fontWeight: 800, color }}>{value}</div>
    </div>
  )
}

// ─── Category breakdown ───────────────────────────────────────────────────────

function CategoryBreakdown({ byCategory, bySeverity }: {
  byCategory: Record<string, number>; bySeverity: Record<string, number>
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
      <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>By Category</div>
        {Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([cat, count]) => {
          const Icon = CAT_ICON[cat as Category] ?? FileCode
          return (
            <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
              <Icon style={{ width: 11, height: 11, color: 'var(--text-muted)', flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: 'var(--text-secondary)', flex: 1 }}>{CAT_LABEL[cat as Category] ?? cat}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>{count}</span>
            </div>
          )
        })}
      </div>
      <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>By Severity</div>
        {(['critical', 'high', 'medium', 'low'] as Severity[]).map(sev => {
          const count = bySeverity[sev] ?? 0
          if (!count) return null
          return (
            <div key={sev} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: SEV_COLOR[sev], flexShrink: 0 }} />
              <span style={{ fontSize: 11, color: 'var(--text-secondary)', flex: 1, textTransform: 'capitalize' }}>{sev}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: SEV_COLOR[sev] }}>{count}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Finding row ──────────────────────────────────────────────────────────────

function FindingRow({ finding }: { finding: Finding }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ borderBottom: '1px solid var(--border)', padding: '8px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
        onClick={() => setOpen(!open)}>
        {open
          ? <ChevronDown style={{ width: 11, height: 11, color: 'var(--text-muted)', flexShrink: 0 }} />
          : <ChevronRight style={{ width: 11, height: 11, color: 'var(--text-muted)', flexShrink: 0 }} />}
        <SevBadge severity={finding.severity} />
        <span style={{ fontSize: 11, color: 'var(--text-primary)', flex: 1 }}>{finding.description}</span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
          {shortPath(finding.filePath)}:{finding.lineNumber}
        </span>
      </div>
      {open && (
        <div style={{ marginTop: 6, marginLeft: 19, padding: 8, background: 'var(--bg-primary)', borderRadius: 6, border: '1px solid var(--border)' }}>
          <div style={{ fontSize: 10, fontFamily: 'monospace', color: '#f59e0b', marginBottom: 4, wordBreak: 'break-all' }}>
            {finding.matchedText}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
            💡 {finding.suggestion}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
            {finding.filePath}:{finding.lineNumber}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Build task row ───────────────────────────────────────────────────────────

function TaskRow({ task, onDispatch }: { task: BuildTask; onDispatch: (id: string) => void }) {
  const canDispatch = task.status === 'pending' || task.status === 'approval_required'
  return (
    <div style={{
      padding: '10px 12px', marginBottom: 6,
      background: 'var(--bg-elevated)', border: `1px solid ${task.severity === 'critical' ? '#f43f5e33' : 'var(--border)'}`,
      borderRadius: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 4 }}>
            <SevBadge severity={task.severity} />
            <span style={{ fontSize: 10, color: 'var(--text-muted)', padding: '1px 5px', borderRadius: 4, background: 'var(--bg-primary)', border: '1px solid var(--border)' }}>
              {CAT_LABEL[task.category] ?? task.category}
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>priority: {task.priority}</span>
            {task.requiresApproval && (
              <span style={{ fontSize: 9, color: '#a855f7', padding: '1px 5px', borderRadius: 4, background: '#a855f711', border: '1px solid #a855f744', display: 'flex', alignItems: 'center', gap: 3 }}>
                <Lock style={{ width: 8, height: 8 }} />APPROVAL REQUIRED
              </span>
            )}
            <span style={{ fontSize: 10, color: task.status === 'complete' ? '#10b981' : task.status === 'assigned' ? '#3b82f6' : 'var(--text-muted)', marginLeft: 'auto' }}>
              {task.status}
            </span>
          </div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 3 }}>
            {task.title}
          </div>
          {task.filePath && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
              {shortPath(task.filePath)}
            </div>
          )}
        </div>
        {canDispatch && (
          <button
            onClick={() => onDispatch(task.id)}
            style={{
              flexShrink: 0, padding: '4px 10px', fontSize: 10, fontWeight: 600,
              borderRadius: 5, cursor: 'pointer', border: '1px solid #3b82f644',
              background: '#3b82f611', color: '#3b82f6',
              display: 'flex', alignItems: 'center', gap: 4,
            }}
          >
            <Play style={{ width: 9, height: 9 }} />Dispatch
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

type Tab = 'overview' | 'findings' | 'tasks'

export default function AuditPage() {
  const { workspaceId } = useWorkspace()
  const qc              = useQueryClient()
  const [tab, setTab]   = useState<Tab>('overview')
  const [catFilter, setCatFilter] = useState<string>('')
  const [latestRunId, setLatestRunId] = useState<string | null>(null)

  // List runs
  const runsQ = useQuery({
    queryKey: ['audit-runs', workspaceId],
    queryFn:  () => fetch(`${API}/runs?workspace_id=${workspaceId}`).then(r => r.json()) as Promise<{ success: true; data: AuditRun[] }>,
    refetchInterval: 10_000,
  })

  const runs    = runsQ.data?.data ?? []
  const current = runs[0]
  const runId   = latestRunId ?? current?.id ?? null

  // Findings for selected run
  const findingsQ = useQuery({
    queryKey: ['audit-findings', runId, catFilter],
    queryFn:  () => fetch(`${API}/runs/${runId}/findings${catFilter ? `?category=${catFilter}` : ''}`).then(r => r.json()) as Promise<{ success: true; data: Finding[] }>,
    enabled:  !!runId,
  })

  // Build tasks for selected run
  const tasksQ = useQuery({
    queryKey: ['audit-tasks', runId],
    queryFn:  () => fetch(`${API}/runs/${runId}/tasks`).then(r => r.json()) as Promise<{ success: true; data: BuildTask[] }>,
    enabled:  !!runId,
  })

  const findings = findingsQ.data?.data ?? []
  const tasks    = tasksQ.data?.data ?? []

  // Trigger audit
  const auditMut = useMutation({
    mutationFn: () => fetch(`${API}/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: workspaceId }),
    }).then(r => r.json()) as Promise<{ success: true; data: AuditSummary }>,
    onSuccess: (res) => {
      setLatestRunId(res.data.runId)
      qc.invalidateQueries({ queryKey: ['audit-runs'] })
      qc.invalidateQueries({ queryKey: ['audit-findings'] })
      qc.invalidateQueries({ queryKey: ['audit-tasks'] })
    },
  })

  // Dispatch task
  const dispatchMut = useMutation({
    mutationFn: (taskId: string) => fetch(`${API}/runs/${runId}/tasks/${taskId}/dispatch`, { method: 'POST' }).then(r => r.json()),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['audit-tasks'] }),
  })

  const TAB_STYLE = (t: Tab): React.CSSProperties => ({
    fontSize: 12, fontWeight: 500, padding: '6px 14px', border: 'none',
    background: 'transparent', cursor: 'pointer',
    color: tab === t ? '#3b82f6' : 'var(--text-muted)',
    borderBottom: tab === t ? '2px solid #3b82f6' : '2px solid transparent',
  })

  const critCount   = current?.criticalCount ?? 0
  const highCount   = current?.highCount ?? 0
  const totalFindings = current?.findingCount ?? 0
  const mockCount   = findings.filter(f => f.patternId === 'fake-simulation' || f.patternId === 'hardcoded-pass' || f.patternId === 'fake-marker').length
  const testGapCount = findings.filter(f => f.category === 'testing').length

  // Aggregate byCategory/bySeverity from findings for display
  const byCategory: Record<string, number> = {}
  const bySeverity: Record<string, number> = {}
  for (const f of findings) {
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1
  }

  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--bg-primary)' }}>
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '24px 20px' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <ScanSearch style={{ width: 18, height: 18, color: '#6366f1' }} />
              <h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
                War Room Audit
              </h1>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
              Full-repo gap analysis — every finding references a real file and line. No fake results.
            </p>
          </div>
          <button
            onClick={() => auditMut.mutate()}
            disabled={auditMut.isPending}
            style={{
              padding: '8px 16px', fontSize: 12, fontWeight: 600, borderRadius: 7, cursor: 'pointer',
              background: '#6366f1', color: '#fff', border: 'none', opacity: auditMut.isPending ? 0.6 : 1,
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <ScanSearch style={{ width: 13, height: 13 }} />
            {auditMut.isPending ? 'Scanning…' : 'Run Audit'}
          </button>
        </div>

        {/* Run selector */}
        {runs.length > 1 && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
            {runs.slice(0, 5).map(r => (
              <button key={r.id} onClick={() => setLatestRunId(r.id)}
                style={{
                  fontSize: 10, padding: '3px 8px', borderRadius: 5, cursor: 'pointer',
                  border: `1px solid ${r.id === runId ? '#6366f1' : 'var(--border)'}`,
                  background: r.id === runId ? '#6366f111' : 'var(--bg-elevated)',
                  color: r.id === runId ? '#6366f1' : 'var(--text-muted)',
                }}>
                {new Date(r.createdAt).toLocaleTimeString()} — {r.findingCount} findings
              </button>
            ))}
          </div>
        )}

        {!runId && !auditMut.isPending && (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
            <ScanSearch style={{ width: 40, height: 40, margin: '0 auto 12px', opacity: 0.3 }} />
            <p style={{ fontSize: 13 }}>No audit runs yet. Click "Run Audit" to scan the repo.</p>
          </div>
        )}

        {auditMut.isPending && (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
            <RefreshCw style={{ width: 24, height: 24, margin: '0 auto 10px', animation: 'spin 1s linear infinite' }} />
            <p style={{ fontSize: 12 }}>Scanning repository… reading real files…</p>
          </div>
        )}

        {runId && !auditMut.isPending && (
          <>
            {/* Summary cards */}
            <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
              <SummaryCard label="Total Gaps"     value={totalFindings}  color="#6366f1" icon={ScanSearch} />
              <SummaryCard label="Critical"       value={critCount}      color="#f43f5e" icon={XCircle} />
              <SummaryCard label="High"           value={highCount}      color="#f97316" icon={AlertTriangle} />
              <SummaryCard label="Unsafe Mocks"   value={mockCount}      color="#f43f5e" icon={ShieldAlert} />
              <SummaryCard label="Test Gaps"      value={testGapCount}   color="#f59e0b" icon={TestTube} />
              <SummaryCard label="Build Tasks"    value={current?.taskCount ?? 0} color="#10b981" icon={Wrench} />
            </div>

            {/* Tabs */}
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: 16 }}>
              {(['overview', 'findings', 'tasks'] as Tab[]).map(t => (
                <button key={t} style={TAB_STYLE(t)} onClick={() => setTab(t)}>
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                  {t === 'findings' && totalFindings > 0 && (
                    <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: critCount > 0 ? '#f43f5e' : 'var(--text-muted)' }}>
                      ({totalFindings})
                    </span>
                  )}
                  {t === 'tasks' && tasks.length > 0 && (
                    <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: '#6366f1' }}>
                      ({tasks.length})
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Overview tab */}
            {tab === 'overview' && Object.keys(byCategory).length > 0 && (
              <>
                <CategoryBreakdown byCategory={byCategory} bySeverity={bySeverity} />

                {/* Top tasks */}
                <h3 style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>
                  Top Priority Tasks
                </h3>
                {tasks.filter((_, i) => i < 5).map(t => (
                  <TaskRow key={t.id} task={t} onDispatch={(id) => dispatchMut.mutate(id)} />
                ))}

                {/* Approval-required */}
                {tasks.some(t => t.requiresApproval && t.status === 'approval_required') && (
                  <>
                    <h3 style={{ fontSize: 12, fontWeight: 600, color: '#a855f7', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10, marginTop: 20 }}>
                      <Lock style={{ width: 11, height: 11, display: 'inline', marginRight: 5 }} />
                      Approval Required
                    </h3>
                    {tasks.filter(t => t.requiresApproval && t.status === 'approval_required').slice(0, 5).map(t => (
                      <TaskRow key={t.id} task={t} onDispatch={(id) => dispatchMut.mutate(id)} />
                    ))}
                  </>
                )}
              </>
            )}

            {/* Findings tab */}
            {tab === 'findings' && (
              <div>
                {/* Category filter */}
                <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
                  <button onClick={() => setCatFilter('')}
                    style={{ fontSize: 10, padding: '3px 8px', borderRadius: 5, cursor: 'pointer', border: `1px solid ${!catFilter ? '#6366f1' : 'var(--border)'}`, background: !catFilter ? '#6366f111' : 'var(--bg-elevated)', color: !catFilter ? '#6366f1' : 'var(--text-muted)' }}>
                    All
                  </button>
                  {Object.keys(byCategory).map(cat => (
                    <button key={cat} onClick={() => setCatFilter(cat)}
                      style={{ fontSize: 10, padding: '3px 8px', borderRadius: 5, cursor: 'pointer', border: `1px solid ${catFilter === cat ? '#6366f1' : 'var(--border)'}`, background: catFilter === cat ? '#6366f111' : 'var(--bg-elevated)', color: catFilter === cat ? '#6366f1' : 'var(--text-muted)' }}>
                      {CAT_LABEL[cat as Category] ?? cat} ({byCategory[cat]})
                    </button>
                  ))}
                </div>

                {findings.length === 0 && (
                  <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)', fontSize: 12 }}>
                    {catFilter ? 'No findings in this category' : 'Loading findings…'}
                  </div>
                )}

                {findings.map(f => <FindingRow key={f.id} finding={f} />)}
              </div>
            )}

            {/* Tasks tab */}
            {tab === 'tasks' && (
              <div>
                {tasks.length === 0 && (
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 30 }}>
                    No build tasks generated yet. Run an audit first.
                  </p>
                )}
                {tasks.map(t => (
                  <TaskRow key={t.id} task={t} onDispatch={(id) => dispatchMut.mutate(id)} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
