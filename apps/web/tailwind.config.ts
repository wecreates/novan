import type { Config } from 'tailwindcss'

/**
 * Tailwind config — extends the design tokens declared as CSS vars in
 * src/index.css. JS-side classes should prefer named tokens here over
 * raw hex values; raw hex in components is a smell.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        void:      'var(--void)',
        bg:        'var(--bg-primary)',
        surface:   'var(--bg-surface)',
        elevated:  'var(--bg-elevated)',
        border:    'var(--border)',
        primary:   'var(--text-primary)',
        secondary: 'var(--text-secondary)',
        muted:     'var(--text-muted)',
        faint:     'var(--text-faint)',
        healthy:   'var(--accent-healthy)',
        active:    'var(--accent-active)',
        warning:   'var(--accent-warning)',
        critical:  'var(--accent-critical)',
        paused:    'var(--accent-paused)',
      },
      fontFamily: {
        sans: ['Inter', 'SF Pro Display', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['10px', { lineHeight: '14px', letterSpacing: '0.02em' }],
        xs:    ['11px', { lineHeight: '16px' }],
        sm:    ['13px', { lineHeight: '18px' }],
      },
      boxShadow: {
        1: 'var(--shadow-1)',
        2: 'var(--shadow-2)',
        3: 'var(--shadow-3)',
        4: 'var(--shadow-4)',
        'glow-healthy':  'var(--glow-healthy)',
        'glow-warning':  'var(--glow-warning)',
        'glow-critical': 'var(--glow-critical)',
      },
      transitionTimingFunction: {
        'out':    'cubic-bezier(0.22, 1, 0.36, 1)',
        'in-out': 'cubic-bezier(0.65, 0, 0.35, 1)',
        'spring': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
      transitionDuration: {
        fast: '120ms',
        slow: '400ms',
        camera: '800ms',
      },
      zIndex: {
        universe: '0',
        orbit:    '10',
        overlay:  '20',
        drawer:   '30',
        dropdown: '40',
        modal:    '50',
        command:  '60',
      },
      animation: {
        'pulse-slow':   'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'pulse-active': 'soft-pulse 2.4s cubic-bezier(0.65, 0, 0.35, 1) infinite',
      },
    },
  },
  plugins: [],
} satisfies Config
