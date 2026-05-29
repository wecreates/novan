/**
 * SetupPage — R146.24
 *
 * First-run bootstrap. On a fresh PWA install with no API token in
 * localStorage, the operator hits this page, pastes the deployment's
 * OPERATOR_BOOTSTRAP_SECRET, gets back a long-lived API token, and
 * continues to the dashboard. The token is then auto-attached to
 * every fetch via api.ts's existing Authorization header injection.
 *
 * Once a token exists, the page shows current token metadata + lets
 * the operator wipe it.
 *
 * This is the prerequisite for re-enabling R146.23 global auth.
 */
import React, { useState } from 'react'
import { Key, LogIn, Trash2, CheckCircle2 } from 'lucide-react'
import { API_BASE, setAuthToken, clearAuthToken } from '../api.js'

export default function SetupPage() {
  const [secret, setSecret] = useState('')
  const [workspaceId, setWorkspaceId] = useState('default')
  const [tokenPreview, setTokenPreview] = useState<string | null>(
    () => (typeof localStorage !== 'undefined' ? localStorage.getItem('ops_auth_token') : null)?.slice(0, 12) ?? null,
  )
  const [status, setStatus] = useState<{ kind: 'idle' | 'loading' | 'error' | 'success'; msg?: string }>({ kind: 'idle' })

  async function bootstrap() {
    if (secret.length < 8) {
      setStatus({ kind: 'error', msg: 'secret too short' })
      return
    }
    setStatus({ kind: 'loading' })
    try {
      const r = await fetch(`${API_BASE}/api/v1/auth/bootstrap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret, workspace_id: workspaceId, name: 'pwa-bootstrap' }),
      })
      const body = await r.json() as { success?: boolean; error?: string; data?: { token: string; prefix: string } }
      if (!r.ok || !body.success || !body.data?.token) {
        setStatus({ kind: 'error', msg: body.error ?? `HTTP ${r.status}` })
        return
      }
      setAuthToken(body.data.token)
      setTokenPreview(body.data.prefix)
      setSecret('')
      setStatus({ kind: 'success', msg: `Token saved (${body.data.prefix}…). Reloading in 2s.` })
      setTimeout(() => { window.location.href = '/home' }, 2_000)
    } catch (e) {
      setStatus({ kind: 'error', msg: (e as Error).message })
    }
  }

  function logout() {
    clearAuthToken()
    setTokenPreview(null)
    setStatus({ kind: 'idle' })
  }

  return (
    <div className="p-6 max-w-md mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <Key className="w-5 h-5 text-amber-400" />
        <h1 className="text-xl font-semibold">Setup</h1>
      </div>

      {tokenPreview ? (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-5 py-4 space-y-2">
          <div className="flex items-center gap-2 text-sm text-emerald-300">
            <CheckCircle2 className="w-4 h-4" />
            <span>API token configured: <code className="font-mono text-xs">{tokenPreview}…</code></span>
          </div>
          <p className="text-xs text-muted">
            Every API call is now sent with this token in the Authorization header.
            Wipe it below to force re-bootstrap on next reload.
          </p>
          <button
            onClick={logout}
            className="flex items-center gap-1 px-2.5 py-1 rounded text-xs border border-red-500/40 text-red-300 hover:bg-red-500/10"
          >
            <Trash2 className="w-3 h-3" /> Wipe token
          </button>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-surface p-4 space-y-3">
          <p className="text-xs text-muted">
            Paste the <code className="font-mono">OPERATOR_BOOTSTRAP_SECRET</code> from your deployment's
            <code className="font-mono"> .env</code> to mint a long-lived API token. Stored only in this
            browser's <code className="font-mono">localStorage</code>.
          </p>
          <div className="space-y-2">
            <label className="text-xs text-muted">Bootstrap secret</label>
            <input
              type="password"
              value={secret}
              onChange={e => setSecret(e.target.value)}
              autoComplete="off"
              placeholder="OPERATOR_BOOTSTRAP_SECRET"
              className="w-full px-3 py-2 rounded bg-[var(--surface-hover)] font-mono text-sm"
              onKeyDown={e => { if (e.key === 'Enter') void bootstrap() }}
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs text-muted">Workspace ID</label>
            <input
              value={workspaceId}
              onChange={e => setWorkspaceId(e.target.value)}
              className="w-full px-3 py-2 rounded bg-[var(--surface-hover)] font-mono text-sm"
            />
          </div>
          <button
            onClick={() => void bootstrap()}
            disabled={status.kind === 'loading' || secret.length < 8}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded text-sm border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
          >
            <LogIn className="w-4 h-4" />
            {status.kind === 'loading' ? 'Bootstrapping…' : 'Mint token'}
          </button>
        </div>
      )}

      {status.kind === 'error' && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-2 text-sm text-red-300">
          Error: {status.msg}
        </div>
      )}
      {status.kind === 'success' && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-2 text-sm text-emerald-300">
          {status.msg}
        </div>
      )}
    </div>
  )
}
