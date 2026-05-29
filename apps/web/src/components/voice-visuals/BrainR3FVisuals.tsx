/**
 * BrainR3FVisuals — R3F components meant to render INSIDE the existing
 * <Canvas> on /brain. They subscribe to the global VoiceVisualContext,
 * so dropping any of them into the scene wires them to live audio.
 *
 * Components:
 *   - <BrainPulseGroup>     — wraps children, scales them by amplitude
 *   - <OrbitRings>          — concentric rings that expand on speech
 *
 * Why R3F here vs plain JSX:
 *   The Brain canvas is already a full WebGL scene. Adding overlay
 *   <div>s on top is fine for halos (cheap), but the pulse + rings
 *   need to live in 3D space so they composite with the existing
 *   nodes correctly.
 */
import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useVoiceVisual } from '../../contexts/VoiceVisualContext.js'

interface PulseProps { children: React.ReactNode }

/**
 * Wraps the brain mesh / nodes. The group's scale breathes with
 * voice amplitude — never more than ±5% so the operator never feels
 * the camera jitter.
 */
export function BrainPulseGroup({ children }: PulseProps) {
  const ref = useRef<THREE.Group>(null)
  const { audio, settings, motionReduced, lowPower } = useVoiceVisual()

  const enabled = settings.mode === 'auto'
              || settings.mode === 'brain_pulse'
  const intensity = motionReduced || lowPower ? 0
    : settings.intensity === 'low' ? 0.018
    : settings.intensity === 'high' ? 0.06
    : 0.035

  useFrame(() => {
    if (!ref.current) return
    if (!enabled || intensity === 0) {
      // Smoothly relax to 1.0
      ref.current.scale.lerp(new THREE.Vector3(1, 1, 1), 0.1)
      return
    }
    const target = 1 + audio.amplitude * intensity
    const t = new THREE.Vector3(target, target, target)
    ref.current.scale.lerp(t, 0.18)
  })

  return <group ref={ref}>{children}</group>
}

/**
 * Concentric Jarvis-style rings around the brain. They expand outward
 * + fade as amplitude rises. Three rings is enough for the effect;
 * more becomes noisy.
 */
export function OrbitRings({ origin = [0, 0, 0] as [number, number, number] }) {
  const refs = [useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null)]
  const { audio, settings, motionReduced, lowPower } = useVoiceVisual()

  const enabled = settings.mode === 'auto' || settings.mode === 'orbit_rings'
  // Low power disables the rings outright (they're cheap, but the
  // operator may want to ship cycles to other work).
  if (!enabled || lowPower) return null

  useFrame(({ clock }) => {
    refs.forEach((r, i) => {
      if (!r.current) return
      const phase = (clock.elapsedTime * 0.25 + i / refs.length) % 1
      const baseR = 5.5 + i * 1.2
      const radius = baseR + phase * (audio.amplitude * 4 + (motionReduced ? 0.2 : 0.8))
      r.current.scale.setScalar(radius / 5.5)
      const mat = r.current.material as THREE.MeshBasicMaterial
      // Fade as the ring grows. amplitude scales the peak opacity.
      const peak = 0.18 + audio.amplitude * 0.35
      mat.opacity = peak * (1 - phase)
    })
  })

  const color = audio.isError       ? 0xef4444
              : audio.needsApproval ? 0xf59e0b
              : audio.isListening   ? 0x67e8f9
              : 0x8b7cff

  return (
    <group position={origin}>
      {refs.map((r, i) => (
        <mesh key={i} ref={r} rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[5.5, 5.55, 96]} />
          <meshBasicMaterial color={color} transparent opacity={0} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </group>
  )
}
