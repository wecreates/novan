/**
 * NeuralBrainView — R146.114 — 3D neural-region visualization.
 *
 * Inspired by the kzzy47 / Pulse [2] BRAIN tab. Renders 10 named brain
 * anatomy regions as distinct particle clusters with streaks of flowing
 * fiber tracts connecting them. Each region label shows neuron count +
 * firing rate that comes from Novan's actual subsystem metrics.
 *
 * Mapping (Novan subsystem → brain region):
 *   PREFRONTAL    → frontier intelligence (planning, foresight)
 *   MOTOR CORTEX  → action dispatcher (the part that takes actions)
 *   CONCEPT LAYER → capability catalog
 *   GLIA          → cron / observability / supporting infrastructure
 *   ASSOCIATION   → semantic search / knowledge graph
 *   HIPPOCAMPUS   → memory tiers
 *   EXECUTIVE     → orchestration / brain-task
 *   SENSORY CORTEX→ ingestion (feeds, connectors)
 *   AUDITORY      → voice intent + chat
 *   CEREBELLUM    → self-monitoring / cron health
 *
 * "Firing rate" = events/sec for that subsystem in the last minute,
 * pulled from /api/v1/brain/metrics. Regions glow more when firing
 * more. Fiber tracts pulse green particles between adjacent regions.
 */
import { useRef, useMemo, useEffect, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'

export interface BrainRegion {
  name:        string
  neurons:     number
  firingRate:  number    // events/sec; 0..10ish
  hue:         number    // 0..360
  position:    [number, number, number]
}

const DEFAULT_REGIONS: BrainRegion[] = [
  { name: 'PREFRONTAL',     neurons:   134, firingRate: 1.2, hue:  45, position: [ 0.0,  1.8,  1.2] },
  { name: 'MOTOR CORTEX',   neurons:    61, firingRate: 0.9, hue: 350, position: [-1.5,  1.4,  0.3] },
  { name: 'CONCEPT LAYER',  neurons:  2396, firingRate: 0.5, hue:  38, position: [ 1.8,  0.9,  0.6] },
  { name: 'GLIA',           neurons:   411, firingRate: 2.7, hue: 140, position: [-2.0, -0.2,  0.0] },
  { name: 'ASSOCIATION',    neurons:   226, firingRate: 0.4, hue: 280, position: [-1.4,  0.2, -0.4] },
  { name: 'HIPPOCAMPUS',    neurons:   320, firingRate: 1.5, hue: 200, position: [ 0.0,  0.0,  0.0] },
  { name: 'EXECUTIVE',      neurons:   139, firingRate: 0.4, hue:  60, position: [ 1.4,  0.0, -0.4] },
  { name: 'SENSORY CORTEX', neurons:    56, firingRate: 1.0, hue: 180, position: [-1.4, -1.4,  0.6] },
  { name: 'AUDITORY',       neurons:   220, firingRate: 1.0, hue: 320, position: [ 1.4, -1.2,  0.6] },
  { name: 'CEREBELLUM',     neurons:   180, firingRate: 0.8, hue: 100, position: [ 0.0, -1.8,  0.0] },
]

// Edges between regions (the "fiber tracts"). Hippocampus connects to most.
const REGION_EDGES: Array<[number, number]> = [
  [5, 0], [5, 1], [5, 2], [5, 3], [5, 4], [5, 6],   // hippocampus hub
  [0, 6], [0, 2], [0, 4],                            // prefrontal ↔ executive/concept/assoc
  [1, 6], [1, 7],                                    // motor ↔ exec/sensory
  [2, 4], [2, 6],                                    // concept ↔ assoc/exec
  [3, 9], [3, 5],                                    // glia ↔ cerebellum/hippo
  [7, 9], [8, 9],                                    // sensory & auditory → cerebellum
  [8, 0],                                            // auditory → prefrontal
]

// ─── A single region cluster ───────────────────────────────────────────

function RegionCluster({ region, density = 80 }: { region: BrainRegion; density?: number }) {
  const ref = useRef<THREE.Points>(null)
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry()
    const positions = new Float32Array(density * 3)
    // Seeded jitter so re-renders don't twinkle
    let seed = region.position.reduce((s, n) => s + Math.abs(n * 1e3), 0) | 0
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff }
    for (let i = 0; i < density; i++) {
      // Gaussian-ish blob around the region center
      const r = 0.35 + rand() * 0.35
      const phi = Math.acos(2 * rand() - 1)
      const theta = 2 * Math.PI * rand()
      positions[i * 3]     = region.position[0] + Math.sin(phi) * Math.cos(theta) * r
      positions[i * 3 + 1] = region.position[1] + Math.sin(phi) * Math.sin(theta) * r * 0.85
      positions[i * 3 + 2] = region.position[2] + Math.cos(phi) * r
    }
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    return g
  }, [region.position, density])

  useFrame((state) => {
    if (!ref.current) return
    // Pulse intensity by firing rate
    const t = state.clock.elapsedTime
    const intensity = 0.7 + 0.3 * Math.sin(t * region.firingRate * 2)
    const mat = ref.current.material as THREE.PointsMaterial
    if (mat) mat.opacity = 0.5 + 0.45 * intensity
  })

  return (
    <points ref={ref} geometry={geom}>
      <pointsMaterial
        size={0.045}
        color={`hsl(${region.hue}, 100%, 65%)`}
        transparent
        opacity={0.85}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
        sizeAttenuation
      />
    </points>
  )
}

