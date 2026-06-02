/**
 * BrainHomePage — the minimal, iconic Brain view.
 *
 * Mirrors the Novan reference design:
 *   - Full-bleed dark canvas
 *   - Particle-cloud brain mesh centered
 *   - 7 named lobes orbiting the brain (Vision, Operations, Knowledge,
 *     Strategy, Finance, Creative, Systems) with live counts
 *   - Strategy core glows at the brain's center
 *
 * The page chrome (sidebar, top header, bottom ask-Novan bar) is owned
 * by App.tsx — this component only renders the canvas + lobe labels.
 *
 * The operational 3D node graph still exists at /brain/graph.
 */
import React, { Suspense, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls, AdaptiveDpr } from '@react-three/drei'
import * as THREE from 'three'
import {
  Target, Settings as SettingsIcon, BookOpen, DollarSign,
  Brush, Layers as LayersIcon, Network as NetIcon,
} from 'lucide-react'
import { api } from '../api.js'
import { BreathingOrb, ParticleTrail } from '../components/NovanVisuals.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'
import { BrainPulseGroup, OrbitRings } from '../components/voice-visuals/BrainR3FVisuals.js'
import { VoiceHaloVisualizer } from '../components/voice-visuals/VoiceHaloVisualizer.js'
import { LiveSpawningNodes } from '../components/voice-visuals/LiveSpawningNodes.js'
import { PersistentBusinessNodes } from '../components/voice-visuals/PersistentBusinessNodes.js'
import { useBusinessConstructionStream } from '../hooks/useBusinessConstructionStream.js'
import { useBusinessGraph, type BusinessSystem } from '../hooks/useBusinessGraph.js'
import { SystemDetailDrawer } from './brain/SystemDetailDrawer.js'

// ─── Lobe definitions ─────────────────────────────────────────────────
// Each lobe is a logical category. The `systems` list filters real
// nodes from /api/v1/brain/graph; `position` is the on-screen anchor
// (percent of container width / height, 0..100).
//
// "Strategy" sits at the center with a brand-purple glow. Every other
// lobe orbits around it at the positions in the reference.

interface LobeDef {
  id:       string
  name:     string
  icon:     typeof Target
  /** Accent color used for the icon disk. */
  accent:   string
  /** Anchor in % of canvas (50/50 = center). */
  position: { x: number; y: number }
  /** Which node `system` ids belong to this lobe — used for live counts. */
  systems:  string[]
}

const LOBES: LobeDef[] = [
  // top
  { id: 'vision',     name: 'Vision',     icon: Target,        accent: '#5BAFFF', position: { x: 50, y: 14 }, systems: ['mission', 'strategy', 'horizons', 'governance'] },
  // upper-left
  { id: 'operations', name: 'Operations', icon: SettingsIcon,  accent: '#3DDC97', position: { x: 22, y: 28 }, systems: ['runtime', 'workflow', 'agents', 'orchestrator', 'fabric'] },
  // upper-right
  { id: 'knowledge',  name: 'Knowledge',  icon: BookOpen,      accent: '#5BAFFF', position: { x: 80, y: 36 }, systems: ['memory', 'reasoning', 'chains', 'search', 'embeddings'] },
  // center (highlighted)
  { id: 'strategy',   name: 'Strategy',   icon: Target,        accent: '#8B7CFF', position: { x: 50, y: 50 }, systems: ['strategic', 'mission', 'goals', 'horizons'] },
  // lower-left
  { id: 'finance',    name: 'Finance',    icon: DollarSign,    accent: '#E6B86A', position: { x: 28, y: 70 }, systems: ['economy', 'budget', 'cost', 'commerce', 'pricing'] },
  // lower-right
  { id: 'creative',   name: 'Creative',   icon: Brush,         accent: '#D67BA6', position: { x: 78, y: 70 }, systems: ['creative', 'image', 'design', 'studio'] },
  // bottom
  { id: 'systems',    name: 'Systems',    icon: LayersIcon,    accent: '#E69B6A', position: { x: 53, y: 85 }, systems: ['system', 'platform', 'infra', 'security', 'audit'] },
]

// ─── Particle Brain ───────────────────────────────────────────────────
// Builds an asymmetric blob of points roughly the shape of a brain by
// stacking three overlapping ellipsoid point clouds (two hemispheres +
// a cerebellum). Total ~3500 points — cheap on every laptop GPU.

