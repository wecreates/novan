/**
 * Brain — minimal premium 3D operational view.
 *
 * Dark background, soft depth, dropdown-first nav, no clutter.
 * Real data from /api/v1/brain/graph; click to drill into nodes;
 * actions through /api/v1/brain/actions (approval-gated).
 */
import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Canvas, useFrame, type ThreeEvent } from '@react-three/fiber'
import { OrbitControls, Html, AdaptiveDpr, AdaptiveEvents, Stats } from '@react-three/drei'
import {
  Brain, Filter, Eye, Sparkles, Activity, X, Loader2,
  ChevronDown, Search, Pause, Play, ShieldCheck, Network, AlertOctagon,
  Command, ArrowLeft, Clock, History, Bookmark, ChevronRight,
} from 'lucide-react'
import * as THREE from 'three'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'
import { COLOR, STATUS_COLOR as STATUS_COLOR_TOKEN } from '../design/tokens.js'
import { tone } from '../design/audio.js'

// ─── Types from API ──────────────────────────────────────────────────────

interface BrainNode {
  id: string; kind: string; label: string; system?: string
  status: 'healthy' | 'degraded' | 'down' | 'pending' | 'paused' | 'unknown'
  metric?: number; detail?: string
  position?: [number, number, number]
  scale?: number
}
interface BrainEdge { from: string; to: string; kind: string }
interface BrainGraph {
  template: string; generatedAt: number
  nodes: BrainNode[]; edges: BrainEdge[]
  systems: Array<{ id: string; label: string; count: number; status: string }>
}
interface NodeDetail {
  id: string; kind: string; label: string; status: string
  fields: Array<{ key: string; value: string }>
  events: Array<{ at: number; type: string; summary: string }>
  actions: Array<{ id: string; label: string; risk: 'low' | 'medium' | 'high' | 'critical'; payload?: Record<string, unknown> }>
}
interface SearchHit { id: string; kind: string; label: string; detail: string; score: number }
interface TimelineSummary {
  from: number; to: number; bucketMs: number
  buckets: Array<{ at: number; events: number; byKind: Record<string, number> }>
  totalEvents: number
  topKinds: Array<{ kind: string; count: number }>
}
interface DecisionPath {
  rootEvent: { type: string; at: number } | null
  steps: Array<{ step: number; kind: string; at: number; summary: string; source?: string }>
  notes: string[]
}
interface SavedView { name: string; template: string; focus: string | null; createdAt: number }

// ─── Visual constants ────────────────────────────────────────────────────

// Local typed view of the central design tokens (keeps strict types).
const STATUS_COLOR: Record<BrainNode['status'], string> = {
  healthy:  STATUS_COLOR_TOKEN.healthy ?? COLOR.healthy,
  degraded: STATUS_COLOR_TOKEN.degraded ?? COLOR.warning,
  down:     STATUS_COLOR_TOKEN.down ?? COLOR.critical,
  pending:  STATUS_COLOR_TOKEN.pending ?? COLOR.info,
  paused:   STATUS_COLOR_TOKEN.paused ?? COLOR.paused,
  unknown:  STATUS_COLOR_TOKEN.unknown ?? COLOR.textMuted,
}

const TEMPLATES: Array<{ id: string; label: string }> = [
  { id: 'neural',         label: 'Neural Brain' },
  { id: 'solar',          label: 'Solar System' },
  { id: 'command_core',   label: 'Command Core' },
  { id: 'galaxy',         label: 'Galaxy Map' },
  { id: 'runtime_mesh',   label: 'Runtime Mesh' },
  { id: 'agent_swarm',    label: 'Agent Swarm' },
  { id: 'security_grid',  label: 'Security Grid' },
  { id: 'mission_orbit',  label: 'Mission Orbit' },
]

// ─── 3D primitives ───────────────────────────────────────────────────────

function NodeSphere({
  node, selected, hovered, onClick, onDoubleClick, onHover,
}: {
  node: BrainNode
  selected: boolean; hovered: boolean
  onClick: (n: BrainNode) => void
  onDoubleClick: (n: BrainNode) => void
  onHover: (n: BrainNode | null) => void
}) {
  const mesh = useRef<THREE.Mesh>(null)
  const color = STATUS_COLOR[node.status]
  const pos = node.position ?? [0, 0, 0]
  const baseScale = node.scale ?? 0.5
  const isCore = node.kind === 'core'
  const isSystem = node.kind === 'system'

  // Subtle pulse on core; slow rotation on systems
  useFrame((_, dt) => {
    if (!mesh.current) return
    if (isCore) {
      const t = performance.now() / 1000
      mesh.current.scale.setScalar(baseScale * (1 + Math.sin(t * 0.8) * 0.04))
    } else {
      mesh.current.rotation.y += dt * 0.05
    }
  })

  return (
    <group position={pos}>
      <mesh ref={mesh}
        onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onClick(node) }}
        onDoubleClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onDoubleClick(node) }}
        onPointerOver={(e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); onHover(node) }}
        onPointerOut={() => onHover(null)}
        scale={baseScale}>
        <sphereGeometry args={[1, isCore ? 32 : isSystem ? 20 : 12, isCore ? 32 : isSystem ? 20 : 12]} />
        <meshStandardMaterial
          color={color}
          roughness={isCore ? 0.2 : 0.5}
          metalness={isCore ? 0.5 : 0.2}
          emissive={color}
          emissiveIntensity={selected ? 0.6 : hovered ? 0.4 : isCore ? 0.25 : 0.12}
        />
      </mesh>
      {(isCore || isSystem || selected || hovered) && (
        <Html distanceFactor={10} center position={[0, baseScale * 1.6, 0]}>
          <div className="text-[10px] text-white/80 font-mono whitespace-nowrap select-none pointer-events-none">
            {node.label}
          </div>
        </Html>
      )}
    </group>
  )
}

function Edge({ from, to }: { from: [number, number, number]; to: [number, number, number] }) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([...from, ...to], 3))
    return g
  }, [from[0], from[1], from[2], to[0], to[1], to[2]])
  return (
    <line>
      <primitive object={geometry} attach="geometry" />
      <lineBasicMaterial color="#475569" transparent opacity={0.25} />
    </line>
  )
}

