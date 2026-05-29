/**
 * CreativeWorkspacePage — premium spatial workspace for Novan's image
 * generation ecosystem.
 *
 * Layout:
 *   Top     · command bar (generate, remix, upscale, compare, search,
 *             open Brain creative view)
 *   Left    · prompt + minimal controls (style / aspect / quality /
 *             provider / variation count)
 *   Center  · immersive generation canvas
 *   Right   · floating Creative Inspector drawer
 *   Bottom  · generation timeline strip
 *
 * Visual language:
 *   - charcoal backgrounds, glass surfaces, restrained silver accents
 *   - cinematic spacing, no rainbow gradients, no neon
 *   - presence-driven microinteractions only — never gimmicky
 *
 * Provider-agnostic; no vendor name is hardcoded.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Sparkles, Wand2, Maximize2, GitCompare, Image as ImageIcon, Loader2,
  Star, Search, Brain, Layers, X, ChevronDown, FileImage, Mic, MicOff,
  Download, Copy, Upload, BarChart3, Trash2,
} from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'
import { useSpeechRecognition } from '../hooks/useSpeechRecognition.js'

interface Generation {
  id: string; prompt: string; enhancedPrompt: string | null
  provider: string; model: string | null
  stylePreset: string | null; aspectRatio: string | null
  imageUrl: string | null; imagePath: string | null
  status: 'pending' | 'succeeded' | 'failed' | 'blocked'
  userRating: number | null; isFavorite: boolean
  qualityScore: number | null; slopRiskScore: number | null
  originalityScore: number | null; compositionScore: number | null
  brandFitScore: number | null; creativeFlags: string[] | null
  costEstimateUsd: number; actualCostUsd: number | null
  latencyMs: number | null; createdAt: number; completedAt: number | null
  blockedReason: string | null
}

interface PromptScore {
  qualityScore: number; slopRisk: number; compositionScore: number
  originalityScore: number; brandFitScore: number; flags: string[]
}

interface CreativeMetricsData {
  totalGenerations: number; avgQuality: number | null; avgSlopRisk: number | null
  avgOriginality: number | null; rejectRate: number; flagRate: number
  topStyles: Array<{ style: string; count: number; avgQuality: number }>
  providerHealth: Array<{ provider: string; samples: number; successRate: number; avgLatency: number; avgQuality: number }>
}

const STYLES   = ['', 'editorial', 'minimal', 'cinematic', 'product', 'architectural', 'monochrome', 'isometric', 'brutalist', 'swiss']
const MOODS    = ['', 'calm', 'confident', 'serious', 'playful', 'dark', 'warm']
const ASPECTS  = ['1:1', '16:9', '9:16', '4:3', '3:4']
const QUALITY  = ['standard', 'high', 'ultra']
const PROVIDERS_AUTO = ''

export default function CreativeWorkspacePage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const [prompt, setPrompt]         = useState('')
  const [enhanced, setEnhanced]     = useState<{ prompt: string; added?: string[]; removed?: string[] } | null>(null)
  const [style, setStyle]           = useState('')
  const [mood, setMood]             = useState('')
  const [aspect, setAspect]         = useState('1:1')
  const [quality, setQuality]       = useState('high')
  const [provider, setProvider]     = useState(PROVIDERS_AUTO)
  const [variations, setVariations] = useState(1)
  const [selected, setSelected]     = useState<Generation | null>(null)
  const [showInspector, setShowInspector] = useState(true)
  const [compareMode, setCompareMode]     = useState(false)
  const [compareSet, setCompareSet]       = useState<Set<string>>(new Set())
  const [fullscreen, setFullscreen]       = useState(false)
  const [showMetrics, setShowMetrics]     = useState(false)
  const [promptScore, setPromptScore]     = useState<PromptScore | null>(null)
  const [references, setReferences]       = useState<Array<{ id: string; dataUrl: string; name: string }>>([])
  const [dropActive, setDropActive]       = useState(false)
  const [exportCopied, setExportCopied]   = useState(false)
  const promptRef = useRef<HTMLTextAreaElement | null>(null)

  // ─── Voice prompt input ─────────────────────────────────────────────
  // Interim transcripts stream into the prompt box; finals commit the
  // whole utterance. The mic indicator follows useSpeechRecognition.
  const interimStartRef = useRef<number | null>(null)
  const sr = useSpeechRecognition({
    locale: 'en-US', continuous: false,
    onInterim: (t) => {
      // Replace from the position we started listening
      const start = interimStartRef.current ?? prompt.length
      setPrompt(prompt.slice(0, start) + t)
    },
    onFinal: (t) => {
      const start = interimStartRef.current ?? prompt.length
      const next = (prompt.slice(0, start) + t).trim()
      setPrompt(next)
      interimStartRef.current = null
    },
  })
  function toggleMic() {
    if (sr.listening) { sr.stop(); return }
    interimStartRef.current = prompt.length > 0 && !prompt.endsWith(' ') ? prompt.length + 1 : prompt.length
    if (interimStartRef.current > prompt.length) setPrompt(prompt + ' ')
    sr.start()
  }

  // ─── Data ─────────────────────────────────────────────────────────────
  const historyQ = useQuery<{ data: Generation[] }>({
    queryKey: ['creative', 'history', workspaceId],
    queryFn:  () => api.get(`/api/v1/studio/history?workspace_id=${workspaceId}&limit=80`),
    refetchInterval: 5000,
    enabled:  !!workspaceId,
  })
  const metricsQ = useQuery<{ data: CreativeMetricsData }>({
    queryKey: ['creative', 'metrics', workspaceId],
    queryFn:  () => api.get(`/api/v1/studio/creative/metrics?workspace_id=${workspaceId}`),
    refetchInterval: 30_000,
    enabled:  !!workspaceId && showMetrics,
  })

  // Live prompt scoring (debounced)
  useEffect(() => {
    if (!prompt.trim()) { setPromptScore(null); return }
    const handle = setTimeout(() => {
      api.post<{ data: PromptScore }>('/api/v1/studio/creative/score-prompt', { prompt }).then(r => setPromptScore(r.data)).catch(() => null)
    }, 350)
    return () => clearTimeout(handle)
  }, [prompt])

  // ─── Mutations ────────────────────────────────────────────────────────
  const generate = useMutation({
    mutationFn: async () => {
      // First valid reference is forwarded as source_image_url for i2i.
      const ref = references.find(r => r.dataUrl)?.dataUrl
      const body = {
        workspace_id: workspaceId,
        prompt: enhanced?.prompt ?? prompt,
        style_preset: style || undefined,
        mood: mood || undefined,
        aspect_ratio: aspect,
        quality,
        provider: provider || undefined,
        ...(ref ? { source_image_url: ref } : {}),
      }
      if (variations > 1) {
        return api.post('/api/v1/studio/batch', { ...body, count: variations })
      }
      return api.post('/api/v1/studio/generate', body)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['creative', 'history'] }),
  })
  const improvePrompt = useMutation({
    mutationFn: () => api.post<{ data: { prompt: string; removed: string[]; added: string[] } }>('/api/v1/studio/creative/improve-prompt', { prompt }),
    onSuccess: (r) => setEnhanced(r.data),
  })
  const makePremium = useMutation({
    mutationFn: () => api.post<{ data: { prompt: string; added: string[] } }>('/api/v1/studio/creative/make-premium', { prompt }),
    onSuccess: (r) => setEnhanced(r.data),
  })
  const rate = useMutation({
    mutationFn: (v: { id: string; rating: number }) => api.post('/api/v1/studio/rate', { workspace_id: workspaceId, id: v.id, rating: v.rating }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['creative', 'history'] }),
  })
  const favorite = useMutation({
    mutationFn: (v: { id: string; favorite: boolean }) => api.post('/api/v1/studio/favorite', { workspace_id: workspaceId, id: v.id, favorite: v.favorite }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['creative', 'history'] }),
  })
  const review = useMutation({
    mutationFn: (id: string) => api.post('/api/v1/studio/creative/review', { workspace_id: workspaceId, generation_id: id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['creative', 'history'] }),
  })

  const history = historyQ.data?.data ?? []
  const recent  = useMemo(() => history.filter(g => g.status === 'succeeded'), [history])

  // Auto-select the newest succeeded generation when none chosen
  useEffect(() => {
    if (!selected && recent.length > 0) setSelected(recent[0] ?? null)
  }, [recent, selected])

  // ─── Reference upload pipeline ──────────────────────────────────────
  // Accept files via drop, paste, or file input. Convert to data URL,
  // ping the /reference endpoint for audit, and keep client-side.
  const handleFiles = useCallback(async (files: FileList | File[] | null) => {
    if (!files) return
    const list = Array.from(files).filter(f => f.type.startsWith('image/')).slice(0, 4 - references.length)
    for (const f of list) {
      if (f.size > 3_000_000) {
        setReferences(refs => [...refs, { id: `err-${Date.now()}`, dataUrl: '', name: `${f.name} (too large, max 3 MB)` }])
        continue
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result))
        r.onerror = () => reject(new Error('read failed'))
        r.readAsDataURL(f)
      }).catch(() => null)
      if (!dataUrl) continue
      // Audit the attachment server-side (no binary stored — just URL audit)
      api.post('/api/v1/studio/reference', { workspace_id: workspaceId, data_url: dataUrl, kind: 'reference' }).catch(() => null)
      setReferences(refs => [...refs, { id: `${Date.now()}-${f.name}`, dataUrl, name: f.name }])
    }
  }, [references.length, workspaceId])

  // Paste handler: image clipboard data → reference
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      const files: File[] = []
      for (let i = 0; i < items.length; i++) {
        const it = items[i]!
        if (it.kind === 'file') {
          const f = it.getAsFile()
          if (f && f.type.startsWith('image/')) files.push(f)
        }
      }
      if (files.length > 0) { e.preventDefault(); void handleFiles(files) }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [handleFiles])

  // ─── Generation replay: restore form state from selected row ────────
  // Triggered when the operator clicks a timeline thumbnail; the form
  // re-populates with the original settings so they can iterate.
  const [lastReplayedId, setLastReplayedId] = useState<string | null>(null)
  useEffect(() => {
    if (!selected || selected.id === lastReplayedId) return
    // Only restore when prompt is empty or matches the prior selection,
    // so the operator doesn't lose unsent text.
    if (prompt && prompt !== selected.prompt && prompt !== (selected.enhancedPrompt ?? '')) return
    setPrompt(selected.prompt)
    setStyle(selected.stylePreset ?? '')
    setAspect(selected.aspectRatio ?? '1:1')
    setProvider(selected.provider ?? '')
    setLastReplayedId(selected.id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  // ─── Export the selected generation as a spec (clipboard or file) ───
  function exportSpec(format: 'clipboard' | 'json' | 'image') {
    if (!selected) return
    const spec = {
      prompt:         selected.prompt,
      enhancedPrompt: selected.enhancedPrompt,
      provider:       selected.provider,
      model:          selected.model,
      stylePreset:    selected.stylePreset,
      aspectRatio:    selected.aspectRatio,
      quality:        quality,
      scores: {
        quality:     selected.qualityScore,
        slopRisk:    selected.slopRiskScore,
        originality: selected.originalityScore,
        composition: selected.compositionScore,
      },
      flags:          selected.creativeFlags,
      latencyMs:      selected.latencyMs,
      costUsd:        selected.actualCostUsd ?? selected.costEstimateUsd,
      createdAt:      selected.createdAt,
      imageUrl:       selected.imageUrl,
    }
    if (format === 'clipboard') {
      void navigator.clipboard.writeText(JSON.stringify(spec, null, 2))
      setExportCopied(true)
      setTimeout(() => setExportCopied(false), 1500)
      return
    }
    if (format === 'json') {
      const blob = new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `novan-spec-${selected.id.slice(0, 8)}.json`; a.click()
      URL.revokeObjectURL(url)
      return
    }
    if (format === 'image' && selected.imageUrl) {
      const a = document.createElement('a'); a.href = selected.imageUrl
      a.download = `novan-${selected.id.slice(0, 8)}.png`; a.target = '_blank'; a.click()
    }
  }

  function toggleCompare(id: string) {
    setCompareSet(s => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id); else if (next.size < 4) next.add(id)
      return next
    })
  }

  return (
    <div className={`creative-workspace flex flex-col h-screen bg-[#0b0d10] text-primary`}>
      {/* Top command bar */}
      <header className="flex items-center gap-3 px-5 py-2.5 border-b border-border/40 backdrop-blur-md">
        <div className="flex items-center gap-1.5 text-xs font-semibold">
          <Sparkles className="w-3.5 h-3.5 text-cyan-300" />
          Creative
        </div>
        <div className="flex-1" />
        <button onClick={() => setCompareMode(c => !c)} className={`btn text-2xs ${compareMode ? 'btn-primary' : 'btn-ghost'}`}><GitCompare className="w-3 h-3 mr-1" />Compare {compareSet.size > 0 ? `(${compareSet.size})` : ''}</button>
        <button onClick={() => setFullscreen(f => !f)} className="btn btn-ghost text-2xs"><Maximize2 className="w-3 h-3 mr-1" />Fullscreen</button>
        <button onClick={() => setShowInspector(s => !s)} className="btn btn-ghost text-2xs"><Layers className="w-3 h-3 mr-1" />Inspector</button>
        <button onClick={() => setShowMetrics(s => !s)} className={`btn text-2xs ${showMetrics ? 'btn-primary' : 'btn-ghost'}`}>Metrics</button>
        <button className="btn btn-ghost text-2xs" title="Search creative memory"><Search className="w-3 h-3 mr-1" />Memory</button>
        <Link to="/creative/brain" className="btn btn-ghost text-2xs"><Brain className="w-3 h-3 mr-1" />Brain view</Link>
        <Link to="/war-room/creative" className="btn btn-ghost text-2xs"><BarChart3 className="w-3 h-3 mr-1" />War room</Link>
      </header>

      {/* Creative metrics overlay strip */}
      {showMetrics && metricsQ.data?.data && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2 px-5 py-2 text-2xs border-b border-border/40">
          <Stat label="Generations"    value={metricsQ.data.data.totalGenerations} />
          <Stat label="Avg quality"    value={pct(metricsQ.data.data.avgQuality)} />
          <Stat label="Avg slop-risk"  value={pct(metricsQ.data.data.avgSlopRisk)} {...((metricsQ.data.data.avgSlopRisk ?? 0) > 0.4 ? { accent: 'rose' as const } : {})} />
          <Stat label="Avg originality" value={pct(metricsQ.data.data.avgOriginality)} />
          <Stat label="Reject rate"    value={`${((metricsQ.data.data.rejectRate ?? 0) * 100).toFixed(1)}%`} {...((metricsQ.data.data.rejectRate ?? 0) > 0.1 ? { accent: 'rose' as const } : {})} />
          <Stat label="Flag rate"      value={`${((metricsQ.data.data.flagRate ?? 0) * 100).toFixed(1)}%`} />
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* Left: prompt + controls */}
        <aside className="w-[360px] flex-shrink-0 border-r border-border/40 p-4 flex flex-col gap-3 overflow-y-auto">
          <textarea
            value={prompt}
            onChange={e => { setPrompt(e.target.value); setEnhanced(null) }}
            placeholder="Describe the visual you want…"
            rows={6}
            className="w-full px-3 py-2.5 text-sm bg-[#13161a] border border-border/40 rounded-lg outline-none resize-none focus:border-cyan-500/40 transition-colors"
          />

          {enhanced && (
            <div className="text-2xs p-2 rounded border border-cyan-500/30 bg-cyan-500/5">
              <div className="text-cyan-300 mb-1">Director suggests:</div>
              <div className="text-secondary">{enhanced.prompt}</div>
              <div className="flex gap-2 mt-1.5">
                <button onClick={() => { setPrompt(enhanced.prompt); setEnhanced(null) }} className="btn btn-primary text-2xs px-2 py-0.5">Use</button>
                <button onClick={() => setEnhanced(null)} className="btn btn-ghost text-2xs px-2 py-0.5">Dismiss</button>
              </div>
            </div>
          )}

          {/* Prompt score chips */}
          {promptScore && (
            <div className="flex flex-wrap gap-1.5 text-2xs">
              <ScoreChip label="quality"     value={promptScore.qualityScore} good />
              <ScoreChip label="composition" value={promptScore.compositionScore} good />
              <ScoreChip label="originality" value={promptScore.originalityScore} good />
              <ScoreChip label="slop-risk"   value={promptScore.slopRisk} bad />
            </div>
          )}

          {/* Director quick actions */}
          <div className="flex gap-1.5">
            <button disabled={!prompt.trim() || improvePrompt.isPending} onClick={() => improvePrompt.mutate()}
              className="btn btn-ghost text-2xs flex-1" title="Anti-slop rewrite">
              <Wand2 className="w-3 h-3 mr-1" />Improve
            </button>
            <button disabled={!prompt.trim() || makePremium.isPending} onClick={() => makePremium.mutate()}
              className="btn btn-ghost text-2xs flex-1" title="Promote editorial cues">
              <Sparkles className="w-3 h-3 mr-1" />Premium
            </button>
          </div>

          {/* Compact control grid */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Selector label="Style"    value={style}   onChange={setStyle}   options={STYLES.map(s => ({ value: s, label: s || 'auto' }))} />
            <Selector label="Mood"     value={mood}    onChange={setMood}    options={MOODS.map(s => ({ value: s, label: s || 'auto' }))} />
            <Selector label="Aspect"   value={aspect}  onChange={setAspect}  options={ASPECTS.map(s => ({ value: s, label: s }))} />
            <Selector label="Quality"  value={quality} onChange={setQuality} options={QUALITY.map(s => ({ value: s, label: s }))} />
            <Selector label="Provider" value={provider} onChange={setProvider} options={[
              { value: '', label: 'auto-route' },
              { value: 'openai', label: 'OpenAI' },
              { value: 'stability', label: 'Stability' },
              { value: 'replicate', label: 'Replicate' },
              { value: 'fal', label: 'fal.ai' },
            ]} />
            <Selector label="Count"    value={String(variations)} onChange={v => setVariations(Math.max(1, Math.min(8, Number(v) || 1)))}
              options={[1, 2, 4, 6, 8].map(n => ({ value: String(n), label: `${n}` }))} />
          </div>

          <button
            disabled={!prompt.trim() || generate.isPending}
            onClick={() => generate.mutate()}
            className="btn btn-primary w-full mt-2">
            {generate.isPending ? <><Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />Generating…</> : <><Sparkles className="w-3.5 h-3.5 mr-2" />Generate</>}
          </button>

          <div className="flex items-center gap-2 text-2xs text-muted mt-1">
            <button onClick={toggleMic} disabled={!sr.supported}
              title={sr.supported ? (sr.listening ? 'Stop dictation' : 'Dictate the prompt') : 'Speech recognition unsupported here'}
              className={`btn text-2xs ${sr.listening ? 'btn-primary' : 'btn-ghost'}`}>
              {sr.listening ? <><Mic className="w-3 h-3 mr-1 animate-pulse" />Listening…</> : <><MicOff className="w-3 h-3 mr-1" />Dictate</>}
            </button>
            <span className="flex-1 truncate">
              <span className="font-mono">"reduce slop"</span> · <span className="font-mono">"more premium"</span> · <span className="font-mono">"4 variations"</span>
            </span>
          </div>

          {/* Reference uploads (drag/drop/paste) */}
          {references.length > 0 && (
            <div className="mt-1">
              <div className="text-2xs text-muted mb-1">References ({references.length})</div>
              <div className="flex gap-1.5 flex-wrap">
                {references.map(r => (
                  <div key={r.id} className="relative group">
                    <img src={r.dataUrl} alt={r.name} className="w-12 h-12 rounded object-cover border border-border/40" />
                    <button onClick={() => setReferences(refs => refs.filter(x => x.id !== r.id))}
                      aria-label={`Remove ${r.name}`}
                      className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-rose-500/80 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          <label className="text-2xs text-muted cursor-pointer hover:text-primary transition-colors flex items-center gap-1">
            <Upload className="w-3 h-3" />
            <span>Drop, paste, or browse a reference</span>
            <input type="file" accept="image/*" className="hidden" onChange={e => handleFiles(e.target.files)} />
          </label>
        </aside>

        {/* Center: immersive canvas (drop zone) */}
        <main
          onDragOver={e => { e.preventDefault(); setDropActive(true) }}
          onDragLeave={() => setDropActive(false)}
          onDrop={e => { e.preventDefault(); setDropActive(false); void handleFiles(e.dataTransfer.files) }}
          className={`flex-1 flex items-center justify-center relative overflow-hidden bg-gradient-to-b from-[#0b0d10] to-[#0e1115] transition-colors ${dropActive ? 'ring-2 ring-cyan-400/40 ring-inset' : ''}`}>
          {dropActive && (
            <div className="absolute inset-0 flex items-center justify-center bg-cyan-500/5 backdrop-blur-sm pointer-events-none z-10">
              <div className="text-sm text-cyan-200">Drop image to add reference</div>
            </div>
          )}
          {compareMode && compareSet.size > 1 ? (
            <CompareGrid generations={recent.filter(g => compareSet.has(g.id))} />
          ) : selected?.imageUrl ? (
            <CanvasImage gen={selected} fullscreen={fullscreen} onClose={() => setFullscreen(false)} />
          ) : (
            <CanvasEmpty pending={generate.isPending} />
          )}
        </main>

        {/* Right: Creative Inspector */}
        {showInspector && selected && (
          <aside className="w-[300px] flex-shrink-0 border-l border-border/40 p-4 flex flex-col gap-3 overflow-y-auto bg-[#0d1014]">
            <div className="flex items-start justify-between">
              <div className="text-xs font-semibold">Creative Inspector</div>
              <button onClick={() => setShowInspector(false)} className="text-muted"><X className="w-3 h-3" /></button>
            </div>

            <ScoreRow label="quality"     value={selected.qualityScore}     accent="emerald" />
            <ScoreRow label="originality" value={selected.originalityScore} accent="emerald" />
            <ScoreRow label="composition" value={selected.compositionScore} accent="emerald" />
            <ScoreRow label="slop-risk"   value={selected.slopRiskScore}    accent="rose" inverted />

            <div className="text-2xs">
              <div className="text-muted mb-1">Provider</div>
              <div className="font-mono">{selected.provider}{selected.model ? ` · ${selected.model}` : ''}</div>
            </div>
            <div className="text-2xs">
              <div className="text-muted mb-1">Latency / Cost</div>
              <div className="font-mono">{selected.latencyMs ? `${selected.latencyMs}ms` : '—'} · ${(selected.actualCostUsd ?? selected.costEstimateUsd).toFixed(3)}</div>
            </div>
            <div className="text-2xs">
              <div className="text-muted mb-1">Prompt</div>
              <div className="text-secondary leading-relaxed">{selected.enhancedPrompt ?? selected.prompt}</div>
            </div>
            {selected.creativeFlags && selected.creativeFlags.length > 0 && (
              <div className="text-2xs">
                <div className="text-muted mb-1">Flags</div>
                <ul className="space-y-0.5">
                  {selected.creativeFlags.slice(0, 6).map((f, i) => <li key={i} className="font-mono truncate">{f}</li>)}
                </ul>
              </div>
            )}

            <div className="flex gap-1.5 mt-1">
              <button onClick={() => favorite.mutate({ id: selected.id, favorite: !selected.isFavorite })} className={`btn ${selected.isFavorite ? 'btn-primary' : 'btn-ghost'} text-2xs flex-1`}>
                <Star className="w-3 h-3 mr-1" />{selected.isFavorite ? 'Saved' : 'Save'}
              </button>
              <button onClick={() => review.mutate(selected.id)} className="btn btn-ghost text-2xs flex-1" title="Re-run creative review">
                <Wand2 className="w-3 h-3 mr-1" />Review
              </button>
            </div>

            {/* Star rating */}
            <div className="flex items-center gap-1">
              {[1, 2, 3, 4, 5].map(n => (
                <button key={n} onClick={() => rate.mutate({ id: selected.id, rating: n })}
                  aria-label={`${n} stars`}
                  className={`w-4 h-4 rounded ${(selected.userRating ?? 0) >= n ? 'bg-amber-400' : 'bg-surface-hover hover:bg-amber-400/40'} transition-colors`} />
              ))}
            </div>

            {/* Export panel */}
            <div className="border-t border-border/40 pt-3 mt-2 space-y-1.5">
              <div className="text-2xs text-muted mb-1">Export</div>
              <button onClick={() => exportSpec('image')} disabled={!selected.imageUrl} className="btn btn-ghost text-2xs w-full justify-start">
                <Download className="w-3 h-3 mr-1.5" />Download image
              </button>
              <button onClick={() => exportSpec('json')} className="btn btn-ghost text-2xs w-full justify-start">
                <FileImage className="w-3 h-3 mr-1.5" />Download spec (.json)
              </button>
              <button onClick={() => exportSpec('clipboard')} className="btn btn-ghost text-2xs w-full justify-start">
                <Copy className="w-3 h-3 mr-1.5" />{exportCopied ? 'Copied!' : 'Copy spec to clipboard'}
              </button>
            </div>
          </aside>
        )}
      </div>

      {/* Bottom timeline strip */}
      <footer className="h-[120px] flex-shrink-0 border-t border-border/40 px-4 py-2 overflow-x-auto bg-[#0a0c0f]">
        <div className="flex items-center gap-2 h-full">
          {recent.length === 0 && <div className="text-2xs text-muted italic">No generations yet — describe a visual on the left.</div>}
          {recent.slice(0, 60).map(g => (
            <button key={g.id}
              onClick={() => compareMode ? toggleCompare(g.id) : setSelected(g)}
              className={`relative h-full aspect-square flex-shrink-0 rounded overflow-hidden border transition-all ${
                selected?.id === g.id ? 'border-cyan-400/60 ring-1 ring-cyan-400/40' :
                compareSet.has(g.id)  ? 'border-amber-400/60' :
                'border-border/40 hover:border-border'
              }`}>
              {g.imageUrl ? (
                <img src={g.imageUrl} alt={g.prompt.slice(0, 50)} className="w-full h-full object-cover" loading="lazy" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-muted text-2xs"><ImageIcon className="w-4 h-4" /></div>
              )}
              {g.isFavorite && <Star className="absolute top-1 right-1 w-3 h-3 text-amber-400 fill-amber-400" />}
              {typeof g.qualityScore === 'number' && (
                <span className={`absolute bottom-1 left-1 text-[9px] font-mono px-1 rounded ${g.qualityScore > 0.7 ? 'bg-emerald-500/30 text-emerald-200' : g.qualityScore > 0.4 ? 'bg-amber-500/30 text-amber-200' : 'bg-rose-500/30 text-rose-200'}`}>
                  {(g.qualityScore * 100).toFixed(0)}
                </span>
              )}
            </button>
          ))}
        </div>
      </footer>

      {/* War-room provider health overlay (when metrics visible) */}
      {showMetrics && metricsQ.data?.data && (
        <div className="absolute bottom-[140px] right-4 w-[280px] drawer-edge p-3 text-2xs space-y-1.5 backdrop-blur-md bg-[#13161a]/90">
          <div className="label">Provider health (7d)</div>
          {metricsQ.data.data.providerHealth.length === 0 && <div className="text-muted italic">No data yet.</div>}
          {metricsQ.data.data.providerHealth.map(p => (
            <div key={p.provider} className="flex items-center gap-2">
              <span className="font-mono w-20 truncate">{p.provider}</span>
              <span className="text-muted">n={p.samples}</span>
              <span className="ml-auto">{(p.successRate * 100).toFixed(0)}% · {p.avgLatency}ms</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Subcomponents ──────────────────────────────────────────────────────

function CanvasImage({ gen, fullscreen, onClose }: { gen: Generation; fullscreen: boolean; onClose: () => void }) {
  return (
    <div className={`${fullscreen ? 'fixed inset-0 z-50 bg-black/95' : 'relative'} flex items-center justify-center p-8 transition-all`}>
      <img
        src={gen.imageUrl ?? ''}
        alt={gen.prompt.slice(0, 80)}
        className="max-w-full max-h-full rounded-lg shadow-2xl object-contain transition-transform hover:scale-[1.01] duration-300"
      />
      {fullscreen && (
        <button onClick={onClose} aria-label="exit fullscreen" className="absolute top-6 right-6 btn btn-ghost text-xs"><X className="w-4 h-4" /></button>
      )}
    </div>
  )
}

function CanvasEmpty({ pending }: { pending: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 text-muted">
      {pending ? (
        <>
          <Loader2 className="w-8 h-8 animate-spin opacity-50" />
          <div className="text-xs">Routing to the best provider…</div>
        </>
      ) : (
        <>
          <FileImage className="w-12 h-12 opacity-20" />
          <div className="text-xs">Describe a visual and press Generate.</div>
        </>
      )}
    </div>
  )
}

function CompareGrid({ generations }: { generations: Generation[] }) {
  const cols = generations.length <= 2 ? 2 : generations.length <= 4 ? 2 : 3
  return (
    <div className={`grid gap-3 p-6 w-full h-full place-content-center`} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {generations.map(g => (
        <div key={g.id} className="relative rounded-lg overflow-hidden border border-border/40 max-h-[400px]">
          {g.imageUrl && <img src={g.imageUrl} alt={g.prompt.slice(0, 50)} className="w-full h-full object-cover" />}
          <div className="absolute bottom-2 left-2 right-2 text-2xs font-mono bg-black/50 backdrop-blur-sm rounded px-2 py-1 text-white">
            {g.provider} · {typeof g.qualityScore === 'number' ? `Q${(g.qualityScore * 100).toFixed(0)}` : '—'}
          </div>
        </div>
      ))}
    </div>
  )
}

function Selector({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <label className="space-y-1">
      <span className="text-2xs text-muted uppercase tracking-wider">{label}</span>
      <div className="relative">
        <select value={value} onChange={e => onChange(e.target.value)}
          className="w-full appearance-none bg-[#13161a] border border-border/40 rounded px-2 py-1.5 text-xs focus:border-cyan-500/40 outline-none">
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <ChevronDown className="w-3 h-3 absolute right-2 top-2 pointer-events-none text-muted" />
      </div>
    </label>
  )
}

function ScoreChip({ label, value, good, bad }: { label: string; value: number; good?: boolean; bad?: boolean }) {
  const pctVal = Math.round(value * 100)
  const isGood = good ? value >= 0.65 : false
  const isBad  = bad  ? value >= 0.5  : (good && value < 0.4)
  return (
    <span className={`px-1.5 py-0.5 rounded text-2xs font-mono ${
      isBad  ? 'bg-rose-500/20 text-rose-200' :
      isGood ? 'bg-emerald-500/20 text-emerald-200' :
      'bg-surface-hover text-muted'
    }`}>
      {label}·{pctVal}
    </span>
  )
}

function ScoreRow({ label, value, accent, inverted }: { label: string; value: number | null; accent: 'emerald' | 'rose'; inverted?: boolean }) {
  if (value == null) return null
  const pct = Math.max(0, Math.min(1, value))
  const isHealthy = inverted ? pct < 0.3 : pct > 0.6
  const color = isHealthy ? (accent === 'emerald' ? 'bg-emerald-400' : 'bg-rose-400') : 'bg-amber-400'
  return (
    <div className="text-2xs">
      <div className="flex items-center justify-between mb-1">
        <span className="text-muted">{label}</span>
        <span className="font-mono">{(pct * 100).toFixed(0)}</span>
      </div>
      <div className="h-1 rounded bg-surface-hover overflow-hidden">
        <div className={color} style={{ width: `${pct * 100}%`, height: '100%' }} />
      </div>
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: 'rose' }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted">{label}</span>
      <span className={`font-mono ${accent === 'rose' ? 'text-rose-300' : ''}`}>{value}</span>
    </div>
  )
}

function pct(n: number | null): string { return n == null ? '—' : `${(n * 100).toFixed(0)}%` }
