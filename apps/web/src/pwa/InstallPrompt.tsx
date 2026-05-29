/**
 * InstallPrompt.tsx — Subtle banner that nudges the operator to install
 * the PWA on first eligible visit.
 *
 * Android Chrome fires `beforeinstallprompt` once the heuristics agree
 * (manifest valid, SW present, repeat-visit, not already installed).
 * We capture the event, show our banner, and call `prompt()` if the
 * operator taps install.
 *
 * iOS Safari doesn't fire beforeinstallprompt — instead we show an
 * iOS-specific hint with the "Share → Add to Home Screen" instruction
 * the first time the page is opened on an iPhone-class user agent.
 *
 * Dismiss state persists in localStorage so we don't nag.
 */
import { useEffect, useState } from 'react'
import { isStandalone } from './registerSW'

interface BIPEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const DISMISS_KEY = 'novan.pwa.installDismissed'

function userIsApple(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  return /iPhone|iPad|iPod/i.test(ua) && !/CriOS|FxiOS/i.test(ua)
}

export function InstallPrompt(): JSX.Element | null {
  const [event, setEvent] = useState<BIPEvent | null>(null)
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try { return localStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
  })
  const [showIosHint, setShowIosHint] = useState(false)

  useEffect(() => {
    if (isStandalone()) return  // already installed
    if (dismissed) return

    const onBip = (e: Event): void => {
      e.preventDefault()
      setEvent(e as BIPEvent)
    }
    window.addEventListener('beforeinstallprompt', onBip)

    // iOS path — no native event, so we show a hint after a short delay
    // so it doesn't flash on first paint.
    if (userIsApple()) {
      const t = setTimeout(() => setShowIosHint(true), 1500)
      return () => { clearTimeout(t); window.removeEventListener('beforeinstallprompt', onBip) }
    }
    return () => window.removeEventListener('beforeinstallprompt', onBip)
  }, [dismissed])

  function dismiss(): void {
    try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* tolerated */ }
    setDismissed(true)
    setEvent(null)
    setShowIosHint(false)
  }

  if (dismissed || isStandalone()) return null

  // Android / Desktop Chrome path
  if (event) {
    return (
      <div className="fixed bottom-4 left-4 right-4 z-50 max-w-md mx-auto px-4 py-3 rounded-xl bg-black/90 backdrop-blur border border-white/15 text-white shadow-2xl flex items-center gap-3">
        <div className="flex-1 text-[13px]">
          <div className="font-medium mb-0.5">Install Novan</div>
          <div className="text-white/60 text-[12px]">Add to home screen for a real app icon.</div>
        </div>
        <button
          onClick={async () => {
            try {
              await event.prompt()
              const r = await event.userChoice.catch(() => ({ outcome: 'dismissed' as const }))
              if (r.outcome === 'accepted') dismiss()
            } catch { /* tolerated */ }
          }}
          className="px-3 py-1.5 rounded-lg bg-white text-black text-[12px] font-medium hover:bg-white/90"
        >Install</button>
        <button
          onClick={dismiss}
          className="w-7 h-7 flex items-center justify-center rounded-lg text-white/40 hover:text-white hover:bg-white/10"
          aria-label="Dismiss"
        >×</button>
      </div>
    )
  }

  // iOS path
  if (showIosHint) {
    return (
      <div className="fixed bottom-4 left-4 right-4 z-50 max-w-md mx-auto px-4 py-3 rounded-xl bg-black/90 backdrop-blur border border-white/15 text-white shadow-2xl flex items-start gap-3">
        <div className="flex-1 text-[13px]">
          <div className="font-medium mb-0.5">Install Novan</div>
          <div className="text-white/60 text-[12px]">
            Tap <span className="font-mono">Share</span> → <span className="font-mono">Add to Home Screen</span>.
          </div>
        </div>
        <button
          onClick={dismiss}
          className="w-7 h-7 flex items-center justify-center rounded-lg text-white/40 hover:text-white hover:bg-white/10"
          aria-label="Dismiss"
        >×</button>
      </div>
    )
  }

  return null
}
