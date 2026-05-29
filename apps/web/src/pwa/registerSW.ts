/**
 * registerSW.ts — Best-effort service-worker registration.
 *
 * Called once from main.tsx. Guards on `serviceWorker` so SSR / older
 * browsers don't throw. Production-only registration to avoid the
 * dev-server cache-fighting headaches.
 */
export function registerServiceWorker(): void {
  if (typeof window === 'undefined') return
  if (!('serviceWorker' in navigator)) return
  // Dev: skip. Vite HMR + SW caching collide.
  if (import.meta.env.DEV) return

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(() => { /* silent — first install is invisible */ })
      .catch(() => { /* tolerated — PWA degrades to plain web app */ })
  })
}

/** Detect if we're already running as an installed PWA (standalone display). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const mql = window.matchMedia?.('(display-mode: standalone)')
  if (mql?.matches) return true
  // iOS Safari uses navigator.standalone
  if ((navigator as unknown as { standalone?: boolean }).standalone) return true
  return false
}
