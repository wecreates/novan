import { useState, useEffect, useCallback } from 'react'
import { Beaker, RefreshCw, Plus, CheckCircle, XCircle, AlertCircle, Target, Brain } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

/**
 * ExperimentsPage — R146.101.
 *
 * Operator surface for experiments, hypotheses, and the brain's calibration
 * reliability curve (R146.86).
 */

interface Experiment {
  id:              string
  workspaceId:     string
  businessId:      string | null
  title:           string
  hypothesis:      string
  prediction:      string
  metric:          string
  intervention:    string
  status:          'running' | 'concluded' | 'abandoned'
  verdict:         'supported' | 'refuted' | 'inconclusive' | null
  lessons:         string | null
  confidencePre:   number | null
  confidencePost:  number | null
  startAt:         number
  endAt:           number | null
  createdAt:       number
}

interface Hypothesis {
  id:           string
  workspaceId:  string
  subject:      string
  claim:        string
  prediction:   string
  confidence:   number
  status:       'open' | 'supported' | 'refuted' | 'superseded'
  reviewedAt:   number | null
  createdAt:    number
}

interface CalibrationBucket { binLow: number; binHigh: number; n: number; empirical: number }
interface Calibration { buckets: CalibrationBucket[]; brierScore: number; n: number }

async function brainOp<T = unknown>(workspaceId: string, op: string, params: Record<string, unknown>): Promise<T> {
  const res = await api.post('/api/v1/brain/task', { workspace_id: workspaceId, plan: [{ op, params }] }) as {
    data?: { results?: Array<{ ok: boolean; data?: T; error?: string }> }
  }
  const r = res?.data?.results?.[0]
  if (!r?.ok) throw new Error(r?.error ?? `op ${op} failed`)
  return r.data as T
}

type Tab = 'experiments' | 'hypotheses' | 'calibration'

