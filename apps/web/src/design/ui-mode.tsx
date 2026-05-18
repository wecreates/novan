/**
 * ui-mode.tsx — Operator-selectable UI modes.
 *
 * Each mode shifts visual emphasis without changing data:
 *   focus     — minimal chrome, everything else dimmed
 *   executive — strategy-first, costs/horizons emphasized
 *   security  — incidents/kill-switches emphasized
 *   creative  — design concepts / image studio emphasized
 *   runtime   — fabric/workers/queues emphasized
 *   mission   — workflows/horizons/proposals emphasized
 *
 * Applied as a class on <body>: ui-mode-{name}. CSS selectors can
 * scope visual de-emphasis to non-active systems.
 */
import React, { createContext, useContext, useEffect, useState } from 'react'

export type UIMode = 'focus' | 'executive' | 'security' | 'creative' | 'runtime' | 'mission'

export const UI_MODES: Array<{ id: UIMode; label: string; accent: string; emphasis: string[] }> = [
  { id: 'focus',     label: 'Focus',     accent: '#a1a3ab', emphasis: [] },
  { id: 'executive', label: 'Executive', accent: '#67e8f9', emphasis: ['executive_loop', 'commerce', 'governance', 'simulation'] },
  { id: 'security',  label: 'Security',  accent: '#ef4444', emphasis: ['security', 'governance', 'war_room'] },
  { id: 'creative',  label: 'Creative',  accent: '#34d399', emphasis: ['image_studio', 'commerce', 'research'] },
  { id: 'runtime',   label: 'Runtime',   accent: '#f59e0b', emphasis: ['runtime', 'infrastructure', 'agents'] },
  { id: 'mission',   label: 'Mission',   accent: '#67e8f9', emphasis: ['executive_loop', 'war_room', 'learning'] },
]

interface UIModeCtx {
  mode: UIMode
  setMode: (m: UIMode) => void
  emphasis: string[]
}

const Ctx = createContext<UIModeCtx | null>(null)

export function UIModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<UIMode>(() => {
    if (typeof window === 'undefined') return 'focus'
    return (localStorage.getItem('novan.ui-mode') as UIMode) ?? 'focus'
  })
  const setMode = (m: UIMode) => {
    setModeState(m)
    if (typeof window !== 'undefined') localStorage.setItem('novan.ui-mode', m)
  }
  useEffect(() => {
    // Apply as body class for CSS hooks
    if (typeof document === 'undefined') return
    const cls = document.body.classList
    UI_MODES.forEach(m => cls.remove(`ui-mode-${m.id}`))
    cls.add(`ui-mode-${mode}`)
  }, [mode])
  const emphasis = UI_MODES.find(m => m.id === mode)?.emphasis ?? []
  return <Ctx.Provider value={{ mode, setMode, emphasis }}>{children}</Ctx.Provider>
}

export function useUIMode(): UIModeCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useUIMode must be used inside UIModeProvider')
  return v
}
