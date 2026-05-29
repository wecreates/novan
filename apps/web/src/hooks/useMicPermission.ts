/**
 * useMicPermission — observe the browser's microphone permission state.
 *
 * Returns one of:
 *   'granted'    — operator has approved mic; capture works
 *   'denied'     — operator blocked it; surface a muted-mic affordance
 *   'prompt'     — never asked yet
 *   'unsupported' — Permissions API or mediaDevices missing
 *
 * Never opens the mic. Polls the Permissions API at mount and listens
 * for `change` events when supported. Used purely to drive UI cues
 * (e.g. crossed-out mic icon) — not to gate listening flows.
 */
import { useEffect, useState } from 'react'

export type MicPermission = 'granted' | 'denied' | 'prompt' | 'unsupported'

export function useMicPermission(): MicPermission {
  const [state, setState] = useState<MicPermission>('unsupported')

  useEffect(() => {
    if (typeof navigator === 'undefined') return
    // Permissions API isn't on every browser (Safari is partial)
    // — fall back to feature detection on `mediaDevices`.
    const perms = (navigator as Navigator & { permissions?: Permissions }).permissions
    if (!perms || typeof perms.query !== 'function') {
      const hasMedia = Boolean((navigator as Navigator & { mediaDevices?: MediaDevices }).mediaDevices)
      setState(hasMedia ? 'prompt' : 'unsupported')
      return
    }

    let status: PermissionStatus | null = null
    let listener: (() => void) | null = null
    let cancelled = false

    perms.query({ name: 'microphone' as PermissionName }).then((s) => {
      if (cancelled) return
      status = s
      setState(s.state as MicPermission)
      // Hold the listener reference so cleanup can detach it. Without
      // this, every mount/unmount cycle leaks a closure that fires on
      // every permission change for the page's lifetime.
      listener = () => { if (!cancelled) setState(s.state as MicPermission) }
      s.addEventListener('change', listener)
    }).catch(() => {
      if (!cancelled) setState('unsupported')
    })

    return () => {
      cancelled = true
      if (status && listener) status.removeEventListener('change', listener)
    }
  }, [])

  return state
}
