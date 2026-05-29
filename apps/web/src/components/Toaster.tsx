/**
 * Toaster — minimal global notification queue.
 *
 * Wired into the QueryClient's MutationCache so EVERY mutation that
 * throws produces a visible toast. Until now ~200 mutations across the
 * app silently swallowed errors with no operator feedback.
 *
 * Use `toast.error(msg)` / `toast.success(msg)` / `toast.info(msg)` from
 * anywhere; the dispatch event bubbles to the singleton renderer mounted
 * once in App.tsx.
 */
import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle, Info, X, Brain } from 'lucide-react'
import { API_BASE } from '../api.js'

type Severity = 'error' | 'success' | 'info' | 'brain'
interface Toast { id: number; severity: Severity; message: string; at: number; issueId?: string }

const TOAST_EVENT = 'novan:toast'
const AUTO_DISMISS_MS = 6_000
let nextId = 1

interface ToastPayload { severity: Severity; message: string; issueId?: string }

function dispatch(severity: Severity, message: string, issueId?: string): void {
  window.dispatchEvent(new CustomEvent<ToastPayload>(TOAST_EVENT, { detail: { severity, message, ...(issueId ? { issueId } : {}) } }))
}

export const toast = {
  error:   (msg: string) => dispatch('error', msg),
  success: (msg: string) => dispatch('success', msg),
  info:    (msg: string) => dispatch('info', msg),
  brain:   (msg: string, issueId?: string) => dispatch('brain', msg, issueId),
}

/**
 * Forward a mutation/fetch error to the brain. Operator sees a short
 * "Brain is investigating" toast instead of a raw error trace.
 *
 * Backend creates an issue, runs the auto-diagnose patterns, fires the
 * auto-loop if the pattern is known + low-risk. Whole pipeline is
 * fire-and-forget from the UI's perspective.
 */
const BASE = API_BASE
const WORKSPACE = (typeof localStorage !== 'undefined' && localStorage.getItem('ops_workspace')) || 'default'

export async function reportToBrain(opts: {
  message: string
  source?:  'ui' | 'voice' | 'chat'
  url?:     string
  method?:  string
  statusCode?: number
  stack?:   string
  payload?: unknown
}): Promise<void> {
  try {
    const res = await fetch(`${BASE}/api/v1/brain/errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace_id: WORKSPACE,
        source:       opts.source ?? 'ui',
        error_message: opts.message,
        ...(opts.url        ? { url:         opts.url } : {}),
        ...(opts.method     ? { method:      opts.method } : {}),
        ...(opts.statusCode ? { status_code: opts.statusCode } : {}),
        ...(opts.stack      ? { stack:       opts.stack } : {}),
        ...(opts.payload    ? { payload:     opts.payload as Record<string, unknown> } : {}),
        user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 200) : undefined,
      }),
    })
    const j = await res.json() as { success: boolean; data?: { brainSays: string; issueId: string; diagnosed: boolean; autoFixQueued: boolean } }
    if (j.success && j.data) {
      toast.brain(j.data.brainSays, j.data.issueId)
    } else {
      // Fall back to raw error if brain ingest itself failed
      toast.error(opts.message)
    }
  } catch {
    // Brain ingest endpoint unreachable — degrade to raw error
    toast.error(opts.message)
  }
}

export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([])

  useEffect(() => {
    // Track auto-dismiss timers so unmounting the Toaster cancels them
    // — otherwise navigating away triggers setState on an unmounted tree.
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const handler = (e: Event) => {
      const ev = e as CustomEvent<ToastPayload>
      const t: Toast = { id: nextId++, severity: ev.detail.severity, message: ev.detail.message, at: Date.now() }
      setToasts(prev => [...prev, t].slice(-5))   // cap at 5 visible
      const timer = setTimeout(() => {
        setToasts(prev => prev.filter(x => x.id !== t.id))
        timers.delete(timer)
      }, AUTO_DISMISS_MS)
      timers.add(timer)
    }
    window.addEventListener(TOAST_EVENT, handler)
    return () => {
      window.removeEventListener(TOAST_EVENT, handler)
      for (const t of timers) clearTimeout(t)
      timers.clear()
    }
  }, [])

  if (toasts.length === 0) return null
  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-md pointer-events-none">
      {toasts.map(t => (
        <div key={t.id}
          className={`pointer-events-auto rounded-lg border px-3 py-2 shadow-lg flex items-start gap-2 text-xs animate-in slide-in-from-right-4 ${
            t.severity === 'error'   ? 'bg-rose-500/15 border-rose-500/40 text-rose-200' :
            t.severity === 'success' ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200' :
            t.severity === 'brain'   ? 'bg-violet-500/15 border-violet-500/40 text-violet-200' :
                                       'bg-sky-500/15 border-sky-500/40 text-sky-200'
          }`}>
          {t.severity === 'error'   ? <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> :
           t.severity === 'success' ? <CheckCircle   className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> :
           t.severity === 'brain'   ? <Brain         className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 animate-pulse" /> :
                                      <Info          className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />}
          <span className="flex-1 break-words">{t.message}</span>
          <button onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}
            aria-label="Dismiss notification"
            className="text-current opacity-60 hover:opacity-100 flex-shrink-0">
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}
    </div>
  )
}
