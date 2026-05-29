/**
 * PromptLabPage — R146.22
 *
 * The prompt-evolution registry that runs weekly auto-mutation cron
 * had ZERO operator visibility. This page lists every slot in the
 * workspace with its version count, active count, best mean score,
 * and total uses; opens any slot to see all versions side-by-side
 * (score, mutation directive, retired status, full body); lets the
 * operator manually trigger evolvePrompt for a slot, seed a new
 * version, retire one, or re-enable a retired one.
 *
 * Backend: routes/prompts.ts (R146.22 — new route layer)
 */
import React, { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Beaker, Play, Plus, ArrowLeft, ToggleLeft, ToggleRight, GitBranch } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

interface SlotSummary {
  slot:           string
  versions:       number
  activeVersions: number
  bestMean:       number | null
  totalUses:      number
}

interface PromptVersion {
  id:           string
  workspaceId:  string
  slot:         string
  version:      number
  body:         string
  uses:         number
  scoreSum:     number
  lastScore:    number | null
  lastUsedAt:   number | null
  enabled:      boolean
  parentId:     string | null
  origin:       string
  createdAt:    number
  updatedAt:    number
  meanScore:    number | null
}

const ORIGIN_TONE: Record<string, string> = {
  seed:           'text-slate-300 bg-slate-500/15 border-slate-500/40',
  manual_edit:    'text-sky-300 bg-sky-500/15 border-sky-500/40',
  auto_mutation:  'text-amber-300 bg-amber-500/15 border-amber-500/40',
  auto_promotion: 'text-emerald-300 bg-emerald-500/15 border-emerald-500/40',
}

export default function PromptLabPage() {
  const { workspaceId } = useWorkspace()
  const [openSlot, setOpenSlot] = useState<string | null>(null)

  if (openSlot) return <SlotDetail slot={openSlot} workspaceId={workspaceId} onBack={() => setOpenSlot(null)} />
  return <SlotList workspaceId={workspaceId} onOpen={setOpenSlot} />
}

