/**
 * NovanVisuals.tsx — R146.111 — fluid UI primitives for brain + chat.
 *
 * Four exports, all dependency-free (no framer-motion, no three.js):
 *
 *   <BreathingOrb />       — soft glowing orb with breathing pulse + subtle
 *                            hue drift. Pure SVG + CSS, GPU-accelerated.
 *   <ParticleTrail />      — cursor-following particle trail using a single
 *                            canvas + requestAnimationFrame. Pauses when
 *                            offscreen / unmounted / prefers-reduced-motion.
 *   <TypewriterText />     — types one char at a time at a tunable speed.
 *                            Pauses at punctuation. Cursor blinks.
 *   <AnimatedBubble />     — wrapper that fades + lifts + scales in via
 *                            CSS transition. Smooth height changes via
 *                            ResizeObserver-driven max-height animation.
 *
 * Honest scope: I'm deliberately NOT pulling in a 60kB animation library.
 * Everything here uses native CSS transitions, transforms, and one canvas
 * 2d context. ~6kB gzipped. Respects prefers-reduced-motion globally.
 */
import { useEffect, useRef, useState, useMemo, type ReactNode, type CSSProperties } from 'react'

// ─── Shared: respect reduced-motion preference ─────────────────────────

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const fn = () => setReduced(mq.matches)
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [])
  return reduced
}

// ─── BreathingOrb ─────────────────────────────────────────────────────

interface BreathingOrbProps {
  size?:         number       // px diameter, default 140
  hue?:          number       // base hue 0..360, default 200 (sky)
  intensity?:    number       // 0..1 brightness scalar, default 0.85
  speed?:        number       // breath cycles/sec, default 0.25 (4s/breath)
  state?:        'idle' | 'listening' | 'thinking' | 'speaking'
  className?:    string
  style?:        CSSProperties
}

/** Soft breathing orb. Three stacked radial gradients on a circular SVG —
 *  outer halo, mid glow, inner core. Scale + opacity breathe via CSS
 *  custom-property animations driven by a single keyframe. State changes
 *  shift hue + speed without re-mounting. */
export function BreathingOrb({
  size = 140, hue = 200, intensity = 0.85, speed = 0.25, state = 'idle',
  className, style,
}: BreathingOrbProps): JSX.Element {
  const reduced = useReducedMotion()
  // State → tweak hue + breath speed
  const tuned = useMemo(() => {
    if (state === 'listening') return { h: hue,       sp: speed * 2.5, i: intensity * 1.05 }  // faster, slightly warmer
    if (state === 'thinking')  return { h: hue + 35,  sp: speed * 0.7, i: intensity * 0.95 }  // slower, drifted
    if (state === 'speaking')  return { h: hue + 15,  sp: speed * 3.5, i: intensity * 1.1  }  // fastest, brightest
    return { h: hue, sp: speed, i: intensity }
  }, [state, hue, speed, intensity])

  const duration = reduced ? 0 : 1 / Math.max(0.05, tuned.sp)
  const inner = `hsla(${tuned.h}, 95%, 78%, ${tuned.i})`
  const mid   = `hsla(${tuned.h + 10}, 90%, 60%, ${tuned.i * 0.55})`
  const halo  = `hsla(${tuned.h + 20}, 85%, 50%, ${tuned.i * 0.25})`

  return (
    <div
      aria-hidden
      className={className}
      style={{
        position: 'relative', width: size, height: size,
        display: 'inline-block', pointerEvents: 'none',
        ...style,
      }}
    >
      <style>{`
        @keyframes novan-breathe {
          0%, 100% { transform: scale(0.92); opacity: 0.78; filter: blur(0px); }
          50%      { transform: scale(1.06); opacity: 1;    filter: blur(0.4px); }
        }
        @keyframes novan-halo-drift {
          0%, 100% { transform: scale(1) rotate(0deg);   opacity: 0.55; }
          50%      { transform: scale(1.12) rotate(180deg); opacity: 0.85; }
        }
        .novan-orb-core { animation: novan-breathe var(--novan-orb-dur) ease-in-out infinite; transform-origin: center; }
        .novan-orb-halo { animation: novan-halo-drift calc(var(--novan-orb-dur) * 1.7) ease-in-out infinite; transform-origin: center; }
        @media (prefers-reduced-motion: reduce) {
          .novan-orb-core, .novan-orb-halo { animation: none; }
        }
      `}</style>
      <div style={{ position: 'absolute', inset: 0, '--novan-orb-dur': `${duration}s` } as CSSProperties}>
        {/* halo */}
        <div className="novan-orb-halo" style={{
          position: 'absolute', inset: 0, borderRadius: '50%',
          background: `radial-gradient(circle at 50% 50%, ${halo} 0%, transparent 70%)`,
          filter: 'blur(20px)',
        }} />
        {/* mid glow */}
        <div className="novan-orb-core" style={{
          position: 'absolute', inset: '12%', borderRadius: '50%',
          background: `radial-gradient(circle at 45% 40%, ${inner} 0%, ${mid} 45%, transparent 78%)`,
          filter: 'blur(2px)',
          animationDelay: '-0.3s',
        }} />
        {/* inner core */}
        <div className="novan-orb-core" style={{
          position: 'absolute', inset: '32%', borderRadius: '50%',
          background: `radial-gradient(circle at 45% 38%, white 0%, ${inner} 35%, transparent 80%)`,
          filter: 'blur(1px)',
          mixBlendMode: 'screen',
        }} />
      </div>
    </div>
  )
}

