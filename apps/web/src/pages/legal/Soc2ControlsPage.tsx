/**
 * Soc2ControlsPage.tsx — Renders /api/v1/compliance/controls.
 *
 * Read-only catalog view. Status badges per control; grouped by CC
 * category to mirror the SOC 2 TSC structure.
 */
import { useEffect, useState } from 'react'

interface Control {
  id: string; category: string; title: string; description: string
  status: 'implemented' | 'partial' | 'gap'
  evidence: Array<{ kind: string; ref: string; notes?: string }>
}
interface Payload {
  controls: Control[]
  summary: { implemented: number; partial: number; gap: number; total: number }
  byCategory: Record<string, Control[]>
}

export default function Soc2ControlsPage(): JSX.Element {
  const [data, setData] = useState<Payload | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const r = await fetch('/api/v1/compliance/controls', { credentials: 'include' })
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

  const badge = (s: Control['status']) =>
    s === 'implemented' ? 'bg-green-50 text-green-700 border-green-200'
    : s === 'partial'   ? 'bg-amber-50 text-amber-700 border-amber-200'
    :                     'bg-red-50 text-red-700 border-red-200'

  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-xl font-semibold mb-1">SOC 2 Controls</h1>
      <p className="text-sm text-gray-500 mb-4">
        {data.summary.implemented} implemented · {data.summary.partial} partial · {data.summary.gap} gap · {data.summary.total} total
      </p>

      {Object.entries(data.byCategory).map(([cat, controls]) => (
        <section key={cat} className="mb-6">
          <h2 className="text-[13px] font-semibold text-gray-500 mb-2">{cat}</h2>
          <div className="border border-gray-200 rounded bg-white divide-y divide-gray-100">
            {controls.map(c => (
              <div key={c.id} className="p-3 flex gap-4">
                <div className="font-mono text-[12px] text-gray-500 w-16 flex-shrink-0">{c.id}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="font-medium text-[14px]">{c.title}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${badge(c.status)}`}>{c.status}</span>
                  </div>
                  <div className="text-[13px] text-gray-600">{c.description}</div>
                  {c.evidence.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {c.evidence.map((e, i) => (
                        <span key={i} className="text-[11px] font-mono text-gray-500 bg-gray-50 px-1.5 py-0.5 rounded border border-gray-200">
                          {e.kind}: {e.ref}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
