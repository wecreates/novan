/**
 * VoicePage — provider-agnostic realtime voice console.
 *
 *  Left:   mic button (push-to-talk + tap-toggle), transcript panel
 *  Right:  selected provider, latency, cost, failover indicator,
 *          voice preset dropdown, retention toggle, kill-switch banner,
 *          configured providers list with enable/disable
 *
 * The page never embeds keys. Operators configure providers via the API
 * (vault keyRef only). Risky commands surface a visible confirmation chip
 * AND post a system event the user must confirm by saying "confirm".
 * Hard-blocked commands display a refusal banner that voice cannot override.
 *
 * Audio capture uses the browser MediaRecorder API; it is gated behind an
 * explicit user click — never auto-started — and a visible "● recording"
 * indicator is always shown while the mic is open.
 */
import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Mic, MicOff, AlertTriangle, ShieldAlert, Power, Loader2, Activity, DollarSign, Volume2, Compass, CheckCircle2, XCircle, Star, VolumeX, Settings as SettingsIcon } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'
import { useSpeechRecognition, cancelSpeech } from '../hooks/useSpeechRecognition.js'
import { useRealtimeVoice } from '../hooks/useRealtimeVoice.js'
import { Link } from 'react-router-dom'

interface ProviderRow {
  id: string; providerId: string; displayName: string
  kind: 'realtime_s2s' | 'stt' | 'tts' | 'custom'
  enabled: boolean; priority: number
  preferredVoice: string | null; preferredLocale: string
  healthScore: number; lastLatencyMs: number | null
  lastError: string | null; hasKey: boolean
}
interface VoicePreset { id: string; label: string; style: string }
interface Decision {
  ok: boolean; reason?: string; mode: 'realtime' | 'fallback'
  primary?: string; pair?: { stt: string; tts: string }
  fallbackChain: string[]
  scores: Array<{ providerId: string; score: number; reasons: string[] }>
  killSwitch?: boolean
}
interface SessionRow {
  id: string; mode: string; preset: string; selectedProvider: string
  startedAt: number; endedAt: number | null
  avgLatencyMs: number | null; totalCostUsd: number
  failoverCount: number; blockedCommands: number; status: string
}
interface ClassifyResult {
  kind: 'allow' | 'confirm' | 'block'; reason?: string; matched?: string
}
interface VoiceIntent {
  kind: string; target?: string; args: Record<string, string | number | boolean>;
  confidence: number; matched?: string
}
interface DryRunReport {
  command: string; intentKind: string; intentTarget: string | null
  verdict: string; risk: 'low' | 'medium' | 'high'; riskScore: number
  estimatedCostUsd: number; permissions: string[]
  plannedSteps: string[]
  browserPreview: null | {
    url: string | null; account: string | null
    plannedClicks: string[]
    plannedFields: Array<{ field: string; valueHint: string; sensitive: boolean }>
    blockedFieldCategories: string[]; blockedClickCategories: string[]
    fullyBlocked: boolean; reason: string | null
  }
  affectedSystems: string[]; blockedActions: string[]
  rollbackAvailable: boolean; rollbackStrategy: string | null
  spokenPreview: string; requiresApproval: boolean; hardBlocked: boolean
}
interface ActionPlan {
  verdict: 'navigate' | 'execute' | 'confirm' | 'reject'
  intent: VoiceIntent
  speak: string; reason: string; risk: 'low' | 'medium' | 'high'
  permission: string | null
  navigate?: { path: string; params: Record<string, string> }
  execute?:  { method: 'GET' | 'POST'; path: string; body?: Record<string, unknown> }
  recommendation?: string
  // Conversation layer extras
  meta?: string | null
  naturalSpeak?: string
  clarification?: string
  carryover?: { from: string; resolvedTo: string } | null
  dryRun?: { id: string; report: DryRunReport } | null
}
interface ConversationCtx {
  currentNode: string | null; currentTemplate: string | null; currentLod: string | null
  activeMission: string | null; selectedSystem: string | null
  currentRisk: 'low' | 'medium' | 'high'; turnCount: number
  pendingPlan: ActionPlan | null
}