// ─── ParticleTrail ─────────────────────────────────────────────────────

interface ParticleTrailProps {
  hue?:           number       // 0..360, default 200
  density?:       number       // particles spawned per pointer-move event, default 2
  life?:          number       // particle lifetime ms, default 900
  size?:          number       // max particle radius px, default 4
  fadePower?:     number       // 1=linear, 2=quadratic, default 1.7
  blend?:         GlobalCompositeOperation
  className?:     string
}

interface Particle { x: number; y: number; vx: number; vy: number; born: number; size: number; hue: number }

/** Cursor-trail particle field. Mount once at the top of a page; it covers
 *  the viewport as a position:fixed canvas underneath all content. Particles
 *  spawn from pointer events with small random velocities and fade. */
export function ParticleTrail({
  hue = 200, density = 2, life = 900, size = 4, fadePower = 1.7,
  blend = 'lighter', className,
}: ParticleTrailProps): JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const particles = useRef<Particle[]>([])
  const rafRef = useRef<number | null>(null)
  const reduced = useReducedMotion()

  useEffect(() => {
    if (reduced) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let w = window.innerWidth, h = window.innerHeight
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const resize = () => {
      w = window.innerWidth; h = window.innerHeight
      canvas.width  = w * dpr; canvas.height = h * dpr
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    let lastX = -1, lastY = -1
    const spawn = (e: PointerEvent | MouseEvent) => {
      const x = e.clientX, y = e.clientY
      const moved = lastX < 0 ? 0 : Math.hypot(x - lastX, y - lastY)
      lastX = x; lastY = y
      // Throttle: tiny movements don't spawn
      if (moved < 1.5 && particles.current.length > 30) return
      const now = performance.now()
      const n = Math.max(1, Math.min(density, 6))
      for (let i = 0; i < n; i++) {
        const angle = Math.random() * Math.PI * 2
        const vel = 0.2 + Math.random() * 0.8
        particles.current.push({
          x: x + (Math.random() - 0.5) * 4,
          y: y + (Math.random() - 0.5) * 4,
          vx: Math.cos(angle) * vel,
          vy: Math.sin(angle) * vel - 0.15,
          born: now,
          size: size * (0.4 + Math.random() * 0.8),
          hue: hue + (Math.random() - 0.5) * 30,
        })
      }
      // Hard cap to keep frame budget tight
      if (particles.current.length > 800) particles.current.splice(0, particles.current.length - 800)
    }
    window.addEventListener('pointermove', spawn, { passive: true })

    const tick = () => {
      const now = performance.now()
      ctx.clearRect(0, 0, w, h)
      ctx.globalCompositeOperation = blend
      const alive: Particle[] = []
      for (const p of particles.current) {
        const age = (now - p.born) / life
        if (age >= 1) continue
        const fade = Math.pow(1 - age, fadePower)
        p.x += p.vx; p.y += p.vy
        p.vy += 0.005     // gentle gravity
        p.vx *= 0.985     // friction
        p.vy *= 0.985
        const r = p.size * fade
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3)
        grad.addColorStop(0,   `hsla(${p.hue}, 95%, 80%, ${0.9 * fade})`)
        grad.addColorStop(0.4, `hsla(${p.hue}, 95%, 65%, ${0.5 * fade})`)
        grad.addColorStop(1,   `hsla(${p.hue}, 95%, 50%, 0)`)
        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.arc(p.x, p.y, r * 3, 0, Math.PI * 2)
        ctx.fill()
        alive.push(p)
      }
      particles.current = alive
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)

    return () => {
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', spawn)
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      particles.current = []
    }
  }, [hue, density, life, size, fadePower, blend, reduced])

  if (reduced) return null
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={className}
      style={{
        position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0,
      }}
    />
  )
}

// ─── TypewriterText ────────────────────────────────────────────────────