function ParticleBrain() {
  // Build the geometry once; never re-computed
  const geometry = useMemo(() => {
    const COUNT = 3600
    const positions = new Float32Array(COUNT * 3)
    const colors    = new Float32Array(COUNT * 3)

    // Three sub-clouds: left lobe, right lobe, cerebellum
    const lobes = [
      { cx: -1.2, cy:  0.2, cz:  0.0, rx: 3.0, ry: 2.3, rz: 2.4, n: 1500 },
      { cx:  1.2, cy:  0.2, cz:  0.0, rx: 3.0, ry: 2.3, rz: 2.4, n: 1500 },
      { cx:  0.0, cy: -1.8, cz:  0.2, rx: 1.6, ry: 1.0, rz: 1.4, n:  600 },
    ]

    let i = 0
    for (const l of lobes) {
      for (let k = 0; k < l.n; k++) {
        // Sample point inside an ellipsoid with bias toward the shell
        const u = Math.random()
        const v = Math.random()
        const theta = u * Math.PI * 2
        const phi   = Math.acos(2 * v - 1)
        // bias r toward 0.7..1.0 so the cloud feels like a surface
        const r = 0.70 + Math.random() * 0.30
        const sx = l.rx * r * Math.sin(phi) * Math.cos(theta)
        const sy = l.ry * r * Math.sin(phi) * Math.sin(theta)
        const sz = l.rz * r * Math.cos(phi)
        positions[i * 3 + 0] = l.cx + sx
        positions[i * 3 + 1] = l.cy + sy
        positions[i * 3 + 2] = l.cz + sz

        // Color: pure white drops with a tint of the closest brand hue
        const tint = Math.random()
        if      (tint < 0.05) { colors[i*3]=0.55; colors[i*3+1]=0.49; colors[i*3+2]=1.00 } // brand purple
        else if (tint < 0.10) { colors[i*3]=0.40; colors[i*3+1]=0.91; colors[i*3+2]=0.98 } // cyan
        else                  { colors[i*3]=0.95; colors[i*3+1]=0.95; colors[i*3+2]=1.00 } // soft white
        i++
      }
    }

    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    g.setAttribute('color',    new THREE.BufferAttribute(colors, 3))
    return g
  }, [])

  const ref = useRef<THREE.Points>(null)
  // Slow rotation so the brain feels alive without becoming distracting
  useFrame(({ clock }) => {
    if (ref.current) ref.current.rotation.y = clock.elapsedTime * 0.04
  })

  return (
    <points ref={ref} geometry={geometry}>
      <pointsMaterial
        size={0.025}
        vertexColors
        transparent
        opacity={0.85}
        sizeAttenuation
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  )
}

// Sparse edge filaments — short tendrils between random nearby points
// to give the brain that "neuron-network" wire look. Cheap (200 lines).
function NeuralFilaments() {
  const geometry = useMemo(() => {
    const COUNT = 200
    const positions = new Float32Array(COUNT * 6) // pairs of (x,y,z)
    for (let i = 0; i < COUNT; i++) {
      // anchor + small offset
      const u = Math.random()
      const theta = u * Math.PI * 2
      const phi   = Math.acos(2 * Math.random() - 1)
      const r     = 1.6 + Math.random() * 1.4
      const x = r * Math.sin(phi) * Math.cos(theta)
      const y = r * Math.sin(phi) * Math.sin(theta) + 0.2
      const z = r * Math.cos(phi)
      const dx = (Math.random() - 0.5) * 0.6
      const dy = (Math.random() - 0.5) * 0.6
      const dz = (Math.random() - 0.5) * 0.6
      positions[i*6  ] = x;       positions[i*6+1] = y;       positions[i*6+2] = z
      positions[i*6+3] = x + dx;  positions[i*6+4] = y + dy;  positions[i*6+5] = z + dz
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    return g
  }, [])

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color="#7B82A3" transparent opacity={0.18} />
    </lineSegments>
  )
}

