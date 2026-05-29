/**
 * IdeasPage — paste/import notes, see extracted idea cards, promote
 * to real businesses via the existing constructBusiness pipeline.
 *
 * Honest scope:
 *   - Heuristic extraction shows what the server actually found in the
 *     pasted text. No LLM enrichment yet — operator edits the rest.
 *   - "Promote" calls /promote which runs constructBusiness server-side.
 *     The UI then shows the resulting businessId; the brain canvas will
 *     pick up the spawn events via the existing SSE.
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Lightbulb, FileText, Sparkles, Archive, X, ArrowRight, Loader2, RefreshCw } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'
import { PageHeader } from '../components/PageHeader.js'
import { EmptyState } from '../components/EmptyState.js'

interface Idea {
  id: string
  title: string
  raw: string
  category: string | null
  targetUser: string | null
  painPoint: string | null
  solution: string | null
  features: string[]
  monetization: string | null
  techStack: string[]
  status: string
  sourceType: string
  sourceRef: string | null
  sourceExcerpt: string | null
  promotedToBusinessId: string | null
  demandScore: number | null
  difficultyScore: number | null
  buildReadiness: number | null
  upsideScore: number | null
  riskScore: number | null
  createdAt: number
  updatedAt: number
}

const STATUS_ORDER = ['raw','clarified','validated','blueprinted','promoted','archived','rejected'] as const
const STATUS_COLORS: Record<string, string> = {
  raw:         'var(--accent-warning)',
  clarified:   'var(--accent-info)',
  validated:   'var(--accent-active)',
  blueprinted: '#a78bfa',
  promoted:    'var(--accent-healthy)',
  archived:    'var(--text-muted)',
  rejected:    'var(--accent-critical)',
}

export default function IdeasPage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const [pasted, setPasted] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('')

  const list = useQuery({
    queryKey: ['ideas', workspaceId, statusFilter],
    queryFn:  () => api.get<{ data: Idea[] }>(`/api/v1/ideas?workspace_id=${workspaceId}${statusFilter ? `&status=${statusFilter}` : ''}`)
                       .then(r => r.data),
    refetchInterval: 30_000,
  })

  const stats = useQuery({
    queryKey: ['idea-stats', workspaceId],
    queryFn:  () => api.get<{ data: Array<{ status: string; category: string | null; count: number }> }>(`/api/v1/ideas/stats?workspace_id=${workspaceId}`)
                       .then(r => r.data),
  })

  const extract = useMutation({
    mutationFn: () => api.post<{ data: { extracted: number; created: Idea[]; deduped: Idea[] } }>(
      `/api/v1/ideas/extract`,
      { workspace_id: workspaceId, text: pasted, source_type: 'paste' },
    ).then(r => r.data),
    onSuccess: () => {
      setPasted('')
      qc.invalidateQueries({ queryKey: ['ideas', workspaceId] })
      qc.invalidateQueries({ queryKey: ['idea-stats', workspaceId] })
    },
  })

  function statusCount(s: string): number {
    return (stats.data ?? []).filter(r => r.status === s).reduce((a, r) => a + r.count, 0)
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        breadcrumb="Brain · Ideas"
        title="Ideas Pipeline"
        subtitle="Paste notes, chat exports, or strategy docs. Novan extracts idea drafts heuristically; you edit, blueprint, and promote into real businesses."
      />

      {/* Paste-to-extract */}
      <section className="panel p-4 mb-6">
        <div className="flex items-center gap-2 mb-2 text-[11px] text-[var(--text-muted)] uppercase tracking-wider">
          <FileText className="w-3.5 h-3.5" /> Paste notes, ChatGPT export, or strategy doc
        </div>
        <textarea
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder="Paste any text. Novan picks up 'build a...', 'idea: ...', tool/SaaS/extension patterns, plus bullet-point features near each hit."
          rows={6}
          className="w-full bg-[var(--bg-elevated)] border border-[var(--border)] rounded-md p-3 text-[13px] font-mono text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus-ring resize-y"
        />
        <div className="flex items-center justify-between mt-2">
          <div className="text-[11px] text-[var(--text-muted)]">{pasted.length.toLocaleString()} chars</div>
          <button
            onClick={() => extract.mutate()}
            disabled={extract.isPending || pasted.length < 20}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--accent-active)]/15 border border-[var(--accent-active)]/40 hover:bg-[var(--accent-active)]/25 text-[12px] text-[var(--accent-active)] focus-ring disabled:opacity-40"
          >
            {extract.isPending
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Extracting…</>
              : <><Sparkles className="w-3.5 h-3.5" /> Extract ideas</>}
          </button>
        </div>
        {extract.data && (
          <div className="mt-3 text-[11px] text-[var(--text-secondary)]">
            Extracted <strong>{extract.data.extracted}</strong> drafts ·
            <span className="text-[var(--accent-healthy)] ml-1.5">created {extract.data.created.length}</span> ·
            <span className="text-[var(--text-muted)] ml-1.5">deduped {extract.data.deduped.length}</span>
          </div>
        )}
      </section>

      {/* Status filter pills */}
      <div className="flex gap-1.5 mb-3 flex-wrap text-[11px]">
        <FilterPill active={statusFilter === ''} onClick={() => setStatusFilter('')} color="var(--text-muted)">
          All <span className="text-[var(--text-muted)]">{(stats.data ?? []).reduce((a, r) => a + r.count, 0)}</span>
        </FilterPill>
        {STATUS_ORDER.map(s => (
          <FilterPill key={s} active={statusFilter === s} onClick={() => setStatusFilter(s)} color={STATUS_COLORS[s]!}>
            {s} <span className="text-[var(--text-muted)] ml-1">{statusCount(s)}</span>
          </FilterPill>
        ))}
      </div>

      {/* Ideas grid */}
      {!list.isLoading && (list.data ?? []).length === 0 && (
        <EmptyState
          icon={<Lightbulb className="w-8 h-8" />}
          title="No ideas yet"
          description="Paste notes above and click Extract, or POST to /api/v1/ideas to create one manually."
        />
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {(list.data ?? []).map(idea => <IdeaCard key={idea.id} idea={idea} workspaceId={workspaceId} />)}
      </div>
    </div>
  )
}

