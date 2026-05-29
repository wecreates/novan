/**
 * useBusinessConstructionStream — subscribes to the brain SSE feed
 * and surfaces business-system spawn events in real time.
 *
 * The brain API already streams every workspace event over
 * /api/v1/brain/stream (event: 'runtime'). We filter for the
 * `business.*` event types and keep a rolling buffer of spawned
 * systems with their spatial positions so the Brain canvas can
 * render them appearing live.
 *
 * Honest scope:
 *   - This is a passive consumer — it never fakes events. If no
 *     business is being constructed, `spawned` stays empty.
 *   - On reconnect, we re-establish the EventSource. Older spawn
 *     events are not replayed; the brain's separate read endpoint
 *     (/businesses/:id/systems) is the source of truth for steady
 *     state.
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { API_BASE } from '../api.js'

export interface SpawnedSystem {
  id:        string
  businessId: string
  kind:      'department' | 'workflow' | 'agent_slot' | 'asset' | 'analytics' | 'integration'
  layer:     'executive' | 'operations' | 'finance' | 'creative' | 'growth' | 'intelligence' | 'security'
  name:      string
  parentId:  string | null
  position:  { x: number; y: number; z: number } | null
  /** ms epoch when the SSE delivered it — drives fade-in timing. */
  spawnedAt: number
}

export interface ConstructionEvent {
  type:     'business.constructed' | 'business.system.spawned' | 'business.construction.completed'
  payload:  Record<string, unknown>
  at:       number
}

interface RuntimeEvent {
  type:    string
  source:  string
  createdAt: number
  payload: Record<string, unknown>
}

interface Options {
  /** Drop spawn events older than this many ms (default 30 s) so the
   *  canvas doesn't carry a long tail of stale animations after a
   *  burst of construction. */
  retentionMs?: number
}

export function useBusinessConstructionStream(workspaceId: string, opts: Options = {}) {
  const retentionMs = opts.retentionMs ?? 30_000
  const [spawned, setSpawned] = useState<SpawnedSystem[]>([])
  const [recent, setRecent]   = useState<ConstructionEvent[]>([])
  const [connected, setConnected] = useState(false)
  const sourceRef = useRef<EventSource | null>(null)

  // Open / re-open the stream when the workspace changes
  useEffect(() => {
    if (!workspaceId || typeof EventSource === 'undefined') return
    let cancelled = false
    let reopenTimer: ReturnType<typeof setTimeout> | null = null

    function open() {
      if (cancelled) return
      // Direct to API (skip Vite proxy) — proxied SSE leaks sockets across HMR.
      const BASE = API_BASE
      const es = new EventSource(`${BASE}/api/v1/brain/stream?workspace_id=${encodeURIComponent(workspaceId)}`)
      sourceRef.current = es

      es.addEventListener('open', () => setConnected(true))
      es.addEventListener('error', () => {
        setConnected(false)
        // Browser auto-reconnects EventSource by default; if it gives
        // up (readyState CLOSED), reopen once after a short delay.
        // Track the timer so unmount-during-backoff doesn't fire open()
        // on a torn-down component.
        if (es.readyState === EventSource.CLOSED && !cancelled) {
          reopenTimer = setTimeout(() => { reopenTimer = null; open() }, 2_000)
        }
      })
      es.addEventListener('runtime', (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as RuntimeEvent
          handle(data)
        } catch { /* ignore malformed frames */ }
      })
    }

    function handle(ev: RuntimeEvent) {
      if (!ev.type?.startsWith('business.')) return
      const at = ev.createdAt || Date.now()

      if (ev.type === 'business.system.spawned') {
        const p = ev.payload as {
          businessId?: string; systemId?: string; kind?: string; layer?: string;
          name?: string; parentId?: string | null; position?: { x: number; y: number; z: number } | null
        }
        if (!p.systemId) return
        const sys: SpawnedSystem = {
          id:         p.systemId,
          businessId: p.businessId ?? '',
          kind:       (p.kind ?? 'workflow') as SpawnedSystem['kind'],
          layer:      (p.layer ?? 'operations') as SpawnedSystem['layer'],
          name:       p.name ?? '(unnamed)',
          parentId:   p.parentId ?? null,
          position:   p.position ?? null,
          spawnedAt:  Date.now(),
        }
        setSpawned(prev => {
          // Dedupe by id; keep the freshest entry
          const without = prev.filter(s => s.id !== sys.id)
          return [...without, sys]
        })
      }

      // Keep a small "recent events" log for the UI banner
      setRecent(prev => {
        const next = [{ type: ev.type as ConstructionEvent['type'], payload: ev.payload, at }, ...prev]
        return next.slice(0, 30)
      })
    }

    open()
    return () => {
      cancelled = true
      if (reopenTimer) { clearTimeout(reopenTimer); reopenTimer = null }
      sourceRef.current?.close()
      sourceRef.current = null
      setConnected(false)
    }
  }, [workspaceId])

  // Garbage-collect old spawns on a slow timer so they fade out cleanly
  useEffect(() => {
    const id = setInterval(() => {
      const cutoff = Date.now() - retentionMs
      setSpawned(prev => prev.filter(s => s.spawnedAt >= cutoff))
    }, 2_000)
    return () => clearInterval(id)
  }, [retentionMs])

  const clear = useCallback(() => { setSpawned([]); setRecent([]) }, [])

  return { spawned, recent, connected, clear }
}
