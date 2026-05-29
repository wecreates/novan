/**
 * VoiceVisualControls — single dropdown that exposes every voice-visual
 * setting. Designed to live in the Brain page's top-right command row.
 *
 * The dropdown is the only surface for these knobs; the brain canvas
 * itself stays clean.
 */
import { useState, useRef, useEffect } from 'react'
import { Sparkles, ChevronDown } from 'lucide-react'
import {
  useVoiceVisual,
  type VisualMode, type Intensity, type Performance,
} from '../../contexts/VoiceVisualContext.js'

const MODES: Array<{ id: VisualMode; label: string }> = [
  { id: 'auto',          label: 'Auto' },
  { id: 'brain_pulse',   label: 'Brain Pulse' },
  { id: 'orbit_rings',   label: 'Orbit Rings' },
  { id: 'neural_wave',   label: 'Neural Wave' },
  { id: 'voice_halo',    label: 'Voice Halo' },
  { id: 'constellation', label: 'Frequency Constellation' },
  { id: 'equalizer',     label: 'Glass Equalizer' },
  { id: 'off',           label: 'Off' },
]

const INTENSITIES: Intensity[]   = ['low', 'medium', 'high']
const PERF: Performance[]        = ['full', 'balanced', 'low_power']

export function VoiceVisualControls() {
  const { settings, update, ctl, audio } = useVoiceVisual()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const fn = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', fn)
    return () => window.removeEventListener('mousedown', fn)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(s => !s)}
        title="Voice visuals"
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-[var(--border)] hover:border-[var(--border-strong)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors focus-ring">
        <Sparkles className="w-3 h-3" />
        <span>Visuals</span>
        <ChevronDown className="w-3 h-3 opacity-60" />
      </button>

      {open && (
        <div className="absolute top-full mt-1 right-0 panel-elevated dropdown-in min-w-[260px] z-dropdown overflow-hidden"
             role="menu">
          {/* Mode */}
          <Section label="Mode">
            <div className="grid grid-cols-2 gap-1 p-2">
              {MODES.map(m => (
                <Chip key={m.id} active={settings.mode === m.id}
                  onClick={() => update({ mode: m.id })}>
                  {m.label}
                </Chip>
              ))}
            </div>
          </Section>

          {/* Intensity */}
          <Section label="Intensity">
            <div className="flex gap-1 p-2">
              {INTENSITIES.map(i => (
                <Chip key={i} active={settings.intensity === i}
                  onClick={() => update({ intensity: i })}>
                  {i}
                </Chip>
              ))}
            </div>
          </Section>

          {/* Performance */}
          <Section label="Performance">
            <div className="flex gap-1 p-2">
              {PERF.map(p => (
                <Chip key={p} active={settings.performance === p}
                  onClick={() => update({ performance: p })}>
                  {p.replace('_', ' ')}
                </Chip>
              ))}
            </div>
          </Section>

          {/* Accessibility */}
          <Section label="Accessibility">
            <Toggle label="Reduced motion"           value={settings.reducedMotion}
              onChange={v => update({ reducedMotion: v })} />
            <Toggle label="Disable flicker"          value={settings.disableFlicker}
              onChange={v => update({ disableFlicker: v })} />
            <Toggle label="Background constellation" value={settings.backgroundStars}
              onChange={v => update({ backgroundStars: v })} />
            <Toggle label="Equalizer in prompt bar"  value={settings.equalizerEnabled}
              onChange={v => update({ equalizerEnabled: v })} />
          </Section>

          {/* Preview */}
          <Section label="Preview">
            <div className="flex items-center justify-between px-3 py-2">
              <div>
                <div className="text-[11px] text-[var(--text-primary)]">Synthetic audio</div>
                <div className="text-[10px] text-[var(--text-muted)]">
                  {audio.preview ? 'Preview running — Novan is NOT speaking' : 'Tests visuals without mic'}
                </div>
              </div>
              <Toggle label="" value={audio.preview} onChange={v => ctl.setPreview(v)} />
            </div>
          </Section>
        </div>
      )}
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-[var(--border)] last:border-b-0">
      <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)] px-3 pt-2">{label}</div>
      {children}
    </div>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      role="menuitemradio"
      aria-checked={active}
      className={`px-2 py-1 rounded text-[11px] transition-colors focus-ring ${
        active
          ? 'bg-[var(--accent-active)]/15 border border-[var(--accent-active)]/40 text-[var(--accent-active)]'
          : 'border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
      }`}>
      {children}
    </button>
  )
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-[var(--surface-hover)] transition-colors">
      {label && <span className="text-[11px] text-[var(--text-secondary)]">{label}</span>}
      <span className={`relative inline-block w-7 h-4 rounded-full transition-colors ${
        value ? 'bg-[var(--accent-active)]' : 'bg-[var(--bg-elevated)] border border-[var(--border)]'
      }`}>
        <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-[var(--text-primary)] transition-transform ${
          value ? 'translate-x-3' : 'translate-x-0.5'
        }`} />
      </span>
      <input type="checkbox" checked={value} onChange={e => onChange(e.target.checked)}
        className="sr-only" aria-label={label} />
    </label>
  )
}
