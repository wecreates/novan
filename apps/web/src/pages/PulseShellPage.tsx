/**
 * PulseShellPage — R146.114 — Pulse-style operating shell.
 *
 * Inspired by the kzzy47 / Pulse Instagram reels. Single full-bleed dark
 * canvas with a macOS-app-style top toolbar:
 *
 *   [PULSE logo | KRONOS ▾]   [1] AGENTS  [2] BRAIN  [3] DECK  [4] TEAM  [5] USAGE
 *                                                          MRR · LEADS · TASKS · UPTIME
 *
 * Tabs:
 *   [1] AGENTS — node graph of every business / agent / system
 *   [2] BRAIN  — 3D neural-region visualization with firing rates
 *   [3] DECK   — placeholder (operator can build out)
 *   [4] TEAM   — placeholder
 *   [5] USAGE  — placeholder
 *
 * Keyboard 1..5 switches tabs. Stats pull from /api/v1/brain/stats and
 * /api/v1/portfolio/stats. Falls back to dashes when offline.
 *
 * The intro Kronos landing (gold) shows once per session — press SPACE
 * or click to dismiss.
 */
import { useEffect, useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Suspense, lazy } from 'react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'
import { KronosBrain } from '../components/KronosBrain.js'
import { NeuralBrainView } from '../components/NeuralBrainView.js'
import { WarRoomView } from '../components/WarRoomView.js'

// Lazy-load the existing 3D scene for the (now optional) graph subview
const BrainHomePage = lazy(() => import('./BrainHomePage.js'))

type Tab = 'AGENTS' | 'BRAIN' | 'DECK' | 'TEAM' | 'USAGE'
const TABS: Array<{ key: Tab; idx: number }> = [
  { key: 'AGENTS', idx: 1 },
  { key: 'BRAIN',  idx: 2 },
  { key: 'DECK',   idx: 3 },
  { key: 'TEAM',   idx: 4 },
  { key: 'USAGE',  idx: 5 },
]

const SESSION_INTRO_KEY = 'novan-pulse-intro-shown'

interface PulseStats {
  mrr?:    number
  leads?:  number
  tasks?:  number
  uptime?: string
}

function useUptime(): string {
  const [now, setNow] = useState(() => Date.now())
  const [bootMs] = useState(() => {
    const v = sessionStorage.getItem('novan-pulse-boot')
    if (v) return parseInt(v, 10)
    const t = Date.now()
    sessionStorage.setItem('novan-pulse-boot', String(t))
    return t
  })
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const sec = Math.max(0, Math.floor((now - bootMs) / 1000))
  const h = Math.floor(sec / 3600).toString().padStart(2, '0')
  const m = Math.floor((sec % 3600) / 60).toString().padStart(2, '0')
  const s = (sec % 60).toString().padStart(2, '0')
  return `+${h}:${m}:${s}`
}

function StatChip({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
      padding: '4px 10px',
      borderLeft: '1px solid rgba(255,255,255,0.08)',
      fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace',
    }}>
      <span style={{ fontSize: 9, letterSpacing: '0.18em', color: 'rgba(255,255,255,0.45)' }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 700, color, letterSpacing: '0.04em' }}>{value}</span>
    </div>
  )
}

