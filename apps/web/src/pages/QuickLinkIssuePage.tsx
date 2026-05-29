/**
 * QuickLinkIssuePage.tsx — Laptop-side: shows a QR + short link so the
 * phone can sign in without typing a password.
 *
 * QR rendering: built with a tiny inline SVG generator so we don't add
 * a dep. Encodes the redemption URL as a QR matrix using a public-domain
 * implementation of the QR Code algorithm (Mode 8, ECC L) — kept in a
 * sibling util.
 */
import { useEffect, useMemo, useState } from 'react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'
import { qrMatrix } from '../pwa/qr.js'

export default function QuickLinkIssuePage(): JSX.Element {
  const { workspaceId } = useWorkspace()
  const [link, setLink] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function issue(): Promise<void> {
    if (!workspaceId) return
    setBusy(true); setErr(null); setLink(null)
    try {
      const r = await fetch('/api/v1/auth/quick-link/issue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId, issued_by: 'operator' }),
        credentials: 'include',
      })
      const j = await r.json()
      if (!j.success) throw new Error(j.error ?? 'issue failed')
      setLink(j.data.link)
      setExpiresAt(j.data.expiresAt)
    } catch (e) { setErr((e as Error).message) }
    finally { setBusy(false) }
  }

  useEffect(() => { void issue() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [workspaceId])

  const remaining = useMemo(() => {
    if (!expiresAt) return null
    const ms = expiresAt - Date.now()
    if (ms <= 0) return 'expired'
    return `${Math.max(1, Math.floor(ms / 1000))}s`
  }, [expiresAt])

  const matrix = useMemo(() => (link ? qrMatrix(link) : null), [link])

  return (
    <div className="p-8 max-w-xl mx-auto">
      <h1 className="text-xl font-semibold mb-1">Sign in on your phone</h1>
      <p className="text-sm text-gray-500 mb-6">
        Scan with your phone camera, or open the short link. Single-use, expires in 5 minutes.
      </p>

      {err && <div className="mb-4 p-3 border border-red-200 bg-red-50 rounded text-[13px] text-red-700">{err}</div>}

      <div className="flex flex-col items-center gap-4 p-6 border border-gray-200 rounded bg-white">
        {matrix ? (
          <svg
            viewBox={`0 0 ${matrix.length} ${matrix.length}`}
            className="w-64 h-64"
            style={{ shapeRendering: 'crispEdges' }}
          >
            <rect width={matrix.length} height={matrix.length} fill="#ffffff" />
            {matrix.flatMap((row, y) =>
              row.map((v, x) => v
                ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="#000000" />
                : null,
              ),
            )}
          </svg>
        ) : (
          <div className="w-64 h-64 flex items-center justify-center text-gray-400 text-sm">Generating…</div>
        )}
        {link && (
          <div className="w-full">
            <div className="text-[11px] text-gray-500 mb-1">Short link</div>
            <div className="font-mono text-[12px] break-all bg-gray-50 border border-gray-200 rounded p-2">{link}</div>
          </div>
        )}
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-gray-500">{remaining ? `Expires in ${remaining}` : ' '}</span>
          <button
            onClick={() => void issue()}
            disabled={busy || !workspaceId}
            className="text-[12px] px-3 py-1.5 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
          >New link</button>
        </div>
      </div>

      <p className="text-[11px] text-gray-400 mt-4">
        Token + redeem timing tracked under <code>auth.quick_link_issued</code> / <code>auth.quick_link_redeemed</code> events.
      </p>
    </div>
  )
}
