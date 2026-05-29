/**
 * LiveSpawningNodes — R3F + Html overlay rendering each
 * `business.system.spawned` event as a 3D-anchored chip on the brain
 * canvas. Cinematic fade-in: ring expands, label fades to opacity 1
 * over ~900 ms, then settles.
 *
 * Drop it inside the same `<Canvas>` as the brain mesh. It reads
 * spawn state from the SSE hook and animates each chip relative to
 * its `spawnedAt` timestamp — no faked timing.
 */
import { useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import {
  Settings as SettingsIcon, BookOpen, DollarSign, Brush,
  Layers, Target, ShieldCheck, GitBranch, Cpu, Database,
  Sparkles, Activity,
} from 'lucide-react'
import type { SpawnedSystem } from '../../hooks/useBusinessConstructionStream.js'

// Layer → accent color (matches the lobe palette)
const LAYER_ACCENT: Record<SpawnedSystem['layer'], string> = {
  executive:    '#8B7CFF',
  operations:   '#3DDC97',
  finance:      '#E6B86A',
  creative:     '#D67BA6',
  growth:       '#5BAFFF',
  intelligence: '#5BAFFF',
  security:     '#E69B6A',
}

// Kind → icon
const KIND_ICON: Record<SpawnedSystem['kind'], typeof Target> = {
  department:  Target,
  workflow:    GitBranch,
  agent_slot:  Activity,
  asset:       Brush,
  analytics:   Sparkles,
  integration: Cpu,
}

// Layer → fallback icon when kind doesn't dominate
const LAYER_ICON: Record<SpawnedSystem['layer'], typeof Target> = {
  executive:    Target,
  operations:   SettingsIcon,
  finance:      DollarSign,
  creative:     Brush,
  growth:       BookOpen,
  intelligence: Database,
  security:     ShieldCheck,
}

const FADE_IN_MS = 900
const HOLD_MS    = 12_000
const FADE_OUT_MS = 4_000

interface Props {
  spawned:     SpawnedSystem[]
  /** Optional time provider for testing; defaults to Date.now(). */
  now?:        () => number
}

export function LiveSpawningNodes({ spawned, now = Date.now }: Props) {
  // No spawned nodes → render nothing (and no rAF tick)
  if (spawned.length === 0) return null

  return (
    <>
      {spawned.map(s => (
        <SpawnChip key={s.id} system={s} now={now} />
      ))}
    </>
  )
}

function SpawnChip({ system, now }: { system: SpawnedSystem; now: () => number }) {
  // Default-positioned (no spatial hint) systems land near the brain's
  // bottom edge in a soft horizontal scatter so the eye picks them up
  // without occluding the lobes.
  const position = useMemo<[number, number, number]>(() => {
    if (system.position) return [system.position.x, system.position.y, system.position.z]
    // Deterministic scatter — same id always lands in the same spot
    let h = 0
    for (let i = 0; i < system.id.length; i++) h = (h * 31 + system.id.charCodeAt(i)) | 0
    const x = ((h % 10) / 10) * 6 - 3
    const y = -5 + ((Math.abs(h >> 4) % 10) / 10) * 1.2
    return [x, y, 0]
  }, [system.id, system.position])

  // Pick the strongest icon: department uses the LAYER icon (it's the
  // primary node type), everything else uses the KIND icon.
  const Icon = system.kind === 'department' ? LAYER_ICON[system.layer] : KIND_ICON[system.kind]
  const accent = LAYER_ACCENT[system.layer]

  // Compute envelope each frame. We don't useState — re-rendering on
  // every frame would be wasteful. The wrapper div's style is mutated
  // in useFrame via a ref so the React tree stays still.
  const html = useMemo(() => (
    <div
      data-spawn-chip={system.id}
      style={{
        opacity: 0,
        transform: 'translate(-50%, -50%) scale(0.6)',
        transition: 'none',                  // we drive it from useFrame
        pointerEvents: 'none',
        userSelect: 'none',
        whiteSpace: 'nowrap',
      }}
      className="flex items-center gap-2"
    >
      <div
        className="w-7 h-7 rounded-full flex items-center justify-center"
        style={{
          background: `${accent}1A`,
          boxShadow: `0 0 0 1px ${accent}55, 0 0 18px ${accent}33`,
          color: accent,
        }}
      >
        <Icon className="w-3.5 h-3.5" strokeWidth={1.6} />
      </div>
      <div
        className="text-[11px] font-medium text-white/95 tracking-tight"
        style={{ textShadow: `0 0 10px ${accent}66` }}
      >
        {system.name}
      </div>
    </div>
  ), [Icon, accent, system.id, system.name])

  useFrame(() => {
    const node = document.querySelector(`[data-spawn-chip="${system.id}"]`) as HTMLElement | null
    if (!node) return
    const age = now() - system.spawnedAt
    let opacity = 0
    let scale = 0.6
    if (age < FADE_IN_MS) {
      const t = age / FADE_IN_MS
      // ease-out cubic
      const e = 1 - Math.pow(1 - t, 3)
      opacity = e
      scale = 0.6 + 0.4 * e
    } else if (age < FADE_IN_MS + HOLD_MS) {
      opacity = 1
      scale = 1
    } else if (age < FADE_IN_MS + HOLD_MS + FADE_OUT_MS) {
      const t = (age - FADE_IN_MS - HOLD_MS) / FADE_OUT_MS
      opacity = 1 - t
      scale = 1 - 0.08 * t
    } else {
      opacity = 0
      scale = 0.92
    }
    node.style.opacity = String(opacity)
    node.style.transform = `translate(-50%, -50%) scale(${scale})`
  })

  return (
    <Html position={position} center pointerEvents="none" zIndexRange={[40, 30]}>
      {html}
    </Html>
  )
}
