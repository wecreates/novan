/**
 * Image Studio — premium generation workspace.
 *
 * Routes through smart provider router. Real provider calls only.
 * Cost preview shown before generation. Rating + favorite feed back into router.
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Image as ImageIcon, Sparkles, Wand2, Star, Heart, Download,
  RefreshCw, Copy, Trash2, BookmarkPlus, ChevronDown, DollarSign, Cpu, Zap,
} from 'lucide-react'
import { studioApi, type ImageGenRecord, type PromptTemplate } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

const BRAND_CATEGORIES = [
  'icon', 'logo', 'hero', 'mockup', 'ad', 'social', 'thumbnail', 'ui_concept', 'landing', 'other',
] as const

const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4']

const STYLE_PRESETS = ['premium-minimal', 'photoreal', 'flat-vector', 'isometric-3d', 'cinematic']

export default function ImageStudioPage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()

  // Form state
  const [prompt, setPrompt] = useState('')
  const [enhancePrompt, setEnhancePrompt] = useState(true)
  const [provider, setProvider] = useState<string>('')  // empty = auto
  const [aspectRatio, setAspectRatio] = useState('1:1')
  const [brandCategory, setBrandCategory] = useState<string>('')
  const [stylePreset, setStylePreset] = useState<string>('')
  const [count, setCount] = useState(1)
  const [budgetCapUsd, setBudgetCapUsd] = useState<number>(0.02)
  const [filter, setFilter] = useState<'all' | 'favorites'>('all')

  const stats = useQuery({
    queryKey: ['studio-stats', workspaceId],
    queryFn:  () => studioApi.stats(workspaceId),
    refetchInterval: 30_000,
  })
  const router = useQuery({
    queryKey: ['studio-router', workspaceId],
    queryFn:  () => studioApi.routerScores(workspaceId),
    refetchInterval: 60_000,
  })
  const history = useQuery({
    queryKey: ['studio-history', workspaceId, filter],
    queryFn:  () => studioApi.history(workspaceId, filter === 'favorites' ? { favorites: true, limit: 40 } : { limit: 40 }),
    refetchInterval: 30_000,
  })
  const templates = useQuery({
    queryKey: ['studio-templates', workspaceId],
    queryFn:  () => studioApi.templates(workspaceId),
  })

  const generate = useMutation<unknown, Error>({
    mutationFn: async () => {
      const body: Parameters<typeof studioApi.generate>[0] = {
        workspace_id: workspaceId, prompt,
        aspect_ratio: aspectRatio,
        budget_cap_usd: budgetCapUsd,
        enhance_prompt: enhancePrompt,
      }
      if (provider)      body.provider = provider
      if (brandCategory) body.brand_category = brandCategory
      if (stylePreset)   body.style_preset = stylePreset
      if (count > 1) return await studioApi.batch({ ...body, count })
      return await studioApi.generate(body)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['studio-history', workspaceId] })
      void qc.invalidateQueries({ queryKey: ['studio-stats',  workspaceId] })
    },
  })

  // Type-narrow the latest-image preview: only show on single-result generate
  const latestSingle = generate.data && typeof generate.data === 'object' && 'data' in generate.data
    && generate.data.data && typeof generate.data.data === 'object' && 'imageUrl' in generate.data.data
    ? generate.data.data as ImageGenRecord
    : null

  const rate = useMutation({
    mutationFn: ({ id, rating }: { id: string; rating: number }) => studioApi.rate(workspaceId, id, rating),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['studio-history', workspaceId] }) },
  })
  const favorite = useMutation({
    mutationFn: ({ id, favorite }: { id: string; favorite: boolean }) => studioApi.favorite(workspaceId, id, favorite),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['studio-history', workspaceId] }) },
  })

  const saveAsTemplate = useMutation({
    mutationFn: () => studioApi.createTemplate({
      workspace_id: workspaceId,
      name:    prompt.slice(0, 60) || 'Untitled',
      prompt,
      ...(brandCategory   ? { brand_category: brandCategory } : {}),
      ...(provider        ? { default_provider: provider }    : {}),
      ...(aspectRatio     ? { default_aspect_ratio: aspectRatio } : {}),
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['studio-templates', workspaceId] }) },
  })

  const useTemplate = (t: PromptTemplate) => {
    setPrompt(t.prompt)
    if (t.brandCategory) setBrandCategory(t.brandCategory)
    if (t.defaultProvider) setProvider(t.defaultProvider)
    if (t.defaultAspectRatio) setAspectRatio(t.defaultAspectRatio)
    void studioApi.useTemplate(workspaceId, t.id)
  }

  const routerScores = router.data?.data.scores ?? []
  const available = router.data?.data.available ?? []
  const cheapestEstimate = routerScores.length > 0
    ? Math.min(...routerScores.map(s => s.estimate))
    : null

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
      <div className="flex items-center gap-3">
        <ImageIcon className="w-6 h-6 text-sky-400" />
        <div className="flex-1">
          <h1 className="text-xl font-medium text-primary">Image Studio</h1>
          <p className="text-xs text-muted">
            {available.length === 0
              ? 'No image providers configured — set REPLICATE_API_TOKEN / OPENAI_API_KEY / STABILITY_API_KEY / FAL_KEY'
              : `${available.length} provider${available.length === 1 ? '' : 's'} available · router selects automatically`}
          </p>
        </div>
        {stats.data && (
          <div className="flex gap-4 text-xs">
            <Stat label="today" value={`${stats.data.data.today.count} · $${stats.data.data.today.spendUsd.toFixed(2)}`} />
            <Stat label="7d"    value={`${stats.data.data.week.count}  · $${stats.data.data.week.spendUsd.toFixed(2)}`} />
            <Stat label="failed 24h" value={String(stats.data.data.failed24h)} highlight={stats.data.data.failed24h > 0} />
            <Stat label="favorites"  value={String(stats.data.data.favorites)} />
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: form */}
        <div className="lg:col-span-2 space-y-4">
          <Section title="Prompt" icon={<Sparkles className="w-4 h-4" />}>
            <div className="p-5">
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                placeholder="Describe the image. Be specific about subject, style, composition, colors, lighting."
                rows={5}
                className="w-full bg-elevated border border-border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-sky-500"
              />
              <label className="mt-3 flex items-center gap-2 text-xs text-muted cursor-pointer">
                <input type="checkbox" checked={enhancePrompt} onChange={e => setEnhancePrompt(e.target.checked)} />
                <Wand2 className="w-3 h-3" />
                Auto-enhance prompt (Groq prompt-rewriter; ~$0 via cache)
              </label>
            </div>
          </Section>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <FormField label="Provider">
              <select value={provider} onChange={e => setProvider(e.target.value)} className="w-full bg-elevated border border-border rounded px-2 py-1.5 text-xs">
                <option value="">auto-select</option>
                {available.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </FormField>
            <FormField label="Aspect ratio">
              <select value={aspectRatio} onChange={e => setAspectRatio(e.target.value)} className="w-full bg-elevated border border-border rounded px-2 py-1.5 text-xs">
                {ASPECT_RATIOS.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </FormField>
            <FormField label="Style preset">
              <select value={stylePreset} onChange={e => setStylePreset(e.target.value)} className="w-full bg-elevated border border-border rounded px-2 py-1.5 text-xs">
                <option value="">none</option>
                {STYLE_PRESETS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </FormField>
            <FormField label="Brand category">
              <select value={brandCategory} onChange={e => setBrandCategory(e.target.value)} className="w-full bg-elevated border border-border rounded px-2 py-1.5 text-xs">
                <option value="">none</option>
                {BRAND_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </FormField>
            <FormField label="Batch size">
              <input type="number" min={1} max={8} value={count} onChange={e => setCount(Math.max(1, Math.min(8, Number(e.target.value))))}
                className="w-full bg-elevated border border-border rounded px-2 py-1.5 text-xs" />
            </FormField>
            <FormField label="Budget cap (USD)">
              <input type="number" step="0.001" min={0} value={budgetCapUsd} onChange={e => setBudgetCapUsd(Number(e.target.value))}
                className="w-full bg-elevated border border-border rounded px-2 py-1.5 text-xs" />
            </FormField>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => generate.mutate()}
              disabled={generate.isPending || !prompt.trim() || available.length === 0}
              className="px-5 py-2 rounded bg-sky-500/20 text-sky-300 border border-sky-500/40 hover:bg-sky-500/30 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
            >
              {generate.isPending ? 'Generating…' : count > 1 ? `Generate ${count} images` : 'Generate'}
            </button>
            {cheapestEstimate !== null && (
              <span className="text-xs text-muted flex items-center gap-1">
                <DollarSign className="w-3 h-3" />
                from ${cheapestEstimate.toFixed(4)}/image
              </span>
            )}
            <button
              onClick={() => saveAsTemplate.mutate()}
              disabled={!prompt.trim()}
              className="text-xs px-3 py-1.5 rounded border border-border hover:bg-elevated flex items-center gap-1"
              title="Save as reusable template"
            >
              <BookmarkPlus className="w-3 h-3" /> Save template
            </button>
            {generate.error && (
              <span className="text-xs text-red-400">{(generate.error as Error).message}</span>
            )}
          </div>

          {/* Latest generation (single, not batch) */}
          {latestSingle && latestSingle.imageUrl && (
            <Section title="Latest" icon={<ImageIcon className="w-4 h-4" />}>
              <div className="p-5">
                <img src={latestSingle.imageUrl} alt="" className="rounded border border-border max-w-full max-h-96 mx-auto" />
                <div className="mt-2 text-xs text-muted font-mono">
                  {latestSingle.provider} · ${(latestSingle.actualCostUsd ?? latestSingle.costEstimateUsd).toFixed(4)}{latestSingle.latencyMs ? ` · ${latestSingle.latencyMs}ms` : ''}
                </div>
              </div>
            </Section>
          )}
        </div>

        {/* Right: router + templates */}
        <div className="space-y-4">
          <Section title="Router" icon={<Cpu className="w-4 h-4" />}>
            <div className="p-3 space-y-2 text-xs">
              {routerScores.length === 0 ? (
                <div className="text-muted">No providers configured.</div>
              ) : (
                routerScores.map(s => (
                  <div key={s.provider} className="flex items-center gap-2 py-1 border-b border-border last:border-0">
                    <span className="font-mono w-20">{s.provider}</span>
                    <span className="text-muted">${s.estimate.toFixed(4)}</span>
                    {s.successRate >= 0 && (
                      <span className={s.successRate >= 0.9 ? 'text-emerald-400' : s.successRate >= 0.6 ? 'text-amber-400' : 'text-red-400'}>
                        {Math.round(s.successRate*100)}%
                      </span>
                    )}
                    {s.avgLatency > 0 && (
                      <span className="text-muted ml-auto">{Math.round(s.avgLatency)}ms</span>
                    )}
                  </div>
                ))
              )}
            </div>
          </Section>

          <Section title="Templates" icon={<BookmarkPlus className="w-4 h-4" />}>
            <div className="p-3 space-y-2 text-xs">
              {(templates.data?.data ?? []).length === 0 ? (
                <div className="text-muted">No templates yet. Save a prompt to start.</div>
              ) : (
                (templates.data?.data ?? []).slice(0, 8).map(t => (
                  <div key={t.id} className="flex items-center gap-2">
                    <button onClick={() => useTemplate(t)} className="flex-1 text-left truncate hover:text-sky-400">
                      {t.name}
                    </button>
                    <span className="text-muted font-mono">{t.useCount}×</span>
                    <button onClick={() => studioApi.deleteTemplate(workspaceId, t.id).then(() => qc.invalidateQueries({ queryKey: ['studio-templates', workspaceId] }))}
                            className="text-muted hover:text-red-400">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </Section>
        </div>
      </div>

      {/* History grid */}
      <Section
        title="History"
        icon={<ImageIcon className="w-4 h-4" />}
        actions={
          <div className="flex gap-1 text-xs">
            <button onClick={() => setFilter('all')}      className={filter === 'all'      ? 'px-2 py-1 rounded bg-sky-500/20 text-sky-300' : 'px-2 py-1 rounded text-muted'}>All</button>
            <button onClick={() => setFilter('favorites')} className={filter === 'favorites' ? 'px-2 py-1 rounded bg-sky-500/20 text-sky-300' : 'px-2 py-1 rounded text-muted'}>Favorites</button>
          </div>
        }
      >
        <div className="p-4">
          {(history.data?.data ?? []).filter(r => r.status === 'succeeded' && r.imageUrl).length === 0 ? (
            <div className="text-muted text-sm py-8 text-center">No images yet. Generate one above.</div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {(history.data?.data ?? [])
                .filter(r => r.status === 'succeeded' && r.imageUrl)
                .map(r => <HistoryTile key={r.id} r={r} onRate={(n) => rate.mutate({ id: r.id, rating: n })} onFavorite={(f) => favorite.mutate({ id: r.id, favorite: f })} onCopy={() => { setPrompt(r.prompt); window.scrollTo({ top: 0, behavior: 'smooth' }) }} />)}
            </div>
          )}
        </div>
      </Section>
    </div>
  )
}

function HistoryTile({ r, onRate, onFavorite, onCopy }: {
  r: ImageGenRecord
  onRate: (n: number) => void
  onFavorite: (f: boolean) => void
  onCopy: () => void
}) {
  return (
    <div className="rounded-lg border border-border overflow-hidden bg-surface">
      {r.imageUrl && <img src={r.imageUrl} alt="" className="w-full aspect-square object-cover" loading="lazy" />}
      <div className="p-2 text-xs space-y-1">
        <div className="text-primary truncate" title={r.prompt}>{r.prompt.slice(0, 60)}</div>
        <div className="text-muted font-mono flex items-center gap-1.5">
          <span>{r.provider}</span>
          <span>·</span>
          <span>${(r.actualCostUsd ?? r.costEstimateUsd).toFixed(4)}</span>
          {r.latencyMs && (<><span>·</span><span>{r.latencyMs}ms</span></>)}
        </div>
        <div className="flex items-center justify-between mt-1">
          <div className="flex gap-0.5">
            {[1,2,3,4,5].map(n => (
              <button key={n} onClick={() => onRate(n)} title={`Rate ${n}/5`}>
                <Star className={`w-3 h-3 ${n <= (r.userRating ?? 0) ? 'fill-amber-400 text-amber-400' : 'text-muted'}`} />
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            <button onClick={() => onFavorite(!r.isFavorite)} title="Toggle favorite">
              <Heart className={`w-3 h-3 ${r.isFavorite ? 'fill-red-400 text-red-400' : 'text-muted'}`} />
            </button>
            <button onClick={onCopy} title="Copy prompt to form">
              <Copy className="w-3 h-3 text-muted hover:text-sky-400" />
            </button>
            {r.imageUrl && (
              <a href={r.imageUrl} target="_blank" rel="noopener noreferrer" download title="Open/download">
                <Download className="w-3 h-3 text-muted hover:text-sky-400" />
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Section({ title, icon, actions, children }: { title: string; icon?: JSX.Element; actions?: JSX.Element; children: JSX.Element | JSX.Element[] }) {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-medium text-primary">{title}</h3>
        {actions && <div className="ml-auto">{actions}</div>}
      </div>
      {children}
    </div>
  )
}

function FormField({ label, children }: { label: string; children: JSX.Element }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-muted">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  )
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`font-mono text-sm ${highlight ? 'text-amber-400' : 'text-primary'}`}>{value}</div>
    </div>
  )
}
