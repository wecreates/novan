/**
 * Talk — conversational interface to Novan.
 *
 * - Persistent conversations
 * - SSE streaming responses
 * - Identity audit shown per message (hype score, uncertainty handling)
 * - Citations link back to reasoning chains
 * - Sidebar with conversation history
 */
import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  MessageSquare, Send, Plus, Archive, CheckCircle2, AlertTriangle, FileText, Loader2,
  Hammer, ShieldAlert, XCircle, Settings, Square, RotateCcw, Paperclip, X, GitBranch, Download, Mic, MicOff,
  Volume2, VolumeX,
} from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'
import { useVoicePlayback } from '../hooks/useVoicePlayback.js'

interface Conversation {
  id: string; title: string; messageCount: number
  totalTokens: number; totalCostUsd: number
  createdAt: number; updatedAt: number
}
interface ChatMessage {
  id: string; role: 'user' | 'assistant' | 'system'
  content: string
  citations: Array<{ kind: string; id: string; extract: string }>
  attachments?: Array<{ url: string; mime: string; kind: 'image' | 'document' | 'reference'; name?: string; sizeBytes?: number }>
  audit: { passed?: boolean; hypeScore?: number; uncertaintyHandling?: string; factEstimateOk?: boolean; violations?: Array<{ kind: string; detail: string }> } | null
  tokens: number; costUsd: number
  provider: string | null; model: string | null
  streamComplete: boolean
  createdAt: number
  supersededAt: number | null
  supersededBy: string | null
  regeneratedFrom: string | null
  cancelled: boolean
}
interface ChatAction {
  id: string; messageId: string; actionType: string
  title: string; summary: string
  payload: Record<string, unknown>
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  status: 'suggested' | 'approved' | 'rejected' | 'executed' | 'failed'
  executedResult: Record<string, unknown> | null
}
interface ProviderInfo { id: string; family: string; model: string; enabled: boolean; hasKey: boolean; priority: number }