function SlotList({ workspaceId, onOpen }: { workspaceId: string; onOpen: (slot: string) => void }) {
  const list = useQuery({
    queryKey: ['prompt-slots', workspaceId],
    queryFn:  () => api.get<{ data: SlotSummary[] }>(`/api/v1/prompts?workspace_id=${workspaceId}`),
    refetchInterval: 60_000,
  })
  const slots = list.data?.data ?? []

  return (
    <div className="p-6 space-y-4 max-w-6xl mx-auto">
      <div className="flex items-center gap-3">
        <Beaker className="w-5 h-5 text-purple-400" />
        <h1 className="text-xl font-semibold">Prompt Lab</h1>
        <span className="text-xs text-muted">{slots.length} slots · {slots.reduce((a, s) => a + s.totalUses, 0)} total uses</span>
      </div>

      {list.isLoading ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : slots.length === 0 ? (
        <div className="rounded-lg border border-slate-500/30 bg-slate-500/5 px-5 py-4 text-sm text-muted">
          No prompt slots in this workspace yet. They'll appear once the brain calls <code className="font-mono">usePrompt(workspaceId, slot)</code> for any task type.
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-surface divide-y divide-[var(--border)]">
          {slots.map(s => (
            <button
              key={s.slot}
              onClick={() => onOpen(s.slot)}
              className="w-full text-left px-4 py-3 hover:bg-[var(--surface-hover)] grid grid-cols-12 gap-2 items-center"
            >
              <span className="col-span-4 font-mono text-sm">{s.slot}</span>
              <span className="col-span-2 text-xs text-muted">{s.activeVersions}/{s.versions} active</span>
              <span className="col-span-3 text-xs">
                {s.bestMean !== null
                  ? <span className="text-emerald-400 font-mono">best mean {s.bestMean.toFixed(3)}</span>
                  : <span className="text-muted italic">no scored uses yet</span>}
              </span>
              <span className="col-span-2 text-xs text-muted text-right">{s.totalUses.toLocaleString()} uses</span>
              <span className="col-span-1 text-xs text-sky-400 text-right">open →</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function SlotDetail({ slot, workspaceId, onBack }: { slot: string; workspaceId: string; onBack: () => void }) {
  const qc = useQueryClient()
  const [seedOpen, setSeedOpen] = useState(false)
  const [seedBody, setSeedBody] = useState('')

  const list = useQuery({
    queryKey: ['prompt-versions', workspaceId, slot],
    queryFn:  () => api.get<{ data: PromptVersion[] }>(`/api/v1/prompts/${encodeURIComponent(slot)}?workspace_id=${workspaceId}`),
    refetchInterval: 60_000,
  })

  const evolve = useMutation({
    mutationFn: () => api.post<{ data: { retired: number; added: unknown; reason: string } }>(
      `/api/v1/prompts/${encodeURIComponent(slot)}/evolve`, { workspace_id: workspaceId }),
    onSuccess:  () => { void qc.invalidateQueries({ queryKey: ['prompt-versions', workspaceId, slot] }) },
  })

  const seed = useMutation({
    mutationFn: () => api.post(
      `/api/v1/prompts/${encodeURIComponent(slot)}/seed`,
      { workspace_id: workspaceId, body: seedBody }),
    onSuccess: () => {
      setSeedBody(''); setSeedOpen(false)
      void qc.invalidateQueries({ queryKey: ['prompt-versions', workspaceId, slot] })
    },
  })

  const toggle = useMutation({
    mutationFn: (vars: { id: string; enable: boolean }) =>
      api.post(`/api/v1/prompts/${vars.id}/${vars.enable ? 'enable' : 'retire'}`, { workspace_id: workspaceId }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['prompt-versions', workspaceId, slot] }) },
  })

  const versions = list.data?.data ?? []
  const active = versions.filter(v => v.enabled)
  const retired = versions.filter(v => !v.enabled)

  return (
    <div className="p-6 space-y-4 max-w-6xl mx-auto">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-xs text-muted hover:text-primary flex items-center gap-1">
          <ArrowLeft className="w-3 h-3" /> back
        </button>
        <Beaker className="w-5 h-5 text-purple-400" />
        <h1 className="text-xl font-mono">{slot}</h1>
        <span className="text-xs text-muted">{active.length} active · {retired.length} retired</span>
        <button
          onClick={() => evolve.mutate()}
          disabled={evolve.isPending}
          className="ml-auto flex items-center gap-1 px-3 py-1.5 rounded text-xs border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 disabled:opacity-50"
        >
          <GitBranch className="w-3 h-3" /> {evolve.isPending ? 'Evolving…' : 'Evolve now'}
        </button>
        <button
          onClick={() => setSeedOpen(v => !v)}
          className="flex items-center gap-1 px-3 py-1.5 rounded text-xs border border-border hover:bg-[var(--surface-hover)]"
        >
          <Plus className="w-3 h-3" /> Seed
        </button>
      </div>

      {evolve.data?.data && (
        <div className="text-xs text-muted">
          Evolve result: {evolve.data.data.reason} · retired={evolve.data.data.retired} · added={evolve.data.data.added ? 'yes' : 'no'}
        </div>
      )}

      {seedOpen && (
        <div className="rounded-lg border border-border bg-surface p-4 space-y-2">
          <div className="text-sm font-medium">Seed a new manual_edit version</div>
          <textarea
            value={seedBody}
            onChange={e => setSeedBody(e.target.value)}
            placeholder="Paste prompt body — min 10 chars, max 32k…"
            className="w-full h-40 px-3 py-2 rounded bg-[var(--surface-hover)] font-mono text-xs"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => seed.mutate()}
              disabled={seed.isPending || seedBody.length < 10}
              className="px-3 py-1.5 rounded text-xs border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
            >
              {seed.isPending ? 'Seeding…' : 'Insert version'}
            </button>
            <button onClick={() => { setSeedOpen(false); setSeedBody('') }} className="text-xs text-muted hover:text-primary">cancel</button>
            <span className="text-xs text-muted ml-auto">{seedBody.length.toLocaleString()} chars</span>
          </div>
        </div>
      )}

      {list.isLoading ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : versions.length === 0 ? (
        <div className="text-sm text-muted italic">No versions for this slot.</div>
      ) : (
        <div className="space-y-3">
          {versions.map(v => (
            <div key={v.id} className={`rounded-lg border bg-surface p-3 ${v.enabled ? 'border-border' : 'border-border opacity-60'}`}>
              <div className="flex items-center gap-2 flex-wrap text-xs">
                <span className="font-mono font-medium text-sm">v{v.version}</span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] border ${ORIGIN_TONE[v.origin] ?? ORIGIN_TONE.seed}`}>
                  {v.origin}
                </span>
                {!v.enabled && <span className="px-1.5 py-0.5 rounded text-[10px] border border-red-500/40 text-red-300 bg-red-500/10">retired</span>}
                <span className="text-muted">{v.uses.toLocaleString()} uses</span>
                {v.meanScore !== null && <span className="text-emerald-400 font-mono">mean {v.meanScore.toFixed(3)}</span>}
                {v.lastScore !== null && <span className="text-muted">last {v.lastScore.toFixed(3)}</span>}
                <span className="text-muted text-[10px]">created {new Date(v.createdAt).toLocaleDateString()}</span>
                <button
                  onClick={() => toggle.mutate({ id: v.id, enable: !v.enabled })}
                  disabled={toggle.isPending}
                  className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border border-border hover:bg-[var(--surface-hover)] disabled:opacity-50"
                >
                  {v.enabled ? <ToggleRight className="w-3 h-3 text-emerald-400" /> : <ToggleLeft className="w-3 h-3 text-muted" />}
                  {v.enabled ? 'Retire' : 'Enable'}
                </button>
              </div>
              <details className="mt-2">
                <summary className="text-xs text-muted cursor-pointer hover:text-primary">show body ({v.body.length} chars)</summary>
                <pre className="mt-1 text-[10px] font-mono bg-[var(--surface-hover)] p-2 rounded whitespace-pre-wrap overflow-x-auto max-h-96 overflow-y-auto">
                  {v.body}
                </pre>
              </details>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
