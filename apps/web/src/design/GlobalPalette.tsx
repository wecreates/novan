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

// Full route registry — every page reachable via ⌘K. Grouped by section
// so the palette can show categories. Order = appearance order in the
// "nothing typed yet" view.
const ROUTES: Route[] = [
  // ─── Core ──
  { path: '/brain',             label: 'Brain · Home',             keywords: ['brain', 'home', 'lobes', 'overview', 'main'] },
  { path: '/brain/graph',       label: 'Brain · Operational graph', keywords: ['brain', 'graph', 'nodes', '3d', 'systems'] },
  { path: '/talk',              label: 'Talk to Novan',            keywords: ['chat', 'talk', 'ask'] },
  { path: '/narrative',         label: 'Narrative',                keywords: ['narrative', 'summary', 'recent'] },
  { path: '/agency',            label: 'Agency · CEO delegations', keywords: ['agency', 'agents', 'ceo', 'delegate', 'catalog'] },
  { path: '/self-check',        label: 'Self-check · platform smoke', keywords: ['self', 'check', 'smoke', 'health', 'self-heal', 'regression'] },
  { path: '/home',              label: 'Home dashboard',           keywords: ['home', 'dashboard', 'overview'] },
  { path: '/mission',           label: 'Mission charter',          keywords: ['mission', 'charter', 'principles'] },
  // ─── Intelligence ──
  { path: '/strategic-home',    label: 'Strategic home',           keywords: ['strategic', 'home'] },
  { path: '/mission-intelligence', label: 'Mission intelligence',  keywords: ['mission', 'intelligence'] },
  { path: '/strategic',         label: 'Strategic console',        keywords: ['strategic', 'console', 'load', 'anomalies', 'why'] },
  { path: '/cognition',         label: 'Cognition',                keywords: ['cognition', 'memory', 'reasoning'] },
  { path: '/truth',             label: 'Truth · reality anchoring', keywords: ['truth', 'drift', 'reality'] },
  { path: '/capability-gap',    label: 'Capability gaps',          keywords: ['capability', 'gap'] },
  { path: '/insights',          label: 'Insights',                 keywords: ['insights'] },
  { path: '/search',            label: 'Semantic search',          keywords: ['search', 'chains'] },
  { path: '/memory',            label: 'Memory browser',           keywords: ['memory', 'browser'] },
  // ─── Voice ──
  { path: '/voice',             label: 'Voice console',            keywords: ['voice', 'speech', 'mic', 'realtime'] },
  { path: '/voice/analytics',   label: 'Voice analytics',          keywords: ['voice', 'analytics', 'feedback', 'quality'] },
  // ─── Operations ──
  { path: '/war-room',          label: 'War room',                 keywords: ['war', 'room'] },
  { path: '/executive-war-room', label: 'Executive war room',      keywords: ['executive', 'war', 'room'] },
  { path: '/company-operations', label: 'Company operations',      keywords: ['company', 'operations'] },
  { path: '/runtime',           label: 'Runtime 24/7',             keywords: ['runtime', 'heartbeat', 'uptime'] },
  { path: '/agents',            label: 'Agents',                   keywords: ['agents', 'bots'] },
  { path: '/workflows',         label: 'Workflows',                keywords: ['workflows'] },
  { path: '/orchestrator',      label: 'Orchestrator',             keywords: ['orchestrator'] },
  { path: '/timeline',          label: 'Timeline',                 keywords: ['timeline'] },
  { path: '/audit-trail',       label: 'Audit trail',              keywords: ['audit', 'events', 'history'] },
  { path: '/audit',             label: 'Audit',                    keywords: ['audit'] },
  { path: '/system-map',        label: 'System map',               keywords: ['system', 'map', 'services'] },
  { path: '/fabric',            label: 'Runtime fabric',           keywords: ['fabric', 'nodes', 'scaling'] },
  { path: '/compute',           label: 'Remote compute',           keywords: ['compute', 'remote'] },
  // ─── Build ──
  { path: '/proposals',         label: 'Code proposals',           keywords: ['proposals', 'code', 'build'] },
  { path: '/patches',           label: 'Code patches',             keywords: ['patches'] },
  { path: '/patch-approvals',   label: 'Patch approvals',          keywords: ['patch', 'approvals'] },
  { path: '/sandbox',           label: 'Sandbox',                  keywords: ['sandbox'] },
  { path: '/incidents',         label: 'Incidents',                keywords: ['incidents'] },
  { path: '/dead-letter',       label: 'Dead letter',              keywords: ['dead', 'letter', 'dlq'] },
  // ─── Goals & Risk ──
  { path: '/goals',             label: 'Goals',                    keywords: ['goals'] },
  { path: '/risks',             label: 'Risks',                    keywords: ['risks'] },
  { path: '/businesses',        label: 'Businesses',               keywords: ['businesses'] },
  { path: '/approvals',         label: 'Approvals',                keywords: ['approvals'] },
  { path: '/operator-input',    label: 'Operator input',           keywords: ['operator', 'input', 'revenue'] },
  // ─── Commerce + Creative ──
  { path: '/commerce',          label: 'Commerce war room',        keywords: ['commerce', 'shop', 'pod'] },
  { path: '/image-studio',      label: 'Image studio',             keywords: ['image', 'studio', 'generate'] },
  { path: '/creative',          label: 'Creative workspace',       keywords: ['creative', 'workspace', 'art'] },
  { path: '/creative/brain',    label: 'Creative brain',           keywords: ['creative', 'brain', 'clusters', 'lineage'] },
  { path: '/war-room/creative', label: 'Creative war room',        keywords: ['creative', 'analytics', 'quality'] },
  // ─── Governance ──
  { path: '/trust-governance',  label: 'Trust & governance',       keywords: ['trust', 'governance'] },
  { path: '/identity',          label: 'Identity audit',           keywords: ['identity', 'tone', 'hype'] },
  { path: '/simulation',        label: 'Simulation engine',        keywords: ['simulation', 'scenarios'] },
  { path: '/security',          label: 'Security',                 keywords: ['security'] },
  { path: '/security-team',     label: 'Security team',            keywords: ['security', 'team'] },
  { path: '/launch-tonight',    label: 'Launch tonight',           keywords: ['launch', 'tonight'] },
  { path: '/launch-lock',       label: 'Launch lock',              keywords: ['launch', 'lock', 'gate'] },
  // ─── Money ──
  { path: '/economy',           label: 'Economy + ROI',            keywords: ['economy', 'cost', 'spend', 'revenue'] },
  { path: '/governor',          label: 'Cost governor',            keywords: ['cost', 'governor'] },
  { path: '/tenant',            label: 'Tenant & billing',         keywords: ['tenant', 'billing'] },
  { path: '/analytics',         label: 'Analytics',                keywords: ['analytics'] },
  // ─── Learning ──
  { path: '/learning',          label: 'Learning center',          keywords: ['learning', 'center'] },
  { path: '/learning-runtime',  label: 'Learning runtime',         keywords: ['learning', 'runtime'] },
  { path: '/evolution',         label: 'Evolution',                keywords: ['evolution'] },
  // ─── Settings ──
  { path: '/notifications',     label: 'Notifications',            keywords: ['notifications', 'slack', 'discord'] },
  { path: '/help',              label: 'Help',                     keywords: ['help', 'docs'] },
  { path: '/settings',          label: 'Settings (advanced)',      keywords: ['settings', 'preferences', 'api tokens', 'webhooks'] },
  { path: '/account',           label: 'Account',                  keywords: ['account', 'profile', 'theme', 'brain templates'] },
  { path: '/account?tab=workspace', label: 'Settings · Workspace', keywords: ['settings', 'workspace', 'features', 'retention'] },
  { path: '/account?tab=integrations', label: 'Settings · Integrations', keywords: ['integrations', 'connectors', 'api', 'webhooks'] },
  // ─── Session-built surfaces (added by route palette audit) ──
  { path: '/today',             label: 'Today (landing)',          keywords: ['today', 'home', 'recap', 'priority'] },
  { path: '/ideas',             label: 'Ideas',                    keywords: ['ideas', 'extract', 'product', 'business'] },
  { path: '/issues',            label: 'Issue ledger',             keywords: ['issues', 'bugs', 'diagnose', 'patch', 'incidents'] },
  { path: '/tasks',             label: 'Brain tasks (directive)',  keywords: ['tasks', 'directive', 'brain', 'command', 'do', 'execute', 'terminal'] },
  { path: '/notifications',     label: 'Notifications',            keywords: ['notifications', 'alerts', 'bell', 'inbox'] },
  { path: '/research',          label: 'Research engine',          keywords: ['research', 'topics', 'findings', 'agents', 'web search', 'crawl'] },
  { path: '/brain/errors',      label: 'Brain error log',          keywords: ['errors', 'brain', 'diagnose', 'auto-fix', 'log', 'audit'] },
  { path: '/connectors',        label: 'Connectors',               keywords: ['connectors', 'integrations', 'github', 'slack', 'oauth'] },
  { path: '/skill-library',     label: 'Skill library',            keywords: ['skills', 'library', 'instructions', 'copilot'] },
  // ─── Compute + Runtime ──
  { path: '/compute/cost',      label: 'Compute · Cost',           keywords: ['compute', 'cost', 'spend'] },
  { path: '/compute/health',    label: 'Compute · Health',         keywords: ['compute', 'health', 'system'] },
  { path: '/compute/runtime',   label: 'Compute · Runtime',        keywords: ['compute', 'runtime'] },
  { path: '/compute/settings',  label: 'Compute · Settings',       keywords: ['compute', 'settings', 'limits'] },
  { path: '/compute/war-room',  label: 'Compute · War room',       keywords: ['compute', 'war room'] },
  // ─── Governance ──
  { path: '/governor/alerts',       label: 'Governor · Alerts',       keywords: ['governor', 'alerts'] },
  { path: '/governor/kill-switches', label: 'Governor · Kill switches', keywords: ['governor', 'kill', 'emergency'] },
  { path: '/governor/providers',    label: 'Governor · Providers',    keywords: ['governor', 'providers'] },
  { path: '/governor/runaway',      label: 'Governor · Runaway jobs', keywords: ['governor', 'runaway'] },
  { path: '/governor/usage',        label: 'Governor · Usage',        keywords: ['governor', 'usage'] },
  { path: '/governor/workers',      label: 'Governor · Workers',      keywords: ['governor', 'workers'] },
  // ─── Learning detail ──
  { path: '/learning/feedback',         label: 'Learning · Feedback',       keywords: ['learning', 'feedback'] },
  { path: '/learning/insights',         label: 'Learning · Insights',       keywords: ['learning', 'insights'] },
  { path: '/learning/memory-quality',   label: 'Learning · Memory quality', keywords: ['learning', 'memory', 'quality'] },
  { path: '/learning/patterns',         label: 'Learning · Patterns',       keywords: ['learning', 'patterns'] },
  { path: '/learning/recommendations',  label: 'Learning · Recommendations', keywords: ['learning', 'recommendations'] },
  // ─── Voice + Creative + misc ──
  { path: '/voice-profiles',    label: 'Voice profiles',           keywords: ['voice', 'profiles', 'tts'] },
  { path: '/voice/analytics',   label: 'Voice analytics',          keywords: ['voice', 'analytics'] },
  { path: '/creative/brain',    label: 'Creative · Brain view',    keywords: ['creative', 'brain'] },
  { path: '/creative/workspace', label: 'Creative · Workspace',    keywords: ['creative', 'workspace'] },
  { path: '/war-room/creative', label: 'War room · Creative',      keywords: ['war room', 'creative'] },
  { path: '/agents/control',    label: 'Agents · Control',         keywords: ['agents', 'control'] },
  { path: '/launch',            label: 'Launch',                   keywords: ['launch', 'tonight'] },
  { path: '/brain/graph',       label: 'Brain · Operational graph', keywords: ['brain', 'graph', '3d', 'systems'] },
]

