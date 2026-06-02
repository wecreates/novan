/**
 * VoiceLibraryPage — R146.110 — browse + preview every free TTS voice.
 *
 * Grid layout. Each card has:
 *   - Display name + language + gender pill
 *   - Style description
 *   - ▶ Preview button — streams /api/v1/free-voice/preview/<id>
 *   - 📋 Copy voice id button
 *   - "Use as Novan voice" button (sets NOVAN_TTS_VOICE_ID env via brain op)
 *
 * Browser system voices are enumerated client-side via
 * window.speechSynthesis.getVoices() and rendered as a dedicated section
 * at the top. They play instantly with zero network round-trip.
 *
 * Filters: language, gender, source, search box.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Play, Square, Copy, Check, Search, Mic } from 'lucide-react'
import { API_BASE as BASE } from '../api.js'

interface FreeVoice {
  id: string; source: string; voiceId: string; displayName: string
  language: string; gender: string; style?: string; needsKey?: boolean
  notes?: string; modelPath?: string
}

interface CatalogResponse {
  success: boolean
  data: {
    total: number
    bySource: Record<string, FreeVoice[]>
    previewLine: string
    sources: Array<{ source: string; count: number; needsKey: boolean }>
  }
}

interface BrowserVoice {
  name: string; lang: string; localService: boolean; default: boolean
}

function GenderPill({ g }: { g: string }) {
  const color = g === 'female' ? 'bg-pink-100 text-pink-700' : g === 'male' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${color}`}>{g}</span>
}

function SourcePill({ src }: { src: string }) {
  const color =
    src === 'pollinations'    ? 'bg-violet-100 text-violet-700' :
    src === 'streamelements'  ? 'bg-emerald-100 text-emerald-700' :
    src === 'huggingface'     ? 'bg-amber-100 text-amber-700' :
                                'bg-sky-100 text-sky-700'
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${color}`}>{src}</span>
}

export default function VoiceLibraryPage(): JSX.Element {
  const [catalog, setCatalog] = useState<FreeVoice[]>([])
  const [previewLine, setPreviewLine] = useState('Hi.')
  const [browserVoices, setBrowserVoices] = useState<BrowserVoice[]>([])
  const [filter, setFilter] = useState({ lang: '', gender: '', source: '', search: '' })
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // Load server catalog
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await fetch(`${BASE}/api/v1/free-voice/catalog`, { credentials: 'include' })
        if (!res.ok) return
        const data = (await res.json()) as CatalogResponse
        if (!alive) return
        const all: FreeVoice[] = []
        for (const list of Object.values(data.data.bySource)) all.push(...list)
        setCatalog(all.filter(v => v.source !== 'browser'))
        setPreviewLine(data.data.previewLine ?? 'Hi.')
      } catch { /* noop */ }
    })()
    return () => { alive = false }
  }, [])

  // Enumerate browser voices (Web Speech API)
  useEffect(() => {
    const load = () => {
      if (typeof window === 'undefined' || !window.speechSynthesis) return
      const v = window.speechSynthesis.getVoices()
      setBrowserVoices(v.map(x => ({
        name: x.name, lang: x.lang, localService: x.localService, default: x.default,
      })))
    }
    load()
    window.speechSynthesis?.addEventListener('voiceschanged', load)
    return () => window.speechSynthesis?.removeEventListener('voiceschanged', load)
  }, [])

  const stop = () => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.currentTime = 0 }
    if (typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel()
    setPlayingId(null)
  }

  const playServer = (voice: FreeVoice) => {
    stop()
    const url = `${BASE}/api/v1/free-voice/preview/${encodeURIComponent(voice.id)}`
    const a = new Audio(url)
    a.crossOrigin = 'anonymous'
    a.onended = () => setPlayingId(null)
    a.onerror = () => setPlayingId(null)
    audioRef.current = a
    setPlayingId(voice.id)
    void a.play().catch(() => setPlayingId(null))
  }

  const playBrowser = (name: string) => {
    stop()
    const all = window.speechSynthesis.getVoices()
    const match = all.find(v => v.name === name)
    if (!match) return
    const utter = new SpeechSynthesisUtterance(previewLine)
    utter.voice = match
    utter.onend = () => setPlayingId(null)
    utter.onerror = () => setPlayingId(null)
    setPlayingId(`browser:${name}`)
    window.speechSynthesis.speak(utter)
  }

  const copy = async (id: string) => {
    try { await navigator.clipboard.writeText(id); setCopiedId(id); setTimeout(() => setCopiedId(null), 1500) } catch { /* noop */ }
  }

  const filtered = useMemo(() => {
    const q = filter.search.toLowerCase().trim()
    return catalog.filter(v =>
      (!filter.lang   || v.language.toLowerCase().startsWith(filter.lang.toLowerCase())) &&
      (!filter.gender || v.gender === filter.gender) &&
      (!filter.source || v.source === filter.source) &&
      (!q || v.displayName.toLowerCase().includes(q) || (v.style ?? '').toLowerCase().includes(q) || v.language.toLowerCase().includes(q))
    )
  }, [catalog, filter])

  const languages = useMemo(() => Array.from(new Set(catalog.map(v => v.language))).sort(), [catalog])
  const sources = useMemo(() => Array.from(new Set(catalog.map(v => v.source))).sort(), [catalog])

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl font-semibold">Voice Library</h1>
        <div className="text-sm text-gray-500">
          {catalog.length + browserVoices.length} free voices ·{' '}
          <span className="text-xs">"{previewLine.slice(0, 60)}{previewLine.length > 60 ? '…' : ''}"</span>
        </div>
      </div>
      <p className="text-sm text-gray-500 mb-6">Click ▶ to hear what each voice sounds like. Click the id to copy.</p>

      {/* Filters */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 mb-6">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-gray-400" />
          <input
            value={filter.search}
            onChange={e => setFilter({ ...filter, search: e.target.value })}
            placeholder="Search name / style / lang"
            className="w-full pl-8 pr-2 py-1.5 border rounded text-sm"
          />
        </div>
        <select value={filter.lang} onChange={e => setFilter({ ...filter, lang: e.target.value })}
          className="border rounded px-2 py-1.5 text-sm">
          <option value="">All languages</option>
          {languages.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
        <select value={filter.gender} onChange={e => setFilter({ ...filter, gender: e.target.value })}
          className="border rounded px-2 py-1.5 text-sm">
          <option value="">All voices</option>
          <option value="female">Female</option>
          <option value="male">Male</option>
          <option value="neutral">Neutral</option>
        </select>
        <select value={filter.source} onChange={e => setFilter({ ...filter, source: e.target.value })}
          className="border rounded px-2 py-1.5 text-sm">
          <option value="">All sources</option>
          {sources.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* Browser voices */}
      {browserVoices.length > 0 && (
        <section className="mb-8">
          <h2 className="text-lg font-medium flex items-center gap-2 mb-3">
            <Mic className="w-4 h-4" /> Browser system voices
            <span className="text-xs text-gray-500 font-normal">({browserVoices.length} from your OS, instant playback, offline)</span>
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
            {browserVoices.map(v => (
              <div key={v.name} className="border rounded p-3 flex items-center justify-between bg-sky-50/50">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{v.name}</div>
                  <div className="text-xs text-gray-500">{v.lang} · {v.localService ? 'local' : 'remote'}{v.default ? ' · default' : ''}</div>
                </div>
                <button onClick={() => playingId === `browser:${v.name}` ? stop() : playBrowser(v.name)}
                  className="ml-2 p-2 rounded hover:bg-sky-100">
                  {playingId === `browser:${v.name}` ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Server-side catalog */}
      <section>
        <h2 className="text-lg font-medium mb-3">
          Cloud voices <span className="text-xs text-gray-500 font-normal">({filtered.length} matching)</span>
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map(v => (
            <div key={v.id} className="border rounded p-3 flex flex-col gap-2 hover:bg-gray-50">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{v.displayName}</div>
                  <div className="text-xs text-gray-500 flex items-center gap-1 mt-1">
                    <SourcePill src={v.source} />
                    <GenderPill g={v.gender} />
                    <span>{v.language}</span>
                  </div>
                </div>
                <button onClick={() => playingId === v.id ? stop() : playServer(v)}
                  className="p-2 rounded hover:bg-gray-100 shrink-0">
                  {playingId === v.id ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                </button>
              </div>
              {v.style && <div className="text-xs text-gray-600 line-clamp-2">{v.style}</div>}
              {v.needsKey && <div className="text-[10px] text-amber-600">requires HF_API_TOKEN</div>}
              <div className="flex items-center justify-between text-[10px] text-gray-400">
                <code className="truncate flex-1 mr-2">{v.id}</code>
                <button onClick={() => void copy(v.id)} className="p-1 hover:bg-gray-100 rounded shrink-0">
                  {copiedId === v.id ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                </button>
              </div>
            </div>
          ))}
        </div>
        {filtered.length === 0 && <div className="text-sm text-gray-500">No voices match the current filters.</div>}
      </section>
    </div>
  )
}