export default function ExperimentsPage() {
  const { workspaceId } = useWorkspace()
  const [tab, setTab] = useState<Tab>('experiments')
  const [experiments, setExperiments] = useState<Experiment[]>([])
  const [hypotheses,  setHypotheses]  = useState<Hypothesis[]>([])
  const [calibration, setCalibration] = useState<Calibration | null>(null)
  const [loading,     setLoading]     = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [showExperimentForm, setShowExperimentForm] = useState(false)
  const [showHypothesisForm, setShowHypothesisForm] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const [expForm, setExpForm] = useState({
    title: '', hypothesis: '', prediction: '', metric: '', intervention: '', confidence: 0.5, businessId: '',
  })
  const [hypForm, setHypForm] = useState({
    subject: '', claim: '', prediction: '', confidence: 0.5,
  })

  const refresh = useCallback(async () => {
    if (!workspaceId) return
    setLoading(true); setError(null)
    try {
      const [exps, hyps, cal] = await Promise.all([
        brainOp<Experiment[]>(workspaceId, 'experiment.list', {}),
        brainOp<Hypothesis[]>(workspaceId, 'hypothesis.list', {}),
        brainOp<Calibration>(workspaceId,   'calibration.curve', { daysBack: 90 }),
      ])
      setExperiments(exps ?? [])
      setHypotheses(hyps ?? [])
      setCalibration(cal ?? null)
    } catch (e) { setError((e as Error).message) } finally { setLoading(false) }
  }, [workspaceId])

  useEffect(() => { void refresh() }, [refresh])

  const submitExperiment = async () => {
    if (!workspaceId) return
    setSubmitting(true); setError(null)
    try {
      await brainOp(workspaceId, 'experiment.create', {
        title:        expForm.title,
        hypothesis:   expForm.hypothesis,
        prediction:   expForm.prediction,
        metric:       expForm.metric,
        intervention: expForm.intervention,
        confidence:   expForm.confidence,
        ...(expForm.businessId ? { businessId: expForm.businessId } : {}),
      })
      setShowExperimentForm(false)
      setExpForm({ title: '', hypothesis: '', prediction: '', metric: '', intervention: '', confidence: 0.5, businessId: '' })
      await refresh()
    } catch (e) { setError((e as Error).message) } finally { setSubmitting(false) }
  }

  const submitHypothesis = async () => {
    if (!workspaceId) return
    setSubmitting(true); setError(null)
    try {
      await brainOp(workspaceId, 'hypothesis.create', {
        subject:    hypForm.subject,
        claim:      hypForm.claim,
        prediction: hypForm.prediction,
        confidence: hypForm.confidence,
      })
      setShowHypothesisForm(false)
      setHypForm({ subject: '', claim: '', prediction: '', confidence: 0.5 })
      await refresh()
    } catch (e) { setError((e as Error).message) } finally { setSubmitting(false) }
  }

  const concludeExperiment = async (id: string, verdict: 'supported' | 'refuted' | 'inconclusive') => {
    if (!workspaceId) return
    if (!confirm(`Mark experiment as ${verdict}?`)) return
    try {
      await brainOp(workspaceId, 'experiment.conclude', { id, outcome: {}, verdict })
      await refresh()
    } catch (e) { setError((e as Error).message) }
  }

  const reviewHypothesis = async (id: string, verdict: 'supported' | 'refuted' | 'superseded') => {
    if (!workspaceId) return
    if (!confirm(`Mark hypothesis as ${verdict}?`)) return
    try {
      await brainOp(workspaceId, 'hypothesis.review', { id, verdict })
      await refresh()
    } catch (e) { setError((e as Error).message) }
  }

  const tabs: Array<[Tab, string, JSX.Element]> = [
    ['experiments',  'Experiments',  <Beaker className="w-4 h-4" />],
    ['hypotheses',   'Hypotheses',   <Brain className="w-4 h-4" />],
    ['calibration',  'Calibration',  <Target className="w-4 h-4" />],
  ]

  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><Beaker className="w-6 h-6" />Experiments + Hypotheses</h1>
          <p className="text-sm text-gray-600 mt-1">Every claim the brain makes becomes falsifiable. Outcomes feed the calibration curve.</p>
        </div>
        <button onClick={refresh} disabled={loading} className="px-3 py-2 rounded-lg border hover:bg-gray-50 flex items-center gap-2 text-sm">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />Refresh
        </button>
      </div>

      <div className="flex gap-2 mb-6 border-b">
        {tabs.map(([id, label, icon]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`px-4 py-2 text-sm flex items-center gap-2 border-b-2 -mb-px ${tab === id ? 'border-black font-medium' : 'border-transparent text-gray-600 hover:text-black'}`}>
            {icon}{label}
          </button>
        ))}
      </div>

      {error && <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm flex items-center gap-2"><AlertCircle className="w-4 h-4" />{error}</div>}

      {tab === 'experiments' && (
        <>
          <div className="flex justify-between items-center mb-4">
            <div className="text-sm text-gray-600">{experiments.length} total · {experiments.filter(e => e.status === 'running').length} running</div>
            <button onClick={() => setShowExperimentForm(s => !s)} className="px-3 py-2 rounded-lg bg-black text-white hover:bg-gray-800 flex items-center gap-2 text-sm"><Plus className="w-4 h-4" />New experiment</button>
          </div>

          {showExperimentForm && (
            <div className="mb-6 p-5 rounded-xl border bg-gray-50">
              <h3 className="font-medium mb-4">New experiment</h3>
              <div className="grid grid-cols-2 gap-4">
                <FormField label="Title" value={expForm.title} onChange={v => setExpForm(f => ({ ...f, title: v }))} />
                <FormField label="Business ID (optional)" value={expForm.businessId} onChange={v => setExpForm(f => ({ ...f, businessId: v }))} mono />
                <FormField label="Hypothesis" value={expForm.hypothesis} onChange={v => setExpForm(f => ({ ...f, hypothesis: v }))} multiline />
                <FormField label="Falsifiable Prediction" value={expForm.prediction} onChange={v => setExpForm(f => ({ ...f, prediction: v }))} multiline />
                <FormField label="Metric to measure" value={expForm.metric} onChange={v => setExpForm(f => ({ ...f, metric: v }))} />
                <FormField label="Intervention" value={expForm.intervention} onChange={v => setExpForm(f => ({ ...f, intervention: v }))} />
                <label className="block col-span-2">
                  <span className="text-sm text-gray-700">Pre-confidence ({expForm.confidence.toFixed(2)})</span>
                  <input type="range" min={0} max={1} step={0.05} value={expForm.confidence} onChange={e => setExpForm(f => ({ ...f, confidence: Number(e.target.value) }))} className="mt-1 w-full" />
                </label>
              </div>
              <div className="mt-4 flex gap-2">
                <button onClick={submitExperiment} disabled={submitting} className="px-4 py-2 rounded-lg bg-black text-white hover:bg-gray-800 text-sm disabled:opacity-50">{submitting ? 'Saving…' : 'Create experiment'}</button>
                <button onClick={() => setShowExperimentForm(false)} className="px-4 py-2 rounded-lg border hover:bg-gray-50 text-sm">Cancel</button>
              </div>
            </div>
          )}

          {experiments.length === 0 ? (
            <EmptyState title="No experiments yet" hint="Every meaningful change to a business or strategy should be logged here with a falsifiable prediction." />
          ) : (
            <div className="space-y-3">
              {experiments.map(e => (
                <div key={e.id} className="p-4 rounded-xl border bg-white">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-medium truncate">{e.title}</h3>
                        <StatusPill status={e.status} verdict={e.verdict} />
                      </div>
                      <div className="text-sm text-gray-700 mb-1"><strong>Hypothesis:</strong> {e.hypothesis}</div>
                      <div className="text-sm text-gray-700 mb-1"><strong>Prediction:</strong> {e.prediction}</div>
                      <div className="text-xs text-gray-500 mt-2">metric: <code>{e.metric}</code> · pre-conf {e.confidencePre?.toFixed(2) ?? '—'} · post-conf {e.confidencePost?.toFixed(2) ?? '—'}</div>
                    </div>
                    {e.status === 'running' && (
                      <div className="flex flex-col gap-1">
                        <button onClick={() => concludeExperiment(e.id, 'supported')}    className="px-3 py-1 rounded text-xs bg-green-50 text-green-700 hover:bg-green-100 border border-green-200">Supported</button>
                        <button onClick={() => concludeExperiment(e.id, 'refuted')}      className="px-3 py-1 rounded text-xs bg-red-50 text-red-700 hover:bg-red-100 border border-red-200">Refuted</button>
                        <button onClick={() => concludeExperiment(e.id, 'inconclusive')} className="px-3 py-1 rounded text-xs bg-gray-50 text-gray-700 hover:bg-gray-100 border border-gray-200">Inconclusive</button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'hypotheses' && (
        <>
          <div className="flex justify-between items-center mb-4">
            <div className="text-sm text-gray-600">{hypotheses.length} total · {hypotheses.filter(h => h.status === 'open').length} open</div>
            <button onClick={() => setShowHypothesisForm(s => !s)} className="px-3 py-2 rounded-lg bg-black text-white hover:bg-gray-800 flex items-center gap-2 text-sm"><Plus className="w-4 h-4" />New hypothesis</button>
          </div>

          {showHypothesisForm && (
            <div className="mb-6 p-5 rounded-xl border bg-gray-50">
              <h3 className="font-medium mb-4">New hypothesis</h3>
              <div className="grid grid-cols-2 gap-4">
                <FormField label="Subject" value={hypForm.subject} onChange={v => setHypForm(f => ({ ...f, subject: v }))} />
                <label className="block">
                  <span className="text-sm text-gray-700">Confidence ({hypForm.confidence.toFixed(2)})</span>
                  <input type="range" min={0} max={1} step={0.05} value={hypForm.confidence} onChange={e => setHypForm(f => ({ ...f, confidence: Number(e.target.value) }))} className="mt-1 w-full" />
                </label>
                <FormField label="Claim" value={hypForm.claim} onChange={v => setHypForm(f => ({ ...f, claim: v }))} multiline />
                <FormField label="Falsifying Prediction" value={hypForm.prediction} onChange={v => setHypForm(f => ({ ...f, prediction: v }))} multiline />
              </div>
              <div className="mt-4 flex gap-2">
                <button onClick={submitHypothesis} disabled={submitting} className="px-4 py-2 rounded-lg bg-black text-white hover:bg-gray-800 text-sm disabled:opacity-50">{submitting ? 'Saving…' : 'Create hypothesis'}</button>
                <button onClick={() => setShowHypothesisForm(false)} className="px-4 py-2 rounded-lg border hover:bg-gray-50 text-sm">Cancel</button>
              </div>
            </div>
          )}

          {hypotheses.length === 0 ? (
            <EmptyState title="No hypotheses recorded yet" hint="The brain captures beliefs here with falsifiable predictions; outcomes feed calibration." />
          ) : (
            <div className="space-y-3">
              {hypotheses.map(h => (
                <div key={h.id} className="p-4 rounded-xl border bg-white">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-medium truncate">{h.subject}</h3>
                        <HypothesisStatusPill status={h.status} />
                        <span className="text-xs text-gray-500">conf {h.confidence.toFixed(2)}</span>
                      </div>
                      <div className="text-sm text-gray-700 mb-1"><strong>Claim:</strong> {h.claim}</div>
                      <div className="text-sm text-gray-700"><strong>Falsifying prediction:</strong> {h.prediction}</div>
                    </div>
                    {h.status === 'open' && (
                      <div className="flex flex-col gap-1">
                        <button onClick={() => reviewHypothesis(h.id, 'supported')}  className="px-3 py-1 rounded text-xs bg-green-50 text-green-700 hover:bg-green-100 border border-green-200">Supported</button>
                        <button onClick={() => reviewHypothesis(h.id, 'refuted')}    className="px-3 py-1 rounded text-xs bg-red-50 text-red-700 hover:bg-red-100 border border-red-200">Refuted</button>
                        <button onClick={() => reviewHypothesis(h.id, 'superseded')} className="px-3 py-1 rounded text-xs bg-gray-50 text-gray-700 hover:bg-gray-100 border border-gray-200">Superseded</button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'calibration' && (
        <>
          <div className="mb-4">
            <div className="text-sm text-gray-600 mb-1">90-day reliability curve. Lower Brier score = better calibration.</div>
            {calibration && <div className="text-sm">Brier score: <strong className="font-mono">{calibration.brierScore.toFixed(4)}</strong> · n={calibration.n} observations</div>}
          </div>
          {!calibration || calibration.n === 0 ? (
            <EmptyState title="No observations yet" hint="Calibration data accumulates as experiments and hypotheses conclude. Drive a few cycles and check back." />
          ) : (
            <div className="rounded-xl border overflow-hidden bg-white">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-700">
                  <tr>
                    <th className="px-4 py-2 text-left">Confidence range</th>
                    <th className="px-4 py-2 text-right">n</th>
                    <th className="px-4 py-2 text-right">Empirical rate</th>
                    <th className="px-4 py-2 text-left">Gap vs ideal</th>
                  </tr>
                </thead>
                <tbody>
                  {calibration.buckets.map((b, i) => {
                    const mid = (b.binLow + b.binHigh) / 2
                    const gap = b.n > 0 ? b.empirical - mid : 0
                    return (
                      <tr key={i} className="border-t">
                        <td className="px-4 py-2 font-mono">{b.binLow.toFixed(1)}–{b.binHigh.toFixed(1)}</td>
                        <td className="px-4 py-2 text-right">{b.n}</td>
                        <td className="px-4 py-2 text-right font-mono">{b.n > 0 ? b.empirical.toFixed(2) : '—'}</td>
                        <td className="px-4 py-2">
                          {b.n > 0 ? (
                            <span className={gap > 0.1 ? 'text-blue-600' : gap < -0.1 ? 'text-red-600' : 'text-green-600'}>
                              {gap >= 0 ? '+' : ''}{gap.toFixed(2)} ({gap > 0.1 ? 'underconfident' : gap < -0.1 ? 'overconfident' : 'well-calibrated'})
                            </span>
                          ) : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function FormField({ label, value, onChange, multiline = false, mono = false }: { label: string; value: string; onChange: (v: string) => void; multiline?: boolean; mono?: boolean }) {
  return (
    <label className={`block ${multiline ? 'col-span-2' : ''}`}>
      <span className="text-sm text-gray-700">{label}</span>
      {multiline ? (
        <textarea value={value} onChange={e => onChange(e.target.value)} className={`mt-1 w-full rounded-lg border px-3 py-2 ${mono ? 'font-mono text-sm' : ''}`} rows={2} />
      ) : (
        <input type="text" value={value} onChange={e => onChange(e.target.value)} className={`mt-1 w-full rounded-lg border px-3 py-2 ${mono ? 'font-mono text-sm' : ''}`} />
      )}
    </label>
  )
}

function StatusPill({ status, verdict }: { status: string; verdict: string | null }) {
  if (status === 'running')   return <span className="px-2 py-0.5 rounded text-xs bg-blue-100 text-blue-700">running</span>
  if (status === 'abandoned') return <span className="px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600">abandoned</span>
  if (verdict === 'supported')   return <span className="px-2 py-0.5 rounded text-xs bg-green-100 text-green-700 flex items-center gap-1"><CheckCircle className="w-3 h-3" />supported</span>
  if (verdict === 'refuted')     return <span className="px-2 py-0.5 rounded text-xs bg-red-100 text-red-700 flex items-center gap-1"><XCircle className="w-3 h-3" />refuted</span>
  return <span className="px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600">{verdict ?? 'concluded'}</span>
}

function HypothesisStatusPill({ status }: { status: string }) {
  const cls = status === 'open'       ? 'bg-blue-100 text-blue-700'
            : status === 'supported'  ? 'bg-green-100 text-green-700'
            : status === 'refuted'    ? 'bg-red-100 text-red-700'
            : 'bg-gray-100 text-gray-600'
  return <span className={`px-2 py-0.5 rounded text-xs ${cls}`}>{status}</span>
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="p-8 text-center rounded-xl border bg-gray-50 text-gray-600">
      <div className="mb-1 font-medium">{title}</div>
      <div className="text-sm">{hint}</div>
    </div>
  )
}
