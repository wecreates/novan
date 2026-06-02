/**
 * KronosBrain — R146.113 — particle-brain landing template.
 *
 * Visual inspired by the kzzy47 / Pulse reel: a dense cloud of bright
 * magenta points arranged in a roughly spherical, slightly squished
 * (brain-shaped) volume on pure black. Slow rotation. Soft outer halo.
 * Label below ("NOVAN" by default, customizable). Small key-hint that
 * says "[SPACE] to enter" — pressing space (or clicking the orb) calls
 * the onEnter callback.
 *
 * Differences from the source:
 *  - We connect near-neighbor points with faint lines to ALSO give the
 *    wireframe-mesh feel from some of the reel's frames. Best of both.
 *  - Hue is configurable. Default 320 (magenta). Set to 200 for Novan
 *    sky-blue to match the rest of the app.
 *  - Honors prefers-reduced-motion: drops to a still composition.
 */
import { useRef, useMemo, useEffect, useCallback, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import * as THREE from 'three'

interface KronosBrainProps {
  label?:        string          // big text below the orb. Default 'NOVAN'.
  subLabel?:     string          // micro-text above the entry hint. Optional.
  hint?:         string          // hint text. Default 'SPACE to enter'.
  hue?:          number          // 0..360. Default 320 (magenta).
  pointCount?:   number          // # of particles. Default 700.
  squish?:       number          // y-axis scale 0.5..1.0. Default 0.82 (brain-ish).
  rotationSpeed?: number         // rad/sec. Default 0.18.
  onEnter?:      () => void      // called on SPACE press or orb click
}

function useReducedMotion(): boolean {
  const [r, setR] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const fn = () => setR(mq.matches)
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [])
  return r
}

// ─── particle cloud ────────────────────────────────────────────────────

function ParticleBrain({ count, hue, squish, rotationSpeed }: {
  count: number; hue: number; squish: number; rotationSpeed: number
}) {
  const groupRef = useRef<THREE.Group>(null)
  const reduced = useReducedMotion()

  // Generate positions once (Fibonacci sphere → even visual spread, no clumping).
  // R146.113: deterministic seeded jitter so the same brain renders every mount
  // — prevents flicker on re-render.
  const { positions, lineGeom } = useMemo(() => {
    const pos = new Float32Array(count * 3)
    let seed = 12345
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff }
    const pts: Array<[number, number, number]> = []
    for (let i = 0; i < count; i++) {
      // Fibonacci sphere — evenly distributed points on unit sphere
      const phi = Math.acos(1 - 2 * (i + 0.5) / count)
      const theta = Math.PI * (1 + Math.sqrt(5)) * i
      const jitter = 1 + (rand() - 0.5) * 0.45  // radius jitter for organic feel
      const x = Math.cos(theta) * Math.sin(phi) * jitter
      const y = Math.sin(theta) * Math.sin(phi) * jitter * squish
      const z = Math.cos(phi) * jitter
      pos[i * 3]     = x
      pos[i * 3 + 1] = y
      pos[i * 3 + 2] = z
      pts.push([x, y, z])
    }
    // Build near-neighbor lines (k=2 closest for each point) — gives the
    // wireframe-mesh feel without needing full triangulation. ~2*count edges.
    const lineVerts: number[] = []
    const k = 2
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!
      // Distance to every other point — O(n^2) but n is ~700 so ~500k ops, fine
      const dists: Array<{ j: number; d: number }> = []
      for (let j = 0; j < pts.length; j++) {
        if (j === i) continue
        const b = pts[j]!
        const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2]
        dists.push({ j, d: dx * dx + dy * dy + dz * dz })
      }
      dists.sort((m, n) => m.d - n.d)
      for (let kk = 0; kk < k; kk++) {
        const j = dists[kk]!.j
        if (j > i) {  // dedupe — only emit each edge once
          const b = pts[j]!
          lineVerts.push(a[0], a[1], a[2], b[0], b[1], b[2])
        }
      }
    }
    const lg = new THREE.BufferGeometry()
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lineVerts), 3))
    return { positions: pos, lineGeom: lg }
  }, [count, squish])

  const pointGeom = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    return g
  }, [positions])

  useFrame((_, dt) => {
    if (reduced) return
    if (groupRef.current) groupRef.current.rotation.y += dt * rotationSpeed
  })

  const baseColor   = `hsl(${hue}, 100%, 62%)`
  const lineColor   = `hsl(${hue}, 100%, 45%)`

  return (
    <group ref={groupRef}>
      {/* Edges first so points sit on top */}
      <lineSegments geometry={lineGeom}>
        <lineBasicMaterial color={lineColor} transparent opacity={0.28} />
      </lineSegments>
      <points geometry={pointGeom}>
        <pointsMaterial
          size={0.075}
          color={baseColor}
          sizeAttenuation
          transparent
          opacity={0.95}
          // Makes points additive — dense regions get whiter cores like the reel
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </points>
    </group>
  )
}

