/**
 * useThemeAndShortcuts — items #22 + #24.
 *
 * - Reads operator_preferences.theme on mount, applies via [data-theme]
 *   attribute. Listens for storage events from other tabs.
 * - Two-key chord navigation (Vim/Gmail-style):
 *     g h  → Strategic Home
 *     g w  → War Room
 *     g m  → Mission Intelligence
 *     g e  → Executive War Room
 *     g c  → Company Operations
 *     g a  → Approvals
 *     g i  → Incidents
 *     ?   → cheatsheet (no UI yet — logs to console)
 *     t   → toggle theme
 *   Triggers only when no input/textarea/contenteditable focused.
 */
import { useEffect, useRef } from 'react'
import { useNavigate }       from 'react-router-dom'

const SHORTCUTS: Record<string, string> = {
  h: '/strategic-home',
  w: '/war-room',
  m: '/mission-intelligence',
  e: '/executive-war-room',
  c: '/company-operations',
  a: '/approvals',
  i: '/incidents',
}

const THEME_KEY = 'novan:theme'

function applyTheme(theme: 'dark' | 'light') {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', theme)
  }
}

export function useThemeAndShortcuts(): void {
  const navigate = useNavigate()
  const prefixRef = useRef<{ key: string; expiresAt: number } | null>(null)

  // Theme apply on mount + on storage changes
  useEffect(() => {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(THEME_KEY) : null
    applyTheme((stored as 'dark' | 'light') ?? 'dark')
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_KEY && e.newValue) applyTheme(e.newValue as 'dark' | 'light')
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // Keyboard shortcuts
  useEffect(() => {
    const isInputFocused = () => {
      const a = document.activeElement
      if (!a) return false
      const tag = a.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || (a as HTMLElement).isContentEditable
    }

    const handler = (e: KeyboardEvent) => {
      if (isInputFocused()) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      // Theme toggle (single key)
      if (e.key === 't' && !prefixRef.current) {
        const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
        const next: 'dark' | 'light' = cur === 'light' ? 'dark' : 'light'
        applyTheme(next)
        localStorage.setItem(THEME_KEY, next)
        return
      }

      // Cheatsheet
      if (e.key === '?') {
        // eslint-disable-next-line no-console
        console.log('Novan shortcuts: g+h home, g+w war-room, g+m missions, g+e exec, g+c company, g+a approvals, g+i incidents, t toggle theme')
        return
      }

      // Chord: g <key>
      const now = Date.now()
      const prefix = prefixRef.current
      if (e.key === 'g') {
        prefixRef.current = { key: 'g', expiresAt: now + 1500 }
        return
      }
      if (prefix && prefix.key === 'g' && prefix.expiresAt > now) {
        const path = SHORTCUTS[e.key.toLowerCase()]
        prefixRef.current = null
        if (path) {
          e.preventDefault()
          navigate(path)
        }
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [navigate])
}

/** Imperative theme setter — usable from buttons. */
export function setTheme(theme: 'dark' | 'light'): void {
  applyTheme(theme)
  localStorage.setItem(THEME_KEY, theme)
}

/** Read current theme. */
export function currentTheme(): 'dark' | 'light' {
  if (typeof document === 'undefined') return 'dark'
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
}
