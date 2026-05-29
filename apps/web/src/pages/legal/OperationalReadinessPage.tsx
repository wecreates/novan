/**
 * OperationalReadinessPage.tsx — Renders /api/v1/operational-readiness.
 *
 * 50-component catalog grouped by layer. Status badges + owner chips.
 * Read-only; attestation flow lives at the brain-task surface (call
 * `operational_readiness.attest` via brain-task / MCP).
 */
import { useEffect, useState } from 'react'

interface Item {
  id: string; layer: number; layerName: string
  name: string; spec: string
  status: 'implemented' | 'partial' | 'deferred' | 'not-started'
  owner: string
  evidence?: string[]
  priority: 'required-to-start' | 'required-to-scale' | 'mature-operation'
}
interface Payload {
  items: Item[]
  summary: {
    total: number
    byStatus: Record<Item['status'], number>
    byPriority: Record<Item['priority'], number>
    requiredToStartGap: number
  }
}

const STATUS_STYLES: Record<Item['status'], string> = {
  implemented: 'bg-green-50 text-green-700 border-green-200',
  partial:     'bg-amber-50 text-amber-700 border-amber-200',
  deferred:    'bg-gray-50 text-gray-600 border-gray-200',
  'not-started': 'bg-red-50 text-red-700 border-red-200',
}

export default function OperationalReadinessPage(): JSX.Element {
  const [data, setData] = useState<Payload | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const r = await fetch('/api/v1/operational-readiness', { credentials: 'include' })
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

  const byLayer = new Map<number, Item[]>()
  for (const it of data.items) {
    if (!byLayer.has(it.layer)) byLayer.set(it.layer, [])
    byLayer.get(it.layer)!.push(it)
  }

  return (
    <div className="p-6 max-w-6xl">
      <h1 className="text-xl font-semibold mb-1">Operational Readiness</h1>
      <p className="text-sm text-gray-500 mb-4">
        {data.summary.byStatus.implemented} implemented · {data.summary.byStatus.partial} partial ·
        {' '}{data.summary.byStatus.deferred} deferred · {data.summary.byStatus['not-started']} not started ·
        {' '}{data.summary.requiredToStartGap} required-to-start gaps
      </p>

      {Array.from(byLayer.entries()).sort(([a], [b]) => a - b).map(([layer, items]) => (
        <section key={layer} className="mb-6">
          <h2 className="text-[13px] font-semibold text-gray-500 mb-2">
            Layer {layer} — {items[0]!.layerName}
          </h2>
          <div className="border border-gray-200 rounded bg-white divide-y divide-gray-100">
            {items.map(it => (
              <div key={it.id} className="p-3 flex items-start gap-4">
                <div className="font-mono text-[12px] text-gray-500 w-14 flex-shrink-0">{it.id}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-0.5">
                    <span className="font-medium text-[14px]">{it.name}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STATUS_STYLES[it.status]}`}>{it.status}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded border bg-gray-50 border-gray-200 text-gray-600">{it.owner}</span>
                    <span className="text-[10px] text-gray-400">{it.priority}</span>
                  </div>
                  <div className="text-[13px] text-gray-600">{it.spec}</div>
                  {it.evidence && it.evidence.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {it.evidence.map((e, i) => (
                        <span key={i} className="text-[11px] font-mono text-gray-500 bg-gray-50 px-1.5 py-0.5 rounded border border-gray-200">{e}</span>
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
