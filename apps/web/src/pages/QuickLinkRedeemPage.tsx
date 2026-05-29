/**
 * QuickLinkRedeemPage.tsx — Phone-side: redeem the QR/link token.
 *
 * Reads ?t=<token>, POSTs to /api/v1/auth/quick-link/redeem, and on
 * success bounces to /m/chat. On failure shows a friendly message.
 */
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

type State = 'redeeming' | 'ok' | 'expired' | 'used' | 'unknown' | 'error'

export default function QuickLinkRedeemPage(): JSX.Element {
  const navigate = useNavigate()
  const [search] = useSearchParams()
  const [state, setState] = useState<State>('redeeming')
  const [detail, setDetail] = useState<string>('')

  useEffect(() => {
    const token = search.get('t')
    if (!token) { setState('unknown'); return }
    let cancelled = false
    void (async () => {
      try {
        const r = await fetch('/api/v1/auth/quick-link/redeem', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
          credentials: 'include',
        })
        const j = await r.json().catch(() => null)
        if (cancelled) return
        if (j?.success) {
          setState('ok')
          // Brief OK pause then navigate.
          setTimeout(() => navigate('/m/chat', { replace: true }), 400)
        } else {
          const reason = j?.error
          if (reason === 'expired' || reason === 'used' || reason === 'unknown') setState(reason)
          else { setState('error'); setDetail(String(reason ?? r.status)) }
        }
      } catch (e) { if (!cancelled) { setState('error'); setDetail((e as Error).message) } }
    })()
    return () => { cancelled = true }
  }, [search, navigate])

  return (
    <div className="flex flex-col items-center justify-center h-[100dvh] bg-black text-white px-6 text-center">
      {state === 'redeeming' && <div className="text-white/70">Signing you in…</div>}
      {state === 'ok' && <div className="text-emerald-400">Signed in. Redirecting…</div>}
      {state === 'expired' && (
        <>
          <div className="text-amber-300 text-lg mb-2">Link expired.</div>
          <div className="text-white/50 text-[13px]">Generate a new one from the laptop.</div>
        </>
      )}
      {state === 'used' && (
        <>
          <div className="text-amber-300 text-lg mb-2">Link already used.</div>
          <div className="text-white/50 text-[13px]">Each link signs in one device once.</div>
        </>
      )}
      {state === 'unknown' && (
        <>
          <div className="text-red-300 text-lg mb-2">Invalid link.</div>
          <div className="text-white/50 text-[13px]">Ask the laptop for a fresh one.</div>
        </>
      )}
      {state === 'error' && (
        <>
          <div className="text-red-300 text-lg mb-2">Sign-in failed.</div>
          <div className="text-white/50 text-[13px]">{detail}</div>
        </>
      )}
    </div>
  )
}
