/**
 * R146.326 — Minimal main page.
 *
 * One thing on screen: the ask box. Everything else lives behind a single
 * dropdown at the top-right. No sidebars, no metrics, no chrome.
 *
 * Layout principles:
 *   - Centered greeting + ask box, vertically balanced.
 *   - Top-right dropdown menu = "everything else" (chat history, brain,
 *     studios, settings, accounts).
 *   - Cmd/Ctrl-K opens the same dropdown as palette.
 *   - Submit hands off to the chat session — same backend as the full UI.
 */
import React, { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, ArrowRight } from 'lucide-react'

interface NavGroup {
  label: string
  items: Array<{ label: string; to: string; hint?: string }>
}

const NAV: NavGroup[] = [
  { label: 'Talk', items: [
    { label: 'Chat',          to: '/chat',     hint: 'main conversation' },
    { label: 'Voice',         to: '/voice',    hint: 'speak with Novan' },
    { label: 'Briefing',      to: '/briefings', hint: 'today\'s summary' },
  ]},
  { label: 'Brain', items: [
    { label: 'Brain Health',  to: '/brain',           hint: 'what\'s alive' },
    { label: 'Memory',        to: '/memory-browser',  hint: 'long-term recall' },
    { label: 'Capabilities',  to: '/capabilities',    hint: 'what Novan can do' },
    { label: 'Skills',        to: '/skills',          hint: 'learned operations' },
    { label: 'Insights',      to: '/insights',        hint: 'recent learnings' },
  ]},
  { label: 'Build', items: [
    { label: 'Image Studio',  to: '/images',          hint: 'generate visuals' },
    { label: 'Video Studio',  to: '/ai-video-studio', hint: 'short-form video' },
    { label: 'Music Studio',  to: '/music-studio',    hint: 'audio + songs' },
    { label: 'Workflows',     to: '/workflows',       hint: 'recurring jobs' },
    { label: 'Templates',     to: '/templates',       hint: 'reusable recipes' },
  ]},
  { label: 'Run', items: [
    { label: 'Schedule',      to: '/scheduler',       hint: 'production cadence' },
    { label: 'Businesses',    to: '/businesses',      hint: 'portfolio' },
    { label: 'Approvals',     to: '/approvals',       hint: 'pending decisions' },
    { label: 'Risks',         to: '/risks',           hint: 'open risks' },
    { label: 'Goals',         to: '/goals',           hint: 'strategic targets' },
  ]},
  { label: 'Tune', items: [
    { label: 'Settings',      to: '/account',         hint: 'preferences' },
    { label: 'Connectors',    to: '/connectors',      hint: 'wire external services' },
    { label: 'Persona',       to: '/persona',         hint: 'voice + tone' },
    { label: 'Cost Governor', to: '/cost-governor',   hint: 'spending limits' },
    { label: 'Audit Trail',   to: '/audit',           hint: 'what happened' },
  ]},
]

function greeting(): string {
  const h = new Date().getHours()
  if (h < 5)  return 'Late night'
  if (h < 12) return 'Morning'
  if (h < 17) return 'Afternoon'
  if (h < 22) return 'Evening'
  return 'Late'
}

export default function MainPage(): JSX.Element {
  const nav = useNavigate()
  const [openMenu, setOpenMenu] = useState(false)
  const [ask, setAsk] = useState('')
  const askRef = useRef<HTMLTextAreaElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    askRef.current?.focus()
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setOpenMenu(v => !v)
      }
      if (e.key === 'Escape') setOpenMenu(false)
    }
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpenMenu(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [])

  function submit() {
    const v = ask.trim()
    if (!v) return
    // Hand the message to the conversational hub. Stash in sessionStorage
    // so the receiving page can pre-fill without exposing the message in
    // the URL bar. Routes to /today which is the canonical chat surface.
    try { sessionStorage.setItem('novan.prefill', v) } catch { /* */ }
    nav(`/today?prefill=1`)
  }

  return (
    <div className="min-h-screen flex flex-col bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
      {/* Top-right dropdown — the only chrome */}
      <header className="flex justify-end items-center p-4">
        <div ref={menuRef} className="relative">
          <button
            onClick={() => setOpenMenu(v => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-900 transition"
            aria-expanded={openMenu}
          >
            Menu
            <ChevronDown size={14} className={`transition ${openMenu ? 'rotate-180' : ''}`} />
          </button>
          {openMenu && (
            <div className="absolute right-0 top-full mt-1 w-[20rem] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg p-2 z-50">
              {NAV.map(group => (
                <div key={group.label} className="mb-2 last:mb-0">
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{group.label}</div>
                  {group.items.map(it => (
                    <button
                      key={it.to}
                      onClick={() => { setOpenMenu(false); nav(it.to) }}
                      className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 flex justify-between items-center"
                    >
                      <span>{it.label}</span>
                      {it.hint && <span className="text-[11px] text-zinc-400 dark:text-zinc-500">{it.hint}</span>}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </header>

      {/* The whole point: greeting + ask box */}
      <main className="flex-1 flex items-center justify-center px-4">
        <div className="w-full max-w-2xl">
          <h1 className="text-2xl font-light text-zinc-500 dark:text-zinc-400 mb-6 text-center">
            {greeting()}.
          </h1>
          <div className="relative">
            <textarea
              ref={askRef}
              rows={3}
              value={ask}
              onChange={e => setAsk(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
              }}
              placeholder="What needs doing?"
              className="w-full px-5 py-4 pr-14 text-base bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl resize-none focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 placeholder:text-zinc-400"
            />
            <button
              onClick={submit}
              disabled={!ask.trim()}
              className="absolute right-3 bottom-3 p-2 rounded-full bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-90 transition"
              aria-label="Send"
            >
              <ArrowRight size={16} />
            </button>
          </div>
          <div className="mt-3 text-center text-xs text-zinc-400 dark:text-zinc-500">
            ⌘K opens the menu · Enter sends · Shift+Enter for newline
          </div>
        </div>
      </main>

      <footer className="p-4 text-center text-[10px] text-zinc-300 dark:text-zinc-700">
        Novan
      </footer>
    </div>
  )
}
