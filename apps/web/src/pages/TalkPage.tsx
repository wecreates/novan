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
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  MessageSquare, Send, Plus, Archive, CheckCircle2, AlertTriangle, FileText, Loader2,
} from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

interface Conversation {
  id: string; title: string; messageCount: number
  totalTokens: number; totalCostUsd: number
  createdAt: number; updatedAt: number
}
interface ChatMessage {
  id: string; role: 'user' | 'assistant' | 'system'
  content: string
  citations: Array<{ kind: string; id: string; extract: string }>
  audit: { passed?: boolean; hypeScore?: number; uncertaintyHandling?: string; factEstimateOk?: boolean; violations?: Array<{ kind: string; detail: string }> } | null
  tokens: number; costUsd: number
  provider: string | null; model: string | null
  streamComplete: boolean
  createdAt: number
}

export default function TalkPage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamingContent, setStreamingContent] = useState('')
  const [streamingMeta, setStreamingMeta] = useState<{ audit?: ChatMessage['audit']; citations?: number; tokens?: number; costUsd?: number; policyBlocked?: string } | null>(null)
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

  async function send() {
    if (!input.trim() || streaming) return
    let convId = activeId
    if (!convId) {
      const r = await api.post<{ data: { id: string } }>(`/api/v1/chat/conversations`, { workspace_id: workspaceId, title: input.slice(0, 60) })
      convId = (r as { data: { id: string } }).data.id
      setActiveId(convId)
      qc.invalidateQueries({ queryKey: ['conversations', workspaceId] })
    }

    const message = input
    setInput('')
    setStreaming(true)
    setStreamingContent('')
    setStreamingMeta(null)

    try {
      const res = await fetch(`/api/v1/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId, conversation_id: convId, message }),
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
            } else if (eventName === 'done') {
              setStreamingMeta(prev => ({ ...(prev ?? {}), tokens: data.tokens, costUsd: data.costUsd }))
            } else if (eventName === 'error') {
              acc += `\n\n_(error: ${data.error ?? data.reason ?? 'unknown'})_`
              setStreamingContent(acc)
            }
          } catch { /* tolerate */ }
        }
      }
    } catch (e) {
      setStreamingContent(prev => prev + `\n\n_(stream error: ${(e as Error).message})_`)
    } finally {
      setStreaming(false)
      // Refresh messages from server (final persisted state)
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ['messages', workspaceId, convId] })
        setStreamingContent('')
        setStreamingMeta(null)
      }, 500)
    }
  }

  return (
    <div className="flex h-[calc(100vh-3rem)]">
      {/* Sidebar */}
      <aside className="w-64 border-r border-[var(--border)] bg-[var(--surface)] flex flex-col">
        <div className="p-3 border-b border-[var(--border)] flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-sky-400" />
          <span className="text-sm font-medium">Conversations</span>
          <button onClick={() => createConv.mutate()} className="ml-auto p-1 rounded hover:bg-[var(--surface-hover)]" title="New">
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {(convs.data?.data ?? []).map(c => (
            <button key={c.id} onClick={() => setActiveId(c.id)}
              className={`w-full text-left px-3 py-2 text-xs border-b border-[var(--border)] hover:bg-[var(--surface-hover)] ${activeId === c.id ? 'bg-sky-500/10' : ''}`}>
              <div className="flex items-center gap-1">
                <span className="flex-1 truncate">{c.title}</span>
                <button onClick={(e) => { e.stopPropagation(); archive.mutate(c.id) }} className="opacity-0 hover:opacity-100 p-0.5">
                  <Archive className="w-3 h-3 text-[var(--text-muted)]" />
                </button>
              </div>
              <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
                {c.messageCount} msgs · ${c.totalCostUsd.toFixed(4)}
              </div>
            </button>
          ))}
          {(convs.data?.data ?? []).length === 0 && (
            <div className="px-3 py-4 text-[10px] text-[var(--text-muted)] italic">No conversations yet.</div>
          )}
        </div>
      </aside>

      {/* Main thread */}
      <main className="flex-1 flex flex-col">
        <header className="px-4 py-2 border-b border-[var(--border)] flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-emerald-400" />
          <h1 className="text-sm font-medium">Talk to Novan</h1>
          <span className="text-[10px] text-[var(--text-muted)] ml-1">memory-injected · identity-audited · citations linked</span>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
          {!activeId ? (
            <div className="text-center text-sm text-[var(--text-muted)] mt-12">
              <p>Start a new conversation, or pick one from the sidebar.</p>
              <p className="text-[10px] mt-2">Every turn injects active horizons, recent decisions, drift warnings, and pending proposals.</p>
            </div>
          ) : (
            <>
              {(msgs.data?.data ?? []).map(m => <MessageBubble key={m.id} m={m} />)}
              {streaming && (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm">
                  <div className="flex items-center gap-2 text-[10px] text-emerald-300 mb-1">
                    <Loader2 className="w-3 h-3 animate-spin" /> Novan (streaming…)
                    {streamingMeta?.citations !== undefined && <span className="text-[var(--text-muted)]">· {streamingMeta.citations} citations</span>}
                  </div>
                  <pre className="whitespace-pre-wrap font-sans">{streamingContent || '…'}</pre>
                </div>
              )}
            </>
          )}
        </div>

        <form onSubmit={(e) => { e.preventDefault(); void send() }}
          className="border-t border-[var(--border)] p-3 flex gap-2">
          <textarea value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
            placeholder="Ask Novan anything — about runtime state, strategy, code, costs, decisions…"
            disabled={streaming}
            className="flex-1 bg-[var(--surface)] border border-[var(--border)] rounded px-3 py-2 text-sm font-sans resize-none disabled:opacity-50"
            rows={2} />
          <button type="submit" disabled={streaming || !input.trim()}
            className="px-4 py-2 text-sm rounded bg-sky-500/20 border border-sky-500/40 hover:bg-sky-500/30 disabled:opacity-50 flex items-center gap-1.5">
            {streaming ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            Send
          </button>
        </form>
      </main>
    </div>
  )
}

function MessageBubble({ m }: { m: ChatMessage }) {
  const isUser = m.role === 'user'
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm ${
      isUser
        ? 'border-sky-500/30 bg-sky-500/5'
        : 'border-[var(--border)] bg-[var(--surface)]'
    }`}>
      <div className="flex items-center gap-2 text-[10px] mb-1">
        <span className={isUser ? 'text-sky-300' : 'text-emerald-300'}>{isUser ? 'You' : 'Novan'}</span>
        {!isUser && m.audit && (
          m.audit.passed
            ? <span className="text-emerald-400 flex items-center gap-0.5"><CheckCircle2 className="w-3 h-3" /> audit ok</span>
            : <span className="text-amber-400 flex items-center gap-0.5"><AlertTriangle className="w-3 h-3" /> audit issues</span>
        )}
        {!isUser && m.tokens > 0 && (
          <span className="text-[var(--text-muted)]">{m.tokens} tokens · ${m.costUsd.toFixed(4)} · {m.model}</span>
        )}
        <span className="text-[var(--text-muted)] ml-auto">{new Date(m.createdAt).toLocaleTimeString()}</span>
      </div>
      <pre className="whitespace-pre-wrap font-sans text-[var(--text)]">{m.content}</pre>

      {m.audit && m.audit.violations && m.audit.violations.length > 0 && (
        <div className="mt-2 text-[10px] text-amber-300/80 border-t border-[var(--border)] pt-1.5">
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
        <div className="mt-2 text-[10px] text-[var(--text-muted)] border-t border-[var(--border)] pt-1.5">
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
