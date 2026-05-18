/**
 * tokens.ts — JS-accessible mirror of the CSS design tokens.
 *
 * Single source of truth for component code that needs the raw values
 * (e.g. R3F materials, SVG strokes, recharts theming). Tailwind classes
 * remain the preferred surface for component markup.
 */

export const COLOR = {
  // surfaces
  void:      '#050507',
  bg:        '#08090b',
  surface:   '#0d0e12',
  elevated:  '#14161c',
  // text
  textPrimary:   '#e6e7eb',
  textSecondary: '#a1a3ab',
  textMuted:     '#5d6068',
  textFaint:     '#3a3c43',
  // operational accents
  healthy:  '#34d399',
  active:   '#67e8f9',
  warning:  '#f59e0b',
  critical: '#ef4444',
  paused:   '#a78bfa',
  info:     '#94a3b8',
} as const

export const STATUS_COLOR: Record<string, string> = {
  healthy:  COLOR.healthy,
  active:   COLOR.active,
  degraded: COLOR.warning,
  warning:  COLOR.warning,
  down:     COLOR.critical,
  critical: COLOR.critical,
  paused:   COLOR.paused,
  pending:  COLOR.info,
  unknown:  COLOR.textMuted,
}

export const STATUS_PILL: Record<string, string> = {
  healthy:  'pill pill-healthy',
  active:   'pill pill-active',
  degraded: 'pill pill-warning',
  warning:  'pill pill-warning',
  down:     'pill pill-critical',
  critical: 'pill pill-critical',
  paused:   'pill pill-paused',
  pending:  'pill pill-muted',
  unknown:  'pill pill-muted',
}

export const STATUS_DOT: Record<string, string> = {
  healthy:  'dot dot-healthy',
  active:   'dot dot-active',
  degraded: 'dot dot-warning',
  warning:  'dot dot-warning',
  down:     'dot dot-critical',
  critical: 'dot dot-critical',
  paused:   'dot dot-paused',
  pending:  'dot dot-muted',
  unknown:  'dot dot-muted',
}

export const MOTION = {
  easeOut:   'cubic-bezier(0.22, 1, 0.36, 1)',
  easeInOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
  spring:    'cubic-bezier(0.34, 1.56, 0.64, 1)',
  durFast:   120,
  durBase:   200,
  durSlow:   400,
  durCamera: 800,
} as const

export const Z = {
  universe: 0,
  orbit:    10,
  overlay:  20,
  drawer:   30,
  dropdown: 40,
  modal:    50,
  command:  60,
} as const
