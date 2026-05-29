/**
 * StatusBar.tsx — thin always-visible bottom bar.
 *
 * Reuses existing primitives: NotificationCenter for unread count,
 * BrainTaskBar-style active-tasks indicator. Pulls system health from
 * the existing /health endpoint already wired in the app.
 */
import { useEffect, useState } from 'react'

export function StatusBar(): JSX.Element {
  const [health, setHealth] = useState<'ok' | 'partial' | 'alert' | 'unknown'>('unknown')
  const [tasks, setTasks] = useState<number>(0)
  const [approvals, setApprovals] = useState<number>(0)

  useEffect(() => {
    let cancelled = false
    async function poll(): Promise<void> {
      try {
        const r = await fetch('/api/v1/health', { credentials: 'include' })
        if (!cancelled) setHealth(r.ok ? 'ok' : 'alert')
      } catch { if (!cancelled) setHealth('unknown') }
    }
    void poll()
    const t = setInterval(poll, 30_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const r = await fetch('/api/v1/brain-tasks?status=running&limit=1', { credentials: 'include' })
        if (cancelled || !r.ok) return
        const j = await r.json().catch(() => null)
        const n = Number(j?.total ?? j?.data?.length ?? 0)
        if (!cancelled) setTasks(Number.isFinite(n) ? n : 0)
      } catch { /* tolerated */ }
      try {
        const r = await fetch('/api/v1/approvals?status=pending&limit=1', { credentials: 'include' })
        if (cancelled || !r.ok) return
        const j = await r.json().catch(() => null)
        const n = Number(j?.total ?? j?.data?.length ?? 0)
        if (!cancelled) setApprovals(Number.isFinite(n) ? n : 0)
      } catch { /* tolerated */ }
    }
    void load()
    const t = setInterval(load, 60_000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])

  const dot = health === 'ok' ? 'bg-green-500' : health === 'partial' ? 'bg-yellow-500' : health === 'alert' ? 'bg-red-500' : 'bg-gray-400'

  return (
    <div className="flex items-center justify-between px-4 py-1 text-[12px] text-gray-600 border-t border-gray-200 bg-white">
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${dot}`} />
          <span>System {health}</span>
        </span>
        <span>·</span>
        <span>{tasks} active task{tasks === 1 ? '' : 's'}</span>
        <span>·</span>
        <a href="/approvals" className={approvals > 0 ? 'text-amber-700 font-medium hover:underline' : 'hover:underline'}>
          {approvals} pending approval{approvals === 1 ? '' : 's'}
        </a>
      </div>
      <div className="text-gray-400">Novan</div>
    </div>
  )
}
