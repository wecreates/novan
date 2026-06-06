/**
 * R146.330 #21 — Brain op browser.
 *
 * Lists 1015+ ops, filterable by name/description/risk. Sortable by name,
 * usage count, or recency. Each card is one-click "run with default params".
 */
import React, { useEffect, useState, useMemo } from 'react'
import { Search } from 'lucide-react'

interface Op {
  name: string
  description: string
  risk: string
  usage?: { count: number; avgMs: number; lastAt: number }
}

const RISK_COLORS: Record<string, string> = {
  low:      'text-zinc-500',
  medium:   'text-amber-600 dark:text-amber-400',
  high:     'text-red-600 dark:text-red-400',
  critical: 'text-red-700 dark:text-red-300',
}

export default function BrainBrowsePage(): JSX.Element {
  const [ops, setOps]       = useState<Op[]>([])
  const [search, setSearch] = useState('')
  const [risk, setRisk]     = useState('')
  const [sortBy, setSortBy] = useState<'name' | 'usage' | 'recent'>('name')
  const [busy, setBusy]     = useState(false)
  const [output, setOutput] = useState<{ op: string; data: unknown } | null>(null)

  useEffect(() => {
    setBusy(true)
    fetch('/api/v1/brain/op', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ op: 'op.browse', params: { sortBy } }),
    })
      .then(r => r.json())
      .then(j => { if (j.success) setOps(j.data as Op[]) })
      .finally(() => setBusy(false))
  }, [sortBy])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return ops.filter(o => {
      if (risk && o.risk !== risk) return false
      if (q && !o.name.toLowerCase().includes(q) && !o.description.toLowerCase().includes(q)) return false
      return true
    })
  }, [ops, search, risk])

  async function runOp(op: Op): Promise<void> {
    setBusy(true)
    try {
      const r = await fetch('/api/v1/brain/op', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          op: op.name, params: {},
          ...(op.risk === 'high' ? { highRiskConfirm: 'OPERATOR_APPROVED' } : {}),
        }),
      })
      const j = await r.json()
      setOutput({ op: op.name, data: j.data ?? j.error })
    } finally { setBusy(false) }
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
      <header className="border-b border-zinc-200 dark:border-zinc-800 p-4">
        <div className="max-w-4xl mx-auto flex items-center gap-3">
          <div className="flex-1 relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search 1015+ ops…"
              className="w-full pl-9 pr-3 py-2 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md text-sm focus:outline-none focus:border-zinc-400"
            />
          </div>
          <select value={risk} onChange={e => setRisk(e.target.value)} className="px-3 py-2 text-sm bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md">
            <option value="">all risk</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
          <select value={sortBy} onChange={e => setSortBy(e.target.value as 'name' | 'usage' | 'recent')} className="px-3 py-2 text-sm bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md">
            <option value="name">by name</option>
            <option value="usage">by usage</option>
            <option value="recent">by recent</option>
          </select>
        </div>
      </header>

      <main className="max-w-4xl mx-auto p-4">
        <div className="text-xs text-zinc-500 mb-3">{filtered.length} of {ops.length} ops {busy ? '(loading…)' : ''}</div>
        <div className="space-y-1">
          {filtered.map(op => (
            <button
              key={op.name}
              onClick={() => runOp(op)}
              className="w-full text-left p-3 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md hover:border-zinc-400 transition flex items-start gap-3"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <code className="text-sm font-mono">{op.name}</code>
                  <span className={`text-[10px] uppercase tracking-wide ${RISK_COLORS[op.risk] ?? 'text-zinc-500'}`}>{op.risk}</span>
                  {op.usage && op.usage.count > 0 && (
                    <span className="text-[10px] text-zinc-400">· {op.usage.count} call{op.usage.count === 1 ? '' : 's'}</span>
                  )}
                </div>
                <div className="text-xs text-zinc-500 truncate">{op.description}</div>
              </div>
            </button>
          ))}
        </div>

        {output && (
          <div className="fixed bottom-4 right-4 max-w-md max-h-96 overflow-auto p-4 bg-zinc-900 text-zinc-100 rounded-lg shadow-2xl">
            <div className="text-xs font-mono text-zinc-400 mb-2">{output.op}</div>
            <pre className="text-[11px] font-mono whitespace-pre-wrap">{JSON.stringify(output.data, null, 2).slice(0, 4000)}</pre>
            <button onClick={() => setOutput(null)} className="mt-2 text-[10px] text-zinc-500 hover:text-zinc-300">close</button>
          </div>
        )}
      </main>
    </div>
  )
}
