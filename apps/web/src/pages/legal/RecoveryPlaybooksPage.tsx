/**
 * RecoveryPlaybooksPage.tsx — Renders /api/v1/recovery-playbooks.
 *
 * Shows the 8-entry playbook registry. Marks HUMAN-gated playbooks
 * (lock tamper, kill switch, budget) so the operator knows nothing
 * auto-runs there.
 */
import { useEffect, useState } from 'react'

interface Playbook {
  failureMode: string; title: string; description: string
  runbook: string; detectionEventType: string
  autoRecoverable: boolean; escalateAfterFails: number
  recoverySteps: string[]
}
interface Payload {
  playbooks: Playbook[]
  summary: { total: number; autoRecoverable: number; humanGated: number }
}

export default function RecoveryPlaybooksPage(): JSX.Element {
  const [data, setData] = useState<Payload | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const r = await fetch('/api/v1/recovery-playbooks', { credentials: 'include' })
        const j = await r.json()
        if (cancelled) return
        if (!j.success) { setErr(j.error ?? 'load failed'); return }
        setData(j.data as Payload)
      } catch (e) { if (!cancelled) setErr((e as Error).message) }
    }
    void load()
    return () => { cancelled = true }
  }, [])

  if (err) return <div className="p-6 text-red-600">Failed to load: {err}</div>
  if (!data) return <div className="p-6 text-gray-500">Loading…</div>

  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-xl font-semibold mb-1">Recovery Playbooks</h1>
      <p className="text-sm text-gray-500 mb-4">
        {data.summary.total} playbooks · {data.summary.autoRecoverable} auto-recoverable · {data.summary.humanGated} human-gated
      </p>

      <div className="space-y-4">
        {data.playbooks.map(p => (
          <div key={p.failureMode} className="border border-gray-200 rounded bg-white p-4">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="font-medium text-[15px]">{p.title}</span>
              <span className={[
                'text-[10px] px-1.5 py-0.5 rounded border',
                p.autoRecoverable
                  ? 'bg-blue-50 text-blue-700 border-blue-200'
                  : 'bg-amber-50 text-amber-700 border-amber-200',
              ].join(' ')}>
                {p.autoRecoverable ? 'auto' : 'human-gated'}
              </span>
              <span className="text-[11px] font-mono text-gray-500">{p.failureMode}</span>
            </div>
            <div className="text-[13px] text-gray-600 mb-2">{p.description}</div>
            <div className="text-[12px] text-gray-500 mb-2">
              Triggered by: <code className="font-mono">{p.detectionEventType}</code> · runbook:{' '}
              <code className="font-mono">{p.runbook}</code>
              {p.escalateAfterFails > 0 && <> · escalate after {p.escalateAfterFails} fail{p.escalateAfterFails === 1 ? '' : 's'}</>}
            </div>
            <ol className="list-decimal ml-5 text-[13px] text-gray-700 space-y-0.5">
              {p.recoverySteps.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
          </div>
        ))}
      </div>
    </div>
  )
}
