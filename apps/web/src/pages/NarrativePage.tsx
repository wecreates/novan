/**
 * NarrativePage — plain-English summary of what Novan did recently (#48).
 *
 * Surfaces the narrative-intelligence service. Operator picks a window;
 * we render the headline + paragraphs + bullets exactly as the service
 * composes them. Deterministic, replayable, auditable. No LLM round-trip.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BookOpen, RefreshCw, AlertCircle, Inbox } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'
import { PageHeader } from '../components/PageHeader.js'
import { EmptyState } from '../components/EmptyState.js'
import { SkeletonCard } from '../components/Skeleton.js'

interface Narrative {
  headline:    string
  paragraphs:  Array<{ heading: string; body: string }>
  bullets:     Array<{ label: string; value: string }>
  confidence:  number
  windowMs:    number
  eventCount:  number
}

const WINDOWS: Array<{ label: string; minutes: number }> = [
  { label: '15m',  minutes: 15 },
  { label: '1h',   minutes: 60 },
  { label: '4h',   minutes: 240 },
  { label: '24h',  minutes: 1440 },
  { label: '7d',   minutes: 7 * 1440 },
]

export default function NarrativePage() {
  const { workspaceId } = useWorkspace()
  const [windowMin, setWindowMin] = useState(60)
  const [topic, setTopic] = useState('')

  const q = useQuery({
    queryKey: ['narrative', workspaceId, windowMin, topic],
    queryFn: () => api.get<{ data: Narrative }>(
      `/api/v1/intel-ops/narrative/recent?workspace_id=${workspaceId}&window_min=${windowMin}` +
      (topic ? `&topic=${encodeURIComponent(topic)}` : ''),
    ),
    refetchInterval: 60_000,
  })

  const n = q.data?.data

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <PageHeader
        breadcrumb="Intelligence"
        title="Narrative"
        subtitle="Plain-English summary of recent platform activity — deterministic, auditable, no LLM."
        actions={
          <button onClick={() => q.refetch()}
            className="btn btn-ghost focus-ring"
            aria-label="Refresh"
            title="Refresh">
            <RefreshCw className={`w-3.5 h-3.5 ${q.isFetching ? 'animate-spin' : ''}`} />
          </button>
        }
      />

      {/* Controls */}
      <div className="panel p-3 mb-6 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wider text-[var(--text-muted)] mr-1">Window</span>
          <div className="inline-flex items-center bg-[var(--bg-elevated)] rounded-md p-0.5 border border-[var(--border)]">
            {WINDOWS.map(w => (
              <button key={w.minutes} onClick={() => setWindowMin(w.minutes)}
                className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors focus-ring ${
                  windowMin === w.minutes
                    ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-sm'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}>
                {w.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-1 min-w-[200px] max-w-md">
          <span className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">Topic</span>
          <input type="text" value={topic} onChange={(e) => setTopic(e.target.value)}
            placeholder="event-type prefix (optional)"
            className="input flex-1 text-xs" style={{ padding: '4px 10px' }} />
        </div>
      </div>

      {/* Body */}
      {q.isLoading && (
        <div className="space-y-3">
          <SkeletonCard height={88} />
          <SkeletonCard height={120} />
          <SkeletonCard height={120} />
        </div>
      )}

      {q.isError && (
        <div className="panel p-4 flex items-center gap-2 text-sm text-[var(--accent-warning)]">
          <AlertCircle className="w-4 h-4" />
          <span>Failed to load narrative — check the API logs.</span>
        </div>
      )}

      {n && n.eventCount === 0 && !q.isLoading && (
        <EmptyState
          icon={<Inbox className="w-8 h-8" />}
          title="Nothing happened in this window"
          description="Try widening the time range, or clear the topic filter to see all events."
        />
      )}

      {n && n.eventCount > 0 && (
        <div className="space-y-4">
          {/* Headline */}
          <div className="panel p-5">
            <p className="text-[15px] leading-relaxed text-[var(--text-primary)]">{n.headline}</p>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--text-muted)]">
              <span className="inline-flex items-center gap-1">
                <span className={`dot ${n.confidence >= 0.7 ? 'dot-healthy' : n.confidence >= 0.4 ? 'dot-warning' : 'dot-muted'}`} />
                {Math.round(n.confidence * 100)}% confidence
              </span>
              <span>{n.eventCount.toLocaleString()} events</span>
              <span>window {humanWindow(n.windowMs)}</span>
            </div>
          </div>

          {/* Paragraphs */}
          {n.paragraphs.length > 0 && (
            <div className="space-y-3">
              {n.paragraphs.map((p, i) => (
                <section key={i} className="panel p-5">
                  <h2 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)] mb-2">
                    {p.heading}
                  </h2>
                  <p className="text-sm leading-relaxed text-[var(--text-primary)] whitespace-pre-wrap">{p.body}</p>
                </section>
              ))}
            </div>
          )}

          {/* Bullets */}
          {n.bullets.length > 0 && (
            <section className="panel p-5">
              <h2 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)] mb-3">
                Facts
              </h2>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-[13px]">
                {n.bullets.map((b, i) => (
                  <div key={i} className="flex items-center justify-between border-b border-[var(--border)] py-1">
                    <dt className="text-[var(--text-secondary)]">{b.label}</dt>
                    <dd className="font-mono text-[var(--text-primary)]">{b.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {n.confidence < 0.5 && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--surface-hover)] text-[11px] text-[var(--text-secondary)]">
              <AlertCircle className="w-3.5 h-3.5 text-[var(--accent-warning)] mt-0.5 shrink-0" />
              <span>Low confidence — events are scattered across many types; narrative may be incomplete.</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function humanWindow(ms: number): string {
  const min = Math.round(ms / 60_000)
  if (min < 60)            return `${min} min`
  if (min < 1440)          return `${Math.round(min / 60)} hr`
  return `${Math.round(min / 1440)} days`
}
