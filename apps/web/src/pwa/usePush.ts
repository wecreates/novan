/**
 * usePush.ts — Hook for subscribing the browser to Novan push.
 *
 * Flow on operator tap:
 *   1. GET /api/v1/push/public-key → VAPID public key
 *   2. Notification.requestPermission()
 *   3. ServiceWorkerRegistration.pushManager.subscribe()
 *   4. POST /api/v1/push/subscribe with the subscription JSON
 *
 * Returns enough state to render an Enable/Disable button + the
 * current permission status.
 */
import { useCallback, useEffect, useState } from 'react'

type PermissionState = 'default' | 'granted' | 'denied' | 'unsupported'

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export function usePush(workspaceId: string | null) {
  const [permission, setPermission] = useState<PermissionState>('default')
  const [subscribed, setSubscribed] = useState<boolean>(false)
  const [busy, setBusy] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (typeof Notification === 'undefined' || !('serviceWorker' in navigator)) {
      setPermission('unsupported')
      return
    }
    setPermission(Notification.permission as PermissionState)
    // Check if a subscription already exists.
    void (async () => {
      try {
        const reg = await navigator.serviceWorker.ready
        const sub = await reg.pushManager.getSubscription()
        setSubscribed(!!sub)
      } catch { /* tolerated */ }
    })()
  }, [])

  const enable = useCallback(async (): Promise<void> => {
    if (!workspaceId) return
    setBusy(true); setError(null)
    try {
      // 1. Public key
      const r = await fetch('/api/v1/push/public-key', { credentials: 'include' })
      const j = await r.json().catch(() => null)
      const pubKey = j?.data?.publicKey
      if (!pubKey) throw new Error(j?.error ?? 'VAPID keys not configured on the server')

      // 2. Permission
      const perm = await Notification.requestPermission()
      setPermission(perm as PermissionState)
      if (perm !== 'granted') { setError('Notification permission denied'); return }

      // 3. Subscribe via Push Manager
      const reg = await navigator.serviceWorker.ready
      const keyBytes = urlBase64ToUint8Array(pubKey)
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes.buffer as ArrayBuffer,
      })

      // 4. Persist on server
      const sj = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
      await fetch('/api/v1/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: workspaceId,
          subscription: sj,
          user_agent: navigator.userAgent,
        }),
        credentials: 'include',
      })
      setSubscribed(true)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [workspaceId])

  const disable = useCallback(async (): Promise<void> => {
    if (!workspaceId) return
    setBusy(true); setError(null)
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        const endpoint = sub.endpoint
        try { await sub.unsubscribe() } catch { /* tolerated */ }
        await fetch('/api/v1/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace_id: workspaceId, endpoint }),
          credentials: 'include',
        })
      }
      setSubscribed(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [workspaceId])

  return { permission, subscribed, busy, error, enable, disable }
}
