/**
 * R146.326 + R329 (#2, #11, #12) — onboarding with real form inputs.
 *
 * Each of 5 steps now collects actual data:
 *   persona    — operator name → workspace_memory key 'operator.name'
 *   firstGoal  — goal text     → strategic_goals row (or workspace_memory)
 *   connector  — provider pick → /api/v1/oauth/:id/start redirect
 *   budget     — monthly cap   → workspace_memory key 'cost.cap_usd'
 *   preview    — Monday briefing render
 *
 * Error states surfaced when API calls fail. PWA install prompt
 * surfaced at completion when available.
 */
import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, AlertCircle, Loader2 } from 'lucide-react'

interface SetupState {
  steps:    Record<string, boolean>
  nextStep: string | null
  completed: boolean
  percentDone: number
}

type StepId = 'persona' | 'firstGoal' | 'connector' | 'budget' | 'preview'

const ORDER: StepId[] = ['persona', 'firstGoal', 'connector', 'budget', 'preview']

const CONNECTORS = [
  { id: 'slack',    label: 'Slack',            hint: 'Read + post in channels' },
  { id: 'gmail',    label: 'Gmail',            hint: 'Read + draft replies' },
  { id: 'calendar', label: 'Google Calendar',  hint: 'See what\'s coming up' },
]

async function postJSON(url: string, body: unknown): Promise<{ success: boolean; data?: unknown; error?: string }> {
  try {
    const r = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    })
    return await r.json()
  } catch (e) { return { success: false, error: (e as Error).message } }
}

async function getJSON(url: string): Promise<{ success: boolean; data?: unknown; error?: string }> {
  try {
    const r = await fetch(url, { credentials: 'include' })
    return await r.json()
  } catch (e) { return { success: false, error: (e as Error).message } }
}