export default function TalkPage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [activeId, setActiveId] = useState<string | null>(null)
  // Pick up a seed message handed off from the global Ask-Novan bar so
  // the operator's typing isn't lost when navigating in from any page.
  const [input, setInput] = useState<string>(() => {
    try {
      const seed = sessionStorage.getItem('novan:seed-message') ?? ''
      if (seed) sessionStorage.removeItem('novan:seed-message')
      return seed
    } catch { return '' }
  })
  const [streaming, setStreaming] = useState(false)
  const [streamingContent, setStreamingContent] = useState('')
  const [streamingMeta, setStreamingMeta] = useState<{ audit?: ChatMessage['audit']; citations?: number; tokens?: number; costUsd?: number; policyBlocked?: string; cancelled?: boolean; provider?: string; model?: string; toolsDetected?: number; toolsCompleted?: number; videoAnalyzing?: number; musicReplicating?: number } | null>(null)
  // Provider override for the next message (null = let the router pick)
  const [preferProvider, setPreferProvider] = useState<string | null>(null)
  // Search across conversations
  const [searchQuery, setSearchQuery] = useState('')
  // Voice input — Web Speech API for STT. Recognized transcript fills
  // the input box; operator hits Enter to send.
  const [listening, setListening] = useState(false)
  const recRef = useRef<{ stop: () => void } | null>(null)
  const [showSuperseded, setShowSuperseded] = useState(false)
  const [regenerating, setRegenerating] = useState<string | null>(null)
  const [pendingAttachments, setPendingAttachments] = useState<Array<{ url: string; mime: string; kind: 'image' | 'document'; name?: string; sizeBytes?: number }>>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  // Voice playback — when an active profile is set, the assistant's
  // final response is spoken aloud in that voice via the TTS sidecar.
  const voice = useVoicePlayback()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const convs = useQuery({
    queryKey: ['conversations', workspaceId],
    queryFn: () => api.get<{ data: Conversation[] }>(`/api/v1/chat/conversations?workspace_id=${workspaceId}`),
    refetchInterval: 60_000,
  })

  const msgs = useQuery({
    queryKey: ['messages', workspaceId, activeId],
    queryFn: () => activeId
      ? api.get<{ data: ChatMessage[] }>(`/api/v1/chat/conversations/${activeId}/messages?workspace_id=${workspaceId}`)
      : Promise.resolve({ data: [] as ChatMessage[] }),
    enabled: !!activeId,
    refetchInterval: streaming ? false : 30_000,
  })

  const actions = useQuery({
    queryKey: ['chat-actions', workspaceId, activeId],
    queryFn: () => activeId
      ? api.get<{ data: ChatAction[] }>(`/api/v1/chat/conversations/${activeId}/actions?workspace_id=${workspaceId}`)
      : Promise.resolve({ data: [] as ChatAction[] }),
    enabled: !!activeId,
    refetchInterval: streaming ? false : 30_000,
  })

  const providers = useQuery({
    queryKey: ['chat-providers', workspaceId],
    queryFn: () => api.get<{ data: ProviderInfo[] }>(`/api/v1/chat/providers?workspace_id=${workspaceId}`),
    refetchInterval: 5 * 60_000,
  })

  const [showProviders, setShowProviders] = useState(false)

  const configureProvider = useMutation({
    mutationFn: ({ id, enabled, priority }: { id: string; enabled: boolean; priority?: number }) =>
      api.post(`/api/v1/chat/providers`, { workspace_id: workspaceId, provider_id: id, enabled, priority }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chat-providers', workspaceId] }),
  })

  const approveAction = useMutation({
    mutationFn: ({ id, token }: { id: string; token?: string }) =>
      api.post<{ data?: { result?: { result?: { navigateTo?: string } } } }>(
        `/api/v1/chat/actions/${id}/approve`,
        { workspace_id: workspaceId, ...(token ? { approval_token: token } : {}) },
      ),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['chat-actions', workspaceId, activeId] })
      // Honor `navigateTo` hint from action handlers (e.g. construct_business
      // returns navigateTo: '/brain' so the operator watches the spawn cascade).
      // Response shape: data.result is the dispatch return, .result is the
      // inner action result containing navigateTo.
      const nav = (r as { data?: { result?: { result?: { navigateTo?: string } } } })
        ?.data?.result?.result?.navigateTo
      if (nav && typeof nav === 'string' && nav.startsWith('/')) {
        navigate(nav)
      }
    },
  })
  const rejectAction = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/chat/actions/${id}/reject`, { workspace_id: workspaceId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chat-actions', workspaceId, activeId] }),
  })

  const createConv = useMutation({
    mutationFn: () => api.post<{ data: { id: string } }>(`/api/v1/chat/conversations`, { workspace_id: workspaceId, title: 'New conversation' }),
    onSuccess: (r) => {
      const id = (r as { data: { id: string } }).data.id
      setActiveId(id)
      qc.invalidateQueries({ queryKey: ['conversations', workspaceId] })
    },
  })

  const archive = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/chat/conversations/${id}/archive`, { workspace_id: workspaceId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversations', workspaceId] })
      setActiveId(null)
    },
  })

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [msgs.data, streamingContent])

  function stopStream() {
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
  }

  async function addAttachment(file: File) {
    setAttachError(null)
    if (pendingAttachments.length >= 6) {
      setAttachError('max 6 attachments per message'); return
    }
    if (file.size > 4_500_000) {
      setAttachError(`"${file.name}" too large (max ~4.5 MB)`); return
    }
    const isImage = /^image\/(png|jpe?g|webp|gif)$/i.test(file.type)
    const isDoc   = /^(application\/pdf|text\/plain|text\/markdown)$/i.test(file.type)
    if (!isImage && !isDoc) {
      setAttachError(`unsupported type: ${file.type || 'unknown'}`); return
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.onerror = () => reject(new Error('read failed'))
      r.readAsDataURL(file)
    }).catch(() => '')
    if (!dataUrl) { setAttachError('file read failed'); return }
    setPendingAttachments(prev => [...prev, {
      url: dataUrl, mime: file.type.toLowerCase(),
      kind: isImage ? 'image' : 'document',
      name: file.name, sizeBytes: file.size,
    }])
  }

  function removeAttachment(i: number) {
    setPendingAttachments(prev => prev.filter((_, idx) => idx !== i))
  }

  function toggleListening() {
    if (listening) {
      recRef.current?.stop()
      setListening(false)
      return
    }
    const w = window as unknown as { SpeechRecognition?: new () => unknown; webkitSpeechRecognition?: new () => unknown }
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
    if (!Ctor) { setAttachError('Voice input not supported in this browser.'); return }
    const rec = new Ctor() as {
      lang: string; continuous: boolean; interimResults: boolean
      onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
      onend:    (() => void) | null
      onerror:  ((e: unknown) => void) | null
      start: () => void; stop: () => void
    }
    rec.lang = 'en-US'
    rec.continuous = false
    rec.interimResults = false
    rec.onresult = (e) => {
      const transcript = e.results[0]?.[0]?.transcript ?? ''
      if (transcript) setInput(prev => prev ? `${prev} ${transcript}` : transcript)
    }
    rec.onend = () => setListening(false)
    rec.onerror = () => setListening(false)
    recRef.current = rec
    rec.start()
    setListening(true)
  }

  async function onPasteInComposer(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData?.files ?? [])
    if (files.length === 0) return
    e.preventDefault()
    for (const f of files) await addAttachment(f)
  }

  async function send(opts: { messageOverride?: string; regenerateFrom?: string } = {}) {
    const message = opts.messageOverride ?? input
    if ((!message.trim() && pendingAttachments.length === 0) || streaming) return

    // Slash commands — dispatch directly to brain-task instead of LLM round-trip.
    // Mirrors common operator phrases into the corresponding op.
    if (!opts.regenerateFrom && message.trim().startsWith('/')) {
      const parts = message.trim().slice(1).split(/\s+/)
      const cmd  = (parts[0] ?? '').toLowerCase()
      const arg  = parts.slice(1).join(' ').trim()
      const SLASH_MAP: Record<string, { op: string; params: Record<string, unknown> } | null> = {
        task:     arg ? { op: 'issue.create',       params: { symptom: arg, severity: 'info' } } : null,
        research: arg ? { op: 'code.search',        params: { pattern: arg } } : null,
        issues:   { op: 'db.query',                 params: { table: 'issues', minutes: 1440, limit: 20 } },
        safety:   { op: 'safety.flags',             params: {} },
        smoke:    { op: 'platform.smoke',           params: {} },
        mind:     { op: 'mind.cycle',               params: {} },
        loop:     { op: 'issue.auto_loop',          params: {} },
        ingest:   { op: 'issue.ingest',             params: {} },
        providers:{ op: 'providers.validate',       params: {} },
      }
      const action = SLASH_MAP[cmd] ?? null
      if (action) {
        setInput('')
        try {
          const r = await fetch(`/api/v1/brain/task`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspace_id: workspaceId, plan: [action] }),
          })
          const j = await r.json() as { success: boolean; data?: { summary?: string; results?: Array<{ ok: boolean; data?: unknown; error?: string }> } }
          let convId = activeId
          if (!convId) {
            const c = await api.post<{ data: { id: string } }>(`/api/v1/chat/conversations`, { workspace_id: workspaceId, title: `slash: /${cmd}` })
            convId = (c as { data: { id: string } }).data.id
            setActiveId(convId)
            qc.invalidateQueries({ queryKey: ['conversations', workspaceId] })
          }
          // Just refresh messages — the brain-task event was logged in events,
          // and the user gets immediate visual feedback via the messages re-fetch.
          void qc.invalidateQueries({ queryKey: ['messages', convId] })
          // Inline result as a system message banner via the streamingMeta
          const summary = j.data?.summary ?? (j.success ? 'ok' : 'failed')
          setStreamingMeta({ provider: 'brain-task', tokens: 0, costUsd: 0, toolsDetected: 1, toolsCompleted: 1 })
          setStreamingContent(`▸ /${cmd}\n\n${summary}`)
        } catch (e) {
          setStreamingContent(`▸ /${cmd} failed: ${(e as Error).message}`)
        }
        return
      }
    }
    let convId = activeId
    if (!convId) {
      const r = await api.post<{ data: { id: string } }>(`/api/v1/chat/conversations`, { workspace_id: workspaceId, title: message.slice(0, 60) })
      convId = (r as { data: { id: string } }).data.id
      setActiveId(convId)
      qc.invalidateQueries({ queryKey: ['conversations', workspaceId] })
    }

    const attachments = opts.regenerateFrom ? [] : pendingAttachments
    if (!opts.messageOverride) setInput('')
    if (!opts.regenerateFrom) setPendingAttachments([])
    setAttachError(null)
    setStreaming(true)
    setStreamingContent('')
    setStreamingMeta(null)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch(`/api/v1/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: workspaceId, conversation_id: convId, message,
          ...(opts.regenerateFrom ? { regenerate_from: opts.regenerateFrom } : {}),
          ...(attachments.length ? { attachments } : {}),
          ...(preferProvider ? { prefer_provider: preferProvider } : {}),
        }),
        signal: controller.signal,
      })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let acc = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const events = buf.split('\n\n')
        buf = events.pop() ?? ''
        for (const block of events) {
          if (!block.trim()) continue
          const lines = block.split('\n')
          let eventName = 'message', dataStr = ''
          for (const ln of lines) {
            if (ln.startsWith('event: ')) eventName = ln.slice(7).trim()
            else if (ln.startsWith('data: ')) dataStr = ln.slice(6)
          }
          try {
            const data = JSON.parse(dataStr || '{}')
            if (eventName === 'delta') {
              acc += data.content ?? ''
              setStreamingContent(acc)
            } else if (eventName === 'audit') {
              setStreamingMeta(prev => ({ ...(prev ?? {}), audit: data as ChatMessage['audit'] }))
            } else if (eventName === 'context_ready') {
              setStreamingMeta(prev => ({ ...(prev ?? {}), citations: data.citations }))
            } else if (eventName === 'policy_block') {
              setStreamingMeta(prev => ({ ...(prev ?? {}), policyBlocked: data.category }))
            } else if (eventName === 'video_analysis_started') {
              setStreamingMeta(prev => ({ ...(prev ?? {}), videoAnalyzing: data.count as number }))
              setStreamingContent('🎬 Brain is watching the video (pulling frames + transcript)…')
            } else if (eventName === 'video_analyzed') {
              const dd = data as { ok: boolean; url: string; title?: string; summary?: string; error?: string; framesAnalyzed?: number; visualCount?: number }
              if (dd.ok) {
                const visualNote = dd.framesAnalyzed && dd.framesAnalyzed > 0
                  ? `\n👁 Saw ${dd.framesAnalyzed} frames${dd.visualCount ? ` · ${dd.visualCount} visual highlights` : ''}`
                  : ''
                setStreamingContent(`✓ Watched: ${dd.title ?? dd.url}${visualNote}${dd.summary ? `\n${dd.summary}` : ''}\n\nThinking…`)
              } else {
                setStreamingContent(`⚠ Video at ${dd.url} — could not analyze (${dd.error ?? 'unknown'})\n\nProceeding without video context…`)
              }
            } else if (eventName === 'music_replication_started') {
              setStreamingMeta(prev => ({ ...(prev ?? {}), musicReplicating: data.count as number }))
              setStreamingContent('🎵 Brain is replicating the song (download → analyze → studio render)…')
            } else if (eventName === 'music_replicated') {
              const dd = data as { ok: boolean; url: string; title?: string; artist?: string; audioUrl?: string; bpm?: number; key?: string; error?: string }
              if (dd.ok) {
                const meta = [dd.bpm ? `${dd.bpm}bpm` : '', dd.key ? `key ${dd.key}` : ''].filter(Boolean).join(' · ')
                setStreamingContent(`✓ Replicated: ${dd.title ?? dd.url}${dd.artist ? ` — ${dd.artist}` : ''}${meta ? `\n${meta}` : ''}${dd.audioUrl ? `\n🔊 ${dd.audioUrl}` : ''}\n\nThinking…`)
              } else {
                setStreamingContent(`⚠ Song at ${dd.url} — replication failed (${dd.error ?? 'unknown'})\n\nProceeding without music context…`)
              }
            } else if (eventName === 'provider') {
              setStreamingMeta(prev => ({ ...(prev ?? {}), provider: data.provider, model: data.model }))
            } else if (eventName === 'tools_detected') {
              setStreamingMeta(prev => ({ ...(prev ?? {}), toolsDetected: data.count, toolsCompleted: 0 }))
            } else if (eventName === 'tools_completed') {
              setStreamingMeta(prev => ({ ...(prev ?? {}), toolsCompleted: Array.isArray(data.results) ? data.results.length : 0 }))
            } else if (eventName === 'done') {
              setStreamingMeta(prev => ({ ...(prev ?? {}), tokens: data.tokens, costUsd: data.costUsd }))
              // Speak the finalized assistant turn in the active voice
              // profile. No-op when the sidecar is offline or no active
              // profile is set — chat stays text-only in that case.
              if (voice.available && acc.trim().length > 0) {
                void voice.speak(acc)
              }
            } else if (eventName === 'cancelled') {
              setStreamingMeta(prev => ({ ...(prev ?? {}), cancelled: true }))
              acc += '\n\n_(stopped by operator)_'
              setStreamingContent(acc)
            } else if (eventName === 'error') {
              acc += `\n\n_(error: ${data.error ?? data.reason ?? 'unknown'})_`
              setStreamingContent(acc)
            }
          } catch { /* tolerate */ }
        }
      }
    } catch (e) {
      const err = e as Error
      if (err.name === 'AbortError') {
        // Operator hit Stop; the SSE socket close triggers the server's
        // cancelled-event path. Treat this branch as a clean stop.
        setStreamingContent(prev => prev + '\n\n_(stopped by operator)_')
      } else {
        setStreamingContent(prev => prev + `\n\n_(stream error: ${err.message})_`)
      }
    } finally {
      abortRef.current = null
      setStreaming(false)
      setRegenerating(null)
      // Refresh messages from server (final persisted state)
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ['messages', workspaceId, convId] })
        setStreamingContent('')
        setStreamingMeta(null)
      }, 500)
    }
  }

  async function branchFrom(messageId: string) {
    if (!activeId || streaming) return
    try {
      const r = await api.post<{ data: { id: string; copied: number } }>(
        `/api/v1/chat/conversations/${activeId}/fork`,
        { workspace_id: workspaceId, fork_point_message_id: messageId },
      ) as { data: { id: string; copied: number } }
      qc.invalidateQueries({ queryKey: ['conversations', workspaceId] })
      setActiveId(r.data.id)
    } catch (e) {
      setStreamingContent(`_(branch failed: ${(e as Error).message})_`)
    }
  }

  async function regenerate(assistantMsgId: string) {
    if (streaming) return
    setRegenerating(assistantMsgId)
    try {
      const r = await api.post<{ data: { conversationId: string; userMessage: string; regenerateFrom: string } }>(
        `/api/v1/chat/messages/${assistantMsgId}/regenerate`,
        { workspace_id: workspaceId },
      )
      await send({ messageOverride: r.data.userMessage, regenerateFrom: r.data.regenerateFrom })
    } catch (e) {
      setRegenerating(null)
      setStreamingContent(`_(regenerate failed: ${(e as Error).message})_`)
    }
  }

  return (
    <div className="flex h-[calc(100vh-3rem)]">
      {/* Sidebar */}
      <aside className="w-64 border-r border-border bg-surface flex flex-col">
        <div className="p-3 border-b border-border flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-sky-400" />
          <span className="text-sm font-medium">Conversations</span>
          <button onClick={() => createConv.mutate()} className="ml-auto p-1 rounded hover:bg-[var(--surface-hover)]" title="New">
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
        {/* Search across all conversation message bodies */}
        <div className="p-2 border-b border-border">
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search messages…"
            className="w-full text-xs px-2 py-1 bg-[var(--bg-elevated)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--border-glow)]"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {searchQuery.trim().length >= 2 ? (
            <ChatSearchResults
              workspaceId={workspaceId} q={searchQuery.trim()}
              onPick={(convId) => { setActiveId(convId); setSearchQuery('') }}
            />
          ) : (
            <>
              {(convs.data?.data ?? []).map(c => (
                <button key={c.id} onClick={() => setActiveId(c.id)}
                  className={`w-full text-left px-3 py-2 text-xs border-b border-border hover:bg-[var(--surface-hover)] ${activeId === c.id ? 'bg-sky-500/10' : ''}`}>
                  <div className="flex items-center gap-1">
                    <span className="flex-1 truncate">{c.title}</span>
                    <button onClick={(e) => { e.stopPropagation(); archive.mutate(c.id) }} className="opacity-0 hover:opacity-100 p-0.5">
                      <Archive className="w-3 h-3 text-muted" />
                    </button>
                  </div>
                  <div className="text-[10px] text-muted mt-0.5">
                    {c.messageCount} msgs · ${c.totalCostUsd.toFixed(4)}
                  </div>
                </button>
              ))}
              {(convs.data?.data ?? []).length === 0 && (
                <div className="px-3 py-4 text-[10px] text-muted italic">No conversations yet.</div>
              )}
            </>
          )}
        </div>
        {/* Branches of the active conversation */}
        {activeId && <ConversationBranches workspaceId={workspaceId} conversationId={activeId} onPick={setActiveId} />}
      </aside>

      {/* Main thread */}
      <main className="flex-1 flex flex-col">
        <header className="px-4 py-2.5 border-b border-border flex items-center gap-2.5">
          <MessageSquare className="w-4 h-4 text-emerald-400" />
          <div className="flex items-baseline gap-2 min-w-0">
            <h1 className="text-sm font-medium leading-none">Talk to Novan</h1>
            <span className="text-[10px] text-muted truncate">memory · audit · citations · approval-gated actions</span>
          </div>
          <div className="ml-auto flex items-center gap-1">
            {activeId && (
              <div className="inline-flex items-center bg-[var(--bg-elevated)] border border-[var(--border)] rounded-md p-0.5 mr-1">
                <a href={`/api/v1/chat/conversations/${activeId}/export?workspace_id=${workspaceId}&format=md`}
                   download
                   className="px-2 py-0.5 rounded text-[10px] text-muted hover:text-primary hover:bg-[var(--surface-hover)] flex items-center gap-1 focus-ring"
                   title="Download as Markdown">
                  <Download className="w-3 h-3" /> md
                </a>
                <a href={`/api/v1/chat/conversations/${activeId}/export?workspace_id=${workspaceId}&format=json`}
                   download
                   className="px-2 py-0.5 rounded text-[10px] text-muted hover:text-primary hover:bg-[var(--surface-hover)] flex items-center gap-1 focus-ring"
                   title="Download as JSON">
                  <Download className="w-3 h-3" /> json
                </a>
              </div>
            )}
            <a href="/voice-profiles"
              title={voice.available ? 'Voice profile active — assistant replies will speak' : 'No active voice profile · click to configure'}
              className={`p-1.5 rounded hover:bg-[var(--surface-hover)] focus-ring transition-colors ${voice.available ? 'text-[var(--accent-active)]' : 'text-muted'}`}>
              {voice.available ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
            </a>
            <button onClick={() => setShowProviders(s => !s)}
              className={`p-1.5 rounded hover:bg-[var(--surface-hover)] focus-ring transition-colors ${showProviders ? 'bg-[var(--surface-hover)] text-primary' : 'text-muted'}`}
              title="LLM Providers"
              aria-pressed={showProviders}>
              <Settings className="w-3.5 h-3.5" />
            </button>
          </div>
        </header>

        {showProviders && providers.data?.data && (
          <div className="border-b border-border bg-surface p-3 max-h-60 overflow-y-auto">
            <div className="text-xs font-medium mb-2 flex items-center gap-1.5">
              <Settings className="w-3.5 h-3.5" /> LLM Providers
              <span className="text-[10px] text-muted font-normal ml-1">enable + key needed to use</span>
            </div>
            <ul className="space-y-1">
              {providers.data.data.map(p => (
                <li key={p.id} className="flex items-center gap-2 text-xs">
                  <span className={`text-[10px] ${p.hasKey ? 'text-emerald-400' : 'text-slate-500'}`}>
                    {p.hasKey ? '●' : '○'}
                  </span>
                  <span className="font-mono w-20">{p.id}</span>
                  <span className="text-muted text-[10px]">{p.family}</span>
                  <span className="text-muted text-[10px] truncate flex-1">{p.model}</span>
                  <button onClick={() => configureProvider.mutate({ id: p.id, enabled: !p.enabled })}
                    disabled={!p.hasKey}
                    className={`text-[10px] px-1.5 py-0.5 rounded ${p.enabled ? 'bg-emerald-500/15 text-emerald-300' : 'border border-border text-muted'} disabled:opacity-30`}>
                    {p.enabled ? 'enabled' : 'enable'}
                  </button>
                </li>
              ))}
            </ul>
            <p className="text-[10px] text-muted mt-2">
              ●=key set · ○=set env var (GROQ_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, TOGETHER_API_KEY, MISTRAL_API_KEY, DEEPSEEK_API_KEY, FIREWORKS_API_KEY, CEREBRAS_API_KEY)
            </p>
          </div>
        )}

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
          {!activeId ? (
            <div className="text-center text-sm text-muted mt-12">
              <p>Start a new conversation, or pick one from the sidebar.</p>
              <p className="text-[10px] mt-2">Every turn injects active horizons, recent decisions, drift warnings, and pending proposals.</p>
            </div>
          ) : (
            <>
              {(() => {
                const all = msgs.data?.data ?? []
                const visible = showSuperseded ? all : all.filter(m => !m.supersededAt)
                const supersededCount = all.length - visible.length
                // Last non-superseded assistant gets the Regenerate button
                const lastAsstId = [...visible].reverse().find(m => m.role === 'assistant')?.id ?? null
                return (
                  <>
                    {supersededCount > 0 && (
                      <button onClick={() => setShowSuperseded(s => !s)}
                        className="text-[10px] text-muted hover:text-primary mb-1">
                        {showSuperseded ? `Hide ${supersededCount} superseded` : `Show ${supersededCount} superseded`}
                      </button>
                    )}
                    {visible.map(m => {
                      const msgActions = (actions.data?.data ?? []).filter(a => a.messageId === m.id)
                      return (
                        <div key={m.id} className="group">
                          <MessageBubble m={m} />
                          <div className="ml-4 mt-1 flex items-center gap-2">
                            {m.role === 'assistant' && m.id === lastAsstId && !streaming && (
                              <button onClick={() => regenerate(m.id)}
                                disabled={regenerating === m.id}
                                className="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted hover:bg-[var(--surface-hover)] flex items-center gap-1">
                                <RotateCcw className="w-3 h-3" />{regenerating === m.id ? 'regenerating…' : 'regenerate'}
                              </button>
                            )}
                            {!streaming && !m.supersededAt && (
                              <button onClick={() => branchFrom(m.id)}
                                title="Branch a new conversation from this point"
                                className="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted hover:bg-[var(--surface-hover)] flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                <GitBranch className="w-3 h-3" />branch
                              </button>
                            )}
                            {m.cancelled && <span className="text-[10px] text-amber-400">stopped</span>}
                          </div>
                          {msgActions.length > 0 && (
                            <div className="ml-4 mt-2 space-y-2">
                              {msgActions.map(a => (
                                <ActionCard key={a.id} a={a}
                                  onApprove={(token) => approveAction.mutate({ id: a.id, ...(token ? { token } : {}) })}
                                  onReject={() => rejectAction.mutate(a.id)}
                                  pending={approveAction.isPending || rejectAction.isPending} />
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </>
                )
              })()}
              {streaming && (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm">
                  <div className="flex items-center gap-2 text-[10px] text-emerald-300 mb-1">
                    <Loader2 className="w-3 h-3 animate-spin" /> Novan (streaming…)
                    {streamingMeta?.citations !== undefined && <span className="text-muted">· {streamingMeta.citations} citations</span>}
                    <button onClick={stopStream}
                      className="ml-auto text-[10px] px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-300 hover:bg-amber-500/15 flex items-center gap-1"
                      title="Stop generation">
                      <Square className="w-3 h-3" />stop
                    </button>
                  </div>
                  <pre className="whitespace-pre-wrap font-sans">{streamingContent || '…'}</pre>
                </div>
              )}
            </>
          )}
        </div>

        <form onSubmit={(e) => { e.preventDefault(); void send() }}
          className="border-t border-border p-3 flex flex-col gap-2">
          {(pendingAttachments.length > 0 || attachError) && (
            <div className="flex flex-col gap-1.5">
              {attachError && (
                <div className="text-[11px] text-[var(--accent-critical)] flex items-center gap-1.5">
                  <AlertTriangle className="w-3 h-3" /> {attachError}
                </div>
              )}
              {pendingAttachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {pendingAttachments.map((a, i) => (
                    <div key={i} className="group border border-border rounded-md bg-[var(--bg-elevated)] pl-1 pr-1.5 py-1 flex items-center gap-1.5 text-[11px] hover:border-[var(--border-strong)] transition-colors">
                      {a.kind === 'image'
                        ? <img src={a.url} alt="" className="w-7 h-7 object-cover rounded" />
                        : <FileText className="w-4 h-4 text-muted ml-1" />}
                      <span className="max-w-[140px] truncate">{a.name ?? a.mime}</span>
                      <button type="button" onClick={() => removeAttachment(i)}
                        className="ml-0.5 p-0.5 rounded text-muted hover:text-primary hover:bg-[var(--surface-hover)] focus-ring"
                        aria-label={`Remove ${a.name ?? a.mime}`}>
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="flex gap-2 items-end">
            <input ref={fileInputRef} type="file" multiple
              accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/markdown"
              onChange={(e) => {
                const fs = Array.from(e.target.files ?? [])
                Promise.all(fs.map(addAttachment)).finally(() => { if (fileInputRef.current) fileInputRef.current.value = '' })
              }}
              className="hidden" />
            <button type="button" onClick={() => fileInputRef.current?.click()}
              disabled={streaming || pendingAttachments.length >= 6}
              title={pendingAttachments.length >= 6 ? 'Max 6 attachments' : 'Attach image or document'}
              className="h-[44px] w-[40px] flex items-center justify-center rounded-md border border-border hover:bg-[var(--surface-hover)] hover:border-[var(--border-strong)] disabled:opacity-40 disabled:cursor-not-allowed text-muted hover:text-primary transition-colors focus-ring">
              <Paperclip className="w-3.5 h-3.5" />
            </button>
            <button type="button" onClick={toggleListening}
              disabled={streaming}
              title={listening ? 'Stop listening' : 'Voice input'}
              className={`h-[44px] w-[40px] flex items-center justify-center rounded-md border transition-colors focus-ring ${listening ? 'border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent)]' : 'border-border hover:bg-[var(--surface-hover)] hover:border-[var(--border-strong)] text-muted hover:text-primary'} disabled:opacity-40 disabled:cursor-not-allowed`}>
              {listening ? <Mic className="w-3.5 h-3.5 animate-pulse" /> : <MicOff className="w-3.5 h-3.5" />}
            </button>
            <div className="flex-1 relative">
              <textarea value={input} onChange={(e) => setInput(e.target.value)}
                onPaste={onPasteInComposer}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
                placeholder="Ask Novan anything — about runtime state, strategy, code, costs, decisions…"
                disabled={streaming}
                className="w-full bg-[var(--bg-surface)] border border-border rounded-md px-3 py-2.5 text-sm font-sans resize-none disabled:opacity-50 focus:outline-none focus:border-[var(--border-glow)] focus:bg-[var(--bg-elevated)] transition-colors"
                rows={2} />
              <div className="absolute right-2 bottom-1.5 text-[9px] text-[var(--text-faint)] pointer-events-none select-none">
                <kbd className="font-mono">↵</kbd> send · <kbd className="font-mono">⇧↵</kbd> newline
              </div>
            </div>
            <button type="submit" disabled={streaming || (!input.trim() && pendingAttachments.length === 0)}
              className="h-[44px] px-4 text-sm rounded-md bg-sky-500/20 border border-sky-500/40 hover:bg-sky-500/30 hover:border-sky-500/60 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 transition-colors focus-ring">
              {streaming ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              <span>Send</span>
            </button>
          </div>

          {/* Below the composer: provider override + slash hints + live cost */}
          <div className="flex items-center gap-3 mt-2 text-[10px] text-[var(--text-muted)]">
            <label className="flex items-center gap-1">
              <span>Provider:</span>
              <select
                value={preferProvider ?? ''}
                onChange={(e) => setPreferProvider(e.target.value || null)}
                disabled={streaming}
                className="bg-[var(--bg-surface)] border border-[var(--border)] rounded px-1 py-0.5 text-[10px] focus:outline-none focus:border-[var(--border-glow)]">
                <option value="">Auto (router)</option>
                {providers.data?.data?.filter(p => p.enabled && p.hasKey).map(p => (
                  <option key={p.id} value={p.id}>{p.id} · {p.model}</option>
                ))}
              </select>
            </label>
            <span className="text-[var(--text-faint)]">
              Slash: <code>/task</code> <code>/research</code> <code>/issues</code> <code>/safety</code> <code>/smoke</code>
            </span>
            {streaming && streamingMeta && (streamingMeta.tokens || streamingMeta.costUsd) && (
              <span className="ml-auto text-[var(--info)]">
                {streamingMeta.provider && `${streamingMeta.provider} · `}
                {streamingMeta.tokens ?? 0} tok · ${(streamingMeta.costUsd ?? 0).toFixed(5)}
              </span>
            )}
            {streaming && streamingMeta?.toolsDetected ? (
              <span className="text-[var(--accent)]">⚙ {streamingMeta.toolsCompleted ?? 0}/{streamingMeta.toolsDetected} tools</span>
            ) : null}
          </div>
        </form>
      </main>
    </div>
  )
}

function ActionCard({ a, onApprove, onReject, pending }: {
  a: ChatAction
  onApprove: (token?: string) => void
  onReject: () => void
  pending: boolean
}) {
  const riskColor = {
    low:      'border-emerald-500/30 bg-emerald-500/5',
    medium:   'border-sky-500/30 bg-sky-500/5',
    high:     'border-amber-500/30 bg-amber-500/5',
    critical: 'border-red-500/30 bg-red-500/5',
  }[a.riskLevel]

  const statusColor = {
    suggested: 'text-amber-300',
    approved:  'text-emerald-300',
    rejected:  'text-slate-400',
    executed:  'text-emerald-400',
    failed:    'text-red-400',
  }[a.status]

  const needsApprovalToken = a.actionType === 'engage_kill_switch'

  return (
    <div className={`rounded-lg border ${riskColor} px-3 py-2 text-xs`}>
      <div className="flex items-center gap-2">
        <Hammer className="w-3.5 h-3.5 text-sky-400" />
        <span className="font-medium">{a.title}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg)] uppercase tracking-wider">{a.riskLevel}</span>
        <span className={`text-[10px] ml-auto ${statusColor}`}>{a.status}</span>
      </div>
      <p className="text-muted mt-1">{a.summary}</p>
      {a.status === 'suggested' && (
        <div className="mt-2 flex items-center gap-2">
          {needsApprovalToken && (
            <span className="text-[10px] text-amber-300 flex items-center gap-1">
              <ShieldAlert className="w-3 h-3" /> Critical: type CONFIRM to proceed
            </span>
          )}
          <button onClick={() => onApprove(needsApprovalToken ? 'OPERATOR_APPROVED' : undefined)}
            disabled={pending}
            className="ml-auto px-2 py-0.5 rounded text-[10px] bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50">
            Approve
          </button>
          <button onClick={onReject} disabled={pending}
            className="px-2 py-0.5 rounded text-[10px] border border-border text-muted hover:bg-[var(--surface-hover)]">
            Reject
          </button>
        </div>
      )}
      {a.status === 'executed' && a.executedResult && (
        <div className="mt-1 text-[10px] text-emerald-400 font-mono">
          ✓ executed: {JSON.stringify(a.executedResult).slice(0, 120)}
        </div>
      )}
      {a.status === 'failed' && a.executedResult && (
        <div className="mt-1 text-[10px] text-red-400 font-mono">
          ✗ failed: {JSON.stringify(a.executedResult).slice(0, 120)}
        </div>
      )}
      {a.status === 'rejected' && (
        <div className="mt-1 text-[10px] text-muted flex items-center gap-1">
          <XCircle className="w-3 h-3" /> Rejected by operator
        </div>
      )}
    </div>
  )
}

function MessageBubble({ m }: { m: ChatMessage }) {
  const isUser = m.role === 'user'
  const superseded = !!m.supersededAt
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm ${
      superseded ? 'border-slate-700 bg-slate-900/30 opacity-60' :
      isUser
        ? 'border-sky-500/30 bg-sky-500/5'
        : 'border-border bg-surface'
    }`}>
      <div className="flex items-center gap-2 text-[10px] mb-1">
        <span className={isUser ? 'text-sky-300' : 'text-emerald-300'}>{isUser ? 'You' : 'Novan'}</span>
        {m.regeneratedFrom && <span className="text-amber-400 flex items-center gap-0.5"><RotateCcw className="w-3 h-3" /> regenerated</span>}
        {superseded && <span className="text-slate-500">superseded</span>}
        {m.cancelled && <span className="text-amber-400 flex items-center gap-0.5"><Square className="w-3 h-3" /> stopped</span>}
        {!isUser && m.audit && (
          m.audit.passed
            ? <span className="text-emerald-400 flex items-center gap-0.5"><CheckCircle2 className="w-3 h-3" /> audit ok</span>
            : <span className="text-amber-400 flex items-center gap-0.5"><AlertTriangle className="w-3 h-3" /> audit issues</span>
        )}
        {!isUser && m.tokens > 0 && (
          <span className="text-muted">{m.tokens} tokens · ${m.costUsd.toFixed(4)} · {m.model}</span>
        )}
        <span className="text-muted ml-auto">{new Date(m.createdAt).toLocaleTimeString()}</span>
      </div>
      {isUser && m.attachments && m.attachments.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {m.attachments.map((a, i) => (
            a.kind === 'image'
              ? <a key={i} href={a.url} target="_blank" rel="noreferrer" title={a.name ?? a.mime}>
                  <img src={a.url} alt={a.name ?? ''} className="max-h-32 rounded border border-border object-cover" />
                </a>
              : <a key={i} href={a.url} target="_blank" rel="noreferrer"
                   className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 border border-border rounded bg-surface">
                  <FileText className="w-3 h-3" /> {a.name ?? a.mime}
                </a>
          ))}
        </div>
      )}
      <pre className="whitespace-pre-wrap font-sans text-primary">{m.content}</pre>

      {m.audit && m.audit.violations && m.audit.violations.length > 0 && (
        <div className="mt-2 text-[10px] text-amber-300/80 border-t border-border pt-1.5">
          <div className="flex flex-wrap gap-x-3 gap-y-0.5">
            <span>hype {(m.audit.hypeScore ?? 0).toFixed(2)}</span>
            <span>uncertainty: {m.audit.uncertaintyHandling}</span>
            <span>fact/estimate: {m.audit.factEstimateOk ? 'ok' : 'blurred'}</span>
          </div>
          <ul className="mt-0.5 ml-2">
            {m.audit.violations.slice(0, 3).map((v, i) => <li key={i}>· {v.kind}: {v.detail}</li>)}
          </ul>
        </div>
      )}

      {m.citations && m.citations.length > 0 && (
        <div className="mt-2 text-[10px] text-muted border-t border-border pt-1.5">
          <div className="flex items-center gap-1 mb-0.5"><FileText className="w-3 h-3" /> {m.citations.length} citations</div>
          <ul className="ml-2">
            {m.citations.slice(0, 3).map((c, i) => (
              <li key={i} className="truncate" title={c.extract}>
                [{c.kind}:{c.id.slice(0, 8)}] {c.extract.slice(0, 80)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ─── Search results ────────────────────────────────────────────────────
function ChatSearchResults({ workspaceId, q, onPick }: { workspaceId: string; q: string; onPick: (convId: string) => void }) {
  const r = useQuery({
    queryKey: ['chat-search', workspaceId, q],
    queryFn: () => api.get<{ data: Array<{ messageId: string; conversationId: string; conversationTitle: string; role: string; excerpt: string; createdAt: number }> }>(`/api/v1/chat/search?workspace_id=${workspaceId}&q=${encodeURIComponent(q)}&limit=30`),
  })
  const hits = r.data?.data ?? []
  if (r.isLoading) return <div className="px-3 py-4 text-[10px] text-muted">Searching…</div>
  if (hits.length === 0) return <div className="px-3 py-4 text-[10px] text-muted italic">No matches for "{q}"</div>
  return (
    <>
      {hits.map(h => (
        <button key={h.messageId} onClick={() => onPick(h.conversationId)}
          className="w-full text-left px-3 py-2 text-[10px] border-b border-border hover:bg-[var(--surface-hover)]">
          <div className="font-medium truncate text-[11px]">{h.conversationTitle}</div>
          <div className="text-muted line-clamp-2 mt-0.5">{h.excerpt}</div>
          <div className="text-faint mt-0.5">{h.role} · {new Date(h.createdAt).toLocaleDateString()}</div>
        </button>
      ))}
    </>
  )
}

// ─── Branches view ─────────────────────────────────────────────────────
function ConversationBranches({ workspaceId, conversationId, onPick }: { workspaceId: string; conversationId: string; onPick: (id: string) => void }) {
  const r = useQuery({
    queryKey: ['conversation-branches', workspaceId, conversationId],
    queryFn: () => api.get<{ data: Array<{ id: string; title: string; messageCount: number; forkedFromMessageId: string | null }> }>(`/api/v1/chat/conversations/${conversationId}/branches?workspace_id=${workspaceId}`),
  })
  const branches = (r.data?.data ?? []).filter(b => b.id !== conversationId)
  if (branches.length === 0) return null
  return (
    <div className="border-t border-border p-2">
      <div className="text-[9px] uppercase tracking-wider text-faint px-1 mb-1">Branches ({branches.length})</div>
      {branches.map(b => (
        <button key={b.id} onClick={() => onPick(b.id)}
          className="w-full text-left px-2 py-1 text-[10px] rounded hover:bg-[var(--surface-hover)]">
          ↳ <span className="truncate inline-block max-w-[180px] align-bottom">{b.title}</span>
          <span className="text-faint ml-1">{b.messageCount} msgs</span>
        </button>
      ))}
    </div>
  )
}
