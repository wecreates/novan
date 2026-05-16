/**
 * UI System — shared design tokens and primitive components.
 * Consumed by apps/web and apps/admin.
 */
export { clsx } from 'clsx'

// ─── Design tokens ────────────────────────────────────────────────────────────

export const tokens = {
  colors: {
    bg:       { primary: '#0a0a0f', surface: '#111118', elevated: '#1a1a24' },
    border:   '#22222e',
    text:     { primary: '#f0f0f8', secondary: '#8888aa', muted: '#44445a' },
    accent:   { blue: '#3b82f6', green: '#10b981', yellow: '#f59e0b', orange: '#f97316', red: '#ef4444' },
  },
  radius:  { sm: '6px', md: '8px', lg: '12px', xl: '16px' },
  spacing: { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 6: '24px', 8: '32px' },
} as const

// ─── Type helpers ─────────────────────────────────────────────────────────────

export type StatusLevel = 'green' | 'yellow' | 'orange' | 'red'
export type Size        = 'xs' | 'sm' | 'md' | 'lg'
