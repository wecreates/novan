import { useState } from 'react'
import { Film, Play, Sparkles, Tv, RefreshCw, AlertCircle, Layers, Film as FilmIcon } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

/**
 * AIVideoStudioPage — R146.101.
 *
 * Operator-facing surface for the AI Video Studio (R146.94 + R146.95-96).
 * Plan an episode, generate the shot list, route shots to frontier
 * providers, kick off end-to-end execution. The heavy lifting all
 * happens in brain-task ops; this UI is plan-and-launch.
 */

type Format = 'short' | 'long' | 'episode' | 'series-episode' | 'film-act' | 'feature-film'

interface PlanResult {
  id: string
  outline: string
  act_structure: Array<{ act: number; durationMin: number; beats: string[] }>
}

interface Shot {
  id:                string
  sceneId:           string
  beatIndex:         number
  durationSec:       number
  prompt:            string
  charactersInShot:  string[]
  cameraMove?:       string
  preferredProvider?: string
}

interface ShotListResult { shots: Shot[]; totalShots: number; estimatedGenerationMinutes: number }

interface FilmPlan {
  filmId: string
  acts: Array<{ act: number; minutes: number; storyFunction: string }>
  recommendedSubBudgets: { writingMin: number; generationHours: number; editorialHours: number }
}

async function brainOp<T = unknown>(workspaceId: string, op: string, params: Record<string, unknown>, approval = false): Promise<T> {
  const res = await api.post('/api/v1/brain/task', {
    workspace_id: workspaceId,
    plan:         [{ op, params }],
    ...(approval ? { approval_token: 'OPERATOR_APPROVED' } : {}),
  }) as { data?: { results?: Array<{ ok: boolean; data?: T; error?: string }> } }
  const r = res?.data?.results?.[0]
  if (!r?.ok) throw new Error(r?.error ?? `op ${op} failed`)
  return r.data as T
}

type Mode = 'episode' | 'film' | 'series'