export default function PulseShellPage(): JSX.Element {
  const { workspaceId } = useWorkspace()
  const [tab, setTab] = useState<Tab>('AGENTS')
  const [introShown, setIntroShown] = useState(() => {
    try { return sessionStorage.getItem(SESSION_INTRO_KEY) === '1' } catch { return false }
  })
  const uptime = useUptime()

  // Pull live stats. All best-effort — falls back to dashes.
  const stats = useQuery({
    queryKey: ['pulse-stats', workspaceId],
    queryFn: async (): Promise<PulseStats> => {
      const out: PulseStats = {}
      try {
        const r = await api.get<{ data: { totalMonthlyRevenueUsd?: number; totalLeads?: number; activeTasks?: number } }>(
          `/api/v1/portfolio/stats?workspace_id=${workspaceId}`,
        )
        if (typeof r.data.totalMonthlyRevenueUsd === 'number') out.mrr   = r.data.totalMonthlyRevenueUsd
        if (typeof r.data.totalLeads             === 'number') out.leads = r.data.totalLeads
        if (typeof r.data.activeTasks            === 'number') out.tasks = r.data.activeTasks
      } catch { /* ignore */ }
      return out
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })

  // Keyboard shortcuts 1..5
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const idx = parseInt(e.key, 10)
      if (idx >= 1 && idx <= 5) {
        const found = TABS.find(t => t.idx === idx)
        if (found) setTab(found.key)
      }
    }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [])

  const dismissIntro = () => {
    setIntroShown(true)
    try { sessionStorage.setItem(SESSION_INTRO_KEY, '1') } catch { /* noop */ }
  }

  const mrr   = stats.data?.mrr   !== undefined ? `$${stats.data.mrr.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '—'
  const leads = stats.data?.leads !== undefined ? stats.data.leads.toLocaleString() : '—'
  const tasks = stats.data?.tasks !== undefined ? stats.data.tasks.toLocaleString() : '—'

  const tabContent = useMemo(() => {
    if (tab === 'BRAIN') return <NeuralBrainView brandName="NOVAN" />
    if (tab === 'AGENTS') return <WarRoomView />
    if (tab === 'DECK')  return (
      <Suspense fallback={<CenteredText>loading 3D graph…</CenteredText>}>
        <BrainHomePage />
      </Suspense>
    )
    if (tab === 'TEAM')  return <PlaceholderTab name="TEAM"  hint="Agent team roster — coming soon" />
    if (tab === 'USAGE') return <PlaceholderTab name="USAGE" hint="Token, cost & quota dashboards — coming soon" />
    return null
  }, [tab])

  return (
    <div style={{
      position: 'relative',
      width: '100%', height: '100%',
      background: '#000',
      color: 'rgba(255,255,255,0.9)',
      fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace',
      overflow: 'hidden',
    }}>
      {/* INTRO — gold KRONOS landing */}
      {!introShown && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 100 }}>
          <KronosBrain
            label="NOVAN"
            subLabel="PULSE · KRONOS"
            hint="SPACE to enter"
            hue={38}                  // gold/amber to match Pulse
            onEnter={dismissIntro}
          />
        </div>
      )}

      {/* Top toolbar */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, zIndex: 30,
        height: 44,
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '0 14px',
        background: 'rgba(8,8,12,0.85)', backdropFilter: 'blur(8px)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{
            width: 16, height: 16, borderRadius: 8,
            background: 'radial-gradient(circle at 30% 30%, #ffd47a 0%, #b87900 60%, #6b3e00 100%)',
            boxShadow: '0 0 8px #ffaa3380',
          }} />
          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.28em', color: '#ffd47a' }}>NOVAN</span>
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginLeft: 4 }}>· KRONOS ▾</span>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 14, marginLeft: 18 }}>
          {TABS.map(t => {
            const active = tab === t.key
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                style={{
                  display: 'flex', alignItems: 'baseline', gap: 4,
                  padding: '4px 4px 5px',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: active ? '2px solid #ffd47a' : '2px solid transparent',
                  color: active ? '#ffd47a' : 'rgba(255,255,255,0.55)',
                  fontFamily: 'inherit', fontSize: 12,
                  letterSpacing: '0.12em', cursor: 'pointer',
                }}
              >
                <span style={{ opacity: 0.6 }}>[{t.idx}]</span>
                <span>{t.key}</span>
              </button>
            )
          })}
        </div>

        {/* Stats — right side */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
          <StatChip label="MRR"    value={mrr}    color="#ffd47a" />
          <StatChip label="LEADS"  value={leads}  color="#7adfff" />
          <StatChip label="TASKS"  value={tasks}  color="#c2ff6a" />
          <StatChip label="UPTIME" value={uptime} color="rgba(255,255,255,0.85)" />
        </div>
      </div>

      {/* Tab content fills below the toolbar */}
      <div style={{ position: 'absolute', top: 44, left: 0, right: 0, bottom: 0 }}>
        {tabContent}
      </div>
    </div>
  )
}

// ─── Helpers ───────────────────────────────────────────────────────────

function CenteredText({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'rgba(255,255,255,0.4)', fontSize: 12, letterSpacing: '0.2em',
    }}>{children}</div>
  )
}

function PlaceholderTab({ name, hint }: { name: string; hint: string }) {
  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      background: '#000',
      color: 'rgba(255,255,255,0.5)',
      gap: 6,
    }}>
      <div style={{ fontSize: 14, letterSpacing: '0.3em', color: '#ffd47a' }}>{name}</div>
      <div style={{ fontSize: 11, letterSpacing: '0.1em', opacity: 0.6 }}>{hint}</div>
    </div>
  )
}
