/**
 * GlobalPalette — Cmd/Ctrl-K from any page.
 *
 * Searches:
 *   - Routes (jump to a page by name)
 *   - Brain nodes via /api/v1/brain/search (when query is long enough)
 *
 * On select: navigates with optional ?node=… deep-link to Brain.
 */
import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Command, Search, X, Loader2 } from 'lucide-react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'
import { api } from '../api.js'

interface Route { path: string; label: string; keywords: string[] }

const ROUTES: Route[] = [
  { path: '/brain',             label: 'Brain (3D view)',     keywords: ['brain', '3d', 'spatial', 'map', 'graph'] },
  { path: '/talk',              label: 'Talk to Novan',       keywords: ['chat', 'talk', 'ask', 'novan'] },
  { path: '/home',              label: 'Home dashboard',      keywords: ['home', 'dashboard', 'overview'] },
  { path: '/mission',           label: 'Mission charter',     keywords: ['mission', 'charter', 'principles'] },
  { path: '/runtime',           label: 'Runtime (24/7)',      keywords: ['runtime', 'heartbeat', 'uptime', 'cron'] },
  { path: '/economy',           label: 'Economy + ROI',       keywords: ['economy', 'cost', 'spend', 'revenue', 'budget'] },
  { path: '/truth',             label: 'Truth (reality anchoring)', keywords: ['truth', 'drift', 'assumptions', 'reality'] },
  { path: '/commerce',          label: 'Commerce war room',   keywords: ['commerce', 'shop', 'pod', 'social'] },
  { path: '/trust-governance',  label: 'Trust & governance',  keywords: ['trust', 'governance', 'override', 'ethics'] },
  { path: '/proposals',         label: 'Code proposals',      keywords: ['proposals', 'code', 'build'] },
  { path: '/patches',           label: 'Code patches',        keywords: ['patches', 'patch', 'sandbox'] },
  { path: '/fabric',            label: 'Runtime fabric',      keywords: ['fabric', 'nodes', 'scaling'] },
  { path: '/identity',          label: 'Identity audit',      keywords: ['identity', 'tone', 'hype'] },
  { path: '/simulation',        label: 'Simulation engine',   keywords: ['simulation', 'scenarios', 'forecast'] },
  { path: '/audit-trail',       label: 'Audit trail',         keywords: ['audit', 'events', 'history'] },
  { path: '/system-map',        label: 'System map',          keywords: ['system', 'map', 'services'] },
  { path: '/operator-input',    label: 'Operator input',      keywords: ['operator', 'input', 'revenue', 'preferences'] },
  { path: '/notifications',     label: 'Notification drivers', keywords: ['notifications', 'slack', 'discord'] },
  { path: '/search',            label: 'Semantic search',     keywords: ['search', 'chains', 'semantic'] },
  { path: '/cognition',         label: 'Cognition',           keywords: ['cognition', 'memory', 'reasoning'] },
  { path: '/image-studio',      label: 'Image studio',        keywords: ['image', 'studio', 'generate'] },
  { path: '/capability-gap',    label: 'Capability gaps',     keywords: ['capability', 'gap'] },
]

interface BrainHit { id: string; kind: string; label: string; detail: string; score: number }

export function GlobalPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { workspaceId } = useWorkspace()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [brainHits, setBrainHits] = useState<BrainHit[]>([])
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Debounced brain search
  useEffect(() => {
    if (!open || q.length < 2) { setBrainHits([]); return }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setSearching(true)
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await api.get<{ data: BrainHit[] }>(`/api/v1/brain/search?workspace_id=${workspaceId}&q=${encodeURIComponent(q)}&limit=8`)
        setBrainHits(r.data ?? [])
      } catch { setBrainHits([]) }
      setSearching(false)
    }, 180)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [q, open, workspaceId])

  // Reset on open
  useEffect(() => { if (open) { setQ(''); setBrainHits([]) } }, [open])

  if (!open) return null

  const needle = q.toLowerCase()
  const routeHits = q.length === 0
    ? ROUTES.slice(0, 10)
    : ROUTES.filter(r =>
        r.label.toLowerCase().includes(needle) ||
        r.path.includes(needle) ||
        r.keywords.some(k => k.includes(needle)),
      ).slice(0, 10)

  const go = (path: string) => { navigate(path); onClose() }
  const goBrain = (nodeId: string) => { navigate(`/brain?node=${encodeURIComponent(nodeId)}`); onClose() }

  return (
    <div className="fixed inset-0 bg-[var(--bg-glass-strong)] backdrop-blur-sm flex items-start justify-center pt-24 z-command fade-in"
      onClick={onClose}>
      <div className="drawer-edge w-[600px] max-w-[90vw] dropdown-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 p-3 border-b border-border">
          <Command className="w-4 h-4 text-healthy" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search pages or brain nodes…"
            className="flex-1 bg-transparent outline-none text-sm" />
          <button onClick={onClose} className="btn-ghost btn p-1"><X className="w-3 h-3" /></button>
        </div>
        <div className="max-h-[400px] overflow-y-auto p-2">
          {routeHits.length > 0 && (
            <>
              <div className="label px-2 py-1">Pages</div>
              <ul className="space-y-0.5 mb-2">
                {routeHits.map(r => (
                  <li key={r.path}>
                    <button onClick={() => go(r.path)}
                      className="w-full text-left px-2 py-1.5 hover:bg-[var(--surface-hover)] rounded flex items-center gap-2 text-xs text-primary transition-colors duration-fast">
                      <span className="font-mono text-muted w-20 truncate">{r.path}</span>
                      <span className="flex-1">{r.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {q.length >= 2 && (
            <>
              <div className="label px-2 py-1 flex items-center gap-1.5">
                <Search className="w-3 h-3" /> Brain nodes
                {searching && <Loader2 className="w-3 h-3 animate-spin text-muted" />}
              </div>
              {brainHits.length === 0 && !searching && (
                <div className="px-2 py-2 text-2xs text-muted italic">no brain matches</div>
              )}
              <ul className="space-y-0.5">
                {brainHits.map(h => (
                  <li key={h.id}>
                    <button onClick={() => goBrain(h.id)}
                      className="w-full text-left px-2 py-1.5 hover:bg-[var(--surface-hover)] rounded flex items-center gap-2 text-xs transition-colors duration-fast">
                      <span className="font-mono text-muted uppercase tracking-wider w-14 text-2xs">{h.kind}</span>
                      <span className="text-primary flex-1 truncate">{h.label}</span>
                      <span className="text-2xs text-faint">{h.score.toFixed(2)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div className="px-3 py-2 border-t border-border text-2xs text-muted flex items-center gap-3">
          <span>↵ select</span>
          <span>esc close</span>
          <span className="ml-auto">⌘K toggle</span>
        </div>
      </div>
    </div>
  )
}
