/**
 * ChatActionsInboxPage — R146.19
 *
 * Workspace-wide inbox of `chat_actions` rows in 'suggested' state.
 * The brain's `novan-chat.detectIntents` writes these per turn for
 * the operator to approve or dismiss, but until now they were only
 * visible inline in the conversation they originated in.
 *
 * Backend: routes/chat.ts (R146.19 added the workspace-wide endpoint)
 *   GET  /api/v1/chat/actions/pending?workspace_id=X
 *   POST /api/v1/chat/actions/:id/approve  body: { workspace_id, approval_token? }
 *   POST /api/v1/chat/actions/:id/dismiss  body: { workspace_id }
 */
import React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { NavLink } from 'react-router-dom'
import { Inbox, Check, X, AlertTriangle, ExternalLink } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

interface ActionRow {
  id:             string
  messageId:      string
  conversationId: string
  workspaceId:    string
  actionType:     string
  title:          string
  summary:        string
  payload:        Record<string, unknown>
  riskLevel:      'low' | 'medium' | 'high' | 'critical'
  status:         'suggested' | 'approved' | 'dismissed' | 'executed' | 'failed'
  createdAt:      number
}

const RISK_TONE: Record<string, string> = {
  critical: 'text-red-300 bg-red-500/15 border-red-500/40',
  high:     'text-amber-300 bg-amber-500/15 border-amber-500/40',
  medium:   'text-sky-300 bg-sky-500/15 border-sky-500/40',
  low:      'text-slate-300 bg-slate-500/15 border-slate-500/40',
}

// Action types that require an approval token before /approve will run.
const HIGH_RISK = new Set(['engage_kill_switch'])

export default function ChatActionsInboxPage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()

  const list = useQuery({
    queryKey: ['chat-actions-pending', workspaceId],
    queryFn:  () => api.get<{ data: ActionRow[] }>(`/api/v1/chat/actions/pending?workspace_id=${workspaceId}&limit=100`),
    refetchInterval: 30_000,
  })

  const approve = useMutation({
    mutationFn: (vars: { id: string; approval?: string }) =>
      api.post(`/api/v1/chat/actions/${vars.id}/approve`,
        vars.approval ? { workspace_id: workspaceId, approval_token: vars.approval }
                      : { workspace_id: workspaceId }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['chat-actions-pending', workspaceId] }) },
  })

  const dismiss = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/chat/actions/${id}/reject`, { workspace_id: workspaceId }),
    onSuccess:  () => { void qc.invalidateQueries({ queryKey: ['chat-actions-pending', workspaceId] }) },
  })

  const rows = list.data?.data ?? []

  return (
    <div className="p-6 space-y-4 max-w-5xl mx-auto">
      <div className="flex items-center gap-3">
        <Inbox className="w-5 h-5 text-sky-400" />
        <h1 className="text-xl font-semibold">Chat actions inbox</h1>
        <span className="text-xs text-muted">{rows.length} pending</span>
      </div>

      {list.isLoading ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-5 py-4 text-sm text-emerald-300">
          No actions awaiting approval. When chat detects an intent (set horizon, pause agent, etc), it lands here.
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-surface divide-y divide-[var(--border)]">
          {rows.map(a => {
            const hi = HIGH_RISK.has(a.actionType)
            return (
              <div key={a.id} className="px-4 py-3 text-sm">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] border ${RISK_TONE[a.riskLevel] ?? RISK_TONE.medium}`}>
                    {a.riskLevel}
                  </span>
                  <span className="font-mono text-xs">{a.actionType}</span>
                  <span className="font-medium">{a.title}</span>
                  {hi && <AlertTriangle className="w-3.5 h-3.5 text-red-400" />}
                  <NavLink
                    to={`/chat?conversation=${a.conversationId}`}
                    className="ml-auto text-xs text-sky-400 hover:underline flex items-center gap-0.5"
                  >
                    open chat <ExternalLink className="w-3 h-3" />
                  </NavLink>
                </div>
                <div className="text-xs text-muted mt-1">{a.summary}</div>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => approve.mutate({ id: a.id, ...(hi ? { approval: 'OPERATOR_APPROVED' } : {}) })}
                    disabled={approve.isPending}
                    className="flex items-center gap-1 px-2.5 py-1 rounded text-xs border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
                  >
                    <Check className="w-3 h-3" /> Approve
                  </button>
                  <button
                    onClick={() => dismiss.mutate(a.id)}
                    disabled={dismiss.isPending}
                    className="flex items-center gap-1 px-2.5 py-1 rounded text-xs border border-border text-muted hover:bg-[var(--surface-hover)] disabled:opacity-50"
                  >
                    <X className="w-3 h-3" /> Dismiss
                  </button>
                  <span className="ml-auto text-[10px] text-muted font-mono">{new Date(a.createdAt).toLocaleString()}</span>
                </div>
                {Object.keys(a.payload).length > 0 && (
                  <details className="mt-2">
                    <summary className="text-[11px] text-muted cursor-pointer hover:text-primary">payload</summary>
                    <pre className="mt-1 text-[10px] font-mono bg-[var(--surface-hover)] p-2 rounded overflow-x-auto">
                      {JSON.stringify(a.payload, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
