/**
 * HelpPage — In-app operator help.
 * Sections mirror docs/war-room-help.md but rendered as quick-reference.
 */
import { useState } from 'react'
import {
  BookOpen, ShieldAlert, Pause, CheckSquare, AlertTriangle,
  Wrench, Rocket, Search, ChevronRight,
} from 'lucide-react'

const SECTIONS = [
  {
    id: 'status', icon: <BookOpen className="w-4 h-4" />, title: 'Status Vocabulary',
    body: [
      ['open',           'Incident / approval is unattended'],
      ['acknowledged',   'Human has accepted ownership'],
      ['mitigating',     'Active repair in progress'],
      ['resolved',       'Incident closed with resolution note'],
      ['escalated',      'Severity raised; usually requires manual ops action'],
      ['running',        'Job / sandbox / assignment actively executing'],
      ['complete',       'Finished successfully'],
      ['failed',         'Finished with non-zero exit'],
      ['timeout',        'Killed for exceeding time limit'],
      ['blocked',        'Waiting for dependencies or approval'],
      ['cancelled',      'Cancelled by operator'],
      ['isolation_violation', 'Sandbox/orchestrator rule rejected this execution'],
    ],
  },
  {
    id: 'pause', icon: <Pause className="w-4 h-4" />, title: 'How to Pause Agents',
    body: [
      ['1', 'Go to Agents → Agent Control'],
      ['2', 'Find the agent, click Pause'],
      ['3', 'In-flight jobs finish naturally; new dispatches blocked'],
      ['API', 'POST /api/v1/agents/:id/pause'],
    ],
  },
  {
    id: 'approve', icon: <CheckSquare className="w-4 h-4" />, title: 'How to Approve Risky Patches',
    body: [
      ['1', 'Audit dispatch triggers risk classifier on each task'],
      ['2', 'Risky tasks create patch_approvals row + task status=approval_required'],
      ['3', 'Open Patch Approvals page → review risk reason + affected files'],
      ['4', 'Approve (optional note), Reject (note required), or Request Changes'],
      ['5', 'Approval unblocks the task; agent may dispatch via same endpoint'],
    ],
  },
  {
    id: 'kill', icon: <ShieldAlert className="w-4 h-4" />, title: 'How to Use Kill Switches',
    body: [
      ['Where', 'Cost Governor → Kill Switches (/governor/kill-switches)'],
      ['What',  'Each switch maps to a category (AI calls, deploys, schedules)'],
      ['When',  'During budget runaway, provider outage, or auth failure'],
      ['How',   'Toggle enabled state; all matching ops denied at entry'],
    ],
  },
  {
    id: 'stuck', icon: <Wrench className="w-4 h-4" />, title: 'How to Recover Stuck Jobs',
    body: [
      ['1', 'Orchestrator → Locks tab → Sweep stale'],
      ['2', 'Stuck assignments (>10 min) auto-fail'],
      ['3', 'For a specific assignment: POST /assignments/:id/complete success=false'],
      ['API', 'POST /api/v1/orchestrator/locks/recover'],
    ],
  },
  {
    id: 'launch', icon: <Rocket className="w-4 h-4" />, title: 'How to Verify Launch Readiness',
    body: [
      ['1', 'Open Launch Lock page'],
      ['2', 'Click Run Audit'],
      ['3', 'Review 14 checks (typecheck, lint, tests, build, providers, workers, budgets, etc.)'],
      ['4', 'Failed or unverified critical checks block launch'],
      ['5', 'Admin Override available with 5+ char reason (1h TTL)'],
      ['6', 'Every audit + override logged in events table'],
    ],
  },
]

const RUNBOOKS = [
  'Provider Outage',
  'Worker Crash',
  'Queue Backlog',
  'Budget Spike',
  'Failed Deployment',
  'Replay Divergence',
  'Rollback Failure',
  'Stuck Workflow',
  'API Key / Provider Failure',
  'Cloud-API-Only Misconfiguration',
]

export default function HelpPage() {
  const [filter, setFilter] = useState('')
  const filtered = SECTIONS.filter((s) =>
    s.title.toLowerCase().includes(filter.toLowerCase()) ||
    s.body.some((r) => String(r[1]).toLowerCase().includes(filter.toLowerCase())),
  )

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="shrink-0 px-6 pt-5 pb-4 border-b border-border">
        <h1 className="text-lg font-semibold text-primary flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-blue-400" /> Operator Help
        </h1>
        <p className="text-xs text-muted mt-0.5">
          Quick reference for War Room pages, status meanings, and common operator tasks
        </p>
        <div className="mt-3 relative">
          <Search className="w-3.5 h-3.5 text-muted absolute left-3 top-2" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder="Search help topics…"
            className="w-full pl-8 pr-3 py-1.5 text-xs rounded border border-border bg-[var(--bg-surface)] text-primary outline-none focus:border-blue-500/50" />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="max-w-4xl space-y-4">
          {filtered.map((s) => (
            <section key={s.id} className="rounded-lg border border-border bg-[var(--bg-surface)] p-4">
              <h2 className="text-sm font-medium text-primary flex items-center gap-2 mb-3">
                <span className="text-blue-400">{s.icon}</span>
                {s.title}
              </h2>
              <div className="space-y-1.5">
                {s.body.map(([k, v]) => (
                  <div key={k} className="flex items-start gap-3 text-xs">
                    <span className="font-mono text-muted shrink-0 min-w-[100px]">{k}</span>
                    <span className="text-secondary">{v}</span>
                  </div>
                ))}
              </div>
            </section>
          ))}

          <section className="rounded-lg border border-border bg-[var(--bg-surface)] p-4">
            <h2 className="text-sm font-medium text-primary flex items-center gap-2 mb-3">
              <AlertTriangle className="w-4 h-4 text-orange-400" />
              Incident Runbooks
            </h2>
            <p className="text-xs text-muted mb-3">
              Full runbooks at <span className="font-mono">docs/runbooks.md</span>. Each runbook lists
              detection → severity → immediate action → rollback → verification → escalation.
            </p>
            <ul className="space-y-1">
              {RUNBOOKS.map((r, i) => (
                <li key={r} className="text-xs text-secondary flex items-center gap-2">
                  <ChevronRight className="w-3 h-3 text-muted" />
                  <span className="font-mono text-muted">{String(i + 1).padStart(2, '0')}</span>
                  {r}
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-4">
            <h2 className="text-sm font-medium text-blue-400 mb-2">When in Doubt</h2>
            <ol className="space-y-1 text-xs text-secondary list-decimal pl-4">
              <li>Check the <span className="font-mono">events</span> table via Timeline — every state change emits an event</li>
              <li>Check the matching runbook in <span className="font-mono">docs/runbooks.md</span></li>
              <li>Escalate via Incident → Escalate action with a clear reason</li>
            </ol>
          </section>

          <section className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4">
            <h2 className="text-sm font-medium text-yellow-400 mb-2">Secret Safety</h2>
            <p className="text-xs text-secondary">
              Never paste raw API keys, passwords, or tokens into approval notes, resolution notes,
              override reasons, or any UI text field. The sandbox executor scrubs known patterns
              from persisted output, but operator inputs are NOT redacted at write time.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