function IdeaCard({ idea, workspaceId }: { idea: Idea; workspaceId: string }) {
  const qc = useQueryClient()
  const advance = useMutation({
    mutationFn: (action: 'clarify'|'validate'|'blueprint'|'archive'|'promote') =>
      api.post<{ data: unknown }>(`/api/v1/ideas/${idea.id}/${action}`, { workspace_id: workspaceId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ideas', workspaceId] }),
  })
  const reject = useMutation({
    mutationFn: (reason: string) =>
      api.post<{ data: unknown }>(`/api/v1/ideas/${idea.id}/reject`, { workspace_id: workspaceId, reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ideas', workspaceId] }),
  })

  const isTerminal  = idea.status === 'promoted' || idea.status === 'archived' || idea.status === 'rejected'
  const nextAction: 'clarify'|'validate'|'blueprint'|'promote'|null =
      idea.status === 'raw'         ? 'clarify'
    : idea.status === 'clarified'   ? 'validate'
    : idea.status === 'validated'   ? 'blueprint'
    : idea.status === 'blueprinted' ? 'promote'
    :                                 null

  const color = STATUS_COLORS[idea.status] ?? 'var(--text-muted)'

  return (
    <div className="panel p-4 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-[9px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded" style={{ background: `${color}22`, color }}>{idea.status}</span>
            {idea.category && <span className="text-[9px] uppercase tracking-wider text-[var(--text-muted)]">{idea.category}</span>}
            <span className="text-[9px] text-[var(--text-faint)]">{idea.sourceType}</span>
          </div>
          <h3 className="text-[14px] font-medium text-[var(--text-primary)] leading-snug">{idea.title}</h3>
        </div>
        {idea.promotedToBusinessId && (
          <a href={`/business/${idea.promotedToBusinessId}`}
            className="text-[10px] text-[var(--accent-healthy)] hover:underline whitespace-nowrap"
            title="Open promoted business">
            biz ↗
          </a>
        )}
      </div>

      {idea.solution && (
        <div className="text-[12px] text-[var(--text-secondary)]"><span className="text-[var(--text-muted)]">Solution: </span>{idea.solution}</div>
      )}
      {idea.painPoint && (
        <div className="text-[12px] text-[var(--text-secondary)]"><span className="text-[var(--text-muted)]">Pain: </span>{idea.painPoint}</div>
      )}
      {idea.targetUser && (
        <div className="text-[12px] text-[var(--text-secondary)]"><span className="text-[var(--text-muted)]">For: </span>{idea.targetUser}</div>
      )}
      {idea.monetization && (
        <div className="text-[12px] text-[var(--text-secondary)]"><span className="text-[var(--text-muted)]">$ </span>{idea.monetization}</div>
      )}

      {idea.features.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {idea.features.slice(0, 6).map((f, i) =>
            <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] border border-[var(--border)] text-[var(--text-secondary)]">{f}</span>
          )}
        </div>
      )}

      {idea.sourceExcerpt && (
        <details className="mt-1">
          <summary className="text-[10px] text-[var(--text-muted)] cursor-pointer hover:text-[var(--text-secondary)]">source excerpt</summary>
          <div className="mt-1 text-[10px] font-mono text-[var(--text-muted)] bg-[var(--bg-elevated)] p-2 rounded max-h-32 overflow-y-auto whitespace-pre-wrap">
            {idea.sourceExcerpt}
          </div>
        </details>
      )}

      {!isTerminal && (
        <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-[var(--border)]">
          {nextAction && (
            <button
              onClick={() => advance.mutate(nextAction)}
              disabled={advance.isPending}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium bg-[var(--accent-active)]/15 border border-[var(--accent-active)]/40 hover:bg-[var(--accent-active)]/25 text-[var(--accent-active)] focus-ring"
              title={nextAction === 'promote' ? 'Build this idea into a real business' : `Advance to ${nextAction}`}
            >
              {nextAction === 'promote' ? <Sparkles className="w-3 h-3" /> : <ArrowRight className="w-3 h-3" />}
              {nextAction === 'promote' ? 'Promote → business' : `→ ${nextAction}`}
            </button>
          )}
          <button
            onClick={() => advance.mutate('archive')}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
          >
            <Archive className="w-3 h-3" /> archive
          </button>
          <button
            onClick={() => {
              const reason = prompt('Reject reason?')
              if (reason) reject.mutate(reason)
            }}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] text-[var(--text-muted)] hover:text-[var(--accent-critical)] hover:bg-[var(--surface-hover)]"
          >
            <X className="w-3 h-3" /> reject
          </button>
          {advance.isError && (
            <span className="text-[10px] text-[var(--accent-critical)] ml-auto">
              {(advance.error as Error).message}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function FilterPill({ active, onClick, color, children }: {
  active: boolean; onClick: () => void; color: string; children: React.ReactNode
}) {
  return (
    <button onClick={onClick}
      className="px-2.5 py-1 rounded-md transition-colors focus-ring text-[11px]"
      style={{
        background: active ? `${color}22` : 'transparent',
        border: `1px solid ${active ? color : 'var(--border)'}`,
        color: active ? color : 'var(--text-secondary)',
      }}>
      {children}
    </button>
  )
}

// Suppress unused-import lint when RefreshCw isn't actively used yet
void RefreshCw
