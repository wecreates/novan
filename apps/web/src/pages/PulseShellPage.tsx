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
import { api, API_BASE as BASE } from '../api.js'
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

  const [cmdOpen, setCmdOpen] = useState(false)

  // Keyboard shortcuts 1..5, plus Cmd/Ctrl+K for command bar
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCmdOpen(v => !v)
        return
      }
      if (e.key === 'Escape') { setCmdOpen(false); return }
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
    if (tab === 'TEAM')  return <TeamTab />
    if (tab === 'USAGE') return <UsageTab />
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

      {/* R146.120 — Command Bar (Cmd/Ctrl+K) */}
      {cmdOpen && <CommandBar onClose={() => setCmdOpen(false)} />}
    </div>
  )
}

// ─── R146.120 — Command Bar ────────────────────────────────────────────

interface IntentResult {
  category: string
  summary: string
  suggestedOps: string[]
  requiresApproval: boolean
  nextStep: string
}

function CommandBar({ onClose }: { onClose: () => void }): JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<IntentResult | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [runResult, setRunResult] = useState<string | null>(null)

  const classify = async () => {
    if (!prompt.trim()) return
    setBusy(true); setResult(null); setRunResult(null)
    try {
      const r = await fetch(`${BASE}/api/brain/op`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'novan.classifyIntent', params: { prompt } }),
        credentials: 'include',
      })
      const d = await r.json() as { result?: IntentResult }
      if (d.result) setResult(d.result)
    } catch (e) { setRunResult(`error: ${(e as Error).message}`) }
    finally { setBusy(false) }
  }

  const runOp = async (op: string) => {
    setRunning(op); setRunResult(null)
    try {
      const r = await fetch(`${BASE}/api/brain/op`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op, params: {} }),
        credentials: 'include',
      })
      const d = await r.json() as { result?: unknown; error?: string }
      setRunResult(d.error ?? JSON.stringify(d.result, null, 2).slice(0, 600))
    } catch (e) { setRunResult(`error: ${(e as Error).message}`) }
    finally { setRunning(null) }
  }

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ margin: '80px auto 0', maxWidth: 720, background: '#0a0a0e', border: '1px solid rgba(255,212,122,0.25)', borderRadius: 10, padding: 18, color: 'rgba(255,255,255,0.9)', fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace' }}>
        <div style={{ fontSize: 10, letterSpacing: '0.2em', opacity: 0.6, marginBottom: 8 }}>NOVAN · TELL ME WHAT TO DO</div>
        <input autoFocus value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void classify() }}
          placeholder="e.g. add a viral score badge to clips, post the latest reel, refresh ig tokens…"
          style={{ width: '100%', padding: '10px 12px', background: '#000', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, color: '#fff', fontFamily: 'inherit', fontSize: 13, outline: 'none' }} />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button onClick={() => void classify()} disabled={busy || !prompt.trim()} style={btnStyle(busy)}>{busy ? 'thinking…' : 'classify (↵)'}</button>
          <button onClick={onClose} style={btnStyle(false, true)}>cancel (esc)</button>
        </div>

        {result && (
          <div style={{ marginTop: 14, padding: 12, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6 }}>
            <div style={{ fontSize: 10, letterSpacing: '0.18em', color: '#ffd47a', marginBottom: 6 }}>{result.category.toUpperCase()}{result.requiresApproval ? ' · APPROVAL REQUIRED' : ''}</div>
            <div style={{ fontSize: 12, opacity: 0.9 }}>{result.summary}</div>
            <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>{result.nextStep}</div>
            {result.suggestedOps.length > 0 && (
              <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {result.suggestedOps.map(op => (
                  <button key={op} onClick={() => void runOp(op)} disabled={running !== null} style={opChipStyle(running === op)}>
                    {running === op ? '…' : '▸'} {op}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {runResult && (
          <pre style={{ marginTop: 12, padding: 10, fontSize: 11, background: '#000', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap', color: 'rgba(122,223,255,0.9)' }}>{runResult}</pre>
        )}
      </div>
    </div>
  )
}

function btnStyle(busy: boolean, secondary = false): React.CSSProperties {
  return {
    padding: '6px 14px', background: secondary ? 'transparent' : '#ffd47a', color: secondary ? 'rgba(255,255,255,0.6)' : '#000',
    border: secondary ? '1px solid rgba(255,255,255,0.12)' : 'none', borderRadius: 5,
    fontFamily: 'inherit', fontSize: 11, letterSpacing: '0.08em', cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1,
  }
}
function opChipStyle(active: boolean): React.CSSProperties {
  return {
    padding: '4px 10px', background: active ? '#ffd47a' : 'rgba(255,212,122,0.1)', color: active ? '#000' : '#ffd47a',
    border: '1px solid rgba(255,212,122,0.3)', borderRadius: 4,
    fontFamily: 'inherit', fontSize: 10, letterSpacing: '0.06em', cursor: 'pointer',
  }
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

// ─── TEAM tab — org chart from agent roster ────────────────────────────

interface OrgAgent { id: string; shortName: string; role: string; avatarHue: number; status: string; currentTask?: string | null }
function TeamTab(): JSX.Element {
  const [data, setData] = useState<{ ceo: OrgAgent | null; reports: OrgAgent[]; total: number } | null>(null)
  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch(`${BASE}/api/brain/op`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'team.orgChart', params: {} }), credentials: 'include' })
        if (r.ok) {
          const d = await r.json() as { result?: { ceo: OrgAgent | null; reports: OrgAgent[]; total: number } }
          if (d.result) setData(d.result)
        }
      } catch { /* noop */ }
    })()
  }, [])
  if (!data) return <CenteredText>loading team…</CenteredText>
  return (
    <div style={{ padding: 32, color: 'rgba(255,255,255,0.9)', fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace', height: '100%', overflow: 'auto', background: '#000' }}>
      <h1 style={{ color: '#ffd47a', fontSize: 18, fontWeight: 600, letterSpacing: '0.18em', margin: 0 }}>ORG CHART · {data.total} AGENTS</h1>
      {data.ceo && (
        <div style={{ marginTop: 32, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <OrgNode a={data.ceo} large />
          <div style={{ width: 1, height: 32, background: 'rgba(255,255,255,0.15)' }} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, justifyContent: 'center', maxWidth: 1000 }}>
            {data.reports.map(r => <OrgNode key={r.id} a={r} />)}
          </div>
        </div>
      )}
    </div>
  )
}

function OrgNode({ a, large }: { a: OrgAgent; large?: boolean }) {
  const color = `hsl(${a.avatarHue}, 70%, 60%)`
  return (
    <div style={{ width: large ? 200 : 156, padding: 12, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, textAlign: 'center', position: 'relative' }}>
      <div style={{ width: large ? 56 : 40, height: large ? 56 : 40, borderRadius: '50%', background: `linear-gradient(135deg, ${color}, hsl(${a.avatarHue + 30}, 60%, 30%))`, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: large ? 20 : 14, fontWeight: 700, color: '#000', boxShadow: `0 0 12px ${color}66` }}>
        {a.shortName[0]}
      </div>
      <div style={{ marginTop: 8, fontSize: large ? 14 : 12, fontWeight: 600 }}>{a.shortName}</div>
      <div style={{ fontSize: 9, opacity: 0.5, letterSpacing: '0.08em', marginTop: 4 }}>{a.role}</div>
      <div style={{ marginTop: 6, fontSize: 9, opacity: 0.65, minHeight: 12 }}>{a.currentTask || '—'}</div>
      <div style={{ position: 'absolute', top: 8, right: 8, width: 6, height: 6, borderRadius: 3, background: a.status === 'live' ? '#22c55e' : '#525252' }} />
    </div>
  )
}

// ─── USAGE tab — real ai_usage data ────────────────────────────────────

interface UsageData {
  totals: { calls: number; tokens: number; costUsd: number }
  byProvider: Array<{ provider: string; calls: number; tokens: number; costUsd: number }>
  byHour: Array<{ hour: number; calls: number; tokens: number; costUsd: number }>
}
function UsageTab(): JSX.Element {
  const [data, setData] = useState<UsageData | null>(null)
  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch(`${BASE}/api/brain/op`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'usage.buckets', params: { windowHours: 168 } }), credentials: 'include' })
        if (r.ok) {
          const d = await r.json() as { result?: UsageData }
          if (d.result) setData(d.result)
        }
      } catch { /* noop */ }
    })()
  }, [])
  if (!data) return <CenteredText>loading usage…</CenteredText>
  // Build cost sparkline
  const maxHourCost = Math.max(0.0001, ...data.byHour.map(h => h.costUsd))
  return (
    <div style={{ padding: 32, color: 'rgba(255,255,255,0.9)', fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace', height: '100%', overflow: 'auto', background: '#000' }}>
      <h1 style={{ color: '#ffd47a', fontSize: 18, fontWeight: 600, letterSpacing: '0.18em', margin: 0 }}>USAGE · LAST 7 DAYS</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginTop: 16 }}>
        <Stat label="LLM CALLS"  value={data.totals.calls.toLocaleString()}     accent="#7adfff" />
        <Stat label="TOKENS"     value={fmtTokens(data.totals.tokens)}          accent="#c2ff6a" />
        <Stat label="COST"       value={`$${data.totals.costUsd.toFixed(2)}`}  accent="#ffd47a" />
      </div>

      {data.byHour.length > 1 && (
        <div style={{ marginTop: 24, padding: 12, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6 }}>
          <div style={{ fontSize: 10, opacity: 0.5, letterSpacing: '0.18em', marginBottom: 8 }}>COST · HOURLY</div>
          <svg width="100%" height="80" viewBox={`0 0 ${data.byHour.length * 6} 80`} preserveAspectRatio="none">
            {data.byHour.map((h, i) => {
              const barH = (h.costUsd / maxHourCost) * 70
              return <rect key={h.hour} x={i * 6} y={80 - barH} width={5} height={barH} fill="#ffd47a" opacity={0.7} />
            })}
          </svg>
        </div>
      )}

      <div style={{ marginTop: 24 }}>
        <div style={{ fontSize: 10, opacity: 0.5, letterSpacing: '0.18em', marginBottom: 8 }}>BY PROVIDER</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead><tr style={{ opacity: 0.5, fontSize: 10, letterSpacing: '0.12em' }}>
            <th style={{ textAlign: 'left', padding: '6px 8px' }}>PROVIDER</th>
            <th style={{ textAlign: 'right', padding: '6px 8px' }}>CALLS</th>
            <th style={{ textAlign: 'right', padding: '6px 8px' }}>TOKENS</th>
            <th style={{ textAlign: 'right', padding: '6px 8px' }}>COST</th>
          </tr></thead>
          <tbody>
            {data.byProvider.map(p => (
              <tr key={p.provider} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                <td style={{ padding: '8px 8px' }}>{p.provider}</td>
                <td style={{ padding: '8px 8px', textAlign: 'right', opacity: 0.7 }}>{p.calls.toLocaleString()}</td>
                <td style={{ padding: '8px 8px', textAlign: 'right', opacity: 0.7 }}>{fmtTokens(p.tokens)}</td>
                <td style={{ padding: '8px 8px', textAlign: 'right', color: '#ffd47a' }}>${p.costUsd.toFixed(4)}</td>
              </tr>
            ))}
            {data.byProvider.length === 0 && <tr><td colSpan={4} style={{ padding: 16, textAlign: 'center', opacity: 0.4 }}>no usage in this window</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div style={{ padding: 16, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6 }}>
      <div style={{ fontSize: 10, opacity: 0.5, letterSpacing: '0.18em' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: accent, marginTop: 4 }}>{value}</div>
    </div>
  )
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
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