// ─── full landing component ────────────────────────────────────────────

export function KronosBrain({
  label = 'NOVAN',
  subLabel,
  hint = 'SPACE to enter',
  hue = 38,        // R146.114 — default gold/amber to match Pulse/KRONOS aesthetic
  pointCount = 700,
  squish = 0.82,
  rotationSpeed = 0.18,
  onEnter,
}: KronosBrainProps): JSX.Element {
  const enter = useCallback(() => { onEnter?.() }, [onEnter])

  useEffect(() => {
    if (!onEnter) return
    const fn = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.key === 'Enter') { e.preventDefault(); enter() }
    }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [onEnter, enter])

  const haloColor = `hsl(${hue}, 100%, 45%)`
  const textColor = `hsl(${hue}, 100%, 70%)`

  return (
    <div
      onClick={enter}
      role={onEnter ? 'button' : undefined}
      tabIndex={onEnter ? 0 : -1}
      style={{
        position: 'relative',
        width: '100%', height: '100%',
        background: '#000',
        cursor: onEnter ? 'pointer' : 'default',
        overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        userSelect: 'none',
      }}
    >
      {/* Soft halo glow behind the canvas */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          left: '50%', top: '46%',
          width: '60vmin', height: '60vmin',
          transform: 'translate(-50%, -50%)',
          background: `radial-gradient(circle at 50% 50%, ${haloColor}33 0%, ${haloColor}11 38%, transparent 70%)`,
          filter: 'blur(40px)',
          pointerEvents: 'none',
        }}
      />
      {/* The orb */}
      <div style={{
        position: 'relative',
        width: 'min(72vmin, 720px)',
        height: 'min(72vmin, 720px)',
      }}>
        <Canvas
          camera={{ position: [0, 0, 4], fov: 45 }}
          gl={{ antialias: true, alpha: true }}
          style={{ position: 'absolute', inset: 0 }}
        >
          <ParticleBrain
            count={pointCount}
            hue={hue}
            squish={squish}
            rotationSpeed={rotationSpeed}
          />
        </Canvas>
      </div>
      {/* Label */}
      <div
        style={{
          position: 'absolute',
          left: '50%', bottom: '22%',
          transform: 'translateX(-50%)',
          color: textColor,
          fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace',
          fontSize: 'clamp(22px, 3.4vmin, 42px)',
          fontWeight: 600,
          letterSpacing: '0.4em',
          textShadow: `0 0 20px ${haloColor}aa, 0 0 40px ${haloColor}55`,
          pointerEvents: 'none',
        }}
      >
        {label}
      </div>
      {subLabel && (
        <div
          style={{
            position: 'absolute',
            left: '50%', bottom: '17%',
            transform: 'translateX(-50%)',
            color: textColor,
            opacity: 0.6,
            fontSize: 'clamp(10px, 1.4vmin, 14px)',
            letterSpacing: '0.2em',
            pointerEvents: 'none',
          }}
        >
          {subLabel}
        </div>
      )}
      {/* Hint pill */}
      {onEnter && hint && (
        <div
          style={{
            position: 'absolute',
            left: '50%', bottom: '12%',
            transform: 'translateX(-50%)',
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '6px 12px',
            border: `1px solid ${haloColor}66`,
            borderRadius: 4,
            background: `${haloColor}10`,
            color: textColor,
            fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace',
            fontSize: 'clamp(11px, 1.4vmin, 14px)',
            letterSpacing: '0.18em',
            textShadow: `0 0 12px ${haloColor}88`,
            pointerEvents: 'none',
            animation: 'kronos-hint-pulse 2.4s ease-in-out infinite',
          }}
        >
          {hint}
        </div>
      )}
      <style>{`
        @keyframes kronos-hint-pulse {
          0%, 100% { opacity: 0.6 }
          50%      { opacity: 1   }
        }
        @media (prefers-reduced-motion: reduce) {
          [class*="kronos-hint"] { animation: none }
        }
      `}</style>
    </div>
  )
}

export default KronosBrain
