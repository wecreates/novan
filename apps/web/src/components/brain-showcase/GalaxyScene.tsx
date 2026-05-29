/**
 * GalaxyScene.tsx — The 3D content for presentation mode.
 *
 * Renders nodes from /api/v1/brain/graph as glowing spheres in a
 * deliberately-arranged galaxy: workspace clusters orbit the brain
 * core, agents orbit their workspace, edges connect cross-workspace
 * activity.
 *
 * Deliberately simpler than BrainPage's full scene — the showcase
 * doesn't need 8 view templates, it needs ONE beautiful one.
 */
import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { layoutFor, type ViewMode } from './layouts'

export interface ShowcaseNode {
  id:         string
  label:      string
  group:      string         // workspace or category — used for clustering
  size?:      number
  /** 0-1 activity intensity; higher = brighter pulse. */
  activity?:  number
}

export interface ShowcaseEdge {
  from: string
  to:   string
  weight?: number
}

interface Props {
  nodes:       ShowcaseNode[]
  edges:       ShowcaseEdge[]
  anonOn:      boolean
  view?:       ViewMode
  focusGroup?: string
  onNodeClick?: (id: string) => void
}

const GROUP_COLORS = [
  '#60A5FA', '#A78BFA', '#34D399', '#FBBF24', '#F472B6',
  '#22D3EE', '#FB7185', '#FACC15', '#4ADE80', '#818CF8',
]

export function GalaxyScene({
  nodes, edges, anonOn: _anonOn,
  view = 'galaxy', focusGroup, onNodeClick,
}: Props): JSX.Element {
  const meshRef = useRef<THREE.Group>(null)

  // Group nodes by group field, position via the active layout.
  const positioned = useMemo(() => {
    const layout = layoutFor(view, nodes, focusGroup)
    const groupColorMap = new Map<string, string>()
    nodes.forEach(n => {
      if (!groupColorMap.has(n.group)) {
        groupColorMap.set(n.group, GROUP_COLORS[groupColorMap.size % GROUP_COLORS.length]!)
      }
    })
    const out: Array<ShowcaseNode & { pos: [number, number, number]; color: string; emphasis: number }> = []
    for (const n of nodes) {
      const l = layout.get(n.id)
      if (!l) continue
      out.push({ ...n, pos: l.pos, color: groupColorMap.get(n.group) ?? '#88aaff', emphasis: l.emphasis })
    }
    return out
  }, [nodes, view, focusGroup])

  const nodeById = useMemo(() => {
    const m = new Map<string, typeof positioned[0]>()
    positioned.forEach(n => m.set(n.id, n))
    return m
  }, [positioned])

  // Soft pulse for all active nodes — gentle, not flashy.
  useFrame(({ clock }) => {
    if (!meshRef.current) return
    const t = clock.getElapsedTime()
    meshRef.current.children.forEach((child, i) => {
      const node = positioned[i]
      if (!node) return
      const intensity = (node.activity ?? 0.3)
      const pulse = 1 + Math.sin(t * 1.5 + i * 0.7) * 0.1 * intensity
      child.scale.setScalar(pulse * (node.size ?? 0.4))
    })
  })

  return (
    <>
      {/* Atmosphere — soft ambient + a key point light at center */}
      <ambientLight intensity={0.25} />
      <pointLight position={[0, 0, 0]} intensity={1.5} color="#aaccff" distance={50} />
      <pointLight position={[15, 8, 0]} intensity={0.6} color="#ff88aa" distance={30} />

      {/* Brain core */}
      <mesh position={[0, 0, 0]}>
        <icosahedronGeometry args={[1.2, 1]} />
        <meshStandardMaterial
          color="#ffffff"
          emissive="#88bbff"
          emissiveIntensity={0.4}
          roughness={0.3}
          metalness={0.5}
        />
      </mesh>

      {/* Nodes */}
      <group ref={meshRef}>
        {positioned.map(node => {
          const handlers = onNodeClick ? {
            onClick:       (e: { stopPropagation: () => void }) => { e.stopPropagation(); onNodeClick(node.id) },
            onPointerOver: (e: { stopPropagation: () => void }) => { e.stopPropagation(); document.body.style.cursor = 'pointer' },
            onPointerOut:  () => { document.body.style.cursor = '' },
          } : {}
          return (
            <mesh key={node.id} position={node.pos} {...handlers}>
              <sphereGeometry args={[1, 16, 16]} />
              <meshStandardMaterial
                color={node.color}
                emissive={node.color}
                emissiveIntensity={0.6 * node.emphasis}
                roughness={0.4}
                metalness={0.6}
                transparent={node.emphasis < 1}
                opacity={node.emphasis}
              />
            </mesh>
          )
        })}
      </group>

      {/* Edges */}
      {edges.slice(0, 200).map((e, i) => {
        const a = nodeById.get(e.from)
        const b = nodeById.get(e.to)
        if (!a || !b) return null
        const geom = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(...a.pos),
          new THREE.Vector3(...b.pos),
        ])
        return (
          <primitive key={i} object={new THREE.Line(geom, new THREE.LineBasicMaterial({
            color: '#88aaff',
            opacity: Math.min(0.5, (e.weight ?? 0.2)),
            transparent: true,
          }))} />
        )
      })}

      {/* Fog for depth */}
      <fog attach="fog" args={['#050a18', 18, 60]} />
    </>
  )
}
