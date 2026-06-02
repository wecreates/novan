/**
 * MobileChatPage.tsx — Phone-first chat surface for the Novan PWA.
 *
 * Single-screen layout, big touch targets, sticky composer at the
 * bottom. Reuses the same /api/v1/chat/* endpoints as TalkPage.tsx
 * (~940 lines, desktop-oriented). This is intentionally lean — no
 * provider switcher, no actions panel, no fork UI. The phone is for
 * "ask + reply"; the desktop view stays in charge of the rest.
 *
 * SSE streaming: POSTs to /api/v1/chat/stream and parses the
 * EventSource-style frames manually so we can keep streaming over
 * fetch (EventSource doesn't support POST bodies).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'
import { usePush } from '../pwa/usePush.js'
import { useVoiceInput } from '../pwa/useVoiceInput.js'

interface Message {
  id?:         string
  role:        'user' | 'assistant' | 'system'
  content:     string
  createdAt?:  number
  streaming?:  boolean
}

interface Conversation { id: string; title?: string; createdAt?: number }

async function ensureConversation(workspaceId: string): Promise<string> {
  // Reuse the most recent conversation when one exists; create otherwise.
  const r = await fetch(`/api/v1/chat/conversations?workspace_id=${workspaceId}&limit=1`, { credentials: 'include' })
  const j = await r.json().catch(() => null)
  const list = (j?.data ?? []) as Conversation[]
  if (list[0]?.id) return list[0].id
  const c = await fetch('/api/v1/chat/conversations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace_id: workspaceId, title: 'Mobile chat' }),
    credentials: 'include',
  })
  const cj = await c.json().catch(() => null)
  return String(cj?.data?.id ?? '')
}

async function loadMessages(workspaceId: string, conversationId: string): Promise<Message[]> {
  const r = await fetch(`/api/v1/chat/conversations/${conversationId}/messages?workspace_id=${workspaceId}`, { credentials: 'include' })
  const j = await r.json().catch(() => null)
  return ((j?.data ?? []) as Message[]).filter(m => m.role !== 'system')
}

export default function MobileChatPage(): JSX.Element {
  const { workspaceId } = useWorkspace()
  const push = usePush(workspaceId ?? null)
  const voice = useVoiceInput('en-US')
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef  = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    void (async () => {
      try {
        const id = await ensureConversation(workspaceId)
        if (cancelled || !id) return
        setConversationId(id)
        const msgs = await loadMessages(workspaceId, id)
        if (!cancelled) setMessages(msgs)
      } catch (e) { if (!cancelled) setErr((e as Error).message) }
    })()
    return () => { cancelled = true }
  }, [workspaceId])

  // Auto-scroll to bottom on new messages / streaming deltas.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  async function send(): Promise<void> {
    const text = input.trim()
    if (!text || !workspaceId || !conversationId || sending) return
    setInput('')
    setSending(true)
    setErr(null)
    setMessages(prev => [
      ...prev,
      { role: 'user', content: text, createdAt: Date.now() },
      { role: 'assistant', content: '', streaming: true, createdAt: Date.now() },
    ])

    const ac = new AbortController()
    abortRef.current = ac

    try {
      const res = await fetch('/api/v1/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId, conversation_id: conversationId, message: text }),
        credentials: 'include',
        signal: ac.signal,
      })
      if (!res.ok || !res.body) {
        throw new Error(`stream failed: ${res.status}`)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        // SSE frames are separated by \n\n; each frame has `event:` + `data:` lines.
        let idx: number
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          const dataLines = frame.split('\n').filter(l => l.startsWith('data:'))
          if (dataLines.length === 0) continue
          const payload = dataLines.map(l => l.slice(5).trimStart()).join('\n')
          try {
            const obj = JSON.parse(payload) as { delta?: string; content?: string; done?: boolean; error?: string }
            if (obj.delta) {
              setMessages(prev => {
                const last = prev[prev.length - 1]
                if (!last || last.role !== 'assistant') return prev
                const next = [...prev]
                next[next.length - 1] = { ...last, content: last.content + obj.delta }
                return next
              })
            }
            if (obj.error) setErr(obj.error)
            if (obj.done) {
              setMessages(prev => {
                const last = prev[prev.length - 1]
                if (!last || last.role !== 'assistant') return prev
                const next = [...prev]
                next[next.length - 1] = { ...last, streaming: false, ...(obj.content ? { content: obj.content } : {}) }
                return next
              })
            }
          } catch { /* unparseable frame — skip */ }
        }
      }
    } catch (e) {
      if ((e as { name?: string }).name !== 'AbortError') setErr((e as Error).message)
    } finally {
      setSending(false)
      abortRef.current = null
      setMessages(prev => {
        const last = prev[prev.length - 1]
        if (last && last.role === 'assistant' && last.streaming) {
          const next = [...prev]
          next[next.length - 1] = { ...last, streaming: false }
          return next
        }
        return prev
      })
    }
  }

  function cancel(): void {
    abortRef.current?.abort()
  }

  // Pipe finalized voice output into the input box. Operator can edit + send.
  useEffect(() => {
    if (voice.final) {
      setInput(prev => (prev ? prev + ' ' : '') + voice.final)
      voice.reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.final])

  const showEmpty = useMemo(() => !sending && messages.length === 0, [sending, messages])

  return (
    <div className="flex flex-col h-[100dvh] bg-black text-white">
      <header className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-black/90 backdrop-blur sticky top-0 z-10">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded bg-white flex items-center justify-center text-black text-[11px] font-bold">N</div>
          <span className="font-medium tracking-tight">Novan</span>
        </div>
        <div className="flex items-center gap-2">
          {push.permission !== 'unsupported' && (
            <button
              onClick={() => void (push.subscribed ? push.disable() : push.enable())}
              disabled={push.busy}
              className={[
                'text-[11px] px-2 py-1 rounded-full border transition-colors',
                push.subscribed
                  ? 'border-emerald-400/40 text-emerald-300 hover:bg-emerald-400/10'
                  : 'border-white/15 text-white/60 hover:text-white hover:bg-white/10',
                push.busy ? 'opacity-50 cursor-wait' : '',
              ].join(' ')}
              title={push.error ?? (push.subscribed ? 'Disable push notifications' : 'Enable push notifications')}
            >🔔 {push.subscribed ? 'On' : 'Off'}</button>
          )}
          <button
            onClick={() => window.dispatchEvent(new Event('novan:open-cmdbar'))}
            className="text-[11px] px-2 py-1 rounded-full border border-amber-300/40 text-amber-200 hover:bg-amber-300/10"
            title="Open command bar (tell Novan what to do)"
          >⌘K</button>
          <a href="/today" className="text-[11px] text-white/40 hover:text-white">Full UI →</a>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {showEmpty && (
          <div className="h-full flex items-center justify-center text-center px-6">
            <div>
              <div className="text-[15px] text-white/70 mb-1">Hi.</div>
              <div className="text-[13px] text-white/40">Ask Novan anything. Approvals, status, briefings.</div>
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={m.id ?? `${m.role}-${i}-${m.createdAt ?? i}`}
            className={['flex', m.role === 'user' ? 'justify-end' : 'justify-start'].join(' ')}
          >
            <div
              className={[
                'max-w-[78%] px-3.5 py-2.5 rounded-2xl text-[14.5px] leading-snug whitespace-pre-wrap break-words',
                m.role === 'user'
                  ? 'bg-white text-black rounded-br-md'
                  : 'bg-white/10 text-white rounded-bl-md',
              ].join(' ')}
            >
              {m.content || (m.streaming ? <span className="text-white/40 italic">thinking…</span> : '')}
            </div>
          </div>
        ))}
        {err && (
          <div className="text-[12px] text-red-400 px-2 py-1">{err}</div>
        )}
      </div>

      <form
        onSubmit={e => { e.preventDefault(); void send() }}
        className="flex items-end gap-2 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 border-t border-white/10 bg-black"
      >
        {voice.supported && (
          <button
            type="button"
            onClick={() => voice.listening ? voice.stop() : voice.start()}
            className={[
              'w-11 h-11 flex items-center justify-center rounded-2xl text-[18px] flex-shrink-0',
              voice.listening
                ? 'bg-red-500/30 text-red-100 animate-pulse'
                : 'bg-white/10 text-white/80 hover:bg-white/15',
            ].join(' ')}
            aria-label={voice.listening ? 'Stop listening' : 'Start voice input'}
            title={voice.error ?? (voice.listening ? 'Stop' : 'Voice')}
          >🎤</button>
        )}
        <textarea
          value={voice.listening && voice.interim ? input + (input ? ' ' : '') + voice.interim : input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder="Message Novan…"
          rows={1}
          className="flex-1 bg-white/10 text-white placeholder-white/30 rounded-2xl px-4 py-2.5 text-[15px] focus:outline-none focus:bg-white/15 resize-none max-h-32"
        />
        {sending ? (
          <button
            type="button"
            onClick={cancel}
            className="px-3 py-2 rounded-2xl bg-red-500/20 text-red-200 text-[13px] font-medium"
          >Stop</button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim() || !conversationId}
            className="w-11 h-11 flex items-center justify-center rounded-2xl bg-white text-black text-[18px] font-medium disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="Send"
          >↑</button>
        )}
      </form>
    </div>
  )
}