// Soft glow disk behind the brain core — pure radial gradient sprite
function CoreGlow() {
  // Procedural radial-gradient texture
  const tex = useMemo(() => {
    const size = 256
    const c = document.createElement('canvas')
    c.width = c.height = size
    const ctx = c.getContext('2d')!
    const g = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2)
    g.addColorStop(0,   'rgba(139,124,255,0.55)')
    g.addColorStop(0.4, 'rgba(139,124,255,0.18)')
    g.addColorStop(1,   'rgba(139,124,255,0.0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
    const t = new THREE.CanvasTexture(c)
    return t
  }, [])
  return (
    <sprite scale={[5.5, 5.5, 1]} position={[0, 0.1, -0.5]}>
      <spriteMaterial map={tex} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
    </sprite>
  )
}

// ─── Lobe label (HTML overlay) ────────────────────────────────────────

function LobeLabel({ lobe, count, isCore }: { lobe: LobeDef; count: number; isCore: boolean }) {
  const Icon = lobe.icon
  const accent = lobe.accent

  if (isCore) {
    // Strategy is the brain's core — rendered as a centered glowing tile
    return (
      <div
        className="absolute pointer-events-none select-none"
        style={{ left: `${lobe.position.x}%`, top: `${lobe.position.y}%`, transform: 'translate(-50%, -50%)' }}
      >
        <div className="relative flex flex-col items-center">
          {/* R146.111 — soft breathing orb behind the brain core */}
          <div className="absolute inset-0 flex items-center justify-center -z-10" style={{ width: 220, height: 220, left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}>
            <BreathingOrb size={220} hue={210} state="idle" />
          </div>
          <div className="text-center relative">
            <div
              className="text-[22px] font-medium tracking-tight text-white drop-shadow-lg"
              style={{ textShadow: `0 0 24px ${accent}88` }}
            >
              {lobe.name}
            </div>
            <div className="text-[11px] text-white/55 mt-0.5">{count} active</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="absolute pointer-events-none select-none"
      style={{ left: `${lobe.position.x}%`, top: `${lobe.position.y}%`, transform: 'translate(-50%, -50%)' }}
    >
      <div className="flex items-center gap-2.5">
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
          style={{
            background: `${accent}1A`,                                  // 10% alpha tint
            boxShadow: `0 0 0 1px ${accent}40, inset 0 0 12px ${accent}25`,
            color: accent,
          }}
        >
          <Icon className="w-4 h-4" strokeWidth={1.6} />
        </div>
        <div>
          <div className="text-[13px] font-medium text-white leading-tight">{lobe.name}</div>
          <div className="text-[11px] text-white/55 leading-tight">{count} active</div>
        </div>
      </div>
    </div>
  )
}

// ─── Brain graph data → lobe counts ───────────────────────────────────

interface BrainNode { id: string; system?: string; kind: string }
interface BrainGraph { nodes: BrainNode[] }

function countByLobe(graph: BrainGraph | null): Record<string, number> {
  const out: Record<string, number> = {}
  for (const l of LOBES) out[l.id] = 0
  if (!graph) return out
  // Each node contributes to the FIRST matching lobe so we don't double-count.
  // Match against system id (substring) or kind.
  for (const n of graph.nodes) {
    const haystack = `${(n.system ?? '').toLowerCase()} ${n.kind.toLowerCase()}`
    for (const l of LOBES) {
      if (l.systems.some(s => haystack.includes(s))) { out[l.id] = (out[l.id] ?? 0) + 1; break }
    }
  }
  return out
}

// ─── Page ─────────────────────────────────────────────────────────────

export default function BrainHomePage() {
  const { workspaceId } = useWorkspace()
  const navigate = useNavigate()

  const graph = useQuery({
    queryKey: ['brain-graph-lobes', workspaceId],
    queryFn:  () => api.get<{ data: BrainGraph }>(`/api/v1/brain/graph?workspace_id=${workspaceId}&lod=systems`),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })
  const counts = useMemo(() => countByLobe(graph.data?.data ?? null), [graph.data])

  // Live-stream business construction events. When the operator (or
  // an automated trigger) hits POST /businesses/construct, the API
  // emits one `business.system.spawned` event per node. The hook
  // buffers them with their positions; the canvas renders the
  // fade-in cascade in real time.
  const { spawned, recent, connected } = useBusinessConstructionStream(workspaceId)
  const constructionActive = spawned.length > 0
  const latestEvent = recent[0]

  // Persistent business focus: which business's systems to render on
  // the canvas in steady state. Defaults to the most-recently-created
  // business (selectable via the chip in the top-right). When null,
  // the brain shows its calm lobe view.
  const [focusBusinessId, setFocusBusinessId] = useState<string | null>(null)
  const businessGraph = useBusinessGraph(workspaceId, focusBusinessId)
  const inBusinessFocus = businessGraph.focused !== null && businessGraph.systems.length > 0

  // Selected system drives the right-side detail drawer.
  const [selectedSystem, setSelectedSystem] = useState<BusinessSystem | null>(null)
  // Drop selection when focus changes (the selected row no longer applies).
  React.useEffect(() => { setSelectedSystem(null) }, [businessGraph.focused?.id])

  return (
    <div className="relative w-full h-full bg-[var(--bg-primary)] overflow-hidden">
      {/* R146.111 — cursor particles over the brain canvas */}
      <ParticleTrail hue={205} density={1} life={1100} size={3} />
      {/* 3D scene */}
      <Canvas
        dpr={[1, 2]}
        camera={{ position: [0, 0, 9], fov: 50 }}
        gl={{ antialias: true, alpha: true }}
        className="absolute inset-0"
      >
        <color attach="background" args={['#060608']} />
        <ambientLight intensity={0.5} />
        <Suspense fallback={null}>
          <CoreGlow />
          <BrainPulseGroup>
            <ParticleBrain />
            <NeuralFilaments />
          </BrainPulseGroup>
          <OrbitRings origin={[0, 0, 0]} />
          {/* Persistent business layer — once a business is constructed,
             its system rows render at their real spatial positions and
             stay visible. Hides the generic lobes by replacing them
             with the focused business's actual structure. */}
          {inBusinessFocus && (
            <PersistentBusinessNodes
              systems={businessGraph.systems}
              onSelect={(s) => setSelectedSystem(s)}
              selectedId={selectedSystem?.id ?? null}
            />
          )}
          {/* Live construction overlay — fades in one chip per
             `business.system.spawned` event, anchored at the real
             spatial position recorded on each row. Renders OVER the
             persistent layer during the cascade. */}
          <LiveSpawningNodes spawned={spawned} />
        </Suspense>
        <OrbitControls
          enableDamping dampingFactor={0.08}
          rotateSpeed={0.4} zoomSpeed={0.8}
          minDistance={2.5} maxDistance={22}
          enablePan={false}
          // Pivot every dolly on the world point under the cursor.
          // Native three.js OrbitControls support — projects a ray from
          // the mouse, finds the hit point against the camera's focal
          // plane, and moves toward that instead of the orbit target.
          zoomToCursor
        />
        <AdaptiveDpr pixelated />
      </Canvas>

      {/* SVG halo overlay (reads voice state) */}
      <VoiceHaloVisualizer />

      {/* Construction status pill — only visible while spawn events
         are flowing. Restrained — single line, top-center, fades. */}
      {constructionActive && (
        <div className="absolute top-6 left-1/2 -translate-x-1/2 z-overlay pointer-events-none">
          <div className="px-3 py-1.5 rounded-full bg-[var(--bg-glass-strong)] backdrop-blur border border-[var(--accent-active)]/40 flex items-center gap-2 text-[11px]">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-[var(--accent-active)] opacity-70 animate-ping" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--accent-active)]" />
            </span>
            <span className="text-[var(--text-secondary)]">
              {latestEvent?.type === 'business.construction.completed'
                ? 'Business construction complete'
                : `Constructing — ${spawned.length} system${spawned.length === 1 ? '' : 's'} live`}
            </span>
          </div>
        </div>
      )}

      {/* SSE connection state — only surfaced when explicitly broken */}
      {!connected && (
        <div className="absolute bottom-6 left-6 z-overlay pointer-events-none">
          <div className="px-2.5 py-1 rounded-full bg-[var(--bg-surface)]/80 border border-[var(--border)] text-[10px] text-[var(--text-muted)] flex items-center gap-1.5">
            <span className="w-1 h-1 rounded-full bg-[var(--text-muted)]" />
            live stream reconnecting…
          </div>
        </div>
      )}

      {/* Lobe labels — HTML overlay anchored in percentages so they
         scale across screen sizes. Hidden when a business is focused
         so the canvas isn't double-labeled. */}
      {!inBusinessFocus && (
        <div className="absolute inset-0 pointer-events-none" aria-hidden="false">
          {LOBES.map(l => (
            <LobeLabel key={l.id} lobe={l} count={counts[l.id] ?? 0} isCore={l.id === 'strategy'} />
          ))}
        </div>
      )}

      {/* Business focus switcher — top-left chip when at least one
         business exists. Click to cycle through, or click the X to
         return to the calm lobe view. Stays out of the way otherwise. */}
      {businessGraph.businesses.length > 0 && (
        <BusinessFocusChip
          businesses={businessGraph.businesses}
          focused={businessGraph.focused}
          onPick={setFocusBusinessId}
        />
      )}

      {/* System detail drawer — anchored to the right edge, slides in
         when an operator clicks a persistent business chip. */}
      {selectedSystem && (
        <SystemDetailDrawer system={selectedSystem} onClose={() => setSelectedSystem(null)} />
      )}

      {/* Top-right escape hatch to the operational node graph. Tiny +
         out of the way so the brain stays the focus. */}
      <button
        onClick={() => navigate('/brain/graph')}
        title="Open operational graph"
        aria-label="Open operational graph view"
        className="absolute top-6 right-6 w-8 h-8 rounded-full bg-[var(--bg-surface)]/60 backdrop-blur border border-[var(--border)] hover:border-[var(--border-strong)] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors focus-ring z-overlay"
      >
        <NetIcon className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

// ─── Business Focus Chip ───────────────────────────────────────────────
// Top-left floating chip. Reads "Active Focus · <business name>" and
// opens a dropdown of every business in the workspace. Selecting one
// focuses its systems on the canvas; selecting "All Brain (no focus)"
// returns to the lobe view. Mirrors the reference design's centered
// focus selector but anchored to a corner so it doesn't fight the
// global Active Focus dropdown in the app header.

function BusinessFocusChip({
  businesses, focused, onPick,
}: {
  businesses: import('../hooks/useBusinessGraph.js').BusinessRow[]
  focused:    import('../hooks/useBusinessGraph.js').BusinessRow | null
  onPick:     (id: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!open) return
    const fn = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', fn)
    return () => window.removeEventListener('mousedown', fn)
  }, [open])

  return (
    <div ref={ref} className="absolute top-6 left-6 z-overlay">
      <button
        onClick={() => setOpen(s => !s)}
        title="Pick which business to focus on"
        className="px-3 py-1.5 rounded-full bg-[var(--bg-surface)]/70 backdrop-blur border border-[var(--border)] hover:border-[var(--border-strong)] flex items-center gap-2 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors focus-ring"
      >
        <span className="text-[var(--text-muted)]">Focus</span>
        <span className="text-[var(--text-primary)] font-medium">
          {focused?.name ?? 'All Brain'}
        </span>
        <span className="text-[var(--text-muted)]">▾</span>
      </button>
      {open && (
        <div className="mt-1 panel-elevated dropdown-in min-w-[220px] max-h-[40vh] overflow-y-auto z-dropdown">
          <button
            onClick={() => { onPick(null); setOpen(false) }}
            className={`w-full text-left px-3 py-2 text-[12px] flex items-center justify-between hover:bg-[var(--surface-hover)] transition-colors ${
              focused === null ? 'text-[var(--accent-active)]' : 'text-[var(--text-secondary)]'
            }`}
          >
            <span>All Brain</span>
            <span className="text-[10px] text-[var(--text-muted)]">no focus</span>
          </button>
          <div className="h-px bg-[var(--border)] mx-2" />
          {businesses.map(b => (
            <button
              key={b.id}
              onClick={() => { onPick(b.id); setOpen(false) }}
              className={`w-full text-left px-3 py-2 text-[12px] flex items-center justify-between hover:bg-[var(--surface-hover)] transition-colors ${
                focused?.id === b.id ? 'text-[var(--accent-active)]' : 'text-[var(--text-secondary)]'
              }`}
            >
              <span className="truncate">{b.name}</span>
              <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider ml-2 shrink-0">
                {b.industry?.replace(/_/g, ' ') ?? b.stage}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