// ─── Animated fiber tracts (flowing dots between regions) ───────────────

function FiberTracts({ regions, edges }: { regions: BrainRegion[]; edges: Array<[number, number]> }) {
  const ref = useRef<THREE.Points>(null)
  const POINTS_PER_EDGE = 28
  const count = edges.length * POINTS_PER_EDGE

  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
    return g
  }, [count])

  useFrame((state) => {
    if (!ref.current) return
    const pos = ref.current.geometry.attributes.position!.array as Float32Array
    const t = state.clock.elapsedTime
    for (let e = 0; e < edges.length; e++) {
      const [ai, bi] = edges[e]!
      const a = regions[ai], b = regions[bi]
      if (!a || !b) continue
      for (let i = 0; i < POINTS_PER_EDGE; i++) {
        // Each point travels from a → b on a phased offset
        const frac = ((i / POINTS_PER_EDGE) + (t * 0.18 + e * 0.1)) % 1
        // Slight outward bow so tracts arc visibly
        const bow = Math.sin(frac * Math.PI) * 0.18
        const idx = (e * POINTS_PER_EDGE + i) * 3
        pos[idx]     = a.position[0] + (b.position[0] - a.position[0]) * frac + bow
        pos[idx + 1] = a.position[1] + (b.position[1] - a.position[1]) * frac
        pos[idx + 2] = a.position[2] + (b.position[2] - a.position[2]) * frac + bow * 0.5
      }
    }
    ref.current.geometry.attributes.position!.needsUpdate = true
  })

  return (
    <points ref={ref} geometry={geom}>
      <pointsMaterial
        size={0.022}
        color="#c2ff6a"
        transparent
        opacity={0.85}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
        sizeAttenuation
      />
    </points>
  )
}

// ─── Slow rotation wrapper ──────────────────────────────────────────────

function RotatingBrain({ children }: { children: React.ReactNode }) {
  const ref = useRef<THREE.Group>(null)
  useFrame((_, dt) => { if (ref.current) ref.current.rotation.y += dt * 0.05 })
  return <group ref={ref}>{children}</group>
}

// ─── Public component ──────────────────────────────────────────────────

export interface NeuralBrainViewProps {
  regions?:    BrainRegion[]
  brandName?:  string         // "KRONOS" by default
  className?:  string
}

export function NeuralBrainView({
  regions = DEFAULT_REGIONS,
  brandName = 'NOVAN',
  className,
}: NeuralBrainViewProps): JSX.Element {
  const totalNeurons = regions.reduce((s, r) => s + r.neurons, 0)
  return (
    <div className={className} style={{ position: 'relative', width: '100%', height: '100%', background: '#000', overflow: 'hidden' }}>
      <Canvas
        camera={{ position: [0, 0.5, 5.5], fov: 50 }}
        gl={{ antialias: true, alpha: false }}
        style={{ position: 'absolute', inset: 0 }}
      >
        <color attach="background" args={['#000']} />
        <ambientLight intensity={0.2} />
        <RotatingBrain>
          {regions.map(r => <RegionCluster key={r.name} region={r} />)}
          <FiberTracts regions={regions} edges={REGION_EDGES} />
        </RotatingBrain>
        <OrbitControls enableZoom enablePan={false} maxDistance={12} minDistance={3} />
      </Canvas>

      {/* HUD overlays */}
      <div style={{
        position: 'absolute', top: 12, left: 14,
        color: 'rgb(255, 200, 80)',
        fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace',
        fontSize: 12, letterSpacing: '0.15em', pointerEvents: 'none',
      }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{brandName} · {totalNeurons.toLocaleString()} NEURONS · {regions.length} REGIONS</div>
      </div>

      {/* Region label chips overlaid in HTML (positioned in 3D would need r3f Html;
          we keep them as a fixed legend at the bottom-left for readability) */}
      <div style={{
        position: 'absolute', bottom: 14, left: 14, right: 14,
        display: 'flex', flexWrap: 'wrap', gap: 6,
        pointerEvents: 'none',
      }}>
        {regions.map(r => (
          <div key={r.name} style={{
            fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace',
            fontSize: 10, padding: '2px 6px',
            color: `hsl(${r.hue}, 100%, 70%)`,
            border: `1px solid hsl(${r.hue}, 100%, 40%)`,
            background: '#0008',
            borderRadius: 2,
            letterSpacing: '0.08em',
          }}>
            {r.name}<span style={{ opacity: 0.6 }}> · {r.neurons.toLocaleString()} · firing {r.firingRate.toFixed(1)}x</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default NeuralBrainView