function BrainScene({
  graph, selectedId, hoveredId, onNodeClick, onNodeDoubleClick, onNodeHover, focusOn,
}: {
  graph: BrainGraph
  selectedId: string | null; hoveredId: string | null
  onNodeClick: (n: BrainNode) => void
  onNodeDoubleClick: (n: BrainNode) => void
  onNodeHover: (n: BrainNode | null) => void
  focusOn: [number, number, number] | null
}) {
  const controlsRef = useRef<{ target: THREE.Vector3 } | null>(null)
  const posById = useMemo(() => {
    const m = new Map<string, [number, number, number]>()
    for (const n of graph.nodes) m.set(n.id, n.position ?? [0, 0, 0])
    return m
  }, [graph.nodes])

  // Smooth re-target on focus
  useEffect(() => {
    if (!focusOn || !controlsRef.current) return
    const target = new THREE.Vector3(...focusOn)
    const start = controlsRef.current.target.clone()
    let t = 0
    const id = setInterval(() => {
      t += 0.08
      if (t >= 1 || !controlsRef.current) { clearInterval(id); return }
      controlsRef.current.target.lerpVectors(start, target, t)
    }, 16)
    return () => clearInterval(id)
  }, [focusOn])

  return (
    <>
      <ambientLight intensity={0.4} />
      <pointLight position={[10, 10, 10]} intensity={0.6} />
      <pointLight position={[-10, -10, -10]} intensity={0.3} color="#64748b" />

      {/* Edges first so spheres render on top */}
      {graph.edges.map((e, i) => {
        const a = posById.get(e.from); const b = posById.get(e.to)
        if (!a || !b) return null
        return <Edge key={i} from={a} to={b} />
      })}

      {graph.nodes.map(n => (
        <NodeSphere key={n.id} node={n}
          selected={selectedId === n.id} hovered={hoveredId === n.id}
          onClick={onNodeClick} onDoubleClick={onNodeDoubleClick} onHover={onNodeHover} />
      ))}

      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <OrbitControls
        ref={controlsRef as any}
        enableDamping dampingFactor={0.08}
        rotateSpeed={0.6} zoomSpeed={0.7}
        minDistance={3} maxDistance={50}
      />
      <AdaptiveDpr pixelated />
      <AdaptiveEvents />
    </>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────

export default function BrainPage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const [template, setTemplate] = useState('neural')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [reducedMotion, setReducedMotion] = useState(false)
  const [fallback2D, setFallback2D] = useState(false)
  const [focusOn, setFocusOn] = useState<[number, number, number] | null>(null)
  const [eventTicker, setEventTicker] = useState<Array<{ at: number; text: string }>>([])
  // New: palette / replay / focus
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState('')
  const [focusSystem, setFocusSystem] = useState<string | null>(null)
  const [lod, setLod] = useState<'systems' | 'global' | 'focus'>('systems')
  const [replayMode, setReplayMode] = useState(false)
  const [replayAtMs, setReplayAtMs] = useState<number>(Date.now())
  const [timeRange, setTimeRange] = useState<'15m' | '1h' | '24h' | '7d'>('1h')
  const [recentNodes, setRecentNodes] = useState<string[]>(() => {
    if (typeof window === 'undefined') return []
    try { return JSON.parse(localStorage.getItem('novan.brain.recent') ?? '[]') } catch { return [] }
  })
  const [confirmAction, setConfirmAction] = useState<{ actionId: string; payload?: Record<string, unknown>; label: string } | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [historicalSearch, setHistoricalSearch] = useState(false)
  const [windowMinutes, setWindowMinutes] = useState(5)
  const [showFps, setShowFps] = useState(false)

  // URL params for deep-linking from War Room (Incidents/Proposals/Audit)
  const [searchParams] = useSearchParams()
  const screenshotMode = searchParams.get('screenshot') === '1'
  useEffect(() => {
    const at = searchParams.get('replay_at')
    const node = searchParams.get('node')
    const tpl = searchParams.get('template')
    const focus = searchParams.get('focus')
    if (at) {
      const n = Number(at)
      if (Number.isFinite(n)) {
        setReplayMode(true)
        setReplayAtMs(n)
      }
    }
    if (tpl && TEMPLATES.find(t => t.id === tpl)) setTemplate(tpl)
    if (focus) { setFocusSystem(focus); setLod('focus') }
    if (node) setSelectedId(node)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Backend-synced saved views
  const savedViewsQuery = useQuery({
    queryKey: ['brain-saved-views', workspaceId],
    queryFn: () => api.get<{ data: Array<{ id: string; name: string; template: string; focusSystem: string | null; lod: string; cameraPosition: unknown }> }>(
      `/api/v1/brain/saved-views?workspace_id=${workspaceId}`,
    ),
    refetchInterval: 5 * 60_000,
  })
  const savedViews = savedViewsQuery.data?.data ?? []

  const createSavedView = useMutation({
    mutationFn: (input: { name: string }) => api.post(`/api/v1/brain/saved-views`, {
      workspace_id: workspaceId, name: input.name,
      template, focus_system: focusSystem, lod,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['brain-saved-views', workspaceId] }),
  })
  const deleteSavedViewMut = useMutation({
    mutationFn: (id: string) => fetch(`/api/v1/brain/saved-views/${id}?workspace_id=${workspaceId}`, { method: 'DELETE' }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['brain-saved-views', workspaceId] }),
  })

  const graph = useQuery({
    queryKey: ['brain-graph', workspaceId, template, lod, focusSystem, replayMode, replayAtMs],
    queryFn: () => {
      if (replayMode) {
        return api.get<{ data: BrainGraph & { replay: { at: number; readOnly: true; honestNote: string } } }>(
          `/api/v1/brain/replay?workspace_id=${workspaceId}&template=${template}&at=${replayAtMs}`
        )
      }
      const params = new URLSearchParams({
        workspace_id: workspaceId, template, lod,
        ...(focusSystem ? { focus: focusSystem } : {}),
      })
      return api.get<{ data: BrainGraph }>(`/api/v1/brain/graph?${params}`)
    },
    refetchInterval: replayMode ? false : 15_000,
  })

  const timeline = useQuery({
    queryKey: ['brain-timeline', workspaceId, timeRange],
    queryFn: () => {
      const now = Date.now()
      const ranges = { '15m': 15 * 60_000, '1h': 60 * 60_000, '24h': 24 * 60 * 60_000, '7d': 7 * 24 * 60 * 60_000 }
      const from = now - ranges[timeRange]
      const bucket = timeRange === '15m' ? 30_000 : timeRange === '1h' ? 60_000 : timeRange === '24h' ? 30 * 60_000 : 6 * 60 * 60_000
      return api.get<{ data: TimelineSummary }>(`/api/v1/brain/timeline?workspace_id=${workspaceId}&from=${from}&to=${now}&bucket_ms=${bucket}`)
    },
    enabled: replayMode,
    refetchInterval: replayMode ? 30_000 : false,
  })

  const decisionPath = useQuery({
    queryKey: ['brain-decision-path', workspaceId, selectedId, windowMinutes],
    queryFn: () => {
      const key = selectedId?.startsWith('mem:') ? selectedId.slice(4) : selectedId
      return api.get<{ data: DecisionPath }>(`/api/v1/brain/decision-path/${encodeURIComponent(key ?? '')}?workspace_id=${workspaceId}&window_minutes=${windowMinutes}`)
    },
    enabled: !!selectedId && (selectedId.startsWith('mem:') || replayMode),
  })

  const paletteResults = useQuery({
    queryKey: ['brain-search', workspaceId, paletteQuery, historicalSearch, replayMode, replayAtMs],
    queryFn: () => {
      if (historicalSearch) {
        const to = replayMode ? replayAtMs : Date.now()
        const from = to - 7 * 24 * 60 * 60_000
        return api.get<{ data: SearchHit[] }>(`/api/v1/brain/search?workspace_id=${workspaceId}&q=${encodeURIComponent(paletteQuery)}&limit=15&historical=1&from=${from}&to=${to}`)
      }
      return api.get<{ data: SearchHit[] }>(`/api/v1/brain/search?workspace_id=${workspaceId}&q=${encodeURIComponent(paletteQuery)}&limit=15`)
    },
    enabled: paletteOpen && paletteQuery.length >= 2,
  })

  const detail = useQuery<{ data: NodeDetail | null }>({
    queryKey: ['brain-detail', workspaceId, selectedId],
    queryFn: async () => {
      if (!selectedId) return { data: null }
      return api.get<{ data: NodeDetail }>(`/api/v1/brain/nodes/${encodeURIComponent(selectedId)}?workspace_id=${workspaceId}`) as Promise<{ data: NodeDetail }>
    },
    enabled: !!selectedId,
  })

  const doAction = useMutation({
    mutationFn: (args: { actionId: string; payload: Record<string, unknown>; approvalToken?: string }) =>
      api.post(`/api/v1/brain/actions`, {
        workspace_id: workspaceId,
        action_id: args.actionId,
        node_id: selectedId,
        payload: args.payload,
        ...(args.approvalToken ? { approval_token: args.approvalToken } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['brain-graph', workspaceId] })
      qc.invalidateQueries({ queryKey: ['brain-detail', workspaceId, selectedId] })
    },
  })

  // Reduced-motion preference
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReducedMotion(mq.matches)
    const fn = () => setReducedMotion(mq.matches)
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [])

  // SSE event ticker
  useEffect(() => {
    if (!workspaceId) return
    let alive = true
    const url = `/api/v1/brain/stream?workspace_id=${workspaceId}`
    const ctrl = new AbortController()
    ;(async () => {
      try {
        const res = await fetch(url, { signal: ctrl.signal })
        if (!res.body) return
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        while (alive) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const blocks = buf.split('\n\n'); buf = blocks.pop() ?? ''
          for (const block of blocks) {
            const lines = block.split('\n')
            let eventName = '', dataStr = ''
            for (const ln of lines) {
              if (ln.startsWith('event: ')) eventName = ln.slice(7).trim()
              else if (ln.startsWith('data: ')) dataStr = ln.slice(6)
            }
            if (eventName !== 'runtime') continue
            try {
              const d = JSON.parse(dataStr) as { type: string; createdAt: number }
              setEventTicker(prev => [{ at: d.createdAt, text: d.type }, ...prev].slice(0, 8))
            } catch { /* tolerate */ }
          }
        }
      } catch { /* tolerate */ }
    })()
    return () => { alive = false; ctrl.abort() }
  }, [workspaceId])

  const g = graph.data?.data
  const visibleNodes = useMemo(() => {
    if (!g) return [] as BrainNode[]
    return g.nodes.filter(n => {
      if (search && !n.label.toLowerCase().includes(search.toLowerCase()) && !n.id.toLowerCase().includes(search.toLowerCase())) return false
      if (statusFilter !== 'all' && n.status !== statusFilter && n.kind !== 'core' && n.kind !== 'system') return false
      return true
    })
  }, [g, search, statusFilter])

  const visibleEdges = useMemo(() => {
    if (!g) return [] as BrainEdge[]
    const visibleIds = new Set(visibleNodes.map(n => n.id))
    return g.edges.filter(e => visibleIds.has(e.from) && visibleIds.has(e.to))
  }, [g, visibleNodes])

  const onNodeClick = (n: BrainNode) => {
    setSelectedId(n.id)
    if (n.position) setFocusOn(n.position)
    tone('select')
    // Update recent (most-recent first, dedup, cap 8)
    setRecentNodes(prev => {
      const next = [n.id, ...prev.filter(id => id !== n.id)].slice(0, 8)
      if (typeof window !== 'undefined') localStorage.setItem('novan.brain.recent', JSON.stringify(next))
      return next
    })
  }

  // Double-click a system → focus mode
  const onNodeDoubleClick = (n: BrainNode) => {
    if (n.kind === 'system') {
      setFocusSystem(n.id)
      setLod('focus')
    }
  }

  const clearFocus = () => {
    setFocusSystem(null)
    setLod('systems')
    setSelectedId(null)
    setFocusOn([0, 0, 0])
  }

  // Keyboard: Cmd/Ctrl-K opens palette, Esc clears focus/closes palette
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setPaletteOpen(o => !o)
      } else if (e.key === 'Escape') {
        if (paletteOpen) setPaletteOpen(false)
        else if (selectedId) setSelectedId(null)
        else if (focusSystem) clearFocus()
      }
    }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [paletteOpen, selectedId, focusSystem])

  const saveView = () => {
    const name = prompt('Name this view:')
    if (!name) return
    createSavedView.mutate({ name })
  }

  const loadView = (v: { template: string; focusSystem: string | null; lod: string }) => {
    setTemplate(v.template)
    setFocusSystem(v.focusSystem)
    setLod((v.lod as 'systems' | 'global' | 'focus') ?? 'systems')
  }

  const removeView = (id: string) => { deleteSavedViewMut.mutate(id) }

  const onSearchEnter = () => {
    if (!g) return
    const hit = g.nodes.find(n => n.label.toLowerCase().includes(search.toLowerCase()) || n.id.toLowerCase().includes(search.toLowerCase()))
    if (hit) onNodeClick(hit)
  }

  const filteredGraph: BrainGraph | null = g ? { ...g, nodes: visibleNodes, edges: visibleEdges } : null

  return (
    <div className="fixed inset-0 bg-bg text-primary flex flex-col">
      {/* Top command bar — hidden in screenshot mode */}
      <div className={`glass border-b border-border px-4 py-2 flex items-center gap-3 text-xs z-overlay relative ${screenshotMode ? 'hidden' : ''}`}>
        <Brain className="w-4 h-4 text-healthy" />
        <span className="font-medium text-primary tracking-tight">Novan Brain</span>

        {/* Breadcrumb */}
        <div className="flex items-center gap-1.5 text-muted">
          <button onClick={clearFocus} className="hover:text-primary flex items-center gap-1 transition-colors duration-fast ease-out">
            <Brain className="w-3 h-3" /> global
          </button>
          {focusSystem && (
            <>
              <ChevronRight className="w-3 h-3 text-faint" />
              <span className="text-healthy font-mono">{focusSystem}</span>
            </>
          )}
          {selectedId && (
            <>
              <ChevronRight className="w-3 h-3 text-faint" />
              <span className="text-active font-mono truncate max-w-[140px]">{selectedId}</span>
            </>
          )}
        </div>

        <Dropdown label="Template" icon={<Eye className="w-3 h-3" />}
          options={TEMPLATES} value={template} onChange={setTemplate} />

        <Dropdown label="Status" icon={<Filter className="w-3 h-3" />}
          options={[
            { id: 'all', label: 'All' },
            { id: 'healthy', label: 'Healthy' },
            { id: 'degraded', label: 'Degraded' },
            { id: 'down', label: 'Down' },
            { id: 'paused', label: 'Paused' },
            { id: 'pending', label: 'Pending' },
          ]} value={statusFilter} onChange={setStatusFilter} />

        <Dropdown label="View" icon={<Network className="w-3 h-3" />}
          options={[
            { id: '3d', label: '3D' },
            { id: '2d', label: '2D fallback' },
          ]} value={fallback2D ? '2d' : '3d'} onChange={v => setFallback2D(v === '2d')} />

        <Dropdown label="LOD" icon={<Eye className="w-3 h-3" />}
          options={[
            { id: 'global',  label: 'Global only' },
            { id: 'systems', label: 'Systems + subnodes' },
            { id: 'focus',   label: 'Focus selected system' },
          ]} value={lod} onChange={v => setLod(v as 'systems' | 'global' | 'focus')} />

        <Dropdown label={replayMode ? 'Replay' : 'Mode'} icon={<History className="w-3 h-3" />}
          options={[
            { id: 'live',   label: 'Live' },
            { id: 'replay', label: 'Replay' },
          ]} value={replayMode ? 'replay' : 'live'} onChange={v => {
            setReplayMode(v === 'replay')
            if (v === 'replay') setReplayAtMs(Date.now())
          }} />

        {replayMode && (
          <Dropdown label="Range" icon={<Clock className="w-3 h-3" />}
            options={[
              { id: '15m', label: 'Last 15 min' },
              { id: '1h',  label: 'Last hour' },
              { id: '24h', label: 'Last 24h' },
              { id: '7d',  label: 'Last 7d' },
            ]} value={timeRange} onChange={v => setTimeRange(v as '15m' | '1h' | '24h' | '7d')} />
        )}

        <div className="flex items-center gap-1 ml-2 px-2 py-1 rounded bg-white/5 border border-white/10">
          <Search className="w-3 h-3 text-white/40" />
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onSearchEnter() }}
            placeholder="search nodes…"
            className="bg-transparent outline-none w-44 text-[11px]" />
        </div>

        <button onClick={() => setPaletteOpen(true)}
          className="ml-2 px-2 py-1 rounded text-[10px] border border-border hover:bg-[var(--surface-hover)] flex items-center gap-1.5 transition-colors duration-fast ease-out">
          <Command className="w-3 h-3" /> ⌘K
        </button>

        <button onClick={() => setShowFps(f => !f)}
          title="Toggle FPS stats"
          className={`px-2 py-1 rounded text-[10px] border transition-colors duration-fast ease-out ${
            showFps ? 'border-[rgba(103,232,249,0.30)] text-active bg-[rgba(103,232,249,0.05)]' : 'border-border text-muted hover:bg-[var(--surface-hover)]'
          }`}>
          fps
        </button>

        <button onClick={saveView} title="Save current view"
          className="px-2 py-1 rounded text-[10px] border border-white/10 hover:bg-white/5 flex items-center gap-1">
          <Bookmark className="w-3 h-3" />
        </button>

        {focusSystem && (
          <button onClick={clearFocus}
            className="px-2 py-1 rounded text-[10px] border border-white/10 hover:bg-white/5 flex items-center gap-1">
            <ArrowLeft className="w-3 h-3" /> global
          </button>
        )}

        <span className="ml-auto text-[10px] text-white/40">
          {replayMode && <span className="text-amber-300 mr-2">⏸ READ-ONLY · {new Date(replayAtMs).toLocaleTimeString()}</span>}
          {g ? `${g.nodes.length} nodes · ${g.systems.length} systems` : graph.isLoading ? 'loading…' : 'no graph'}
        </span>
      </div>

      {/* Main scene */}
      <div className="flex-1 relative">
        {!filteredGraph ? (
          <div className="absolute inset-0 flex items-center justify-center text-white/40 text-sm">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading brain graph…
          </div>
        ) : fallback2D ? (
          <Fallback2D graph={filteredGraph} onSelect={(n) => onNodeClick(n)} selectedId={selectedId} />
        ) : (
          <ErrorBoundary onError={() => setFallback2D(true)}>
            <Canvas
              dpr={[1, reducedMotion ? 1 : 2]}
              camera={{ position: [12, 8, 12], fov: 50 }}
              frameloop={reducedMotion ? 'demand' : 'always'}
              gl={{ antialias: true, alpha: true }}
              onPointerMissed={() => setSelectedId(null)}>
              <color attach="background" args={[COLOR.bg]} />
              <fog attach="fog" args={[COLOR.bg, 25, 60]} />
              <Suspense fallback={null}>
                <BrainScene
                  graph={filteredGraph}
                  selectedId={selectedId}
                  hoveredId={hoveredId}
                  onNodeClick={onNodeClick}
                  onNodeDoubleClick={onNodeDoubleClick}
                  onNodeHover={(n) => setHoveredId(n?.id ?? null)}
                  focusOn={focusOn}
                />
                {showFps && <Stats className="!left-auto !right-2 !top-auto !bottom-2" />}
              </Suspense>
            </Canvas>
          </ErrorBoundary>
        )}

        {/* All overlay chrome below hides in ?screenshot=1 mode */}
        {!screenshotMode && eventTicker.length > 0 && (
          <div className="absolute bottom-3 left-3 max-w-md text-2xs mono space-y-0.5 pointer-events-none z-overlay">
            {eventTicker.slice(0, 5).map((e, i) => (
              <div key={`${e.at}-${i}`} className="text-muted truncate fade-in">
                <Activity className="w-2.5 h-2.5 inline mr-1 text-healthy opacity-70" />
                {new Date(e.at).toLocaleTimeString()} · {e.text}
              </div>
            ))}
          </div>
        )}

        {/* Systems strip (top-right) — quick template summary */}
        {g && !screenshotMode && (
          <div className="absolute top-3 right-3 glass rounded-lg p-2 space-y-0.5 text-2xs z-overlay">
            {g.systems.map(s => (
              <button key={s.id} onClick={() => {
                const node = g.nodes.find(n => n.id === s.id)
                if (node) onNodeClick(node)
              }}
                className="flex items-center gap-2 w-full hover:bg-[var(--surface-hover)] px-2 py-1 rounded transition-colors duration-fast ease-out">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: STATUS_COLOR[s.status as BrainNode['status']] }} />
                <span className="font-mono text-secondary">{s.label}</span>
                <span className="ml-auto text-muted">{s.count}</span>
              </button>
            ))}
          </div>
        )}

        {/* Detail drawer */}
        {selectedId && detail.data?.data && (
          <DetailDrawer detail={detail.data.data}
            replayMode={replayMode}
            decisionPath={decisionPath.data?.data ?? null}
            windowMinutes={windowMinutes}
            onExpandWindow={() => setWindowMinutes(m => Math.min(60, m + 10))}
            onClose={() => setSelectedId(null)}
            onAction={(actionId, payload, risk, label) => {
              if (risk === 'critical' || risk === 'high') {
                setConfirmAction({ actionId, payload: payload ?? {}, label })
                setConfirmText('')
              } else {
                doAction.mutate({ actionId, payload: payload ?? {} })
              }
            }}
            pending={doAction.isPending} />
        )}

        {/* Critical action confirmation modal */}
        {confirmAction && (
          <div className="absolute inset-0 bg-[var(--bg-glass-strong)] backdrop-blur-sm flex items-center justify-center z-modal fade-in"
            onClick={() => setConfirmAction(null)}>
            <div className="glass-strong rounded-lg p-5 max-w-md shadow-4 border border-[rgba(239,68,68,0.40)] fade-up"
              onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-2 mb-3">
                <AlertOctagon className="w-4 h-4 text-red-400" />
                <h3 className="text-sm font-medium text-red-300">Critical action</h3>
              </div>
              <p className="text-sm text-white/85 mb-3">
                You are about to: <span className="font-mono text-amber-200">{confirmAction.label}</span>
              </p>
              <p className="text-[10px] text-white/50 mb-2">
                Type <span className="font-mono text-red-300">CONFIRM</span> to proceed. This action emits a runtime event and writes to override_log.
              </p>
              <input autoFocus value={confirmText} onChange={(e) => setConfirmText(e.target.value)}
                placeholder="type CONFIRM"
                className="w-full bg-black border border-white/20 rounded px-3 py-2 text-sm font-mono mb-3 outline-none focus:border-red-500/50" />
              <div className="flex gap-2">
                <button onClick={() => setConfirmAction(null)}
                  className="flex-1 px-3 py-1.5 text-xs rounded border border-white/10 hover:bg-white/5">
                  Cancel
                </button>
                <button onClick={() => {
                  if (confirmText.trim() !== 'CONFIRM') return
                  doAction.mutate({ actionId: confirmAction.actionId, payload: confirmAction.payload ?? {}, approvalToken: 'OPERATOR_APPROVED' })
                  setConfirmAction(null); setConfirmText('')
                }}
                  disabled={confirmText.trim() !== 'CONFIRM'}
                  className="flex-1 px-3 py-1.5 text-xs rounded bg-red-500/20 border border-red-500/40 text-red-300 hover:bg-red-500/30 disabled:opacity-30 disabled:cursor-not-allowed">
                  Execute
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Saved views strip */}
        {savedViews.length > 0 && !paletteOpen && !screenshotMode && (
          <div className="absolute top-3 left-3 glass rounded-lg p-2 max-w-[200px] fade-in z-overlay">
            <div className="label mb-1 flex items-center gap-1">
              <Bookmark className="w-3 h-3" /> Saved views
            </div>
            <ul className="space-y-0.5 text-2xs">
              {savedViews.slice(0, 6).map(v => (
                <li key={v.id} className="flex items-center gap-1">
                  <button onClick={() => loadView(v)} className="flex-1 text-left text-secondary hover:bg-[var(--surface-hover)] hover:text-primary px-1.5 py-1 rounded truncate transition-colors duration-fast ease-out" title={`${v.template}${v.focusSystem ? `/${v.focusSystem}` : ''}`}>
                    {v.name}
                  </button>
                  <button onClick={() => removeView(v.id)} className="text-faint hover:text-primary p-0.5 transition-colors duration-fast"><X className="w-2.5 h-2.5" /></button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Mini-map */}
        {filteredGraph && !fallback2D && !screenshotMode && (
          <MiniMap graph={filteredGraph} selectedId={selectedId} />
        )}

        {/* Replay timeline slider */}
        {replayMode && timeline.data?.data && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 glass-strong rounded-lg px-4 py-2 w-[80%] max-w-3xl fade-up z-overlay">
            <div className="flex items-center gap-3 text-[10px]">
              <Clock className="w-3 h-3 text-amber-300" />
              <span className="text-white/60">{new Date(timeline.data.data.from).toLocaleTimeString()}</span>
              <input type="range"
                min={timeline.data.data.from} max={timeline.data.data.to}
                value={replayAtMs} step={(timeline.data.data.to - timeline.data.data.from) / 200}
                onChange={(e) => setReplayAtMs(Number(e.target.value))}
                className="flex-1 accent-amber-400" />
              <span className="text-white/60">{new Date(timeline.data.data.to).toLocaleTimeString()}</span>
              <button onClick={() => setReplayAtMs(timeline.data!.data!.to)}
                className="text-white/40 hover:text-white/80 text-[10px]">now</button>
            </div>
            {/* Histogram of events per bucket */}
            <div className="flex items-end gap-0.5 h-8 mt-1">
              {timeline.data.data.buckets.map(b => {
                const max = Math.max(...timeline.data!.data!.buckets.map(x => x.events), 1)
                const h = Math.max(2, (b.events / max) * 28)
                const active = b.at <= replayAtMs && b.at + timeline.data!.data!.bucketMs > replayAtMs
                return (
                  <div key={b.at} className={`flex-1 ${active ? 'bg-amber-400' : 'bg-white/20'}`}
                    style={{ height: h }} title={`${new Date(b.at).toLocaleTimeString()} · ${b.events} events`} />
                )
              })}
            </div>
            <div className="text-[9px] text-white/40 mt-1 flex justify-between">
              <span>{timeline.data.data.totalEvents} events in window</span>
              <span>{timeline.data.data.topKinds.slice(0, 3).map(k => `${k.kind}(${k.count})`).join(' · ')}</span>
            </div>
          </div>
        )}

        {/* Command palette */}
        {paletteOpen && (
          <div className="absolute inset-0 bg-[var(--bg-glass-strong)] backdrop-blur-sm flex items-start justify-center pt-24 z-command fade-in"
            onClick={() => setPaletteOpen(false)}>
            <div className="drawer-edge w-[600px] max-w-[90vw] dropdown-in"
              onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-2 p-3 border-b border-white/10">
                <Command className="w-4 h-4 text-emerald-400" />
                <input autoFocus value={paletteQuery}
                  onChange={(e) => setPaletteQuery(e.target.value)}
                  placeholder="Search nodes · run actions · jump to system…"
                  className="flex-1 bg-transparent outline-none text-sm" />
                <button onClick={() => setHistoricalSearch(h => !h)}
                  className={`text-[10px] px-1.5 py-0.5 rounded border ${historicalSearch ? 'border-amber-500/40 text-amber-300 bg-amber-500/10' : 'border-white/10 text-white/50'}`}>
                  history {historicalSearch ? 'on' : 'off'}
                </button>
                <span className="text-[10px] text-white/40">ESC</span>
              </div>
              <div className="max-h-[400px] overflow-y-auto p-2">
                {paletteQuery.length < 2 ? (
                  <div className="text-xs text-white/40 p-3">
                    <p className="mb-2">Try: <span className="font-mono">runtime</span>, <span className="font-mono">agent</span>, <span className="font-mono">drift</span>, <span className="font-mono">proposal</span>, system name, agent name.</p>
                    {recentNodes.length > 0 && g && (
                      <>
                        <div className="text-[10px] uppercase tracking-wider mt-3 mb-1">Recent</div>
                        <ul className="space-y-0.5">
                          {recentNodes.map(id => {
                            const n = g.nodes.find(x => x.id === id)
                            if (!n) return null
                            return (
                              <li key={id}>
                                <button onClick={() => { setPaletteOpen(false); onNodeClick(n) }}
                                  className="w-full text-left px-2 py-1 hover:bg-white/5 rounded flex items-center gap-2">
                                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: STATUS_COLOR[n.status] }} />
                                  <span className="font-mono text-white/40 uppercase tracking-wider w-16 text-[10px]">{n.kind}</span>
                                  <span className="text-white/85">{n.label}</span>
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                      </>
                    )}
                  </div>
                ) : paletteResults.isLoading ? (
                  <div className="text-xs text-white/40 p-3 flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> searching…</div>
                ) : (paletteResults.data?.data ?? []).length === 0 ? (
                  <div className="text-xs text-white/40 p-3">No matches.</div>
                ) : (
                  <ul className="space-y-0.5">
                    {(paletteResults.data?.data ?? []).map(hit => {
                      const n = g?.nodes.find(x => x.id === hit.id)
                      return (
                        <li key={hit.id}>
                          <button onClick={() => {
                            setPaletteOpen(false)
                            if (n) onNodeClick(n)
                            else { setSelectedId(hit.id); setFocusOn(null) }
                          }}
                            className="w-full text-left px-2 py-1.5 hover:bg-white/5 rounded flex items-center gap-2 text-xs">
                            <span className="w-1.5 h-1.5 rounded-full" style={{ background: n ? STATUS_COLOR[n.status] : '#64748b' }} />
                            <span className="font-mono text-white/40 uppercase tracking-wider w-16 text-[10px]">{hit.kind}</span>
                            <span className="text-white/85 flex-1 truncate">{hit.label}</span>
                            <span className="text-[10px] text-white/30">{hit.score.toFixed(2)}</span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
              <div className="px-3 py-2 border-t border-white/10 text-[10px] text-white/40 flex items-center gap-3">
                <span>↵ select</span>
                <span>esc close</span>
                <span className="ml-auto">⌘K toggle</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Components ──────────────────────────────────────────────────────────

function Dropdown<T extends string>({
  label, icon, options, value, onChange,
}: {
  label: string
  icon?: React.ReactNode
  options: Array<{ id: T; label: string }>
  value: T
  onChange: (v: T) => void
}) {
  const [open, setOpen] = useState(false)
  const cur = options.find(o => o.id === value)
  return (
    <div className="relative">
      <button onClick={() => setOpen(s => !s)}
        className="flex items-center gap-1.5 px-2 py-1 rounded border border-white/10 hover:bg-white/5">
        {icon}
        <span className="text-white/60">{label}:</span>
        <span className="text-white/90 font-mono">{cur?.label ?? value}</span>
        <ChevronDown className="w-3 h-3 text-white/50" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-black/85 backdrop-blur border border-white/10 rounded shadow-lg min-w-[140px] z-50">
          {options.map(o => (
            <button key={o.id}
              onClick={() => { onChange(o.id); setOpen(false) }}
              className={`w-full text-left px-3 py-1.5 hover:bg-white/10 ${value === o.id ? 'text-emerald-300' : 'text-white/80'}`}>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function DetailDrawer({
  detail, replayMode, decisionPath, windowMinutes, onExpandWindow, onClose, onAction, pending,
}: {
  detail: NodeDetail
  replayMode: boolean
  decisionPath: DecisionPath | null
  windowMinutes: number
  onExpandWindow: () => void
  onClose: () => void
  onAction: (actionId: string, payload: Record<string, unknown> | undefined, risk: 'low' | 'medium' | 'high' | 'critical', label: string) => void
  pending: boolean
}) {
  const statusColor = STATUS_COLOR[detail.status as BrainNode['status']] ?? '#64748b'
  return (
    <div className="absolute top-3 right-3 w-80 drawer-edge slide-from-right p-3 z-drawer"
      style={{ maxHeight: 'calc(100vh - 6rem)', overflowY: 'auto' }}>
      <div className="flex items-center gap-2 mb-2">
        <span className="w-2 h-2 rounded-full" style={{ background: statusColor }} />
        <div className="flex-1">
          <div className="text-xs text-white/40 uppercase tracking-wider">{detail.kind}</div>
          <div className="text-sm font-medium">{detail.label}</div>
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-white/10">
          <X className="w-3.5 h-3.5 text-white/60" />
        </button>
      </div>

      {detail.fields.length > 0 && (
        <div className="text-xs space-y-1 mb-3">
          {detail.fields.map(f => (
            <div key={f.key} className="flex justify-between gap-3">
              <span className="text-white/40">{f.key}</span>
              <span className="font-mono text-white/85 truncate" title={f.value}>{f.value}</span>
            </div>
          ))}
        </div>
      )}

      {detail.events.length > 0 && (
        <div className="text-xs mb-3">
          <div className="text-[10px] uppercase tracking-wider text-white/40 mb-1">Recent events</div>
          <ul className="space-y-0.5">
            {detail.events.slice(0, 5).map((e, i) => (
              <li key={i} className="text-white/70">
                <span className="text-white/40">{new Date(e.at).toLocaleTimeString()}</span>{' '}
                {e.summary}
              </li>
            ))}
          </ul>
        </div>
      )}

      {detail.actions.length > 0 && (
        <div className="text-xs">
          <div className="text-[10px] uppercase tracking-wider text-white/40 mb-1.5 flex items-center gap-2">
            Actions
            {replayMode && <span className="text-amber-300">⏸ disabled in replay</span>}
          </div>
          <div className="space-y-1">
            {detail.actions.map(a => {
              const isCritical = a.risk === 'high' || a.risk === 'critical'
              return (
                <button key={a.id} onClick={() => onAction(a.id, a.payload, a.risk, a.label)}
                  disabled={pending || replayMode}
                  className={`w-full px-2 py-1 rounded text-left flex items-center gap-2 border ${
                    isCritical
                      ? 'border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20'
                      : a.risk === 'medium'
                        ? 'border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20'
                        : 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300 hover:bg-emerald-500/15'
                  } disabled:opacity-50 disabled:cursor-not-allowed`}>
                  {a.id === 'pause_agent' && <Pause className="w-3 h-3" />}
                  {a.id === 'resume_agent' && <Play className="w-3 h-3" />}
                  {a.id === 'approve_proposal' && <ShieldCheck className="w-3 h-3" />}
                  {a.id === 'engage_kill_switch' && <AlertOctagon className="w-3 h-3" />}
                  {!['pause_agent', 'resume_agent', 'approve_proposal', 'engage_kill_switch'].includes(a.id) && <Sparkles className="w-3 h-3" />}
                  <span className="flex-1">{a.label}</span>
                  <span className="text-[10px] uppercase tracking-wider opacity-70">{a.risk}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {decisionPath && decisionPath.steps.length > 0 && (
        <div className="text-xs mt-3 pt-3 border-t border-white/10">
          <div className="text-[10px] uppercase tracking-wider text-white/40 mb-1.5 flex items-center">
            <span>Decision path ({decisionPath.steps.length}) · ±{windowMinutes}m</span>
            {windowMinutes < 60 && (
              <button onClick={onExpandWindow}
                className="ml-auto text-[10px] text-sky-400 hover:underline">expand window →</button>
            )}
          </div>

          {/* SVG mini-graph */}
          <DecisionPathGraph steps={decisionPath.steps} />

          {decisionPath.notes.length > 0 && (
            <p className="text-[10px] text-white/30 mt-1.5">{decisionPath.notes.join(' · ')}</p>
          )}
        </div>
      )}
    </div>
  )
}

function DecisionPathGraph({ steps }: { steps: DecisionPath['steps'] }) {
  if (steps.length === 0) return null
  const kinds = ['chain', 'override', 'event', 'block', 'incident'] as const
  const kindColor: Record<string, string> = {
    chain:    COLOR.healthy, override: COLOR.warning, event: COLOR.textMuted,
    block:    COLOR.critical, incident: '#fb923c',
  }
  const visible = steps.slice(0, 10)
  const w = 290, padX = 14, padY = 18
  const innerW = w - padX * 2
  const minAt = visible[0]!.at
  const maxAt = visible[visible.length - 1]!.at
  const span = Math.max(1, maxAt - minAt)
  const rowY = (kind: string) => padY + (kinds.indexOf(kind as typeof kinds[number]) + 0.5) * 14
  const colX = (at: number) => padX + ((at - minAt) / span) * innerW
  const h = padY + kinds.length * 14 + padY / 2

  return (
    <div className="bg-black/40 border border-white/5 rounded p-1 mt-1 mb-1.5">
      <svg width={w} height={h} className="block">
        {/* kind row labels */}
        {kinds.map(k => (
          <text key={k} x={2} y={rowY(k) + 3} fontSize={8} fill="rgba(255,255,255,0.30)" fontFamily="monospace">
            {k}
          </text>
        ))}
        {/* horizontal time axis */}
        <line x1={padX} y1={h - padY / 2} x2={w - padX} y2={h - padY / 2} stroke="rgba(255,255,255,0.10)" />
        {/* lines between sequential steps */}
        {visible.map((s, i) => {
          if (i === 0) return null
          const prev = visible[i - 1]!
          return (
            <line key={`l-${s.step}`}
              x1={colX(prev.at)} y1={rowY(prev.kind)}
              x2={colX(s.at)}    y2={rowY(s.kind)}
              stroke="rgba(255,255,255,0.18)" strokeWidth={1} />
          )
        })}
        {/* step dots */}
        {visible.map(s => (
          <g key={s.step}>
            <circle cx={colX(s.at)} cy={rowY(s.kind)} r={3.5}
              fill={kindColor[s.kind] ?? '#64748b'}>
              <title>{`${s.kind} · ${new Date(s.at).toLocaleTimeString()} · ${s.summary}`}</title>
            </circle>
          </g>
        ))}
      </svg>
      <div className="text-[9px] text-white/40 flex justify-between px-1 pb-0.5">
        <span>{new Date(minAt).toLocaleTimeString()}</span>
        <span>{new Date(maxAt).toLocaleTimeString()}</span>
      </div>
    </div>
  )
}

function MiniMap({ graph, selectedId }: { graph: BrainGraph; selectedId: string | null }) {
  const w = 120, h = 120
  // Project node positions to 2D (XZ plane) + fit to viewbox
  const points = graph.nodes.map(n => ({
    id: n.id,
    x: n.position?.[0] ?? 0,
    y: n.position?.[2] ?? 0,
    kind: n.kind, status: n.status,
  }))
  if (points.length === 0) return null
  const xs = points.map(p => p.x), ys = points.map(p => p.y)
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY)
  const pad = 6
  const px = (x: number) => pad + ((x - minX) / spanX) * (w - pad * 2)
  const py = (y: number) => pad + ((y - minY) / spanY) * (h - pad * 2)

  return (
    <div className="absolute bottom-3 right-3 glass rounded p-1.5 fade-in z-overlay">
      <div className="label text-[9px] mb-1 flex items-center gap-1">
        <span>mini-map</span><span className="text-faint">XZ</span>
      </div>
      <svg width={w} height={h} className="block">
        {/* origin crosshair */}
        <line x1={px(0)} y1={pad} x2={px(0)} y2={h - pad} stroke="rgba(255,255,255,0.06)" />
        <line x1={pad} y1={py(0)} x2={w - pad} y2={py(0)} stroke="rgba(255,255,255,0.06)" />
        {points.map(p => {
          const r = p.kind === 'core' ? 3 : p.kind === 'system' ? 2 : 1
          const isSel = p.id === selectedId
          return (
            <circle key={p.id} cx={px(p.x)} cy={py(p.y)} r={isSel ? r + 1.5 : r}
              fill={STATUS_COLOR[p.status]}
              stroke={isSel ? '#fff' : 'none'} strokeWidth={isSel ? 1 : 0} />
          )
        })}
      </svg>
    </div>
  )
}

function Fallback2D({ graph, onSelect, selectedId }: {
  graph: BrainGraph
  onSelect: (n: BrainNode) => void
  selectedId: string | null
}) {
  return (
    <div className="absolute inset-0 overflow-y-auto p-6 bg-[#08090b]">
      <p className="text-xs text-white/40 mb-3">2D fallback view — same data, no WebGL.</p>
      <ul className="space-y-1 max-w-3xl">
        {graph.nodes.map(n => (
          <li key={n.id}>
            <button onClick={() => onSelect(n)}
              className={`w-full text-left px-3 py-1.5 text-xs rounded flex items-center gap-2 border ${selectedId === n.id ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-white/5 hover:bg-white/5'}`}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: STATUS_COLOR[n.status] }} />
              <span className="font-mono text-white/40 uppercase tracking-wider w-20 text-[10px]">{n.kind}</span>
              <span className="text-white/85">{n.label}</span>
              {n.detail && <span className="text-white/40 ml-auto truncate">{n.detail}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode; onError: () => void }, { hasError: boolean }> {
  override state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  override componentDidCatch() { this.props.onError() }
  override render() {
    if (this.state.hasError) {
      return <div className="absolute inset-0 flex items-center justify-center text-white/40 text-sm">3D failed — switching to 2D</div>
    }
    return this.props.children
  }
}
