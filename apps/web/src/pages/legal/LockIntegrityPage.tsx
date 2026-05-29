/**
 * LockIntegrityPage.tsx — Renders /api/v1/lock-integrity/verdict.
 *
 * Shows the most recent integrity check for LOCKED_PATHS. Tampering
 * surfaces as red; bootstrap (first-tick) as gray.
 */
import { useEffect, useState } from 'react'

interface Verdict {
  checked: number; matches: number
  tampered: string[]; bootstrapped: string[]; missing: string[]
  uncoveredCanonical: string[]
}
interface Payload { lockedPaths: string[]; verdict: Verdict }

export default function LockIntegrityPage(): JSX.Element {
  const [data, setData] = useState<Payload | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function load(): Promise<void> {
    setLoading(true); setErr(null)
    try {
      const r = await fetch('/api/v1/lock-integrity/verdict', { credentials: 'include' })
      const j = await r.json()
      if (!j.success) { setErr(j.error ?? 'load failed'); return }
      setData(j.data as Payload)
    } catch (e) { setErr((e as Error).message) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  if (err) return <div className="p-6 text-red-600">Failed to load: {err}</div>
  if (!data) return <div className="p-6 text-gray-500">Loading…</div>

  const { lockedPaths, verdict } = data
  const tampered = new Set(verdict.tampered)
  const bootstrapped = new Set(verdict.bootstrapped)
  const missing = new Set(verdict.missing)

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold">Lock Integrity</h1>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="text-[12px] px-2 py-1 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
        >{loading ? 'Checking…' : 'Re-check'}</button>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        {verdict.checked} paths checked · {verdict.matches} matched ·
        {' '}{verdict.tampered.length} tampered · {verdict.bootstrapped.length} bootstrapped ·
        {' '}{verdict.missing.length} missing
      </p>

      {verdict.tampered.length > 0 && (
        <div className="mb-4 p-3 border border-red-200 bg-red-50 rounded text-[13px] text-red-700">
          <strong>Tampering detected.</strong> Do NOT auto-revert. See <code>docs/SPEC.md#§10.5</code> + Recovery Playbooks.
        </div>
      )}

      {verdict.uncoveredCanonical.length > 0 && (
        <div className="mb-4 p-3 border border-amber-200 bg-amber-50 rounded text-[13px] text-amber-700">
          <strong>LOCKED_PATHS drift:</strong> canonical patterns without a matching path entry:
          <ul className="list-disc ml-5 mt-1 font-mono text-[12px]">
            {verdict.uncoveredCanonical.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        </div>
      )}

      <div className="border border-gray-200 rounded bg-white divide-y divide-gray-100">
        {lockedPaths.map(p => {
          let status: 'match' | 'tampered' | 'bootstrap' | 'missing' = 'match'
          if (tampered.has(p)) status = 'tampered'
          else if (bootstrapped.has(p)) status = 'bootstrap'
          else if (missing.has(p)) status = 'missing'
          const cls =
            status === 'match'     ? 'bg-green-50 text-green-700 border-green-200' :
            status === 'tampered'  ? 'bg-red-50 text-red-700 border-red-200' :
            status === 'bootstrap' ? 'bg-gray-50 text-gray-600 border-gray-200' :
                                     'bg-amber-50 text-amber-700 border-amber-200'
          return (
            <div key={p} className="p-2 flex items-center gap-3">
              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${cls} w-20 text-center`}>{status}</span>
              <span className="font-mono text-[12px] text-gray-700 truncate">{p}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
