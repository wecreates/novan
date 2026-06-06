/**
 * R146.328 (#4) — minimal welcome / onboarding page.
 *
 * Drives the 5-step setup.state flow with real UI. One step on screen at
 * a time, each markable independently. Visual: same minimal aesthetic as
 * MainPage — single column, breathing room, no chrome.
 */
import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, ArrowRight } from 'lucide-react'

interface SetupState {
  steps:    Record<string, boolean>
  nextStep: string | null
  completed: boolean
  percentDone: number
}

const STEP_COPY: Record<string, { title: string; body: string; action: string }> = {
  persona: {
    title: "What should I call you?",
    body:  "I'll greet you by name and tune my voice to your style over time.",
    action: "Set name",
  },
  firstGoal: {
    title: "Pick one goal.",
    body:  "Anything you're working on. I'll keep it in mind across sessions.",
    action: "Add goal",
  },
  connector: {
    title: "Wire one place I can act.",
    body:  "Slack, Gmail, or Calendar. Without this I can only talk — I can't do.",
    action: "Connect",
  },
  budget: {
    title: "What's my monthly budget?",
    body:  "I'll stop spending when I hit it. Default is $5/mo; raise it if you want me running heavier loops.",
    action: "Set budget",
  },
  preview: {
    title: "See your first briefing.",
    body:  "I'll generate one now so you know what to expect tomorrow morning.",
    action: "Preview",
  },
}

export default function WelcomePage(): JSX.Element {
  const nav = useNavigate()
  const [state, setState] = useState<SetupState | null>(null)
  const [busy,  setBusy]  = useState(false)

  useEffect(() => {
    fetch('/api/v1/setup/state').then(r => r.json()).then(j => {
      if (j?.success) setState(j.data)
    }).catch(() => null)
  }, [])

  async function mark(step: string) {
    setBusy(true)
    try {
      const r = await fetch('/api/v1/setup/mark', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step }),
      })
      const j = await r.json()
      if (j?.success) setState(j.data)
    } finally { setBusy(false) }
  }

  if (!state) return <div className="min-h-screen flex items-center justify-center text-zinc-400">Loading…</div>

  if (state.completed) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 px-4">
        <h1 className="text-2xl mb-2">All set.</h1>
        <p className="text-zinc-500 mb-6">You're ready.</p>
        <button
          onClick={() => nav('/')}
          className="px-5 py-2 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-full"
        >
          Open Novan
        </button>
      </div>
    )
  }

  const next = state.nextStep
  const copy = next ? STEP_COPY[next] : null

  return (
    <div className="min-h-screen flex flex-col bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
      {/* Progress dots */}
      <header className="p-6 flex justify-center gap-2">
        {Object.keys(STEP_COPY).map(s => (
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
        <div className="w-full max-w-md text-center">
          {copy ? (
            <>
              <h1 className="text-3xl font-light mb-3">{copy.title}</h1>
              <p className="text-zinc-500 dark:text-zinc-400 mb-8">{copy.body}</p>
              <button
                onClick={() => next && mark(next)}
                disabled={busy}
                className="px-6 py-3 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-full inline-flex items-center gap-2 disabled:opacity-40"
              >
                {copy.action}
                <ArrowRight size={16} />
              </button>
              <div className="mt-6">
                <button
                  onClick={() => next && mark(next)}
                  disabled={busy}
                  className="text-xs text-zinc-400 hover:underline"
                >
                  Skip this step
                </button>
              </div>
            </>
          ) : (
            <p className="text-zinc-500">No next step.</p>
          )}
        </div>
      </main>

      <footer className="p-4 text-center text-xs text-zinc-400 dark:text-zinc-600">
        Step {Object.values(state.steps).filter(Boolean).length + 1} of {Object.keys(STEP_COPY).length}
        {state.percentDone > 0 && ` · ${state.percentDone}% complete`}
      </footer>
    </div>
  )
}