interface BrainHit { id: string; kind: string; label: string; detail: string; score: number }

export function GlobalPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { workspaceId } = useWorkspace()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [brainHits, setBrainHits] = useState<BrainHit[]>([])
  const [searching, setSearching] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

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
  useEffect(() => { if (open) { setQ(''); setBrainHits([]); setActiveIdx(0) } }, [open])
  // Reset cursor on query change
  useEffect(() => { setActiveIdx(0) }, [q])

  const needle = q.toLowerCase()
  const routeHits = q.length === 0
    ? ROUTES.slice(0, 14)
    : ROUTES.filter(r =>
        r.label.toLowerCase().includes(needle) ||
        r.path.includes(needle) ||
        r.keywords.some(k => k.includes(needle)),
      ).slice(0, 14)

  // Flat list of selectable items so arrow keys cross sections.
  const flat: Array<{ kind: 'route' | 'brain'; path?: string; nodeId?: string; label: string }> = [
    ...routeHits.map(r => ({ kind: 'route' as const, path: r.path, label: r.label })),
    ...(q.length >= 2 ? brainHits.map(h => ({ kind: 'brain' as const, nodeId: h.id, label: h.label })) : []),
  ]

  const go = (path: string) => { navigate(path); onClose() }
  const goBrain = (nodeId: string) => { navigate(`/brain?node=${encodeURIComponent(nodeId)}`); onClose() }
  const activate = (i: number) => {
    const it = flat[i]
    if (!it) return
    if (it.kind === 'route' && it.path) go(it.path)
    else if (it.kind === 'brain' && it.nodeId) goBrain(it.nodeId)
  }

  // Keyboard navigation: ↑/↓ move, Enter activate, Esc close.
  // Bound to the input so it works the moment the palette opens.
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(i => Math.min(flat.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(i => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      activate(activeIdx)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  // Scroll active item into view as the cursor moves
  useEffect(() => {
    if (!open || !listRef.current) return
    const node = listRef.current.querySelector(`[data-idx="${activeIdx}"]`) as HTMLElement | null
    node?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, open])

  if (!open) return null

  return (
    <div className="fixed inset-0 bg-[var(--bg-glass-strong)] backdrop-blur-sm flex items-start justify-center pt-24 z-command fade-in"
      onClick={onClose}>
      <div className="drawer-edge w-[600px] max-w-[90vw] dropdown-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 p-3 border-b border-border">
          <Command className="w-4 h-4 text-healthy" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search pages or brain nodes…   ↑↓ navigate · ↵ open"
            className="flex-1 bg-transparent outline-none text-sm" />
          <button onClick={onClose} className="btn-ghost btn p-1"><X className="w-3 h-3" /></button>
        </div>
        <div ref={listRef} className="max-h-[400px] overflow-y-auto p-2">
          {routeHits.length > 0 && (
            <>
              <div className="label px-2 py-1">Pages</div>
              <ul className="space-y-0.5 mb-2">
                {routeHits.map((r, i) => {
                  const active = i === activeIdx
                  return (
                    <li key={r.path}>
                      <button onClick={() => go(r.path)}
                        onMouseEnter={() => setActiveIdx(i)}
                        data-idx={i}
                        className={`w-full text-left px-2 py-1.5 rounded flex items-center gap-2 text-xs transition-colors duration-fast ${
                          active ? 'bg-[var(--bg-elevated)] text-primary' : 'text-primary hover:bg-[var(--surface-hover)]'
                        }`}>
                        <span className="font-mono text-muted w-24 truncate">{r.path}</span>
                        <span className="flex-1">{r.label}</span>
                        {active && <span className="text-2xs text-muted">↵</span>}
                      </button>
                    </li>
                  )
                })}
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
                {brainHits.map((h, j) => {
                  const idx = routeHits.length + j
                  const active = idx === activeIdx
                  return (
                    <li key={h.id}>
                      <button onClick={() => goBrain(h.id)}
                        onMouseEnter={() => setActiveIdx(idx)}
                        data-idx={idx}
                        className={`w-full text-left px-2 py-1.5 rounded flex items-center gap-2 text-xs transition-colors duration-fast ${
                          active ? 'bg-[var(--bg-elevated)]' : 'hover:bg-[var(--surface-hover)]'
                        }`}>
                        <span className="font-mono text-muted uppercase tracking-wider w-14 text-2xs">{h.kind}</span>
                        <span className="text-primary flex-1 truncate">{h.label}</span>
                        <span className="text-2xs text-faint">{h.score.toFixed(2)}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </>
          )}

          {flat.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-muted">
              No matches for <span className="font-mono text-primary">{q}</span>
            </div>
          )}
        </div>
        <div className="px-3 py-2 border-t border-border text-2xs text-muted flex items-center gap-3">
          <span><kbd className="font-mono">↑</kbd> <kbd className="font-mono">↓</kbd> nav</span>
          <span><kbd className="font-mono">↵</kbd> open</span>
          <span><kbd className="font-mono">esc</kbd> close</span>
          <span className="ml-auto"><kbd className="font-mono">⌘K</kbd> toggle</span>
        </div>
      </div>
    </div>
  )
}
