/**
 * GlassEqualizerBar — minimal frequency-bar visualizer for the bottom
 * prompt area. Always usable, no 3D required.
 *
 * Draws a row of N thin bars whose heights track the analyser's
 * frequency bins. When no audio is attached + preview is off, the bars
 * settle to a flat baseline (no fake speech).
 *
 * Honest scope: the bars are derived from the same VoiceVisualContext
 * everything else reads. If the operator disables the equalizer in
 * settings, the parent doesn't render this at all.
 */
import { useEffect, useRef } from 'react'
import { useVoiceVisual } from '../../contexts/VoiceVisualContext.js'

interface Props {
  bars?:    number    // default 16
  height?:  number    // px, default 18
  width?:   number    // px, default 88
  className?: string
}

export function GlassEqualizerBar({ bars = 16, height = 18, width = 88, className }: Props) {
  const { audio, motionReduced } = useVoiceVisual()
  const ref = useRef<HTMLCanvasElement>(null)
  // Persist last bar heights so we can soft-lerp toward the target.
  const stateRef = useRef<number[]>(Array.from({ length: bars }, () => 0))

  useEffect(() => {
    const c = ref.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width  = width  * dpr
    c.height = height * dpr
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
  }, [width, height])

  useEffect(() => {
    let raf = 0
    const draw = () => {
      const c = ref.current
      if (!c) { raf = requestAnimationFrame(draw); return }
      const ctx = c.getContext('2d')
      if (!ctx) { raf = requestAnimationFrame(draw); return }

      // Build the target heights from the analyser's amplitude + bands.
      // Distribute energy across bars: lows on the left, mids middle,
      // highs on the right. Gentle smoothing avoids strobing.
      const lo = audio.lowFrequency
      const mi = audio.midFrequency
      const hi = audio.highFrequency
      const amp = audio.amplitude
      const cur = stateRef.current
      const lerpRate = motionReduced ? 0.15 : 0.35

      for (let i = 0; i < bars; i++) {
        const t = i / (bars - 1)                            // 0..1 across the bar
        let band = (t < 0.33 ? lo : t < 0.66 ? mi : hi)
        // Subtle taper at the ends + amp scaling
        const target = Math.min(1, band * (0.6 + 0.5 * Math.sin(t * Math.PI)) * (0.5 + amp * 0.7))
        cur[i] = (cur[i] ?? 0) + ((target - (cur[i] ?? 0)) * lerpRate)
      }

      // Render
      ctx.clearRect(0, 0, width, height)
      const colorPrimary   = 'rgba(139, 124, 255, 0.95)'    // brand
      const colorBaseline  = 'rgba(255, 255, 255, 0.12)'    // hairline
      const barW = (width - (bars - 1) * 2) / bars

      for (let i = 0; i < bars; i++) {
        const h = Math.max(1, (cur[i] ?? 0) * height)
        const x = i * (barW + 2)
        const y = (height - h) / 2
        ctx.fillStyle = (cur[i] ?? 0) > 0.04 ? colorPrimary : colorBaseline
        ctx.fillRect(x, y, barW, h)
      }

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => { cancelAnimationFrame(raf) }
  }, [audio.amplitude, audio.lowFrequency, audio.midFrequency, audio.highFrequency,
      bars, height, width, motionReduced])

  // ARIA: announce listening / speaking state without flooding readers
  const label = audio.isSpeaking ? 'voice speaking'
              : audio.isListening ? 'voice listening'
              : audio.preview ? 'voice preview'
              : 'voice idle'

  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={label}
      width={width}
      height={height}
      className={className}
      style={{ width, height, display: 'block' }}
    />
  )
}
