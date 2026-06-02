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

// R146.115 — anatomically-correct lobe positions. Mapped to a brain-shaped
// ellipsoid (~2.6 x 1.8 x 2.0). Coordinates approximate the right-side view:
// x = lateral (left=negative), y = inferior-superior, z = posterior-anterior
// (front of brain = positive z).
const DEFAULT_REGIONS: BrainRegion[] = [
  { name: 'PREFRONTAL',     neurons:   134, firingRate: 1.2, hue:  45, position: [ 0.0,  0.9,  1.7] },  // front, top
  { name: 'MOTOR CORTEX',   neurons:    61, firingRate: 0.9, hue: 350, position: [-0.7,  1.1,  0.7] },  // top, slightly behind frontal
  { name: 'CONCEPT LAYER',  neurons:  2396, firingRate: 0.5, hue:  38, position: [ 0.7,  1.1,  0.7] },  // top-right (frontal pole)
  { name: 'EXECUTIVE',      neurons:   139, firingRate: 0.4, hue:  60, position: [ 0.0,  1.3,  0.2] },  // top-center (parietal-frontal junction)
  { name: 'ASSOCIATION',    neurons:   226, firingRate: 0.4, hue: 280, position: [-0.5,  0.6,  0.0] },  // mid-left (parietal-temporal)
  { name: 'HIPPOCAMPUS',    neurons:   320, firingRate: 1.5, hue: 200, position: [ 0.0, -0.3,  0.4] },  // deep midline (hippocampal/limbic core)
  { name: 'SENSORY CORTEX', neurons:    56, firingRate: 1.0, hue: 180, position: [ 0.0,  1.0, -0.4] },  // parietal (post-central)
  { name: 'GLIA',           neurons:   411, firingRate: 2.7, hue: 140, position: [ 0.5,  0.6,  0.0] },  // distributed — pinned right-mid for visual balance
  { name: 'AUDITORY',       neurons:   220, firingRate: 1.0, hue: 320, position: [ 1.2,  0.2,  0.2] },  // right temporal
  { name: 'CEREBELLUM',     neurons:   180, firingRate: 0.8, hue: 100, position: [ 0.0, -0.8, -1.4] },  // back-bottom, behind brainstem
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

// ─── Anatomical brain shell ─────────────────────────────────────────────
// R146.115 — a soft translucent ellipsoid with surface noise displacement
// gives a real-brain silhouette behind the regions. Procedural — no mesh
// download. The displacement maps gyri/sulci roughly.

function BrainShell() {
  const ref = useRef<THREE.Group>(null)
  // R146.116 — improved procedural brain shape. Two cerebrum hemispheres
  // joined by a faint corpus-callosum fissure + a separate posterior
  // cerebellum bulge below + temporal lobes that hang lower than the
  // crown. Surface noise stays for gyri/sulci texture.
  const { cerebrum, cerebellum } = useMemo(() => {
    // Cerebrum: a single ellipsoid, then we displace temporal/occipital
    // outward and add the longitudinal fissure.
    const g = new THREE.SphereGeometry(2.05, 128, 80)
    g.scale(1.0, 0.78, 1.32)  // wider front-to-back, flatter top-to-bottom
    const pos = g.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
      const r = Math.sqrt(x * x + y * y + z * z) || 1
      // Surface noise (gyri/sulci feel)
      const n1 = Math.sin(x * 3.1) * Math.cos(y * 2.7) * Math.sin(z * 3.3) * 0.07
      const n2 = Math.sin(x * 6.5 + 0.2) * Math.cos(z * 7.1 - 0.4) * 0.04
      const n3 = Math.sin(y * 9.0) * Math.cos(x * 8.5) * 0.025
      // Longitudinal fissure between hemispheres (recess along sagittal plane)
      const fissure = -Math.max(0, 0.12 - Math.abs(x) * 0.55)
      // Temporal-lobe outward bulge (lateral + lower-front)
      const tempBulge = Math.max(0, 0.18 * Math.exp(-((Math.abs(x) - 0.95) ** 2 / 0.15) - ((y + 0.2) ** 2 / 0.30) - ((z - 0.3) ** 2 / 0.50)))
      // Occipital bulge (back of head, slightly lower)
      const occipBulge = Math.max(0, 0.12 * Math.exp(-((z + 1.1) ** 2 / 0.30) - (y ** 2 / 0.50) - (x ** 2 / 0.40)))
      // Frontal bulge (front, top)
      const frontBulge = Math.max(0, 0.10 * Math.exp(-((z - 1.2) ** 2 / 0.30) - ((y - 0.5) ** 2 / 0.40) - (x ** 2 / 0.45)))
      const d = n1 + n2 + n3 + fissure + tempBulge + occipBulge + frontBulge
      pos.setXYZ(i, x + (x / r) * d, y + (y / r) * d, z + (z / r) * d)
    }
    g.computeVertexNormals()

    // Cerebellum — separate smaller mass behind and below, tucked under the
    // occipital lobe. Two side-by-side hemispheres with their own surface noise.
    const cg = new THREE.SphereGeometry(0.85, 64, 48)
    cg.scale(1.0, 0.55, 0.80)
    cg.translate(0, -0.85, -1.55)
    const cp = cg.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < cp.count; i++) {
      const x = cp.getX(i), y = cp.getY(i), z = cp.getZ(i)
      const r = Math.sqrt(x * x + (y + 0.85) ** 2 + (z + 1.55) ** 2) || 1
      // Cerebellar folia — finer ribbed surface
      const folia = Math.sin(z * 22) * 0.018 + Math.sin(x * 18 + y * 6) * 0.012
      // Vermis groove between cerebellar hemispheres
      const vermis = -Math.max(0, 0.05 - Math.abs(x) * 0.6)
      const d = folia + vermis
      cp.setXYZ(i, x + (x / r) * d, y + ((y + 0.85) / r) * d, z + ((z + 1.55) / r) * d)
    }
    cg.computeVertexNormals()
    return { cerebrum: g, cerebellum: cg }
  }, [])

  return (
    <group ref={ref}>
      <mesh geometry={cerebrum}>
        <meshBasicMaterial color="hsl(38, 100%, 50%)" wireframe transparent opacity={0.09} depthWrite={false} />
      </mesh>
      <mesh geometry={cerebellum}>
        <meshBasicMaterial color="hsl(100, 90%, 50%)" wireframe transparent opacity={0.11} depthWrite={false} />
      </mesh>
    </group>
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
          <BrainShell />
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
