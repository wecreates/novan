/**
 * PatchApprovalsPage — Human Review Queue for risky patch approvals.
 *
 * Shows pending approvals with:
 * - Risk level badge + categories
 * - Affected file paths
 * - Diff preview (if available)
 * - Approve / Reject / Request Changes actions
 */
import { useState }          from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ShieldAlert, ShieldCheck, ShieldX, Clock, CheckCircle2,
  XCircle, AlertTriangle, ChevronDown, ChevronUp, FileCode2,
  MessageSquare, RefreshCcw,
} from 'lucide-react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

// ─── API ──────────────────────────────────────────────────────────────────────

const API = (path: string) => `/api/v1/patch-approvals${path}`

async function fetchApprovals(workspaceId: string, status?: string) {
  const params = new URLSearchParams({ workspace_id: workspaceId })
  if (status) params.set('status', status)
  const r = await fetch(`${API('/')}?${params}`)
  if (!r.ok) throw new Error(await r.text())
  return (await r.json()).data as Approval[]
}

async function postAction(approvalId: string, action: string, body: object) {
  const r = await fetch(API(`/${approvalId}/${action}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }))
    throw new Error(err.error ?? r.statusText)
  }
  return r.json()
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Approval {
  id:             string
  taskId:         string
  auditRunId:     string
  workspaceId:    string
  riskLevel:      'low' | 'medium' | 'high' | 'critical'
  riskCategories: string[]
  riskReason:     string
  taskTitle:      string
  filePath:       string | null
  affectedFiles:  string[]
  diffPreview:    string | null
  status:         'pending' | 'approved' | 'rejected' | 'changes_requested'
  reviewerId:     string | null
  reviewerNote:   string | null
  reviewedAt:     number | null
  createdAt:      number
  updatedAt:      number
}

// ─── Risk badge ───────────────────────────────────────────────────────────────

const RISK_COLORS: Record<string, string> = {
  critical: 'bg-red-500/20 text-red-400 border border-red-500/30',
  high:     'bg-orange-500/20 text-orange-400 border border-orange-500/30',
  medium:   'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
  low:      'bg-green-500/20 text-green-400 border border-green-500/30',
}

const STATUS_COLORS: Record<string, string> = {
  pending:           'bg-yellow-500/20 text-yellow-400',
  approved:          'bg-green-500/20 text-green-400',
  rejected:          'bg-red-500/20 text-red-400',
  changes_requested: 'bg-blue-500/20 text-blue-400',
}

const STATUS_ICONS: Record<string, React.ReactNode> = {
  pending:           <Clock className="w-3 h-3" />,
  approved:          <CheckCircle2 className="w-3 h-3" />,
  rejected:          <XCircle className="w-3 h-3" />,
  changes_requested: <MessageSquare className="w-3 h-3" />,
}

const CATEGORY_LABELS: Record<string, string> = {
  auth:         'Auth',
  payment:      'Payment',
  database:     'Database',
  dependency:   'Dependency',
  security:     'Security',
  billing:      'Billing',
  destructive:  'Destructive',
  large_patch:  'Large Patch',
  orchestration: 'Orchestration',
  deployment:   'Deployment',
}

// ─── ApprovalCard ─────────────────────────────────────────────────────────────

function ApprovalCard({ approval }: { approval: Approval }) {
  const [expanded, setExpanded]   = useState(false)
  const [action, setAction]       = useState<'approve' | 'reject' | 'changes' | null>(null)
  const [note, setNote]           = useState('')
  const [error, setError]         = useState<string | null>(null)
  const qc = useQueryClient()

  const mut = useMutation({
    mutationFn: async ({ act, n }: { act: string; n: string }) => {
      const body: Record<string, string> = { reviewer_id: 'ops-user' }
      if (n) body['note'] = n
      if (act === 'reject' || act === 'request-changes') {
        if (!n.trim()) throw new Error('Note is required for this action')
      }
      return postAction(approval.id, act, body)
    },
    onSuccess: () => {
      setAction(null); setNote(''); setError(null)
      qc.invalidateQueries({ queryKey: ['patch-approvals'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  const isPending = approval.status === 'pending' || approval.status === 'changes_requested'

  const riskIcon = approval.riskLevel === 'critical' || approval.riskLevel === 'high'
    ? <ShieldAlert className="w-4 h-4" />
    : <ShieldCheck className="w-4 h-4" />

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 flex items-start gap-3">
        <div className={`mt-0.5 flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${RISK_COLORS[approval.riskLevel] ?? ''}`}>
          {riskIcon}
          <span className="capitalize">{approval.riskLevel}</span>
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-[var(--text-primary)] truncate">{approval.taskTitle}</p>
          {approval.filePath && (
            <p className="text-xs text-[var(--text-muted)] font-mono truncate mt-0.5">{approval.filePath}</p>
          )}
          <div className="flex flex-wrap gap-1 mt-1.5">
            {approval.riskCategories.map((c) => (
              <span key={c} className="px-1.5 py-0.5 rounded text-xs bg-[var(--bg-elevated)] text-[var(--text-muted)]">
                {CATEGORY_LABELS[c] ?? c}
              </span>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs ${STATUS_COLORS[approval.status] ?? ''}`}>
            {STATUS_ICONS[approval.status]}
            <span className="capitalize">{approval.status.replace('_', ' ')}</span>
          </span>
          <button
            onClick={() => setExpanded((p) => !p)}
            className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Expanded */}
      {expanded && (
        <div className="border-t border-[var(--border)] px-4 py-3 space-y-3">
          {/* Risk reason */}
          <div>
            <p className="text-xs text-[var(--text-muted)] uppercase tracking-wide mb-1">Risk Reason</p>
            <p className="text-sm text-[var(--text-secondary)]">{approval.riskReason}</p>
          </div>

          {/* Affected files */}
          {approval.affectedFiles.length > 0 && (
            <div>
              <p className="text-xs text-[var(--text-muted)] uppercase tracking-wide mb-1">Affected Files</p>
              <div className="space-y-0.5">
                {approval.affectedFiles.map((f) => (
                  <div key={f} className="flex items-center gap-1.5 text-xs font-mono text-[var(--text-secondary)]">
                    <FileCode2 className="w-3 h-3 text-[var(--text-muted)]" />
                    <span className="truncate">{f}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Diff preview */}
          {approval.diffPreview && (
            <div>
              <p className="text-xs text-[var(--text-muted)] uppercase tracking-wide mb-1">Diff Preview</p>
              <pre className="text-xs font-mono bg-[var(--bg-primary)] rounded p-2 overflow-x-auto max-h-40 text-[var(--text-secondary)] whitespace-pre-wrap">
                {approval.diffPreview}
              </pre>
            </div>
          )}

          {/* Reviewer note (if already reviewed) */}
          {approval.reviewerNote && !isPending && (
            <div>
              <p className="text-xs text-[var(--text-muted)] uppercase tracking-wide mb-1">Reviewer Note</p>
              <p className="text-sm text-[var(--text-secondary)] italic">{approval.reviewerNote}</p>
            </div>
          )}

          {/* Action buttons (pending / changes_requested only) */}
          {isPending && (
            <div className="space-y-2">
              {action === null ? (
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => setAction('approve')}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-green-500/20 text-green-400 hover:bg-green-500/30 border border-green-500/30 transition-colors"
                  >
                    <ShieldCheck className="w-3 h-3" /> Approve
                  </button>
                  <button
                    onClick={() => setAction('reject')}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30 transition-colors"
                  >
                    <ShieldX className="w-3 h-3" /> Reject
                  </button>
                  <button
                    onClick={() => setAction('changes')}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border border-blue-500/30 transition-colors"
                  >
                    <MessageSquare className="w-3 h-3" /> Request Changes
                  </button>
                </div>
              ) : (
                <div className="space-y-2 pt-1">
                  <p className="text-xs text-[var(--text-secondary)]">
                    {action === 'approve'
                      ? 'Add an optional note for this approval:'
                      : 'Explain your decision (required):'}
                  </p>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={2}
                    placeholder={action === 'approve' ? 'Optional note…' : 'Required note…'}
                    className="w-full text-xs rounded border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] px-2 py-1.5 resize-none outline-none focus:border-blue-500/50"
                  />
                  {error && <p className="text-xs text-red-400">{error}</p>}
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        const act = action === 'approve' ? 'approve'
                          : action === 'reject' ? 'reject'
                          : 'request-changes'
                        mut.mutate({ act, n: note })
                      }}
                      disabled={mut.isPending}
                      className="px-3 py-1.5 rounded text-xs bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border border-blue-500/30 transition-colors disabled:opacity-50"
                    >
                      {mut.isPending ? 'Submitting…' : 'Confirm'}
                    </button>
                    <button
                      onClick={() => { setAction(null); setNote(''); setError(null) }}
                      className="px-3 py-1.5 rounded text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const STATUS_TABS = [
  { value: undefined, label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'changes_requested', label: 'Changes Requested' },
] as const

export default function PatchApprovalsPage() {
  const { workspaceId } = useWorkspace()
  const [statusFilter, setStatusFilter] = useState<string | undefined>('pending')
  const qc = useQueryClient()

  const { data: approvals = [], isLoading, error } = useQuery({
    queryKey:    ['patch-approvals', workspaceId, statusFilter],
    queryFn:     () => fetchApprovals(workspaceId, statusFilter),
    enabled:     !!workspaceId,
    refetchInterval: 15_000,
  })

  const pending = approvals.filter((a) => a.status === 'pending').length
  const critical = approvals.filter((a) => a.riskLevel === 'critical').length

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-6 pt-5 pb-4 border-b border-[var(--border)]">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">Patch Approvals</h1>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Human review queue for risky autonomous patch tasks
            </p>
          </div>
          <div className="flex items-center gap-3">
            {pending > 0 && (
              <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-yellow-500/20 text-yellow-400 border border-yellow-500/30">
                <AlertTriangle className="w-3 h-3" />
                {pending} pending
              </span>
            )}
            {critical > 0 && (
              <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-red-500/20 text-red-400 border border-red-500/30">
                <ShieldAlert className="w-3 h-3" />
                {critical} critical
              </span>
            )}
            <button
              onClick={() => qc.invalidateQueries({ queryKey: ['patch-approvals'] })}
              className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
              title="Refresh"
            >
              <RefreshCcw className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Status tabs */}
        <div className="flex gap-1 mt-3">
          {STATUS_TABS.map((t) => (
            <button
              key={t.value ?? 'all'}
              onClick={() => setStatusFilter(t.value)}
              className={`px-3 py-1 rounded text-xs transition-colors ${
                statusFilter === t.value
                  ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {isLoading && (
          <div className="flex items-center justify-center h-32 text-[var(--text-muted)] text-sm">
            Loading approvals…
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
            <XCircle className="w-4 h-4 shrink-0" />
            <span>Failed to load approvals: {(error as Error).message}</span>
          </div>
        )}

        {!isLoading && !error && approvals.length === 0 && (
          <div className="flex flex-col items-center justify-center h-48 text-[var(--text-muted)]">
            <ShieldCheck className="w-8 h-8 mb-2 opacity-40" />
            <p className="text-sm">No approvals found</p>
            <p className="text-xs mt-1 opacity-60">
              {statusFilter === 'pending'
                ? 'No patches awaiting review — all clear'
                : 'No records match this filter'}
            </p>
          </div>
        )}

        {!isLoading && approvals.length > 0 && (
          <div className="space-y-3 max-w-4xl">
            {approvals.map((a) => (
              <ApprovalCard key={a.id} approval={a} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
