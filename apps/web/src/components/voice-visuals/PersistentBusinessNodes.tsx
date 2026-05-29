/**
 * PersistentBusinessNodes — steady-state render of a focused business's
 * systems on the brain canvas.
 *
 * Mirrors `LiveSpawningNodes` visually (same chip palette + iconography)
 * but skips the fade-in/out envelope. Once a business exists, its
 * systems stay visible at full opacity until the focus changes.
 *
 * Pair with `LiveSpawningNodes` in the same scene:
 *   - During an active construction cascade, both layers render. The
 *     stream layer's fade-in arrives first because SSE delivers spawn
 *     events ~immediately; the steady-state query refetches a beat
 *     later and the chip cross-fades to "persistent" without flicker.
 *   - Outside construction, only this layer is visible.
 */
import { useMemo } from 'react'
import { Html } from '@react-three/drei'
import {
  Settings as SettingsIcon, BookOpen, DollarSign, Brush,
  Target, ShieldCheck, GitBranch, Cpu, Database,
  Sparkles, Activity,
} from 'lucide-react'
import type { BusinessSystem } from '../../hooks/useBusinessGraph.js'

const LAYER_ACCENT: Record<BusinessSystem['layer'], string> = {
  executive:    '#8B7CFF',
  operations:   '#3DDC97',
  finance:      '#E6B86A',
  creative:     '#D67BA6',
  growth:       '#5BAFFF',
  intelligence: '#5BAFFF',
  security:     '#E69B6A',
}
const KIND_ICON: Record<BusinessSystem['kind'], typeof Target> = {
  department:  Target,
  workflow:    GitBranch,
  agent_slot:  Activity,
  asset:       Brush,
  analytics:   Sparkles,
  integration: Cpu,
}
const LAYER_ICON: Record<BusinessSystem['layer'], typeof Target> = {
  executive:    Target,
  operations:   SettingsIcon,
  finance:      DollarSign,
  creative:     Brush,
  growth:       BookOpen,
  intelligence: Database,
  security:     ShieldCheck,
}

interface Props {
  systems:    BusinessSystem[]
  onSelect?:  (system: BusinessSystem) => void
  selectedId?: string | null
}

export function PersistentBusinessNodes({ systems, onSelect, selectedId }: Props) {
  if (systems.length === 0) return null
  return (
    <>
      {systems.map(s => (
        <PersistentChip key={s.id} system={s} onSelect={onSelect} selected={selectedId === s.id} />
      ))}
    </>
  )
}

function PersistentChip({ system, onSelect, selected }: { system: BusinessSystem; onSelect?: ((s: BusinessSystem) => void) | undefined; selected: boolean }) {
  // Default position when none persisted — deterministic id-based scatter
  // so the same row always lands in the same spot.
  const position = useMemo<[number, number, number]>(() => {
    if (system.position) return [system.position.x, system.position.y, system.position.z]
    let h = 0
    for (let i = 0; i < system.id.length; i++) h = (h * 31 + system.id.charCodeAt(i)) | 0
    const x = ((h % 10) / 10) * 6 - 3
    const y = -5 + ((Math.abs(h >> 4) % 10) / 10) * 1.2
    return [x, y, 0]
  }, [system.id, system.position])

  const Icon = system.kind === 'department' ? LAYER_ICON[system.layer] : KIND_ICON[system.kind]
  const accent = LAYER_ACCENT[system.layer]

  // Departments render slightly larger to feel like primary nodes.
  const isDept = system.kind === 'department'
  const iconSize = isDept ? 'w-8 h-8' : 'w-7 h-7'
  const inner    = isDept ? 'w-4 h-4' : 'w-3.5 h-3.5'
  const textSize = isDept ? 'text-[12px]' : 'text-[11px]'

  // Paused/archived nodes fade to half opacity so the eye reads health.
  const dimmed = system.status === 'paused' || system.status === 'archived'
  const opacity = dimmed ? 0.45 : 1

  // Selected nodes get a brand-purple ring so the eye tracks the drawer.
  const ringColor = selected ? 'var(--accent-active)' : `${accent}40`
  const ringWidth = selected ? 1.5 : 1

  return (
    <Html position={position} center zIndexRange={[35, 25]}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onSelect?.(system) }}
        className="flex items-center gap-2 select-none cursor-pointer group focus-ring rounded-full"
        style={{ opacity, transform: 'translate(-50%, -50%)', whiteSpace: 'nowrap', background: 'transparent', border: 0, padding: 0 }}
        title={`${system.name} — ${system.kind.replace('_', ' ')} · ${system.layer}`}
        aria-label={`Inspect ${system.name}`}
      >
        <div
          className={`${iconSize} rounded-full flex items-center justify-center shrink-0 transition-all group-hover:scale-110`}
          style={{
            background: `${accent}1A`,
            boxShadow: `0 0 0 ${ringWidth}px ${ringColor}, inset 0 0 12px ${accent}25`,
            color: accent,
          }}
        >
          <Icon className={inner} strokeWidth={1.6} />
        </div>
        <div className={`${textSize} font-medium text-white/95 tracking-tight transition-colors group-hover:text-white`}
          style={{ textShadow: `0 0 10px ${accent}55` }}>
          {system.name}
        </div>
      </button>
    </Html>
  )
}
