/**
 * ApprovalsPage — Human-in-the-loop approval queue management.
 */
import { useState, useEffect, useRef }      from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { warRoomApi, type Approval }         from '../api.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  const s = Math.floor(diff / 1000)
  if (s < 60)   return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60)   return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24)   return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function expiresLabel(ms: number): { label: string; color: string } {
  const diff = ms - Date.now()
  if (diff <= 0) return { label: 'Expired', color: '#ef4444' }
  const s = Math.floor(diff / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const label = h > 0 ? `${h}h ${m % 60}m` : m > 0 ? `${m}m` : `${s}s`
  const color = diff < 3_600_000 ? '#ef4444' : diff < 86_400_000 ? '#f59e0b' : '#6b7280'
  return { label: `Expires in ${label}`, color }
}

type TabStatus = 'pending' | 'approved' | 'rejected' | 'expired'

const TABS: { value: TabStatus; label: string }[] = [
  { value: 'pending',  label: 'Pending'  },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'expired',  label: 'Expired'  },
]

// ─── Payload Preview ──────────────────────────────────────────────────────────

function PayloadPreview({ data }: { data: Record<string, unknown> }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ marginTop: 8 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display:    'flex',
          alignItems: 'center',
          gap:        4,
          fontSize:   12,
          color:      'var(--text-muted)',
          background: 'none',
          border:     'none',
          cursor:     'pointer',
          padding:    0,
        }}
      >
        <span style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', display: 'inline-block', transition: 'transform 0.15s' }}>▶</span>
        {open ? 'Hide' : 'Show'} payload
      </button>
      {open && (
        <pre style={{
          marginTop:   6,
          padding:     10,
          background:  'var(--surface-2, #f3f4f6)',
          borderRadius: 6,
          fontSize:    11,
          overflowX:   'auto',
          color:       'var(--text-muted)',
          maxHeight:   200,
        }}>
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  )
}

// ─── Inline Action Box ────────────────────────────────────────────────────────

interface ActionBoxProps {
  approvalId:  string
  action:      'approve' | 'reject'
  onSubmit:    (reason: string) => void
  onCancel:    () => void
  loading:     boolean
}