export default function WelcomePage(): JSX.Element {
  const nav = useNavigate()
  const [state, setState]   = useState<SetupState | null>(null)
  const [busy,  setBusy]    = useState(false)
  const [err,   setErr]     = useState<string | null>(null)
  const [name,    setName]    = useState('')
  const [goal,    setGoal]    = useState('')
  const [connector, setConnector] = useState<string>('')
  const [budget,  setBudget]  = useState<number>(5)
  const [installEvent, setInstallEvent] = useState<Event | null>(null)

  useEffect(() => {
    getJSON('/api/v1/setup/state').then(j => {
      if (j.success && j.data) setState(j.data as SetupState)
      else setErr(j.error ?? 'Could not load setup state')
    })
  }, [])

  useEffect(() => {
    const handler = (e: Event) => { e.preventDefault(); setInstallEvent(e) }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  async function markAndPersist(step: StepId, payload?: Record<string, unknown>): Promise<void> {
    setBusy(true); setErr(null)
    try {
      if (payload) {
        // Persist data via brain.op for the steps that have content
        if (step === 'persona' && name.trim()) {
          await postJSON('/api/v1/brain/op', {
            op: 'memory.remember',
            params: { key: 'operator.name', value: name.trim(), scope: 'operator', importance: 90 },
          })
        }
        if (step === 'firstGoal' && goal.trim()) {
          await postJSON('/api/v1/brain/op', {
            op: 'memory.remember',
            params: { key: 'goal.primary', value: goal.trim(), scope: 'system', importance: 85 },
          })
        }
        if (step === 'budget') {
          await postJSON('/api/v1/brain/op', {
            op: 'memory.remember',
            params: { key: 'cost.cap_usd', value: String(budget), scope: 'system', importance: 80 },
          })
        }
        if (step === 'connector' && connector) {
          // Redirect to OAuth start — operator returns here after authorization
          const r = await getJSON(`/api/v1/oauth/${connector}/start`)
          if (r.success && r.data && typeof (r.data as { redirectUrl?: string }).redirectUrl === 'string') {
            window.location.href = (r.data as { redirectUrl: string }).redirectUrl
            return
          }
          throw new Error((r.error ?? 'OAuth not configured — set provider client envs'))
        }
      }
      const r = await postJSON('/api/v1/setup/mark', { step })
      if (!r.success) throw new Error(r.error ?? 'Could not mark step')
      setState(r.data as SetupState)
    } catch (e) {
      setErr((e as Error).message)
    } finally { setBusy(false) }
  }

  if (!state) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-zinc-50 dark:bg-zinc-950 text-zinc-500">
        {err ? (
          <>
            <AlertCircle size={20} className="mb-2 text-red-500" />
            <div className="mb-3">{err}</div>
            <button onClick={() => location.reload()} className="text-xs underline">Retry</button>
          </>
        ) : (
          <Loader2 size={20} className="animate-spin" />
        )}
      </div>
    )
  }

  if (state.completed) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 px-4">
        <h1 className="text-3xl font-light mb-2">Ready.</h1>
        <p className="text-zinc-500 mb-6 max-w-md text-center">
          I'll be in your morning briefing tomorrow at 6am UTC.
          Until then, ask me anything.
        </p>
        <button onClick={() => nav('/')} className="px-5 py-2 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-full mb-3">Open Novan</button>
        {installEvent && (
          <button
            onClick={async () => {
              const ev = installEvent as unknown as { prompt: () => Promise<void>; userChoice: Promise<unknown> }
              await ev.prompt()
              await ev.userChoice
              setInstallEvent(null)
            }}
            className="text-xs text-zinc-400 hover:underline"
          >
            Add to home screen
          </button>
        )}
      </div>
    )
  }

  const next = state.nextStep as StepId | null

  return (
    <div className="min-h-screen flex flex-col bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
      {/* Progress dots */}
      <header className="p-6 flex justify-center gap-2">
        {ORDER.map(s => (
          <div
            key={s}
            className={`w-2 h-2 rounded-full transition ${
              state.steps[s]   ? 'bg-zinc-900 dark:bg-zinc-100' :
              s === next       ? 'bg-zinc-400 dark:bg-zinc-500' :
                                 'bg-zinc-200 dark:bg-zinc-800'
            }`}
          />
        ))}
      </header>

      <main className="flex-1 flex items-center justify-center px-4">
        <div className="w-full max-w-md">
          {err && (
            <div className="mb-4 p-3 bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300 text-sm rounded">
              {err}
            </div>
          )}

          {next === 'persona' && (
            <>
              <h1 className="text-3xl font-light mb-3 text-center">What should I call you?</h1>
              <p className="text-zinc-500 dark:text-zinc-400 mb-6 text-center">I'll use it to greet you and tune my voice.</p>
              <input
                value={name} onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && markAndPersist('persona', { name })}
                placeholder="Your name"
                className="w-full px-4 py-3 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg mb-4 focus:outline-none focus:border-zinc-400"
                autoFocus
              />
              <button
                onClick={() => markAndPersist('persona', { name })}
                disabled={busy || !name.trim()}
                className="w-full px-5 py-3 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-full disabled:opacity-40 flex items-center justify-center gap-2"
              >
                Continue <ArrowRight size={14} />
              </button>
            </>
          )}

          {next === 'firstGoal' && (
            <>
              <h1 className="text-3xl font-light mb-3 text-center">Pick one goal.</h1>
              <p className="text-zinc-500 dark:text-zinc-400 mb-6 text-center">Anything you're working on right now.</p>
              <textarea
                value={goal} onChange={e => setGoal(e.target.value)}
                placeholder="e.g. Get 1000 followers on my YouTube channel by July"
                rows={3}
                className="w-full px-4 py-3 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg mb-4 resize-none focus:outline-none focus:border-zinc-400"
                autoFocus
              />
              <button
                onClick={() => markAndPersist('firstGoal', { goal })}
                disabled={busy || !goal.trim()}
                className="w-full px-5 py-3 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-full disabled:opacity-40 flex items-center justify-center gap-2"
              >
                Continue <ArrowRight size={14} />
              </button>
            </>
          )}

          {next === 'connector' && (
            <>
              <h1 className="text-3xl font-light mb-3 text-center">Wire one place I can act.</h1>
              <p className="text-zinc-500 dark:text-zinc-400 mb-6 text-center">Without this I can only talk — pick later if you'd rather.</p>
              <div className="space-y-2 mb-4">
                {CONNECTORS.map(c => (
                  <button
                    key={c.id}
                    onClick={() => setConnector(c.id)}
                    className={`w-full text-left p-3 rounded-lg border transition ${
                      connector === c.id
                        ? 'border-zinc-900 dark:border-zinc-100 bg-white dark:bg-zinc-900'
                        : 'border-zinc-200 dark:border-zinc-800 hover:border-zinc-400'
                    }`}
                  >
                    <div className="font-medium">{c.label}</div>
                    <div className="text-xs text-zinc-500">{c.hint}</div>
                  </button>
                ))}
              </div>
              <button
                onClick={() => markAndPersist('connector', { connector })}
                disabled={busy || !connector}
                className="w-full px-5 py-3 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-full disabled:opacity-40 flex items-center justify-center gap-2 mb-2"
              >
                Connect {connector || ''} <ArrowRight size={14} />
              </button>
              <button onClick={() => markAndPersist('connector')} className="w-full text-xs text-zinc-400 hover:underline">Skip for now</button>
            </>
          )}

          {next === 'budget' && (
            <>
              <h1 className="text-3xl font-light mb-3 text-center">Monthly budget?</h1>
              <p className="text-zinc-500 dark:text-zinc-400 mb-6 text-center">I'll stop spending when I hit it.</p>
              <div className="flex items-baseline justify-center mb-4">
                <span className="text-3xl mr-1">$</span>
                <input
                  type="number" min={1} max={10000}
                  value={budget} onChange={e => setBudget(Number(e.target.value))}
                  className="text-4xl font-light bg-transparent text-center w-32 border-b border-zinc-300 dark:border-zinc-700 focus:outline-none focus:border-zinc-900 dark:focus:border-zinc-100"
                />
                <span className="text-zinc-500 ml-2">/ mo</span>
              </div>
              <button
                onClick={() => markAndPersist('budget', { budget })}
                disabled={busy || budget < 1}
                className="w-full px-5 py-3 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-full disabled:opacity-40 flex items-center justify-center gap-2"
              >
                Set ${budget}/mo <ArrowRight size={14} />
              </button>
            </>
          )}

          {next === 'preview' && (
            <>
              <h1 className="text-3xl font-light mb-3 text-center">See your first briefing.</h1>
              <p className="text-zinc-500 dark:text-zinc-400 mb-6 text-center">I'll generate one now so you know what mornings look like.</p>
              <button
                onClick={() => markAndPersist('preview', { preview: true })}
                disabled={busy}
                className="w-full px-5 py-3 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-full disabled:opacity-40 flex items-center justify-center gap-2"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <>Generate <ArrowRight size={14} /></>}
              </button>
            </>
          )}
        </div>
      </main>

      <footer className="p-4 text-center text-xs text-zinc-400 dark:text-zinc-600">
        Step {Object.values(state.steps).filter(Boolean).length + 1} of {ORDER.length} · {state.percentDone}% complete
      </footer>
    </div>
  )
}
