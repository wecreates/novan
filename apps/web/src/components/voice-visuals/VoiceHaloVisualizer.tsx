/**
 * VoiceHaloVisualizer — circular halo around the Brain center.
 *
 * Renders as an SVG overlay anchored to the middle of its container.
 * No three.js required, GPU-friendly. The halo's radius and stroke
 * width breathe with amplitude; color shifts by logical state:
 *
 *   speaking  → brand purple
 *   listening → soft cyan
 *   approval  → amber
 *   error     → restrained red
 *   idle      → near-invisible hairline
 *
 * The component is opaque to its placement — drop it inside any
 * `position: relative` parent and it centers itself.
 */
import { useVoiceVisual } from '../../contexts/VoiceVisualContext.js'

interface Props {
  /** Outer radius in px when amplitude=0 (it grows up to +12 px). */
  baseRadius?: number
  className?:  string
}

export function VoiceHaloVisualizer({ baseRadius = 64, className }: Props) {
  const { audio, settings, motionReduced } = useVoiceVisual()
  if (settings.mode === 'off' || settings.mode === 'equalizer') return null

  const amp = audio.amplitude
  const intensityScale =
    settings.intensity === 'low' ? 0.5
  : settings.intensity === 'high' ? 1.25
  : 1.0
  const grow = motionReduced ? amp * 4 : amp * 14
  const r1 = baseRadius + grow * intensityScale
  const r2 = baseRadius * 0.78 + grow * 0.7 * intensityScale

  let stroke = 'rgba(139, 124, 255, 0.55)'  // brand
  let glow   = 'rgba(139, 124, 255, 0.25)'
  let widthPx = 1.5 + amp * 1.5

  if (audio.isError) {
    stroke = 'rgba(239, 68, 68, 0.55)'
    glow   = 'rgba(239, 68, 68, 0.25)'
  } else if (audio.needsApproval) {
    stroke = 'rgba(245, 158, 11, 0.65)'
    glow   = 'rgba(245, 158, 11, 0.30)'
  } else if (audio.isListening) {
    stroke = 'rgba(103, 232, 249, 0.55)'
    glow   = 'rgba(103, 232, 249, 0.22)'
  } else if (audio.isMuted) {
    stroke = 'rgba(255, 255, 255, 0.10)'
    glow   = 'transparent'
    widthPx = 1
  } else if (!audio.isSpeaking && !audio.preview) {
    stroke = 'rgba(255, 255, 255, 0.10)'
    glow   = 'transparent'
    widthPx = 1
  }

  const size = (r1 + 12) * 2

  return (
    <div
      className={className}
      aria-hidden
      style={{
        position: 'absolute', top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        width: size, height: size, pointerEvents: 'none',
      }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* outer glow ring (only when active) */}
        {glow !== 'transparent' && (
          <circle
            cx={size / 2} cy={size / 2} r={r1}
            fill="none" stroke={glow} strokeWidth={widthPx * 2}
            style={{ filter: 'blur(2px)' }}
          />
        )}
        <circle
          cx={size / 2} cy={size / 2} r={r1}
          fill="none" stroke={stroke} strokeWidth={widthPx}
        />
        <circle
          cx={size / 2} cy={size / 2} r={r2}
          fill="none" stroke={stroke} strokeWidth={widthPx * 0.6}
          opacity={0.5}
        />
      </svg>
    </div>
  )
}