export default function AIVideoStudioPage() {
  const { workspaceId } = useWorkspace()
  const [mode, setMode] = useState<Mode>('episode')
  const [working, setWorking] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  // Episode form
  const [logline,       setLogline]       = useState('A solo operator builds an autonomous AI brain to run their business')
  const [targetMinutes, setTargetMinutes] = useState(5)
  const [format,        setFormat]        = useState<Format>('long')
  const [tone,          setTone]          = useState('')

  // Plan output
  const [plan,     setPlan]     = useState<PlanResult | null>(null)
  const [shotList, setShotList] = useState<ShotListResult | null>(null)
  const [filmPlan, setFilmPlan] = useState<FilmPlan | null>(null)

  // Series form
  const [seriesTitle,   setSeriesTitle]   = useState('')
  const [seriesEpisodes, setSeriesEpisodes] = useState(6)
  const [seriesGenre,   setSeriesGenre]   = useState('drama')
  const [seriesId,      setSeriesId]      = useState<string | null>(null)

  const planEpisode = async () => {
    if (!workspaceId) return
    setWorking(true); setError(null); setShotList(null)
    try {
      const r = await brainOp<PlanResult>(workspaceId, 'aiVideo.planEpisode', {
        logline, targetMinutes, format,
        ...(tone ? { tone } : {}),
      })
      setPlan(r)
    } catch (e) { setError((e as Error).message) } finally { setWorking(false) }
  }

  const generateShotList = async () => {
    if (!workspaceId || !plan) return
    setWorking(true); setError(null)
    try {
      const sl = await brainOp<ShotListResult>(workspaceId, 'aiVideo.generateShotList', {
        episodeId: plan.id, script: plan.outline, targetMinutes,
        preferredCamera: 'cinematic',
      })
      setShotList(sl)
    } catch (e) { setError((e as Error).message) } finally { setWorking(false) }
  }

  const planFeatureFilm = async () => {
    if (!workspaceId) return
    setWorking(true); setError(null); setPlan(null); setShotList(null)
    try {
      const r = await brainOp<FilmPlan>(workspaceId, 'aiVideo.planFeatureFilm', {
        logline, targetMinutes,
      })
      setFilmPlan(r)
    } catch (e) { setError((e as Error).message) } finally { setWorking(false) }
  }

  const createSeries = async () => {
    if (!workspaceId) return
    setWorking(true); setError(null)
    try {
      const r = await brainOp<{ id: string }>(workspaceId, 'aiVideo.createSeries', {
        title: seriesTitle, logline, targetEpisodes: seriesEpisodes, genre: seriesGenre,
      })
      setSeriesId(r.id)
    } catch (e) { setError((e as Error).message) } finally { setWorking(false) }
  }

  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><Film className="w-6 h-6" />AI Video Studio</h1>
          <p className="text-sm text-gray-600 mt-1">
            Novan orchestrates Sora · Veo · Runway · Kling · Luma into long-form output the frontier tools can't produce alone:
            episodes with continuity, series with character bibles, feature films with multi-act structure.
          </p>
        </div>
      </div>

      <div className="flex gap-2 mb-6 border-b">
        {(['episode', 'film', 'series'] as Mode[]).map(m => (
          <button key={m} onClick={() => { setMode(m); setPlan(null); setShotList(null); setFilmPlan(null) }}
            className={`px-4 py-2 text-sm flex items-center gap-2 border-b-2 -mb-px ${mode === m ? 'border-black font-medium' : 'border-transparent text-gray-600 hover:text-black'}`}>
            {m === 'episode' && <FilmIcon className="w-4 h-4" />}
            {m === 'film'    && <Sparkles className="w-4 h-4" />}
            {m === 'series'  && <Tv className="w-4 h-4" />}
            {m === 'episode' ? 'Episode' : m === 'film' ? 'Feature Film' : 'Series'}
          </button>
        ))}
      </div>

      {error && <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm flex items-center gap-2"><AlertCircle className="w-4 h-4" />{error}</div>}

      {/* ── Episode mode ── */}
      {mode === 'episode' && (
        <div className="space-y-6">
          <div className="p-5 rounded-xl border bg-white">
            <h3 className="font-medium mb-4 flex items-center gap-2"><FilmIcon className="w-4 h-4" />Plan an episode</h3>
            <div className="grid grid-cols-2 gap-4">
              <label className="block col-span-2">
                <span className="text-sm text-gray-700">Logline (1-2 sentence story description)</span>
                <textarea value={logline} onChange={e => setLogline(e.target.value)} rows={2} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" />
              </label>
              <label className="block">
                <span className="text-sm text-gray-700">Target minutes ({targetMinutes})</span>
                <input type="range" min={1} max={60} step={1} value={targetMinutes} onChange={e => setTargetMinutes(Number(e.target.value))} className="mt-1 w-full" />
              </label>
              <label className="block">
                <span className="text-sm text-gray-700">Format</span>
                <select value={format} onChange={e => setFormat(e.target.value as Format)} className="mt-1 w-full rounded-lg border px-3 py-2 bg-white">
                  {(['short', 'long', 'episode', 'series-episode', 'film-act'] as Format[]).map(f => <option key={f} value={f}>{f}</option>)}
                </select>
              </label>
              <label className="block col-span-2">
                <span className="text-sm text-gray-700">Tone (optional)</span>
                <input type="text" value={tone} onChange={e => setTone(e.target.value)} placeholder="e.g. dry-witty documentary, cinematic noir" className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" />
              </label>
            </div>
            <div className="mt-4">
              <button onClick={planEpisode} disabled={working} className="px-4 py-2 rounded-lg bg-black text-white hover:bg-gray-800 text-sm disabled:opacity-50 flex items-center gap-2">
                {working ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                {working ? 'Planning…' : 'Plan episode'}
              </button>
            </div>
          </div>

          {plan && (
            <div className="p-5 rounded-xl border bg-white">
              <div className="flex justify-between items-start mb-3">
                <h3 className="font-medium flex items-center gap-2"><Layers className="w-4 h-4" />Act structure</h3>
                <span className="text-xs text-gray-500 font-mono">episode: {plan.id.slice(0, 8)}…</span>
              </div>
              <p className="text-sm text-gray-700 mb-4">{plan.outline}</p>
              <div className="space-y-3">
                {plan.act_structure.map(a => (
                  <div key={a.act} className="p-3 rounded-lg bg-gray-50 border">
                    <div className="flex items-center justify-between mb-2">
                      <div className="font-medium text-sm">Act {a.act}</div>
                      <div className="text-xs text-gray-500">{a.durationMin} min</div>
                    </div>
                    <ul className="text-sm text-gray-700 space-y-1">
                      {a.beats.map((b, i) => <li key={i} className="flex gap-2"><span className="text-gray-400">·</span>{b}</li>)}
                    </ul>
                  </div>
                ))}
              </div>
              <div className="mt-4">
                <button onClick={generateShotList} disabled={working} className="px-4 py-2 rounded-lg border hover:bg-gray-50 text-sm disabled:opacity-50 flex items-center gap-2">
                  {working ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                  Generate shot list
                </button>
              </div>
            </div>
          )}

          {shotList && (
            <div className="p-5 rounded-xl border bg-white">
              <h3 className="font-medium mb-3 flex items-center gap-2"><Film className="w-4 h-4" />Shot list</h3>
              <p className="text-sm text-gray-600 mb-4">
                {shotList.totalShots} shots · estimated render time {shotList.estimatedGenerationMinutes} min @ parallel=2
                <span className="text-xs text-amber-700 ml-2 inline-block bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
                  Executing requires OPERATOR_APPROVED + provider API keys (Runway/Veo/Sora/Kling/Luma)
                </span>
              </p>
              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 text-gray-700 uppercase tracking-wider">
                    <tr>
                      <th className="px-3 py-2 text-left">#</th>
                      <th className="px-3 py-2 text-left">Prompt</th>
                      <th className="px-3 py-2 text-right">Dur</th>
                      <th className="px-3 py-2 text-left">Camera</th>
                      <th className="px-3 py-2 text-left">Provider</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shotList.shots.slice(0, 20).map((s, i) => (
                      <tr key={s.id} className="border-t">
                        <td className="px-3 py-2 text-gray-500">{i + 1}</td>
                        <td className="px-3 py-2 truncate max-w-md">{s.prompt}</td>
                        <td className="px-3 py-2 text-right">{s.durationSec}s</td>
                        <td className="px-3 py-2 text-gray-600">{s.cameraMove ?? 'static'}</td>
                        <td className="px-3 py-2 font-mono text-gray-600">{s.preferredProvider ?? 'auto'}</td>
                      </tr>
                    ))}
                    {shotList.shots.length > 20 && (
                      <tr><td colSpan={5} className="px-3 py-2 text-center text-gray-500">… {shotList.shots.length - 20} more</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Film mode ── */}
      {mode === 'film' && (
        <div className="space-y-6">
          <div className="p-5 rounded-xl border bg-white">
            <h3 className="font-medium mb-4 flex items-center gap-2"><Sparkles className="w-4 h-4" />Plan a feature film</h3>
            <div className="grid grid-cols-2 gap-4">
              <label className="block col-span-2">
                <span className="text-sm text-gray-700">Logline</span>
                <textarea value={logline} onChange={e => setLogline(e.target.value)} rows={2} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" />
              </label>
              <label className="block col-span-2">
                <span className="text-sm text-gray-700">Target minutes ({targetMinutes})</span>
                <input type="range" min={30} max={180} step={5} value={targetMinutes} onChange={e => setTargetMinutes(Number(e.target.value))} className="mt-1 w-full" />
              </label>
            </div>
            <div className="mt-4">
              <button onClick={planFeatureFilm} disabled={working} className="px-4 py-2 rounded-lg bg-black text-white hover:bg-gray-800 text-sm disabled:opacity-50 flex items-center gap-2">
                {working ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                Plan feature film
              </button>
            </div>
          </div>

          {filmPlan && (
            <div className="p-5 rounded-xl border bg-white">
              <h3 className="font-medium mb-3">3-act structure for {targetMinutes}min film</h3>
              <div className="space-y-2 mb-4">
                {filmPlan.acts.map(a => (
                  <div key={a.act} className="p-3 rounded-lg bg-gray-50 border">
                    <div className="flex items-center justify-between">
                      <div className="font-medium text-sm">Act {a.act} ({a.minutes} min)</div>
                    </div>
                    <div className="text-sm text-gray-700 mt-1">{a.storyFunction}</div>
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div className="p-3 rounded bg-gray-50"><div className="text-xs text-gray-500 mb-1">Writing</div><div className="font-medium">{filmPlan.recommendedSubBudgets.writingMin} min</div></div>
                <div className="p-3 rounded bg-gray-50"><div className="text-xs text-gray-500 mb-1">Generation</div><div className="font-medium">{filmPlan.recommendedSubBudgets.generationHours} hours</div></div>
                <div className="p-3 rounded bg-gray-50"><div className="text-xs text-gray-500 mb-1">Editorial</div><div className="font-medium">{filmPlan.recommendedSubBudgets.editorialHours} hours</div></div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Series mode ── */}
      {mode === 'series' && (
        <div className="space-y-6">
          <div className="p-5 rounded-xl border bg-white">
            <h3 className="font-medium mb-4 flex items-center gap-2"><Tv className="w-4 h-4" />Create a series</h3>
            <div className="grid grid-cols-2 gap-4">
              <label className="block col-span-2">
                <span className="text-sm text-gray-700">Title</span>
                <input type="text" value={seriesTitle} onChange={e => setSeriesTitle(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" />
              </label>
              <label className="block col-span-2">
                <span className="text-sm text-gray-700">Logline</span>
                <textarea value={logline} onChange={e => setLogline(e.target.value)} rows={2} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" />
              </label>
              <label className="block">
                <span className="text-sm text-gray-700">Target episodes ({seriesEpisodes})</span>
                <input type="range" min={3} max={26} step={1} value={seriesEpisodes} onChange={e => setSeriesEpisodes(Number(e.target.value))} className="mt-1 w-full" />
              </label>
              <label className="block">
                <span className="text-sm text-gray-700">Genre</span>
                <input type="text" value={seriesGenre} onChange={e => setSeriesGenre(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" />
              </label>
            </div>
            <div className="mt-4">
              <button onClick={createSeries} disabled={working || !seriesTitle} className="px-4 py-2 rounded-lg bg-black text-white hover:bg-gray-800 text-sm disabled:opacity-50 flex items-center gap-2">
                {working ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Tv className="w-4 h-4" />}
                Create series
              </button>
            </div>
          </div>

          {seriesId && (
            <div className="p-5 rounded-xl border bg-green-50 border-green-200 text-sm">
              <strong>Series created:</strong> <code className="font-mono">{seriesId}</code>
              <div className="mt-2 text-gray-700">
                Next: switch to Episode tab and pass <code>seriesId</code> to <code>aiVideo.planEpisode</code> to add episodes with persistent character bible. The continuity layer (R146.100) anchors character/scene refs across all episodes.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
