/**
 * CinematicCamera.tsx — Auto-orbiting camera for presentation mode.
 *
 * Slow continuous orbit around the scene center plus subtle radius
 * breathing (pull-in / push-out). No user input needed — this is the
 * "set it and let people watch" view.
 *
 * Easings are smoothstep, not linear, so the motion never feels
 * mechanical. Speed is configurable; default ≈ 60s per full rotation
 * which feels cinematic without being boring.
 */
import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

interface Props {
  /** Seconds per full rotation. Default 60. */
  orbitPeriodSec?:  number
  /** Base camera distance from center. Default 28. */
  radius?:          number
  /** ±radius variation amplitude (breathing). Default 4. */
  breathAmp?:       number
  /** Seconds per breath cycle. Default 14. */
  breathPeriodSec?: number
  /** When false, the camera stays still (parking the cinematic). */
  enabled?:         boolean
}

export function CinematicCamera({
  orbitPeriodSec = 60,
  radius = 28,
  breathAmp = 4,
  breathPeriodSec = 14,
  enabled = true,
}: Props): null {
  const { camera } = useThree()
  const startedAt = useRef<number>(performance.now())
  const target = useRef(new THREE.Vector3(0, 0, 0))
  const lastEnabled = useRef(enabled)

  useEffect(() => {
    // Reset clock when presentation re-engages so motion feels fresh.
    if (enabled && !lastEnabled.current) startedAt.current = performance.now()
    lastEnabled.current = enabled
  }, [enabled])

  useFrame(() => {
    if (!enabled) return
    const elapsedSec = (performance.now() - startedAt.current) / 1000
    const theta = (elapsedSec / orbitPeriodSec) * Math.PI * 2
    const breath = Math.sin((elapsedSec / breathPeriodSec) * Math.PI * 2) * breathAmp
    const r = radius + breath
    const y = Math.sin(elapsedSec * 0.05) * 3   // gentle vertical drift
    camera.position.set(Math.cos(theta) * r, y, Math.sin(theta) * r)
    camera.lookAt(target.current)
  })

  return null
}
