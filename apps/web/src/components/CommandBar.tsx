/**
 * CommandBar — R146.123
 *
 * Global Cmd/Ctrl+K command bar. Mount once in App.tsx; works from any page.
 * Calls novan.classifyIntent → suggested ops → one-click run.
 * Voice mode via Web Speech API.
 */
import { useEffect, useState } from 'react'
import { API_BASE as BASE } from '../api.js'

interface IntentResult {
  category: string
  summary: string
  suggestedOps: string[]
  requiresApproval: boolean
  nextStep: string
}

export function GlobalCommandBar(): JSX.Element | null {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(v => !v)
        return
      }
      if (e.key === 'Escape' && open) { setOpen(false) }
    }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [open])

  if (!open) return null
  return <CommandBarPanel onClose={() => setOpen(false)} />
}

function CommandBarPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<IntentResult | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [runResult, setRunResult] = useState<string | null>(null)
  const [listening, setListening] = useState(false)

  const startListening = () => {
    type SREvent = { results: ArrayLike<ArrayLike<{ transcript: string }>> }
    type SRec = { lang: string; interimResults: boolean; continuous: boolean; onresult: (e: SREvent) => void; onend: () => void; onerror: () => void; start: () => void }
    const w = window as unknown as { SpeechRecognition?: new () => SRec; webkitSpeechRecognition?: new () => SRec }
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition
    if (!SR) { setRunResult('voice: not supported in this browser'); return }
    const rec = new SR()
    rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false
    rec.onresult = (e) => {
      let txt = ''
      for (let i = 0; i < e.results.length; i++) txt += e.results[i]?.[0]?.transcript ?? ''
      setPrompt(txt)
    }
    rec.onend = () => setListening(false)
    rec.onerror = () => setListening(false)
    rec.start(); setListening(true)
  }

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
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ margin: '80px auto 0', maxWidth: 720, background: '#0a0a0e', border: '1px solid rgba(255,212,122,0.25)', borderRadius: 10, padding: 18, color: 'rgba(255,255,255,0.9)', fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace' }}>
        <div style={{ fontSize: 10, letterSpacing: '0.2em', opacity: 0.6, marginBottom: 8 }}>NOVAN · TELL ME WHAT TO DO</div>
        <input autoFocus value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void classify() }}
          placeholder="e.g. add a viral score badge to clips, post the latest reel, refresh ig tokens…"
          style={{ width: '100%', padding: '10px 12px', background: '#000', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, color: '#fff', fontFamily: 'inherit', fontSize: 13, outline: 'none' }} />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button onClick={() => void classify()} disabled={busy || !prompt.trim()} style={btnStyle(busy)}>{busy ? 'thinking…' : 'classify (↵)'}</button>
          <button onClick={startListening} disabled={listening} style={btnStyle(false, true)} title="speak">{listening ? '🎙 listening…' : '🎙 voice'}</button>
          <button onClick={() => { window.location.href = '/proposals' }} style={btnStyle(false, true)}>review proposals →</button>
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
