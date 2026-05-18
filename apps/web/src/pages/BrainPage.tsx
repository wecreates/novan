/**
 * Brain — minimal premium 3D operational view.
 *
 * Dark background, soft depth, dropdown-first nav, no clutter.
 * Real data from /api/v1/brain/graph; click to drill into nodes;
 * actions through /api/v1/brain/actions (approval-gated).
 */
import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Canvas, useFrame, type ThreeEvent } from '@react-three/fiber'
import { OrbitControls, Html, AdaptiveDpr, AdaptiveEvents } from '@react-three/drei'
import {
  Brain, Filter, Eye, Sparkles, Activity, X, Loader2,
  ChevronDown, Search, Pause, Play, ShieldCheck, Network, AlertOctagon,
} from 'lucide-react'
import * as THREE from 'three'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

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

// ─── Visual constants ────────────────────────────────────────────────────

const STATUS_COLOR: Record<BrainNode['status'], string> = {
  healthy:  '#34d399',
  degraded: '#f59e0b',
  down:     '#ef4444',
  pending:  '#94a3b8',
  paused:   '#a78bfa',
  unknown:  '#64748b',
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
  node, selected, hovered, onClick, onHover,
}: {
  node: BrainNode
  selected: boolean; hovered: boolean
  onClick: (n: BrainNode) => void
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
  graph, selectedId, hoveredId, onNodeClick, onNodeHover, focusOn,
}: {
  graph: BrainGraph
  selectedId: string | null; hoveredId: string | null
  onNodeClick: (n: BrainNode) => void
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
          onClick={onNodeClick} onHover={onNodeHover} />
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

  const graph = useQuery({
    queryKey: ['brain-graph', workspaceId, template],
    queryFn: () => api.get<{ data: BrainGraph }>(`/api/v1/brain/graph?workspace_id=${workspaceId}&template=${template}`),
    refetchInterval: 15_000,
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
  }

  const onSearchEnter = () => {
    if (!g) return
    const hit = g.nodes.find(n => n.label.toLowerCase().includes(search.toLowerCase()) || n.id.toLowerCase().includes(search.toLowerCase()))
    if (hit) onNodeClick(hit)
  }

  const filteredGraph: BrainGraph | null = g ? { ...g, nodes: visibleNodes, edges: visibleEdges } : null

  return (
    <div className="fixed inset-0 bg-[#08090b] text-white flex flex-col">
      {/* Top command bar */}
      <div className="border-b border-white/5 bg-black/40 backdrop-blur px-4 py-2 flex items-center gap-3 text-xs">
        <Brain className="w-4 h-4 text-emerald-400" />
        <span className="font-medium text-white/90">Novan Brain</span>

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

        <div className="flex items-center gap-1 ml-2 px-2 py-1 rounded bg-white/5 border border-white/10">
          <Search className="w-3 h-3 text-white/40" />
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onSearchEnter() }}
            placeholder="search nodes…"
            className="bg-transparent outline-none w-44 text-[11px]" />
        </div>

        {selectedId && (
          <button onClick={() => { setSelectedId(null); setFocusOn([0, 0, 0]) }}
            className="ml-2 px-2 py-1 rounded text-[10px] border border-white/10 hover:bg-white/5 flex items-center gap-1">
            <X className="w-3 h-3" /> esc to global
          </button>
        )}

        <span className="ml-auto text-[10px] text-white/40">
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
              <color attach="background" args={['#08090b']} />
              <fog attach="fog" args={['#08090b', 25, 60]} />
              <Suspense fallback={null}>
                <BrainScene
                  graph={filteredGraph}
                  selectedId={selectedId}
                  hoveredId={hoveredId}
                  onNodeClick={onNodeClick}
                  onNodeHover={(n) => setHoveredId(n?.id ?? null)}
                  focusOn={focusOn}
                />
              </Suspense>
            </Canvas>
          </ErrorBoundary>
        )}

        {/* Event ticker (bottom-left) */}
        {eventTicker.length > 0 && (
          <div className="absolute bottom-3 left-3 max-w-md text-[10px] font-mono space-y-0.5 pointer-events-none">
            {eventTicker.slice(0, 5).map((e, i) => (
              <div key={`${e.at}-${i}`} className="text-white/40 truncate">
                <Activity className="w-2.5 h-2.5 inline mr-1 text-emerald-400/70" />
                {new Date(e.at).toLocaleTimeString()} · {e.text}
              </div>
            ))}
          </div>
        )}

        {/* Systems strip (top-right) — quick template summary */}
        {g && (
          <div className="absolute top-3 right-3 bg-black/50 backdrop-blur border border-white/10 rounded p-2 space-y-0.5 text-[10px]">
            {g.systems.map(s => (
              <button key={s.id} onClick={() => {
                const node = g.nodes.find(n => n.id === s.id)
                if (node) onNodeClick(node)
              }}
                className="flex items-center gap-1.5 w-full hover:bg-white/5 px-1 py-0.5 rounded">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: STATUS_COLOR[s.status as BrainNode['status']] }} />
                <span className="font-mono text-white/70">{s.label}</span>
                <span className="ml-auto text-white/40">{s.count}</span>
              </button>
            ))}
          </div>
        )}

        {/* Detail drawer */}
        {selectedId && detail.data?.data && (
          <DetailDrawer detail={detail.data.data}
            onClose={() => setSelectedId(null)}
            onAction={(actionId, payload, approvalToken) => doAction.mutate({ actionId, payload: payload ?? {}, ...(approvalToken ? { approvalToken } : {}) })}
            pending={doAction.isPending} />
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
  detail, onClose, onAction, pending,
}: {
  detail: NodeDetail
  onClose: () => void
  onAction: (actionId: string, payload?: Record<string, unknown>, approvalToken?: string) => void
  pending: boolean
}) {
  const statusColor = STATUS_COLOR[detail.status as BrainNode['status']] ?? '#64748b'
  return (
    <div className="absolute top-3 right-3 w-80 bg-black/85 backdrop-blur border border-white/10 rounded-lg p-3 shadow-2xl"
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
          <div className="text-[10px] uppercase tracking-wider text-white/40 mb-1.5">Actions</div>
          <div className="space-y-1">
            {detail.actions.map(a => {
              const isCritical = a.risk === 'high' || a.risk === 'critical'
              return (
                <button key={a.id} onClick={() => onAction(a.id, a.payload, isCritical ? 'OPERATOR_APPROVED' : undefined)}
                  disabled={pending}
                  className={`w-full px-2 py-1 rounded text-left flex items-center gap-2 border ${
                    isCritical
                      ? 'border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20'
                      : a.risk === 'medium'
                        ? 'border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20'
                        : 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300 hover:bg-emerald-500/15'
                  } disabled:opacity-50`}>
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
