/**
 * Notification Drivers — show which channels are configured + test them.
 */
import React, { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { Bell, CheckCircle2, XCircle, Send } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

interface Drivers {
  configured: string[]
  available: string[]
  envVars: Record<string, { name: string; set: boolean }>
}

export default function NotificationDriversPage() {
  const { workspaceId } = useWorkspace()
  const [testMessage, setTestMessage] = useState('Test notification from runtime UI')

  const drivers = useQuery({
    queryKey: ['drivers'],
    queryFn:  () => api.get<{ data: Drivers }>(`/api/v1/self/notification-drivers`),
    refetchInterval: 60_000,
  })

  const sendTest = useMutation({
    mutationFn: () => api.post(`/api/v1/autonomy/actions/dispatch`, {
      workspace_id: workspaceId,
      type: 'notify_operator',
      requested_by: 'notification-drivers-test',
      payload: {
        title: 'Test from /notifications',
        body: testMessage,
        severity: 'high',
        signature: `test:${Date.now()}`,
      },
    }),
  })

  const d = drivers.data?.data

  return (
    <div className="p-6 space-y-4 max-w-4xl mx-auto">
      <div className="flex items-center gap-3">
        <Bell className="w-5 h-5 text-amber-400" />
        <h1 className="text-xl font-semibold">Notification Drivers</h1>
        <span className="text-xs text-[var(--text-muted)] ml-1">{d ? `${d.configured.length} of ${d.available.length} configured` : 'loading…'}</span>
      </div>

      {d && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
          <ul className="divide-y divide-[var(--border)]">
            {d.available.map(name => {
              const env = d.envVars[name]
              const ok = d.configured.includes(name)
              return (
                <li key={name} className="px-5 py-3 flex items-center gap-4 text-sm">
                  {ok
                    ? <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    : <XCircle className="w-4 h-4 text-slate-500" />}
                  <span className="font-mono w-20">{name}</span>
                  <span className="text-xs text-[var(--text-muted)] flex-1">{env?.name ?? '?'}</span>
                  <span className={`text-xs ${ok ? 'text-emerald-300' : 'text-[var(--text-muted)]'}`}>
                    {ok ? 'configured' : 'not set'}
                  </span>
                </li>
              )
            })}
          </ul>
          <div className="px-5 py-3 border-t border-[var(--border)] bg-[var(--surface-hover)] text-xs text-[var(--text-muted)]">
            Configuration is via environment variables on the API container. After setting env vars, restart the container.
            High-severity events route to all configured channels; normal-severity only to webhook.
          </div>
        </div>
      )}

      {/* Test sender */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 space-y-2">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Send className="w-4 h-4 text-sky-400" /> Test notification
        </h3>
        <p className="text-xs text-[var(--text-muted)]">
          Dispatches a notify_operator action at HIGH severity so all configured channels receive it.
        </p>
        <textarea
          value={testMessage}
          onChange={(e) => setTestMessage(e.target.value)}
          className="w-full bg-[var(--bg)] border border-[var(--border)] rounded p-2 text-sm font-mono"
          rows={3}
        />
        <button
          onClick={() => sendTest.mutate()}
          disabled={sendTest.isPending || !d || d.configured.length === 0}
          className="px-3 py-1.5 text-xs rounded border border-[var(--border)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
        >
          {sendTest.isPending ? 'Sending…' : 'Send test notification'}
        </button>
        {sendTest.isSuccess && <span className="text-xs text-emerald-400 ml-2">Dispatched.</span>}
        {sendTest.isError && <span className="text-xs text-red-400 ml-2">Failed: see console.</span>}
      </div>
    </div>
  )
}