function ActionBox({ action, onSubmit, onCancel, loading }: ActionBoxProps) {
  const [reason, setReason] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { ref.current?.focus() }, [])

  return (
    <div style={{
      marginTop:    10,
      padding:      12,
      borderRadius: 8,
      border:       `1px solid ${action === 'approve' ? '#bbf7d0' : '#fecaca'}`,
      background:   action === 'approve' ? '#f0fdf4' : '#fef2f2',
    }}>
      <textarea
        ref={ref}
        value={reason}
        onChange={e => setReason(e.target.value)}
        placeholder={action === 'approve' ? 'Reason (optional)' : 'Reason for rejection (optional)'}
        rows={2}
        style={{
          width:        '100%',
          padding:      8,
          borderRadius: 6,
          border:       '1px solid #d1d5db',
          fontSize:     13,
          resize:       'vertical',
          boxSizing:    'border-box',
        }}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button
          onClick={() => onSubmit(reason)}
          disabled={loading}
          style={{
            padding:      '6px 14px',
            borderRadius: 6,
            border:       'none',
            cursor:       loading ? 'not-allowed' : 'pointer',
            background:   action === 'approve' ? '#22c55e' : '#ef4444',
            color:        '#fff',
            fontSize:     13,
            fontWeight:   600,
            opacity:      loading ? 0.6 : 1,
          }}
        >
          {loading ? '…' : action === 'approve' ? 'Confirm Approve' : 'Confirm Reject'}
        </button>
        <button
          onClick={onCancel}
          style={{
            padding:      '6px 14px',
            borderRadius: 6,
            border:       '1px solid #d1d5db',
            cursor:       'pointer',
            background:   '#fff',
            color:        '#374151',
            fontSize:     13,
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// ─── Approval Card ────────────────────────────────────────────────────────────

interface ApprovalCardProps {
  approval:     Approval
  activeAction: Map<string, 'approve' | 'reject'>
  setAction:    (id: string, action: 'approve' | 'reject' | null) => void
  onApprove:    (id: string, reason: string) => void
  onReject:     (id: string, reason: string) => void
  mutating:     boolean
}

function ApprovalCard({ approval, activeAction, setAction, onApprove, onReject, mutating }: ApprovalCardProps) {
  const { id, operationLabel, context, requestedAt, expiresAt, status, risk } = approval
  const action = activeAction.get(id) ?? null

  const riskColor: Record<string, string> = {
    low:      '#22c55e',
    medium:   '#f59e0b',
    high:     '#ef4444',
    critical: '#7f1d1d',
  }

  return (
    <div style={{
      border:       '1px solid var(--border, #e5e7eb)',
      borderRadius: 10,
      padding:      16,
      background:   'var(--surface, #fff)',
      display:      'flex',
      flexDirection: 'column',
      gap:          0,
    }}>
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--text, #111827)' }}>
            {operationLabel}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted, #6b7280)', marginTop: 2 }}>
            Run: {approval.runId} · Step: {approval.stepId}
          </div>
        </div>
        {risk && (
          <span style={{
            fontSize:     11,
            fontWeight:   700,
            padding:      '2px 8px',
            borderRadius: 99,
            background:   `${riskColor[risk] ?? '#6b7280'}22`,
            color:        riskColor[risk] ?? '#6b7280',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}>
            {risk}
          </span>
        )}
      </div>

      {/* Context */}
      {Object.keys(context).length > 0 && <PayloadPreview data={context} />}

      {/* Meta row */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 10, fontSize: 12, color: 'var(--text-muted, #6b7280)' }}>
        <span>Requested {relativeTime(requestedAt)}</span>
        {expiresAt > 0 && (() => {
          const { label, color } = expiresLabel(expiresAt)
          return <span style={{ color, fontWeight: 500 }}>{label}</span>
        })()}
      </div>

      {/* Actions for pending */}
      {status === 'pending' && !action && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button
            onClick={() => setAction(id, 'approve')}
            style={{
              padding:      '6px 14px',
              borderRadius: 6,
              border:       'none',
              cursor:       'pointer',
              background:   '#22c55e',
              color:        '#fff',
              fontSize:     13,
              fontWeight:   600,
            }}
          >
            ✓ Approve
          </button>
          <button
            onClick={() => setAction(id, 'reject')}
            style={{
              padding:      '6px 14px',
              borderRadius: 6,
              border:       '1px solid #ef4444',
              cursor:       'pointer',
              background:   '#fff',
              color:        '#ef4444',
              fontSize:     13,
              fontWeight:   600,
            }}
          >
            ✕ Reject
          </button>
        </div>
      )}

      {action === 'approve' && (
        <ActionBox
          approvalId={id}
          action="approve"
          loading={mutating}
          onSubmit={reason => onApprove(id, reason)}
          onCancel={() => setAction(id, null)}
        />
      )}
      {action === 'reject' && (
        <ActionBox
          approvalId={id}
          action="reject"
          loading={mutating}
          onSubmit={reason => onReject(id, reason)}
          onCancel={() => setAction(id, null)}
        />
      )}

      {/* Decision info for non-pending */}
      {(status === 'approved' || status === 'rejected') && (
        <div style={{
          marginTop:  10,
          padding:    '6px 10px',
          borderRadius: 6,
          background: status === 'approved' ? '#f0fdf4' : '#fef2f2',
          fontSize:   12,
          color:      status === 'approved' ? '#166534' : '#991b1b',
        }}>
          {status === 'approved' ? '✓ Approved' : '✕ Rejected'}
        </div>
      )}
    </div>
  )
}

// ─── Empty State ──────────────────────────────────────────────────────────────

function EmptyState({ tab }: { tab: TabStatus }) {
  const msgs: Record<TabStatus, string> = {
    pending:  'No pending approvals — all clear',
    approved: 'No approved items',
    rejected: 'No rejected items',
    expired:  'No expired approvals',
  }
  return (
    <div style={{
      display:        'flex',
      flexDirection:  'column',
      alignItems:     'center',
      justifyContent: 'center',
      padding:        '48px 24px',
      color:          'var(--text-muted, #6b7280)',
      fontSize:       14,
      gap:            10,
    }}>
      <span style={{ fontSize: 32 }}>✓</span>
      <span>{msgs[tab]}</span>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ApprovalsPage() {
  const qc = useQueryClient()
  const [tab, setTab]             = useState<TabStatus>('pending')
  const [activeAction, setActiveActionMap] = useState<Map<string, 'approve' | 'reject'>>(new Map())

  const setAction = (id: string, action: 'approve' | 'reject' | null) => {
    setActiveActionMap(prev => {
      const next = new Map(prev)
      if (action === null) { next.delete(id) } else { next.set(id, action) }
      return next
    })
  }

  const { data, isLoading, isError } = useQuery({
    queryKey: ['approvals-page'],
    queryFn:  () => warRoomApi.getApprovals(),
    refetchInterval: tab === 'pending' ? 15_000 : false,
  })

  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['approvals-page'] }) }

  const approveMut = useMutation({
    mutationFn: ({ id }: { id: string; reason: string }) => warRoomApi.approve(id),
    onSuccess:  (_, { id }) => { setAction(id, null); invalidate() },
  })

  const rejectMut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => warRoomApi.reject(id, reason),
    onSuccess:  (_, { id }) => { setAction(id, null); invalidate() },
  })

  const allApprovals: Approval[] = data?.data ?? []
  const pendingCount = allApprovals.filter(a => a.status === 'pending').length

  const displayed = allApprovals.filter(a => {
    if (tab === 'pending')  return a.status === 'pending'
    if (tab === 'approved') return a.status === 'approved'
    if (tab === 'rejected') return a.status === 'rejected'
    if (tab === 'expired')  return a.status === 'expired'
    return false
  })

  const isMutating = approveMut.isPending || rejectMut.isPending

  return (
    <div style={{ padding: '28px 32px', maxWidth: 860, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text, #111827)', margin: 0 }}>
          Approval Queue
        </h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted, #6b7280)', margin: '4px 0 0' }}>
          Human-in-the-loop approval gates for workflow operations
        </p>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--border, #e5e7eb)', paddingBottom: 0 }}>
        {TABS.map(t => {
          const active = tab === t.value
          return (
            <button
              key={t.value}
              onClick={() => setTab(t.value)}
              style={{
                padding:         '8px 14px',
                fontSize:        13,
                fontWeight:      active ? 600 : 400,
                border:          'none',
                borderBottom:    active ? '2px solid #6366f1' : '2px solid transparent',
                background:      'none',
                cursor:          'pointer',
                color:           active ? '#6366f1' : 'var(--text-muted, #6b7280)',
                display:         'flex',
                alignItems:      'center',
                gap:             6,
                marginBottom:    -1,
                whiteSpace:      'nowrap',
              }}
            >
              {t.label}
              {t.value === 'pending' && pendingCount > 0 && (
                <span style={{
                  background:   '#ef4444',
                  color:        '#fff',
                  fontSize:     10,
                  fontWeight:   700,
                  borderRadius: 99,
                  padding:      '1px 6px',
                  minWidth:     18,
                  textAlign:    'center',
                }}>
                  {pendingCount}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Body */}
      {isLoading && (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted, #6b7280)', fontSize: 13 }}>
          Loading…
        </div>
      )}

      {isError && (
        <div style={{ textAlign: 'center', padding: 40, color: '#ef4444', fontSize: 13 }}>
          Failed to load approvals. Retrying…
        </div>
      )}

      {!isLoading && !isError && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {displayed.length === 0 ? (
            <EmptyState tab={tab} />
          ) : (
            displayed.map(approval => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                activeAction={activeAction}
                setAction={setAction}
                onApprove={(id, reason) => approveMut.mutate({ id, reason })}
                onReject={(id, reason)  => rejectMut.mutate({ id, reason })}
                mutating={isMutating}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}
