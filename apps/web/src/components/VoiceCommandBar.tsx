/**
 * Voice command bar (item #13).
 *
 * Browser-native: Web Speech API for STT, SpeechSynthesis for TTS.
 * No backend speech provider needed — works in Chrome/Edge/Safari.
 * Firefox lacks SpeechRecognition; we gracefully hide the mic.
 *
 * Commands recognized:
 *   "home" / "war room" / "missions" / "exec" / "company" / "approvals"
 *   "what's broken" → reads top recommendation aloud
 *   "summary"       → reads current page headline aloud
 *   "stop"          → cancels speech
 */
import { useEffect, useRef, useState } from 'react'
import { Mic, MicOff, Volume2 }        from 'lucide-react'
import { useNavigate }                 from 'react-router-dom'
import { intelligenceApi, API_BASE }    from '../api.js'
import { useWorkspace }                from '../contexts/WorkspaceContext.js'

type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  onerror: ((e: unknown) => void) | null
  start: () => void
  stop: () => void
}

function getRecognition(): SpeechRecognitionLike | null {
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike }
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
  if (!Ctor) return null
  const rec = new Ctor()
  rec.continuous = false
  rec.interimResults = false
  rec.lang = 'en-US'
  return rec
}

function speak(text: string): void {
  if (typeof speechSynthesis === 'undefined') return
  speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.rate = 1.05
  u.pitch = 1
  speechSynthesis.speak(u)
}

function stopSpeech(): void {
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel()
}

const NAV: Record<string, string> = {
  'home': '/strategic-home', 'strategic home': '/strategic-home',
  'war room': '/war-room',
  'missions': '/mission-intelligence', 'mission intelligence': '/mission-intelligence',
  'exec': '/executive-war-room', 'executive': '/executive-war-room',
  'company': '/company-operations', 'company operations': '/company-operations',
  'approvals': '/approvals',
  'incidents': '/incidents',
}

export function VoiceCommandBar() {
  const navigate = useNavigate()
  const { workspaceId } = useWorkspace()
  const [listening, setListening] = useState(false)
  const [lastHeard, setLastHeard] = useState<string | null>(null)
  const recRef = useRef<SpeechRecognitionLike | null>(null)

  const supported = typeof window !== 'undefined' && (('SpeechRecognition' in window) || ('webkitSpeechRecognition' in window))

  const handleCommand = async (raw: string) => {
    const cmd = raw.trim().toLowerCase().replace(/[.!?]/g, '')
    setLastHeard(cmd)

    if (cmd === 'stop') { stopSpeech(); return }

    // Navigation
    for (const [phrase, path] of Object.entries(NAV)) {
      if (cmd.includes(phrase)) {
        navigate(path)
        speak(`Opening ${phrase}`)
        return
      }
    }

    // Status queries
    if (cmd.includes("what's broken") || cmd.includes('whats broken') || cmd.includes('top risk')) {
      try {
        const r = await intelligenceApi.home(workspaceId)
        const top = r.data.topRecommendations[0]
        if (!top) { speak('No active recommendations.'); return }
        speak(`Top recommendation: ${top.title}. Bucket ${top.decision.bucket}.`)
      } catch { speak('Could not fetch status.') }
      return
    }
    if (cmd.includes('summary') || cmd.includes('status')) {
      try {
        const r = await intelligenceApi.home(workspaceId)
        speak(`${r.data.headline.status}. ${r.data.headline.summary}`)
      } catch { speak('Could not fetch summary.') }
      return
    }

    // Fall through to the brain — anything the local handlers don't
    // recognize is sent to /api/v1/brain/task. The planner turns
    // arbitrary speech into an operation plan.
    try {
      const res  = await fetch(`${API_BASE}/api/v1/brain/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId, task: raw }),
      })
      const json = await res.json() as { success: boolean; data?: { results?: Array<{ op: string; ok: boolean }>; plannerReason?: string; reason?: string } }
      if (json.success && json.data) {
        const ok  = (json.data.results ?? []).filter(r => r.ok).length
        const err = (json.data.results ?? []).filter(r => !r.ok).length
        const why = json.data.plannerReason ?? json.data.reason ?? 'task complete'
        speak(`Brain: ${why}. ${ok} succeeded, ${err} failed.`)
        return
      }
    } catch { /* fall through */ }
    speak('Command not recognized.')
  }

  const toggle = () => {
    if (!supported) return
    if (listening) {
      recRef.current?.stop()
      setListening(false)
      return
    }
    const rec = getRecognition()
    if (!rec) return
    rec.onresult = (e) => {
      const transcript = e.results[0]?.[0]?.transcript ?? ''
      void handleCommand(transcript)
    }
    rec.onend = () => setListening(false)
    rec.onerror = () => setListening(false)
    recRef.current = rec
    rec.start()
    setListening(true)
  }

  useEffect(() => {
    return () => { recRef.current?.stop() }
  }, [])

  if (!supported) return null

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={toggle}
        title={listening ? 'Stop listening' : 'Voice command (say "home", "summary", "what\'s broken")'}
        className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
          listening
            ? 'bg-red-500/20 text-red-400 border border-red-500/40 animate-pulse'
            : 'text-[var(--text-muted)] hover:bg-[var(--bg-elevated)]'
        }`}
      >
        {listening ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
      </button>
      {lastHeard && (
        <span className="text-xs text-[var(--text-muted)] font-mono max-w-xs truncate" title={lastHeard}>
          &ldquo;{lastHeard}&rdquo;
        </span>
      )}
      <button
        onClick={stopSpeech}
        title="Stop speaking"
        className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--bg-elevated)]"
      >
        <Volume2 className="w-4 h-4" />
      </button>
    </div>
  )
}