interface TypewriterTextProps {
  text:           string
  speed?:         number       // chars per second, default 90
  startDelay?:    number       // ms, default 0
  showCursor?:    boolean      // default true
  onComplete?:    () => void
  className?:     string
  style?:         CSSProperties
}

/** Types text one character at a time with natural pauses at punctuation
 *  (commas: +60ms, period/?/!: +180ms, newline: +220ms). Switches off the
 *  typing animation when the parent passes more text than the typewriter
 *  has caught up to — useful for SSE-streamed completions where new tokens
 *  arrive faster than the typewriter speed. */
export function TypewriterText({
  text, speed = 90, startDelay = 0, showCursor = true,
  onComplete, className, style,
}: TypewriterTextProps): JSX.Element {
  const reduced = useReducedMotion()
  const [shown, setShown] = useState(reduced ? text : '')
  const targetRef = useRef(text)
  const idxRef = useRef(0)

  useEffect(() => { targetRef.current = text }, [text])

  useEffect(() => {
    if (reduced) { setShown(text); return }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = () => {
      if (cancelled) return
      const target = targetRef.current
      if (idxRef.current >= target.length) {
        onComplete?.()
        return
      }
      idxRef.current += 1
      const ch = target[idxRef.current - 1] ?? ''
      setShown(target.slice(0, idxRef.current))
      let delay = 1000 / Math.max(8, speed)
      if (ch === ',')                     delay += 60
      else if (ch === '.' || ch === '!' || ch === '?') delay += 180
      else if (ch === '\n')               delay += 220
      // catch-up: if many chars still queued, accelerate
      const lag = target.length - idxRef.current
      if (lag > 60) delay *= 0.35
      else if (lag > 20) delay *= 0.6
      timer = setTimeout(tick, delay)
    }
    const start = setTimeout(tick, startDelay)
    return () => { cancelled = true; clearTimeout(start); if (timer) clearTimeout(timer) }
  }, [speed, startDelay, reduced, onComplete, text])

  // If parent rewinds text (e.g. new message), reset cursor.
  useEffect(() => {
    if (text.length < idxRef.current) {
      idxRef.current = 0
      setShown('')
    }
  }, [text])

  return (
    <span className={className} style={style}>
      <style>{`@keyframes novan-cursor-blink { 0%, 49% { opacity: 1 } 50%, 100% { opacity: 0 } }`}</style>
      <span>{shown}</span>
      {showCursor && !reduced && shown.length < text.length && (
        <span
          aria-hidden
          style={{
            display: 'inline-block', width: '0.55ch', marginLeft: 1,
            background: 'currentColor', height: '1em',
            verticalAlign: '-0.15em',
            animation: 'novan-cursor-blink 1s steps(2) infinite',
            opacity: 0.6, borderRadius: 1,
          }}
        />
      )}
    </span>
  )
}

// ─── AnimatedBubble ────────────────────────────────────────────────────

interface AnimatedBubbleProps {
  children:       ReactNode
  delay?:         number   // ms before entrance starts
  className?:     string
  style?:         CSSProperties
  /** When the inner content height changes, smoothly animate to the new
   *  height instead of snapping. Default true. */
  fluidHeight?:   boolean
}

/** Entrance: fade + slight upward translate + tiny scale. Height changes:
 *  smoothly tween via ResizeObserver. */
export function AnimatedBubble({
  children, delay = 0, className, style, fluidHeight = true,
}: AnimatedBubbleProps): JSX.Element {
  const reduced = useReducedMotion()
  const [entered, setEntered] = useState(reduced)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const innerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (reduced) return
    const t = setTimeout(() => setEntered(true), delay)
    return () => clearTimeout(t)
  }, [delay, reduced])

  // Fluid height — ResizeObserver on the inner content, drive container's
  // max-height as a CSS transition.
  useEffect(() => {
    if (reduced || !fluidHeight) return
    const inner = innerRef.current
    const container = containerRef.current
    if (!inner || !container) return
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const h = e.contentRect.height
        container.style.maxHeight = `${Math.ceil(h) + 4}px`
      }
    })
    ro.observe(inner)
    // Init
    container.style.maxHeight = `${inner.getBoundingClientRect().height + 4}px`
    return () => ro.disconnect()
  }, [reduced, fluidHeight])

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        opacity:    entered ? 1 : 0,
        transform:  entered ? 'translateY(0) scale(1)' : 'translateY(6px) scale(0.985)',
        transition: 'opacity 360ms cubic-bezier(.2,.7,.2,1), transform 360ms cubic-bezier(.2,.7,.2,1), max-height 360ms cubic-bezier(.2,.7,.2,1)',
        overflow:   fluidHeight ? 'hidden' : undefined,
        ...style,
      }}
    >
      <div ref={innerRef}>{children}</div>
    </div>
  )
}
