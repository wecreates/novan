/**
 * sw.js — Minimal service worker for Novan PWA.
 *
 * Two strategies:
 *   - /api/*    → network-first with a stale-while-revalidate fallback,
 *                 so chat actually works (API responses must be fresh)
 *                 but a brief offline gap still shows the last reply.
 *   - everything else → cache-first for the app shell so the icon-tap
 *                       opens to a working UI even on a cold cellular
 *                       network.
 *
 * Versioning: bump CACHE_VERSION when shell assets change so old caches
 * get pruned on the next activate.
 */
const CACHE_VERSION = 'novan-v1'
const SHELL_CACHE   = `${CACHE_VERSION}-shell`
const API_CACHE     = `${CACHE_VERSION}-api`
const SHELL_ASSETS = [
  '/',
  '/m/chat',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(c => c.addAll(SHELL_ASSETS).catch(() => null))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(k => !k.startsWith(CACHE_VERSION))
        .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  )
})

// Push handler — payloads aren't encrypted on the server side (RFC8291
// AES-128-GCM is intentionally not implemented to keep the push module
// dep-free). We pull the latest broadcast from /api/v1/push/latest and
// render that. The push event itself is the wake-up; the payload comes
// from the API call.
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let title = 'Novan'
    let body  = 'You have a new notification.'
    let url   = '/m/chat'
    let tag   = 'novan'
    try {
      // event.data may carry the payload directly if encryption was used;
      // try that path first.
      const direct = event.data?.json?.() ?? null
      if (direct && typeof direct === 'object') {
        title = String(direct.title || title)
        body  = String(direct.body  || body)
        if (direct.url) url = String(direct.url)
        if (direct.tag) tag = String(direct.tag)
      } else {
        // Otherwise pull the latest broadcast. We don't know which
        // workspace yet — Novan is single-operator so we hit the
        // default workspace. Fall back gracefully.
        const r = await fetch('/api/v1/push/latest?workspace_id=default', { credentials: 'include' })
        const j = await r.json().catch(() => null)
        const p = j?.data
        if (p) {
          title = String(p.title || title)
          body  = String(p.body  || body)
          if (p.url) url = String(p.url)
          if (p.tag) tag = String(p.tag)
        }
      }
    } catch { /* keep defaults */ }
    await self.registration.showNotification(title, {
      body, tag, icon: '/icon.png', badge: '/icon.png',
      data: { url },
    })
  })())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url || '/m/chat'
  event.waitUntil((async () => {
    // Focus an existing PWA window if one's open; otherwise open new.
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const c of all) {
      if ('focus' in c) {
        await c.focus()
        if ('navigate' in c) try { await c.navigate(url) } catch { /* tolerated */ }
        return
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(url)
  })())
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return  // only cache safe GETs

  const url = new URL(req.url)

  // API: network-first, fallback to cached last-known response.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req).then(res => {
        // Only cache successful, complete JSON-ish responses. Skip SSE.
        const ct = res.headers.get('content-type') || ''
        if (res.ok && ct.includes('application/json')) {
          const copy = res.clone()
          caches.open(API_CACHE).then(c => c.put(req, copy)).catch(() => null)
        }
        return res
      }).catch(() => caches.match(req).then(r => r || new Response('Offline', { status: 503 })))
    )
    return
  }

  // Shell: cache-first with background refresh.
  event.respondWith(
    caches.match(req).then(cached => {
      const fetched = fetch(req).then(res => {
        if (res.ok) {
          const copy = res.clone()
          caches.open(SHELL_CACHE).then(c => c.put(req, copy)).catch(() => null)
        }
        return res
      }).catch(() => cached)
      return cached || fetched
    })
  )
})