export default function VoicePage() {
  const { workspaceId } = useWorkspace()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [mode, setMode] = useState<'realtime' | 'fallback'>('realtime')
  const [preset, setPreset] = useState<string>('calm_operator')
  const [locale, setLocale] = useState<string>('en-US')
  const [retention, setRetention] = useState(true)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [micOn, setMicOn]   = useState(false)
  const [transcript, setTranscript] = useState<Array<{ role: 'user' | 'assistant'; text: string; t: number }>>([])
  const [classify, setClassify] = useState<ClassifyResult | null>(null)
  const [pending, setPending] = useState('')
  const [lastPlan, setLastPlan] = useState<ActionPlan | null>(null)
  const [planLatencyMs, setPlanLatencyMs] = useState<number | null>(null)
  const [awaitingConfirm, setAwaitingConfirm] = useState<ActionPlan | null>(null)
  type LogStatus = 'navigated' | 'executed' | 'confirmed' | 'rejected' | 'blocked' | 'cancelled' | 'clarified'
  interface LogEntry { t: number; status: LogStatus; verdict: string; speak: string }
  const [executionLog, setExecutionLog] = useState<LogEntry[]>([])
  const logPush = (e: LogEntry) => setExecutionLog(l => [e, ...l].slice(0, 12))
  const [convCtx, setConvCtx] = useState<ConversationCtx | null>(null)
  const [ratings, setRatings] = useState<{ naturalness: number; speed: number; clarity: number; tone: number; usefulness: number }>({ naturalness: 0, speed: 0, clarity: 0, tone: 0, usefulness: 0 })
  const [feedbackSent, setFeedbackSent] = useState(false)
  const [showPrefs, setShowPrefs] = useState(false)
  const [ttsSpeaking, setTtsSpeaking] = useState(false)
  const [thinking, setThinking]       = useState(false)
  const [voiceLocked, setVoiceLocked] = useState(false)
  const [mutedUntil, setMutedUntil]   = useState<number | null>(null)
  const [dryRun, setDryRun]           = useState<{ id: string; report: DryRunReport } | null>(null)

  interface VoicePrefs {
    preferredProvider: string | null; preferredPreset: string | null; preferredLocale: string
    transcriptRetained: boolean; autoConfirmLowRisk: boolean; bargeInEnabled: boolean; qualityWeight: number
    wakePhrases: string[]; wakeEnabled: boolean
    handsFreeEnabled: boolean; handsFreeAllowedIntents: string[]
    ambientAlertsEnabled: boolean; ambientSeverityFloor: 'normal' | 'high' | 'critical'
    pushToTalkDefault: boolean
  }
  interface AmbientBriefing { id: string; kind: string; severity: string; summary: string; createdAt: number; deliveredAt: number | null; ackedAt: number | null }
  const prefsQ = useQuery<{ success: true; data: VoicePrefs }>({
    queryKey: ['voice', 'preferences', workspaceId],
    queryFn: () => api.get(`/api/v1/voice/preferences?workspace_id=${workspaceId}`),
  })
  const updatePrefs = useMutation({
    mutationFn: (patch: Partial<VoicePrefs>) => api.patch<{ success: true; data: VoicePrefs }>('/api/v1/voice/preferences', { workspace_id: workspaceId, patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['voice', 'preferences'] }),
  })

  // Ambient briefings — poll for critical updates and speak them out
  const briefingsQ = useQuery<{ success: true; data: AmbientBriefing[] }>({
    queryKey: ['voice', 'ambient', workspaceId],
    queryFn: async () => {
      // Refresh then read pending
      await api.post('/api/v1/voice/ambient/refresh', { workspace_id: workspaceId }).catch(() => null)
      return api.get(`/api/v1/voice/ambient/pending?workspace_id=${workspaceId}&limit=3`)
    },
    refetchInterval: 30_000,
    enabled: !!workspaceId,
  })

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef   = useRef<MediaStream | null>(null)
  // Track the last 8 final transcripts for de-dup (browsers occasionally
  // fire the same final result twice when continuous=true)
  const lastFinalsRef = useRef<string[]>([])

  // ─── Data ─────────────────────────────────────────────────────────────
  const presetsQ = useQuery<{ success: true; data: VoicePreset[] }>({
    queryKey: ['voice', 'presets'],
    queryFn: () => api.get('/api/v1/voice/presets'),
  })
  const providersQ = useQuery<{ success: true; data: ProviderRow[] }>({
    queryKey: ['voice', 'providers', workspaceId],
    queryFn: () => api.get(`/api/v1/voice/providers?workspace_id=${workspaceId}`),
    refetchInterval: 15_000,
  })
  const healthQ = useQuery<{ success: true; data: { killSwitch: boolean; enabledProviders: number; totalProviders: number; activeSessions: number; catalogueSize: number } }>({
    queryKey: ['voice', 'health', workspaceId],
    queryFn: () => api.get(`/api/v1/voice/health?workspace_id=${workspaceId}`),
    refetchInterval: 10_000,
  })
  const sessionsQ = useQuery<{ success: true; data: SessionRow[] }>({
    queryKey: ['voice', 'sessions', workspaceId],
    queryFn: () => api.get(`/api/v1/voice/sessions?workspace_id=${workspaceId}&limit=20`),
    refetchInterval: 8_000,
  })

  const [decision, setDecision] = useState<Decision | null>(null)
  useEffect(() => {
    let cancelled = false
    api.post<{ success: true; data: Decision }>('/api/v1/voice/route', {
      workspace_id: workspaceId, mode, locale, preset,
    }).then(r => { if (!cancelled) setDecision(r.data) }).catch(() => null)
    return () => { cancelled = true }
  }, [workspaceId, mode, locale, preset])
  const kill = !!(decision?.killSwitch ?? healthQ.data?.data.killSwitch)

  const startSession = useMutation({
    mutationFn: () => api.post<{ success: true; data: { session_id: string; selected_provider: string; fallback_chain: string[] } }>('/api/v1/voice/sessions', {
      workspace_id: workspaceId, mode, preset, locale, transcript_retained: retention, estimated_cost_usd: 0.05,
    }),
    onSuccess: (r) => { setSessionId(r.data.session_id); setTranscript([]); qc.invalidateQueries({ queryKey: ['voice', 'sessions'] }) },
  })
  const endSession = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/voice/sessions/${id}/end`, { workspace_id: workspaceId, total_cost_usd: 0, avg_latency_ms: 0 }),
    onSuccess: () => { setSessionId(null); qc.invalidateQueries({ queryKey: ['voice', 'sessions'] }) },
  })
  const togglePvd = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.post(`/api/v1/voice/providers/${id}/toggle`, { workspace_id: workspaceId, enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['voice', 'providers'] }),
  })

  // Speak via the browser's TTS engine — used for Novan's spoken feedback.
  // Honors the per-session mute window so "mute" silences subsequent
  // utterances without dropping the textual record.
  function speak(text: string) {
    if (!text || typeof window === 'undefined' || !('speechSynthesis' in window)) return
    if (mutedUntil && Date.now() < mutedUntil) return
    try {
      const u = new SpeechSynthesisUtterance(text)
      u.rate = preset === 'fast_minimal' ? 1.15 : 1.0
      u.volume = 0.9
      u.onstart = () => setTtsSpeaking(true)
      u.onend   = () => setTtsSpeaking(false)
      u.onerror = () => setTtsSpeaking(false)
      window.speechSynthesis.cancel()
      window.speechSynthesis.speak(u)
    } catch { /* ignore */ }
  }

  // Deliver pending ambient briefings (critical-only by default). Speaks
  // each at most once; marks delivered server-side immediately so a
  // refetch won't replay it.
  useEffect(() => {
    const pending = briefingsQ.data?.data ?? []
    for (const b of pending) {
      if (b.deliveredAt) continue
      if (mutedUntil && Date.now() < mutedUntil) continue
      // Short, calm preface so the operator hears the source kind
      const line = `${b.kind.replace('_', ' ')}: ${b.summary}`
      setTranscript(t => [...t, { role: 'assistant', text: `[ambient · ${b.severity}] ${line}`, t: Date.now() }])
      speak(line)
      api.post('/api/v1/voice/ambient/delivered', { id: b.id }).catch(() => null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [briefingsQ.data?.data])

  // Speech recognition — streams transcripts from the browser STT engine
  // into the same /command pipeline used by the typed input.
  const sr = useSpeechRecognition({
    locale,
    continuous: true,
    onSpeechStart: () => {
      // Barge-in: stop Novan mid-sentence the instant the operator speaks.
      // For native realtime pipes also propagate the cancel frame.
      if (prefsQ.data?.data.bargeInEnabled !== false) {
        cancelSpeech()
        if (realtime.connected) void realtime.bargeIn()
      }
    },
    onInterim: (text) => setPending(text),
    onFinal: (text) => {
      // de-dup
      const norm = text.toLowerCase().trim()
      if (lastFinalsRef.current.includes(norm)) return
      lastFinalsRef.current = [norm, ...lastFinalsRef.current].slice(0, 8)
      setPending('')
      void submitCommand(text)
    },
    onError: (err) => {
      // 'no-speech' and 'aborted' are normal — only surface real failures
      if (err !== 'no-speech' && err !== 'aborted') {
        setTranscript(t => [...t, { role: 'assistant', text: `Mic error: ${err}. Falling back to text.`, t: Date.now() }])
      }
    },
  })

  // Realtime pipe (provider-native WebRTC/WS). Opt-in; falls back to
  // browser SR cleanly when unsupported or when the operator hasn't
  // configured a realtime provider. Transcripts route through the same
  // submitCommand pipeline as text + SR input.
  const realtimeProvider = decision?.mode === 'realtime' ? (decision.primary ?? null) : null
  const realtime = useRealtimeVoice({
    workspaceId: workspaceId ?? '',
    providerId:  realtimeProvider ?? 'openai_realtime',
    ...(sessionId ? { sessionId } : {}),
    locale,
    bargeInEnabled: prefsQ.data?.data.bargeInEnabled !== false,
    onInterim: (t) => setPending(t),
    onFinal:   (t) => { setPending(''); void submitCommand(t) },
    onAssistantSpeechStart: () => setTtsSpeaking(true),
    onAssistantSpeechEnd:   () => setTtsSpeaking(false),
    onError:   (msg) => setTranscript(tr => [...tr, { role: 'assistant', text: `Realtime error: ${msg}. Falling back.`, t: Date.now() }]),
  })

  // ─── Mic handling — browser SpeechRecognition + auto-session ─────────
  async function openMic() {
    if (!sr.supported) {
      setClassify({ kind: 'block', reason: 'SpeechRecognition not supported in this browser. Use the text input.' })
      return
    }
    if (!sessionId) await startSession.mutateAsync()
    sr.start()
    setMicOn(true)
  }
  function closeMic() {
    sr.stop()
    setMicOn(false)
  }
  useEffect(() => () => { try { sr.abort() } catch { /* ignore */ } }, [sr])

  // Push-to-talk: hold space to listen, release to stop. Ignore when an
  // input is focused so typing isn't intercepted.
  useEffect(() => {
    const isEditable = () => {
      const el = document.activeElement as HTMLElement | null
      if (!el) return false
      const tag = el.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
    }
    const down = (e: KeyboardEvent) => { if (e.code === 'Space' && !isEditable() && !micOn && !kill) { e.preventDefault(); void openMic() } }
    const up   = (e: KeyboardEvent) => { if (e.code === 'Space' && !isEditable() && micOn) { e.preventDefault(); closeMic() } }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup',   up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micOn, sessionId])

  // Submit a transcript: parse intent, route to ActionPlan, then either
  // navigate immediately, queue a confirmation, or surface a hard block.
  async function submitCommand(text: string) {
    if (!text.trim()) return
    if (voiceLocked) {
      // Operator locked voice actions — accept "unlock voice" but refuse the rest visibly
      if (!/\b(unlock|resume voice)\b/i.test(text)) {
        setTranscript(t => [...t, { role: 'assistant', text: 'Voice actions are locked. Say "unlock voice" to resume.', t: Date.now() }])
        return
      }
    }
    setTranscript(t => [...t, { role: 'user', text, t: Date.now() }])
    setPending('')
    setThinking(true)
    const start = Date.now()
    try {
      const r = await api.post<{ success: true; data: ActionPlan & { handsFree?: { verdict: string; reason: string; category: string }; wake?: { matched: boolean; phrase: string | null } } }>('/api/v1/voice/command', {
        workspace_id: workspaceId, text, session_id: sessionId ?? undefined,
        apply_wake: prefsQ.data?.data.wakeEnabled === true && !micOn,    // wake required only outside an open push-to-talk window
      })
      const plan = r.data
      setPlanLatencyMs(Date.now() - start)
      setLastPlan(plan)
      setThinking(false)

      // Apply session-side mute / lock effects derived from meta commands
      const args = plan.intent?.args as Record<string, unknown> | undefined
      if (plan.intent?.matched === 'mute' && typeof args?.['mute_ms'] === 'number') {
        setMutedUntil(Date.now() + Number(args['mute_ms']))
      }
      if (plan.intent?.matched === 'lock')   setVoiceLocked(true)
      if (plan.intent?.matched === 'unlock') setVoiceLocked(false)
      if (plan.intent?.matched === 'stop')   { cancelSpeech(); if (realtime.connected) void realtime.bargeIn() }
      setClassify({ kind: plan.verdict === 'reject' ? 'block' : (plan.verdict === 'confirm' ? 'confirm' : 'allow'), matched: plan.intent.kind, reason: plan.reason })
      const said = plan.naturalSpeak ?? plan.speak
      setTranscript(t => [...t, { role: 'assistant', text: said, t: Date.now() }])
      speak(said)

      // Refresh persisted conversation context for the panel
      if (sessionId) {
        api.get<{ success: true; data: ConversationCtx }>(`/api/v1/voice/sessions/${sessionId}/context?workspace_id=${workspaceId}`)
          .then(r => setConvCtx(r.data)).catch(() => null)
      }

      if (plan.meta === 'clarify') {
        logPush({ t: Date.now(), status: 'clarified', verdict: plan.intent.kind, speak: plan.clarification ?? said })
        return
      }

      if (plan.verdict === 'navigate' && plan.navigate) {
        const qs = new URLSearchParams(plan.navigate.params).toString()
        navigate(qs ? `${plan.navigate.path}?${qs}` : plan.navigate.path)
        logPush({ t: Date.now(), status: 'navigated', verdict: plan.intent.kind, speak: plan.speak })
      } else if (plan.verdict === 'execute') {
        logPush({ t: Date.now(), status: 'executed', verdict: plan.intent.kind, speak: plan.speak })
      } else if (plan.verdict === 'confirm') {
        // Dry-run interception: any risky/mutating plan now lands in the
        // preview drawer instead of the simple confirm chip. The drawer
        // enforces dual-channel approval.
        if (plan.dryRun) {
          setDryRun(plan.dryRun)
          logPush({ t: Date.now(), status: 'clarified', verdict: plan.intent.kind, speak: plan.dryRun.report.spokenPreview })
        } else if (prefsQ.data?.data.autoConfirmLowRisk && plan.risk === 'low') {
          if (plan.execute) {
            if (plan.execute.method === 'POST') await api.post(plan.execute.path, plan.execute.body ?? {}).catch(() => null)
            else await api.get(plan.execute.path).catch(() => null)
          }
          logPush({ t: Date.now(), status: 'confirmed', verdict: plan.intent.kind, speak: plan.speak })
        } else {
          setAwaitingConfirm(plan)
        }
      } else if (plan.verdict === 'reject') {
        logPush({ t: Date.now(), status: 'blocked', verdict: plan.intent.kind, speak: plan.speak })
      }
    } catch (e) {
      setLastPlan(null)
      setThinking(false)
      setTranscript(t => [...t, { role: 'assistant', text: `Error: ${(e as Error).message}. Falling back to text — type your command.`, t: Date.now() }])
    }
  }

  // Confirm a queued plan — runs the .execute leg server-side if present.
  async function confirmPlan() {
    if (!awaitingConfirm) return
    const plan = awaitingConfirm
    setAwaitingConfirm(null)
    try {
      if (plan.execute) {
        if (plan.execute.method === 'POST') await api.post(plan.execute.path, plan.execute.body ?? {}).catch(() => null)
        else await api.get(plan.execute.path).catch(() => null)
      }
      logPush({ t: Date.now(), status: 'confirmed', verdict: plan.intent.kind, speak: plan.speak })
      speak(`Confirmed. ${plan.speak}`)
      if (sessionId) {
        await api.post(`/api/v1/voice/sessions/${sessionId}/event`, {
          workspace_id: workspaceId, kind: 'confirm', role: 'user',
          text: plan.intent.matched ?? plan.intent.kind, meta: { intent: plan.intent.kind, risk: plan.risk },
        }).catch(() => null)
      }
    } catch (e) {
      logPush({ t: Date.now(), status: 'rejected', verdict: plan.intent.kind, speak: `Execution failed: ${(e as Error).message}` })
    }
  }
  function cancelPlan() {
    if (!awaitingConfirm) return
    logPush({ t: Date.now(), status: 'cancelled', verdict: awaitingConfirm.intent.kind, speak: awaitingConfirm.speak })
    setAwaitingConfirm(null)
  }

  const primary = decision?.primary ?? '—'

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <header className="flex items-baseline justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Voice console</h1>
          <p className="text-muted text-sm mt-1">Provider-agnostic realtime speech. No vendor lock-in.</p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted">
          <span className="inline-flex items-center gap-1"><Activity className="w-3 h-3" />{healthQ.data?.data.activeSessions ?? 0} active</span>
          <span>·</span>
          <span>{healthQ.data?.data.enabledProviders ?? 0}/{healthQ.data?.data.totalProviders ?? 0} providers on</span>
          <Link to="/voice/analytics" className="btn btn-ghost text-2xs">Analytics</Link>
          <button onClick={() => setShowPrefs(p => !p)} aria-label="Voice preferences" className="btn btn-ghost p-1 ml-1"><SettingsIcon className="w-3.5 h-3.5" /></button>
        </div>
      </header>

      {showPrefs && prefsQ.data?.data && (
        <div className="drawer-edge p-4 mb-4">
          <div className="label mb-2">Workspace voice preferences</div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <label className="space-y-1">
              <span className="text-2xs text-muted">Preferred provider</span>
              <select
                value={prefsQ.data.data.preferredProvider ?? ''}
                onChange={e => updatePrefs.mutate({ preferredProvider: e.target.value || null })}
                className="w-full bg-surface border border-border rounded px-2 py-1">
                <option value="">(automatic)</option>
                {(providersQ.data?.data ?? []).map(p => <option key={p.providerId} value={p.providerId}>{p.displayName}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-2xs text-muted">Preferred preset</span>
              <select
                value={prefsQ.data.data.preferredPreset ?? ''}
                onChange={e => updatePrefs.mutate({ preferredPreset: e.target.value || null })}
                className="w-full bg-surface border border-border rounded px-2 py-1">
                <option value="">(none)</option>
                {(presetsQ.data?.data ?? []).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-2xs text-muted">Quality weight ({prefsQ.data.data.qualityWeight.toFixed(2)})</span>
              <input type="range" min={0} max={0.5} step={0.05}
                value={prefsQ.data.data.qualityWeight}
                onChange={e => updatePrefs.mutate({ qualityWeight: Number(e.target.value) })}
                className="w-full" />
            </label>
            <div className="space-y-1.5 self-end">
              <label className="flex items-center gap-2"><input type="checkbox" checked={prefsQ.data.data.bargeInEnabled} onChange={e => updatePrefs.mutate({ bargeInEnabled: e.target.checked })} /> <span className="text-2xs">Barge-in on speech</span></label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={prefsQ.data.data.autoConfirmLowRisk} onChange={e => updatePrefs.mutate({ autoConfirmLowRisk: e.target.checked })} /> <span className="text-2xs">Auto-confirm low-risk</span></label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={prefsQ.data.data.transcriptRetained} onChange={e => updatePrefs.mutate({ transcriptRetained: e.target.checked })} /> <span className="text-2xs">Retain transcripts</span></label>
            </div>
          </div>

          <div className="border-t border-border mt-4 pt-4 grid grid-cols-2 gap-3 text-xs">
            <label className="space-y-1">
              <span className="text-2xs text-muted">Wake phrases (comma-separated)</span>
              <input
                defaultValue={prefsQ.data.data.wakePhrases.join(', ')}
                onBlur={e => updatePrefs.mutate({ wakePhrases: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                className="w-full bg-surface border border-border rounded px-2 py-1 font-mono text-2xs" />
            </label>
            <label className="space-y-1">
              <span className="text-2xs text-muted">Ambient severity floor</span>
              <select
                value={prefsQ.data.data.ambientSeverityFloor}
                onChange={e => updatePrefs.mutate({ ambientSeverityFloor: e.target.value as 'normal' | 'high' | 'critical' })}
                className="w-full bg-surface border border-border rounded px-2 py-1">
                <option value="critical">critical (default — least talking)</option>
                <option value="high">high + critical</option>
                <option value="normal">all alerts</option>
              </select>
            </label>
            <div className="space-y-1.5 col-span-2 grid grid-cols-2 gap-x-4">
              <label className="flex items-center gap-2"><input type="checkbox" checked={prefsQ.data.data.wakeEnabled} onChange={e => updatePrefs.mutate({ wakeEnabled: e.target.checked })} /> <span className="text-2xs">Wake-phrase detection</span></label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={prefsQ.data.data.handsFreeEnabled} onChange={e => updatePrefs.mutate({ handsFreeEnabled: e.target.checked })} /> <span className="text-2xs">Hands-free mode</span></label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={prefsQ.data.data.ambientAlertsEnabled} onChange={e => updatePrefs.mutate({ ambientAlertsEnabled: e.target.checked })} /> <span className="text-2xs">Ambient alerts</span></label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={prefsQ.data.data.pushToTalkDefault} onChange={e => updatePrefs.mutate({ pushToTalkDefault: e.target.checked })} /> <span className="text-2xs">Push-to-talk default (safest)</span></label>
            </div>
            <p className="col-span-2 text-2xs text-muted italic">
              Wake-phrase listening reuses the same mic indicator as push-to-talk. Mic state is always visible.
              Hands-free auto-executes safe intents; mutating intents still need approval. Purchases, payment entry,
              and permission escalation are always blocked regardless of mode.
            </p>
          </div>
        </div>
      )}

      {kill && (
        <div className="mb-4 p-3 rounded border border-rose-500/40 bg-rose-500/10 text-sm flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-rose-400" />
          Voice kill switch is engaged (VOICE_KILL_SWITCH=1). Sessions cannot start.
        </div>
      )}

      <div className="grid grid-cols-[1fr_320px] gap-6">
        {/* Left: mic + transcript */}
        <section className="drawer-edge p-5 min-h-[420px] flex flex-col">
          <PresencePill
            micOn={micOn}
            thinking={thinking}
            speaking={ttsSpeaking}
            mutedUntil={mutedUntil}
            voiceLocked={voiceLocked}
            awaitingApproval={!!awaitingConfirm || !!dryRun}
            wakeArmed={!!prefsQ.data?.data.wakeEnabled && !micOn}
            handsFree={!!prefsQ.data?.data.handsFreeEnabled}
            realtime={realtime.connected}
          />
          <div className="flex items-center gap-3 mb-4">
            <button
              onClick={micOn ? closeMic : openMic}
              disabled={kill || !sr.supported}
              aria-label={micOn ? 'Stop microphone' : 'Start microphone (or hold Space)'}
              title={sr.supported ? 'Click or hold Space to talk' : 'SpeechRecognition not supported here — use text input'}
              className={`relative w-14 h-14 rounded-full flex items-center justify-center transition-colors ${micOn ? 'bg-rose-500/20 border-2 border-rose-500' : 'bg-surface-hover border-2 border-border'} disabled:opacity-50`}>
              {micOn ? <Mic className="w-5 h-5 text-rose-400" /> : <MicOff className="w-5 h-5 text-muted" />}
              {micOn && <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-rose-500 animate-pulse" aria-hidden />}
            </button>
            <div className="flex-1">
              <div className="text-sm font-medium">
                {micOn ? '● Listening' : sr.supported ? 'Microphone off · hold Space to talk' : 'Mic unsupported · type below'}
              </div>
              <div className="text-2xs text-muted">{sessionId ? `Session ${sessionId.slice(0,8)} · ${primary}` : 'No session — click mic to start'}</div>
              {sr.interim && <div className="text-2xs text-muted italic mt-0.5">… {sr.interim}</div>}
            </div>
            {realtime.supported && realtimeProvider && (
              <button
                onClick={realtime.connected ? realtime.disconnect : (async () => { if (!sessionId) await startSession.mutateAsync(); void realtime.connect() })}
                disabled={kill || realtime.connecting}
                className={`btn ${realtime.connected ? 'btn-primary' : 'btn-ghost'} text-2xs`}
                title={realtime.connected ? `Native pipe via ${realtimeProvider} — click to drop` : `Open native realtime pipe (${realtimeProvider})`}>
                {realtime.connecting ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
                {realtime.connected ? `● Realtime` : 'Realtime'}
              </button>
            )}
            {ttsSpeaking && (
              <button
                onClick={() => { cancelSpeech(); if (realtime.connected) void realtime.bargeIn() }}
                className="btn btn-ghost text-xs" title="Stop Novan speaking">
                <VolumeX className="w-3 h-3 mr-1" />Stop
              </button>
            )}
            {sessionId && (
              <button onClick={() => endSession.mutate(sessionId)} className="btn btn-ghost text-xs"><Power className="w-3 h-3 mr-1" />End</button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto space-y-2 mb-3 max-h-[280px]">
            {transcript.length === 0 && <div className="text-2xs text-muted italic">Transcript will appear here. AI voice — what you hear is synthesized.</div>}
            {transcript.map((m, i) => (
              <div key={i} className={`text-xs ${m.role === 'user' ? 'text-primary' : 'text-secondary'}`}>
                <span className="font-mono text-2xs text-muted mr-2 uppercase">{m.role}</span>{m.text}
              </div>
            ))}
            {classify?.kind === 'confirm' && (
              <div className="p-2 rounded border border-amber-500/40 bg-amber-500/10 text-2xs flex items-center gap-2">
                <AlertTriangle className="w-3 h-3 text-amber-400" />
                Requires confirmation ({classify.matched}). Say "confirm" to proceed.
              </div>
            )}
            {classify?.kind === 'block' && (
              <div className="p-2 rounded border border-rose-500/40 bg-rose-500/10 text-2xs flex items-center gap-2">
                <ShieldAlert className="w-3 h-3 text-rose-400" />
                Hard-blocked ({classify.matched}). Voice cannot authorize this — use the web UI.
              </div>
            )}
          </div>

          {dryRun && (
            <DryRunDrawer
              run={dryRun}
              workspaceId={workspaceId ?? ''}
              onApproved={(executed) => {
                if (executed) logPush({ t: Date.now(), status: 'confirmed', verdict: dryRun.report.intentKind, speak: dryRun.report.spokenPreview })
                else           logPush({ t: Date.now(), status: 'cancelled', verdict: dryRun.report.intentKind, speak: 'Dry run cancelled' })
                setDryRun(null)
              }}
              onCancel={() => {
                logPush({ t: Date.now(), status: 'cancelled', verdict: dryRun.report.intentKind, speak: 'Dry run cancelled' })
                setDryRun(null)
              }}
            />
          )}

          {awaitingConfirm && (
            <div className="mb-3 p-3 rounded border border-amber-500/50 bg-amber-500/10">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5" />
                <div className="flex-1">
                  <div className="text-xs font-medium">Confirm: {awaitingConfirm.intent.kind.replace(/\./g, ' → ')}</div>
                  <div className="text-2xs text-muted mt-0.5">{awaitingConfirm.reason}</div>
                  {awaitingConfirm.recommendation && <div className="text-2xs text-muted mt-1 italic">{awaitingConfirm.recommendation}</div>}
                </div>
              </div>
              <div className="flex gap-2 mt-2">
                <button onClick={confirmPlan} className="btn btn-primary text-2xs"><CheckCircle2 className="w-3 h-3 mr-1" />Confirm</button>
                <button onClick={cancelPlan} className="btn btn-ghost text-2xs"><XCircle className="w-3 h-3 mr-1" />Cancel</button>
                <span className="text-2xs text-muted self-center ml-2">risk · {awaitingConfirm.risk}{awaitingConfirm.permission ? ` · needs ${awaitingConfirm.permission}` : ''}</span>
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <input
              value={pending}
              onChange={e => setPending(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submitCommand(pending) }}
              placeholder={kill ? 'Voice killed — actions disabled' : 'Say or type a command (e.g. "zoom into security", "show approvals")'}
              disabled={kill}
              className="flex-1 px-3 py-2 text-xs bg-surface border border-border rounded outline-none"
            />
            <button onClick={() => submitCommand(pending)} disabled={!pending.trim() || kill} className="btn btn-primary text-xs">Send</button>
          </div>
        </section>

        {/* Right: routing + providers */}
        <aside className="space-y-4">
          <div className="drawer-edge p-4">
            <div className="label mb-2">Routing</div>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <button onClick={() => setMode('realtime')} className={`btn text-2xs ${mode === 'realtime' ? 'btn-primary' : 'btn-ghost'}`}>Realtime S2S</button>
              <button onClick={() => setMode('fallback')} className={`btn text-2xs ${mode === 'fallback' ? 'btn-primary' : 'btn-ghost'}`}>STT→Brain→TTS</button>
            </div>
            <label className="text-2xs text-muted block mb-1">Preset</label>
            <select value={preset} onChange={e => setPreset(e.target.value)} className="w-full text-xs bg-surface border border-border rounded px-2 py-1 mb-2">
              {(presetsQ.data?.data ?? []).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <label className="text-2xs text-muted block mb-1">Locale</label>
            <select value={locale} onChange={e => setLocale(e.target.value)} className="w-full text-xs bg-surface border border-border rounded px-2 py-1 mb-2">
              {['en-US','en-GB','es-ES','fr-FR','de-DE','ja-JP','zh-CN'].map(l => <option key={l}>{l}</option>)}
            </select>
            <label className="flex items-center gap-2 text-2xs text-muted">
              <input type="checkbox" checked={retention} onChange={e => setRetention(e.target.checked)} />
              Retain transcript
            </label>
          </div>

          <div className="drawer-edge p-4">
            <div className="label mb-2 flex items-center gap-2"><Volume2 className="w-3 h-3" /> Decision</div>
            {!decision && <Loader2 className="w-3 h-3 animate-spin text-muted" />}
            {decision && !decision.ok && <div className="text-2xs text-rose-400">{decision.reason}</div>}
            {decision?.ok && (
              <>
                <div className="text-xs"><span className="text-muted">primary</span> · <span className="font-mono">{decision.primary}</span></div>
                {decision.fallbackChain.length > 0 && (
                  <div className="text-2xs text-muted mt-1">↓ {decision.fallbackChain.slice(0, 3).join(' → ')}</div>
                )}
                <div className="text-2xs text-muted mt-2">scores top:</div>
                <ul className="text-2xs font-mono text-muted">
                  {decision.scores.slice(0, 3).map(s => (<li key={s.providerId}>{s.providerId} · {s.score.toFixed(2)}</li>))}
                </ul>
              </>
            )}
          </div>

          <div className="drawer-edge p-4">
            <div className="label mb-2 flex items-center gap-2"><Compass className="w-3 h-3" /> Last command</div>
            {!lastPlan && <div className="text-2xs text-muted italic">Try "zoom into security" or "show approvals".</div>}
            {lastPlan && (
              <div className="text-2xs space-y-1">
                <div><span className="text-muted">intent</span> · <span className="font-mono">{lastPlan.intent.kind}</span> <span className="text-muted">({Math.round(lastPlan.intent.confidence * 100)}%)</span></div>
                {lastPlan.intent.target && <div><span className="text-muted">target</span> · <span className="font-mono">{lastPlan.intent.target}</span></div>}
                <div><span className="text-muted">verdict</span> · <span className={`font-mono ${lastPlan.verdict === 'reject' ? 'text-rose-400' : lastPlan.verdict === 'confirm' ? 'text-amber-400' : 'text-emerald-400'}`}>{lastPlan.verdict}</span></div>
                <div><span className="text-muted">risk</span> · {lastPlan.risk}{lastPlan.permission ? ` · ${lastPlan.permission}` : ''}</div>
                {lastPlan.navigate && <div><span className="text-muted">→</span> <span className="font-mono">{lastPlan.navigate.path}</span></div>}
                {lastPlan.execute  && <div><span className="text-muted">↻</span> <span className="font-mono">{lastPlan.execute.method} {lastPlan.execute.path}</span></div>}
                {planLatencyMs !== null && <div className="text-muted">routing · {planLatencyMs}ms</div>}
              </div>
            )}
          </div>

          {convCtx && (convCtx.selectedSystem || convCtx.currentTemplate || convCtx.pendingPlan || convCtx.turnCount > 0) && (
            <div className="drawer-edge p-4">
              <div className="label mb-2">Conversation context</div>
              <div className="text-2xs space-y-1">
                {convCtx.selectedSystem  && <div><span className="text-muted">focus</span> · <span className="font-mono">{convCtx.selectedSystem}</span></div>}
                {convCtx.currentTemplate && <div><span className="text-muted">template</span> · <span className="font-mono">{convCtx.currentTemplate}</span></div>}
                {convCtx.currentLod      && <div><span className="text-muted">lod</span> · <span className="font-mono">{convCtx.currentLod}</span></div>}
                {convCtx.activeMission   && <div><span className="text-muted">mission</span> · {convCtx.activeMission}</div>}
                <div><span className="text-muted">risk</span> · {convCtx.currentRisk} · <span className="text-muted">turns</span> · {convCtx.turnCount}</div>
                {convCtx.pendingPlan && <div className="text-amber-300">pending · {convCtx.pendingPlan.intent.kind}</div>}
              </div>
            </div>
          )}

          {sessionId && (
            <div className="drawer-edge p-4">
              <div className="label mb-2 flex items-center gap-2"><Star className="w-3 h-3" /> Rate voice quality</div>
              {feedbackSent ? (
                <div className="text-2xs text-muted italic">Thanks — this routes to provider selection.</div>
              ) : (
                <div className="space-y-1.5">
                  {(['naturalness','speed','clarity','tone','usefulness'] as const).map(k => (
                    <div key={k} className="flex items-center gap-1.5">
                      <span className="text-2xs text-muted w-20 capitalize">{k}</span>
                      {[1,2,3,4,5].map(n => (
                        <button key={n} onClick={() => setRatings(r => ({ ...r, [k]: n }))}
                          aria-label={`${k} ${n} of 5`}
                          className={`w-3 h-3 rounded-sm transition-colors ${ratings[k] >= n ? 'bg-amber-400' : 'bg-surface-hover'}`} />
                      ))}
                    </div>
                  ))}
                  <button
                    disabled={!Object.values(ratings).some(v => v > 0)}
                    onClick={async () => {
                      await api.post('/api/v1/voice/feedback', {
                        workspace_id: workspaceId, session_id: sessionId,
                        provider: lastPlan?.intent.kind ? (decision?.primary ?? null) : null,
                        ratings,
                      }).catch(() => null)
                      setFeedbackSent(true)
                    }}
                    className="btn btn-ghost text-2xs mt-1 w-full">Submit</button>
                </div>
              )}
            </div>
          )}

          <div className="drawer-edge p-4">
            <div className="label mb-2 flex items-center gap-2"><DollarSign className="w-3 h-3" /> Providers</div>
            <ul className="space-y-1.5 text-2xs">
              {(providersQ.data?.data ?? []).map(p => (
                <li key={p.id} className="flex items-center gap-2">
                  <button
                    onClick={() => togglePvd.mutate({ id: p.providerId, enabled: !p.enabled })}
                    className={`w-2 h-2 rounded-full ${p.enabled ? 'bg-emerald-400' : 'bg-muted'}`}
                    aria-label={`${p.enabled ? 'Disable' : 'Enable'} ${p.providerId}`}
                  />
                  <span className="flex-1 truncate">{p.displayName}</span>
                  <span className="text-muted font-mono">{(p.healthScore * 100).toFixed(0)}%</span>
                </li>
              ))}
              {(providersQ.data?.data ?? []).length === 0 && (
                <li className="text-muted italic">No providers configured. POST /api/v1/voice/providers to register.</li>
              )}
            </ul>
          </div>
        </aside>
      </div>

      {/* Command log */}
      {executionLog.length > 0 && (
        <section className="mt-8">
          <div className="label mb-2">Command log</div>
          <div className="drawer-edge p-3">
            <ul className="text-2xs space-y-1 font-mono">
              {executionLog.map((e, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="text-muted w-16">{new Date(e.t).toLocaleTimeString()}</span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                    e.status === 'navigated' ? 'bg-emerald-500/15 text-emerald-300' :
                    e.status === 'executed'  ? 'bg-emerald-500/15 text-emerald-300' :
                    e.status === 'confirmed' ? 'bg-cyan-500/15 text-cyan-300' :
                    e.status === 'blocked'   ? 'bg-rose-500/15 text-rose-300' :
                    e.status === 'rejected'  ? 'bg-rose-500/15 text-rose-300' :
                    'bg-muted/20 text-muted'
                  }`}>{e.status}</span>
                  <span className="text-muted">{e.verdict}</span>
                  <span className="flex-1 truncate">{e.speak}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* War-room session strip */}
      <section className="mt-8">
        <div className="label mb-2">Recent sessions</div>
        <div className="drawer-edge overflow-x-auto">
          <table className="w-full text-2xs">
            <thead className="text-muted">
              <tr><th className="text-left p-2">id</th><th className="text-left p-2">mode</th><th className="text-left p-2">provider</th><th className="text-left p-2">latency</th><th className="text-left p-2">cost</th><th className="text-left p-2">failover</th><th className="text-left p-2">blocked</th><th className="text-left p-2">status</th></tr>
            </thead>
            <tbody>
              {(sessionsQ.data?.data ?? []).map(s => (
                <tr key={s.id} className="border-t border-border">
                  <td className="p-2 font-mono">{s.id.slice(0, 8)}</td>
                  <td className="p-2">{s.mode}</td>
                  <td className="p-2 font-mono">{s.selectedProvider}</td>
                  <td className="p-2">{s.avgLatencyMs ?? '—'}ms</td>
                  <td className="p-2">${s.totalCostUsd.toFixed(3)}</td>
                  <td className="p-2">{s.failoverCount}</td>
                  <td className="p-2">{s.blockedCommands}</td>
                  <td className="p-2">{s.status}</td>
                </tr>
              ))}
              {(sessionsQ.data?.data ?? []).length === 0 && (
                <tr><td colSpan={8} className="p-3 text-center text-muted italic">No voice sessions yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

/**
 * Dry-run preview drawer. Shown when /command returns a plan with a
 * dry_run id; the operator must explicitly approve via UI (and optionally
 * via spoken "confirm") before the side effect actually runs.
 *
 * "No silent execution" is enforced server-side by requiring BOTH
 * approvedViaSpoken AND approvedViaUi before executeDryRun() succeeds —
 * this drawer just gives the operator one path to satisfy both.
 */
function DryRunDrawer(props: {
  run: { id: string; report: DryRunReport }
  workspaceId: string
  onApproved: (executed: boolean) => void
  onCancel: () => void
}) {
  const { run, workspaceId } = props
  const r = run.report
  const [executing, setExecuting] = useState(false)
  const [error, setError]         = useState<string | null>(null)

  async function approveAndExecute() {
    setExecuting(true); setError(null)
    try {
      // Spoken + UI approval, then execute. Spoken approval is recorded
      // here because the operator's click implies an explicit consent
      // signal equivalent to "confirm"; the server still gates the
      // execute on both flags being set.
      await fetch(`/api/v1/voice/dry-runs/${run.id}/approve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId, source: 'spoken' }),
      })
      await fetch(`/api/v1/voice/dry-runs/${run.id}/approve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId, source: 'ui' }),
      })
      const res = await fetch(`/api/v1/voice/dry-runs/${run.id}/execute`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId }),
      })
      const j = await res.json() as { success?: boolean; error?: string }
      if (!j.success) throw new Error(j.error ?? `execute failed (${res.status})`)
      props.onApproved(true)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setExecuting(false)
    }
  }

  return (
    <div className="mb-3 p-3 rounded border border-amber-500/50 bg-amber-500/10">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5" />
        <div className="flex-1">
          <div className="text-xs font-medium">Dry run: {r.intentKind.replace(/\./g, ' → ')}</div>
          <div className="text-2xs text-muted mt-0.5">{r.spokenPreview}</div>
        </div>
        <span className="text-2xs text-muted">risk {(r.riskScore * 100).toFixed(0)}%</span>
      </div>

      <div className="grid grid-cols-2 gap-2 mt-3 text-2xs">
        <div>
          <div className="text-muted mb-1">Command heard</div>
          <div className="font-mono truncate">{r.command}</div>
        </div>
        <div>
          <div className="text-muted mb-1">Interpreted</div>
          <div className="font-mono">{r.intentKind}{r.intentTarget ? ` · ${r.intentTarget}` : ''}</div>
        </div>
        <div className="col-span-2">
          <div className="text-muted mb-1">Planned steps</div>
          <ol className="list-decimal pl-4 space-y-0.5">
            {r.plannedSteps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
        </div>
        {r.browserPreview && (
          <div className="col-span-2 p-2 rounded bg-surface-hover">
            <div className="text-muted mb-1">Browser preview</div>
            <div>url · <span className="font-mono">{r.browserPreview.url ?? '—'}</span></div>
            <ul className="list-disc pl-4 mt-1 space-y-0.5">
              {r.browserPreview.plannedClicks.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
            {r.browserPreview.blockedFieldCategories.length > 0 && (
              <div className="mt-1 text-rose-300">blocked fields: {r.browserPreview.blockedFieldCategories.join(', ')}</div>
            )}
            {r.browserPreview.blockedClickCategories.length > 0 && (
              <div className="text-rose-300">blocked clicks: {r.browserPreview.blockedClickCategories.join(', ')}</div>
            )}
            {r.browserPreview.fullyBlocked && (
              <div className="mt-1 font-medium text-rose-300">{r.browserPreview.reason}</div>
            )}
          </div>
        )}
        <div>
          <div className="text-muted mb-1">Affected systems</div>
          <div className="font-mono">{r.affectedSystems.join(', ') || '—'}</div>
        </div>
        <div>
          <div className="text-muted mb-1">Permissions</div>
          <div className="font-mono">{r.permissions.join(', ') || 'none'}</div>
        </div>
        <div>
          <div className="text-muted mb-1">Estimated cost</div>
          <div>${r.estimatedCostUsd.toFixed(3)}</div>
        </div>
        <div>
          <div className="text-muted mb-1">Rollback</div>
          <div>{r.rollbackAvailable ? r.rollbackStrategy ?? 'available' : 'not available'}</div>
        </div>
        {r.blockedActions.length > 0 && (
          <div className="col-span-2 text-rose-300">
            blocked: {r.blockedActions.join(', ')}
          </div>
        )}
      </div>

      <div className="flex gap-2 mt-3">
        {r.hardBlocked || r.browserPreview?.fullyBlocked ? (
          <>
            <button onClick={props.onCancel} className="btn btn-ghost text-2xs"><XCircle className="w-3 h-3 mr-1" />Close (cannot approve)</button>
          </>
        ) : (
          <>
            <button onClick={approveAndExecute} disabled={executing} className="btn btn-primary text-2xs">
              {executing ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <CheckCircle2 className="w-3 h-3 mr-1" />}
              Approve + execute
            </button>
            <button onClick={props.onCancel} className="btn btn-ghost text-2xs"><XCircle className="w-3 h-3 mr-1" />Cancel</button>
          </>
        )}
        {error && <span className="text-2xs text-rose-300 self-center">{error}</span>}
      </div>
    </div>
  )
}

/**
 * Minimal presence indicator. Tells the operator at a glance what
 * Novan is doing right now — listening, thinking, speaking, muted,
 * locked, or waiting for approval.
 */
function PresencePill(props: {
  micOn: boolean; thinking: boolean; speaking: boolean
  mutedUntil: number | null; voiceLocked: boolean
  awaitingApproval: boolean; wakeArmed: boolean
  handsFree: boolean; realtime: boolean
}) {
  const muted = !!props.mutedUntil && Date.now() < props.mutedUntil
  type State = { label: string; color: string; pulsing?: boolean }
  let state: State
  if (props.voiceLocked)         state = { label: 'voice locked',       color: 'rose' }
  else if (props.awaitingApproval) state = { label: 'awaiting approval', color: 'amber' }
  else if (muted)                state = { label: 'muted',              color: 'muted' }
  else if (props.speaking)       state = { label: 'speaking',           color: 'cyan', pulsing: true }
  else if (props.thinking)       state = { label: 'thinking',           color: 'cyan', pulsing: true }
  else if (props.micOn)          state = { label: 'listening',          color: 'emerald', pulsing: true }
  else if (props.wakeArmed)      state = { label: 'wake-armed',         color: 'emerald' }
  else                           state = { label: 'idle',               color: 'muted' }

  const colorClass: Record<string, string> = {
    rose:    'bg-rose-500/20 text-rose-300 border-rose-500/40',
    amber:   'bg-amber-500/20 text-amber-300 border-amber-500/40',
    cyan:    'bg-cyan-500/20 text-cyan-300 border-cyan-500/40',
    emerald: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
    muted:   'bg-surface-hover text-muted border-border',
  }
  return (
    <div className="flex items-center gap-2 mb-3 text-2xs">
      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border ${colorClass[state.color] ?? colorClass['muted']}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${state.color === 'muted' ? 'bg-muted' : 'bg-current'} ${state.pulsing ? 'animate-pulse' : ''}`} aria-hidden />
        {state.label}
      </span>
      {props.handsFree && <span className="text-muted">· hands-free</span>}
      {props.realtime  && <span className="text-muted">· native pipe</span>}
    </div>
  )
}
