/**
 * theme.ts — persisted theme overrides.
 *
 * Each token maps to a CSS custom property on :root. Overrides are
 * stored in localStorage and applied on mount + on change. Operators
 * can reset a single token or the whole theme.
 *
 * Honest scope: this only customizes color tokens. Type scale, motion,
 * and spacing stay system-controlled — they're load-bearing for the
 * design system's consistency.
 */

export interface ThemeToken {
  /** CSS variable name (without the leading --). */
  id:       string
  /** Human label shown in the editor. */
  label:    string
  /** Short hint about where this color shows up. */
  hint:     string
  /** Group for the editor's section headers. */
  group:    'Surfaces' | 'Text' | 'Brand & Accents' | 'Borders'
  /** Default value (mirrors index.css :root). */
  default:  string
}

export const THEME_TOKENS: ThemeToken[] = [
  // Surfaces
  { id: 'bg-primary',  label: 'Page',       hint: 'App background behind every page',     group: 'Surfaces', default: '#060608' },
  { id: 'bg-surface',  label: 'Panel',      hint: 'Cards, sidebar, header surface',       group: 'Surfaces', default: '#0A0A0E' },
  { id: 'bg-elevated', label: 'Elevated',   hint: 'Dropdowns, drawers, active tile bg',   group: 'Surfaces', default: '#131319' },

  // Text
  { id: 'text-primary',   label: 'Primary',   hint: 'Headings, body copy',                group: 'Text', default: '#e6e7eb' },
  { id: 'text-secondary', label: 'Secondary', hint: 'Labels, captions, hover state text', group: 'Text', default: '#a1a3ab' },
  { id: 'text-muted',     label: 'Muted',     hint: 'Hints, placeholders, meta',          group: 'Text', default: '#5d6068' },

  // Accents
  { id: 'accent-active',   label: 'Brand',    hint: 'Selection, focus, active nav state', group: 'Brand & Accents', default: '#8B7CFF' },
  { id: 'accent-healthy',  label: 'Healthy',  hint: 'Online dots, success states',        group: 'Brand & Accents', default: '#34d399' },
  { id: 'accent-warning',  label: 'Warning',  hint: 'Degraded, slow, attention',          group: 'Brand & Accents', default: '#f59e0b' },
  { id: 'accent-critical', label: 'Critical', hint: 'Errors, failures, kill switches',    group: 'Brand & Accents', default: '#ef4444' },

  // Borders
  { id: 'border',         label: 'Hairline', hint: 'Subtle separators between panels',    group: 'Borders', default: 'rgba(255,255,255,0.06)' },
  { id: 'border-strong',  label: 'Active',   hint: 'Focused / hovered borders',           group: 'Borders', default: 'rgba(255,255,255,0.12)' },
]

const STORAGE_KEY = 'novan:theme-overrides'

export type ThemeOverrides = Partial<Record<string, string>>

export function loadOverrides(): ThemeOverrides {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as ThemeOverrides
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch { return {} }
}

export function saveOverrides(o: ThemeOverrides): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(o)) } catch {}
}

/** Apply overrides to the document root. Safe to call repeatedly. */
export function applyOverrides(o: ThemeOverrides): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  // Clear any previously-applied overrides not in the new map
  for (const t of THEME_TOKENS) {
    if (o[t.id] !== undefined) root.style.setProperty(`--${t.id}`, o[t.id] as string)
    else                       root.style.removeProperty(`--${t.id}`)
  }
}

/** One-shot: read storage and apply. Called once at app boot. */
export function initTheme(): void {
  applyOverrides(loadOverrides())
}
