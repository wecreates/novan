/**
 * SkillLibraryPage — browse + search imported SKILL.md files.
 *
 * The library is read-only here (ingestion is triggered via the
 * standalone import script or the /ingest API endpoint). The
 * operator searches, picks a skill, reads its body, and can hit
 * "Apply" which records usage and copies the body for use elsewhere.
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { BookOpen, Search, Copy, ExternalLink, Loader2 } from 'lucide-react'
import { api } from '../api.js'
import { PageHeader } from '../components/PageHeader.js'

interface SkillSummary {
  id: string
  name: string
  description: string
  license: string | null
  category: string | null
  tags: string[]
  useCount: number
  lastUsedAt: number | null
  sourceRepo: string | null
}
interface SkillDetail extends SkillSummary {
  body: string
  sourcePath: string
}

export default function SkillLibraryPage() {
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [category, setCategory] = useState<string>('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const list = useQuery({
    queryKey: ['skill-library', q, category],
    queryFn:  () => api.get<{ data: SkillSummary[] }>(
      `/api/v1/skill-library?${new URLSearchParams({
        ...(q        ? { q } : {}),
        ...(category ? { category } : {}),
        sort: 'used',
        limit: '500',
      }).toString()}`,
    ).then(r => r.data),
  })

  const cats = useQuery({
    queryKey: ['skill-categories'],
    queryFn:  () => api.get<{ data: Array<{ category: string | null; count: number }> }>(`/api/v1/skill-library/categories`)
                       .then(r => r.data),
  })

  const detail = useQuery({
    queryKey: ['skill-detail', selectedId],
    queryFn:  () => selectedId
      ? api.get<{ data: SkillDetail }>(`/api/v1/skill-library/${selectedId}`).then(r => r.data)
      : Promise.resolve(null),
    enabled: !!selectedId,
  })

  const use = useMutation({
    mutationFn: (id: string) => api.post<{ data: SkillSummary }>(`/api/v1/skill-library/${id}/use`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skill-library'] }),
  })

  const skills = list.data ?? []
  const categories = (cats.data ?? []).filter(c => c.category).sort((a, b) => b.count - a.count)
  const totalCount = (cats.data ?? []).reduce((a, r) => a + r.count, 0)

  function copyBody() {
    if (!detail.data) return
    navigator.clipboard.writeText(detail.data.body).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
    use.mutate(detail.data.id)
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <PageHeader
        breadcrumb="Brain · Skill Library"
        title="Skill Library"
        subtitle={`${totalCount} imported SKILL.md files. Search + apply to inject instructions into your current task.`}
      />

      {/* Search + category */}
      <div className="flex gap-2 mb-3 flex-wrap items-center">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search by name, slug, or description…"
            className="w-full bg-[var(--bg-elevated)] border border-[var(--border)] rounded-md pl-8 pr-3 py-1.5 text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus-ring"
          />
        </div>
        <div className="text-[11px] text-[var(--text-muted)]">{skills.length} shown</div>
      </div>

      {/* Category pills */}
      <div className="flex gap-1.5 mb-4 flex-wrap text-[11px]">
        <CatPill active={category === ''} onClick={() => setCategory('')}>
          all <span className="text-[var(--text-muted)] ml-1">{totalCount}</span>
        </CatPill>
        {categories.map(c => c.category && (
          <CatPill key={c.category} active={category === c.category} onClick={() => setCategory(c.category!)}>
            {c.category} <span className="text-[var(--text-muted)] ml-1">{c.count}</span>
          </CatPill>
        ))}
      </div>

      {/* Two-column layout: list + detail */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.4fr] gap-4">
        {/* List */}
        <div className="panel overflow-hidden">
          {list.isLoading && (
            <div className="p-8 text-center text-[var(--text-muted)] text-[12px]">
              <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading…
            </div>
          )}
          {!list.isLoading && skills.length === 0 && (
            <div className="p-8 text-center text-[var(--text-muted)] text-[12px]">
              <BookOpen className="w-6 h-6 mb-2 mx-auto opacity-40" />
              {totalCount === 0
                ? <>Library is empty. Run <code className="bg-[var(--bg-elevated)] px-1 rounded">pnpm --filter @ops/api exec tsx src/scripts/import-skill-library.ts &lt;dir&gt;</code></>
                : <>No matches.</>}
            </div>
          )}
          <div className="max-h-[70vh] overflow-y-auto">
            {skills.map(s => (
              <button key={s.id}
                onClick={() => setSelectedId(s.id)}
                className={`block w-full text-left px-3 py-2 border-b border-[var(--border)] hover:bg-[var(--surface-hover)] focus-ring ${selectedId === s.id ? 'bg-[var(--surface-hover)]' : ''}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[12px] font-medium text-[var(--text-primary)] truncate">{s.name}</span>
                  {s.category && <span className="text-[9px] uppercase tracking-wider px-1 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-muted)]">{s.category}</span>}
                  {s.useCount > 0 && <span className="text-[9px] text-[var(--accent-active)] ml-auto">×{s.useCount}</span>}
                </div>
                <div className="text-[11px] text-[var(--text-muted)] line-clamp-2">{s.description}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Detail */}
        <div className="panel p-4 max-h-[70vh] overflow-y-auto">
          {!selectedId && (
            <div className="text-center text-[var(--text-muted)] text-[12px] py-12">
              Select a skill from the list.
            </div>
          )}
          {selectedId && detail.isLoading && (
            <div className="text-center text-[var(--text-muted)] text-[12px] py-12">
              <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading…
            </div>
          )}
          {detail.data && (
            <>
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <h2 className="text-[16px] font-medium text-[var(--text-primary)]">{detail.data.name}</h2>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    {detail.data.category && <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-muted)]">{detail.data.category}</span>}
                    {detail.data.license && <span className="text-[10px] text-[var(--text-muted)]">{detail.data.license}</span>}
                    {detail.data.sourceRepo && <span className="text-[10px] text-[var(--text-muted)]">· {detail.data.sourceRepo}</span>}
                    <span className="text-[10px] text-[var(--accent-active)]">used ×{detail.data.useCount}</span>
                  </div>
                  <p className="text-[12px] text-[var(--text-secondary)] mt-2">{detail.data.description}</p>
                </div>
                <button
                  onClick={copyBody}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[var(--accent-active)]/15 border border-[var(--accent-active)]/40 hover:bg-[var(--accent-active)]/25 text-[11px] text-[var(--accent-active)] focus-ring shrink-0"
                  title="Copy skill body to clipboard + record usage"
                >
                  <Copy className="w-3 h-3" /> {copied ? 'Copied!' : 'Copy & apply'}
                </button>
              </div>
              {detail.data.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-3">
                  {detail.data.tags.map(t =>
                    <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] border border-[var(--border)] text-[var(--text-muted)]">{t}</span>
                  )}
                </div>
              )}
              <details className="text-[10px] text-[var(--text-muted)] mb-3">
                <summary className="cursor-pointer hover:text-[var(--text-secondary)]">
                  <ExternalLink className="w-3 h-3 inline mr-1" /> source path
                </summary>
                <code className="block mt-1 bg-[var(--bg-elevated)] p-2 rounded text-[10px] font-mono break-all">{detail.data.sourcePath}</code>
              </details>
              <pre className="text-[11px] font-mono text-[var(--text-secondary)] bg-[var(--bg-elevated)] p-3 rounded whitespace-pre-wrap leading-relaxed">
                {detail.data.body}
              </pre>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function CatPill({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode
}) {
  return (
    <button onClick={onClick}
      className={`px-2.5 py-1 rounded-md transition-colors focus-ring text-[11px] ${
        active
          ? 'bg-[var(--accent-active)]/15 border border-[var(--accent-active)]/40 text-[var(--accent-active)]'
          : 'border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
      }`}>
      {children}
    </button>
  )
}
