/**
 * TodayPage — operator's daily landing.
 *
 * Honest aggregator. Every section pulls from a real endpoint shipped
 * this session. No invented summaries, no LLM prose. Each row links
 * back to the canonical page for that item.
 *
 * Sections:
 *   - Headline    : recap headline (one line of fact)
 *   - Priority    : top 5 ranked work items with score breakdown
 *   - Alerts      : recap alerts (blocked/failed connectors, cron errors)
 *   - In-flight   : pending approvals + active proposals
 *   - Opportunities: validated/blueprinted ideas
 *   - Quick links : entry points to the deeper surfaces
 */
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  AlertTriangle, Lightbulb, ListChecks, Activity, ArrowRight,
  Plug, BookOpen, Bug, Network, Loader2,
} from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

interface RecapData {
  since: number; now: number; hasContent: boolean
  headline: string
  improvements: Array<{ label: string; ref?: { kind: string; id: string }; at: number }>
  active:        Array<{ label: string; ref?: { kind: string; id: string }; at: number }>
  alerts:        Array<{ label: string; ref?: { kind: string; id: string }; at: number }>
  opportunities: Array<{ label: string; ref?: { kind: string; id: string }; at: number }>
  learning:      Array<{ label: string; ref?: { kind: string; id: string }; at: number }>
  counts: { improvementsCount: number; alertsCount: number; opportunitiesCount: number; activeCount: number; pendingApprovals: number }
}

interface PriorityItem {
  kind: string; id: string; title: string
  score: number; scoreParts: Record<string, number>
  ageHours: number; severity?: string
  ref: { kind: string; id: string }
}

function refToLink(ref: { kind: string; id: string }): string {
  switch (ref.kind) {
    case 'issue':    return `/issues#${ref.id}`
    case 'idea':     return `/ideas#${ref.id}`
    case 'proposal': return `/proposals#${ref.id}`
    case 'action':   return `/connectors#${ref.id}`
    case 'incident': return `/war-room#${ref.id}`
    default:         return '#'
  }
}

const KIND_TONE: Record<string, string> = {
  issue:    'var(--accent-warning)',
  idea:     'var(--accent-active)',
  proposal: '#a78bfa',
  approval: 'var(--accent-warning)',
  incident: 'var(--accent-critical)',
}

export default function TodayPage() {
  const { workspaceId } = useWorkspace()

  const recap = useQuery({
    queryKey: ['recap', workspaceId],
    queryFn:  () => api.get<{ data: RecapData }>(`/api/v1/recap?workspace_id=${workspaceId}`).then(r => r.data),
    refetchInterval: 30_000,
  })

  const priority = useQuery({
    queryKey: ['priority', workspaceId],
    queryFn:  () => api.get<{ data: PriorityItem[] }>(`/api/v1/priority?workspace_id=${workspaceId}`).then(r => r.data),
    refetchInterval: 60_000,
  })

  const r = recap.data
  const items = priority.data ?? []

  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* Headline — quiet, factual, one line */}
      <div className="mb-8">
        <div className="text-[11px] uppercase tracking-[0.15em] text-[var(--text-muted)] mb-2">Today</div>
        <h1 className="text-[24px] font-light text-[var(--text-primary)] leading-snug">
          {recap.isLoading
            ? <span className="text-[var(--text-muted)]"><Loader2 className="w-4 h-4 inline animate-spin" /> loading…</span>
            : r?.headline ?? 'Welcome.'}
        </h1>
      </div>

      {/* Top priority — what to work on next */}
      <section className="mb-8">
        <SectionHeader icon={<Activity className="w-3.5 h-3.5" />} label="Priority"
          subtitle="Ranked across issues, ideas, proposals, approvals, and incidents. Score formula visible per item." />
        {items.length === 0 ? (
          <Empty>Nothing ranked right now — system is quiet.</Empty>
        ) : (
          <div className="space-y-1.5">
            {items.slice(0, 5).map(item => (
              <Link key={`${item.kind}-${item.id}`} to={refToLink(item.ref)}
                className="block panel px-4 py-2.5 hover:bg-[var(--surface-hover)] focus-ring">
                <div className="flex items-center gap-3">
                  <div className="text-[10px] font-mono w-12 text-right" style={{ color: KIND_TONE[item.kind] ?? 'var(--text-muted)' }}>
                    {item.score.toFixed(1)}
                  </div>
                  <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
                    style={{ background: `${KIND_TONE[item.kind] ?? 'var(--text-muted)'}22`, color: KIND_TONE[item.kind] ?? 'var(--text-muted)' }}>
                    {item.kind}
                  </span>
                  <span className="flex-1 text-[12px] text-[var(--text-primary)] truncate">{item.title}</span>
                  {item.severity && <span className="text-[10px] text-[var(--text-muted)]">{item.severity}</span>}
                  <span className="text-[10px] text-[var(--text-faint)]">{Math.round(item.ageHours)}h</span>
                  <ArrowRight className="w-3 h-3 text-[var(--text-muted)]" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Two-column: Alerts + Opportunities */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <section>
          <SectionHeader icon={<AlertTriangle className="w-3.5 h-3.5" />} label={`Alerts ${r ? `(${r.alerts.length})` : ''}`} />
          {r && r.alerts.length === 0
            ? <Empty>No alerts in scope.</Empty>
            : <div className="space-y-1">
                {(r?.alerts ?? []).slice(0, 5).map((a, i) => (
                  <div key={i} className="panel px-3 py-2 text-[12px] text-[var(--text-secondary)]">
                    {a.label}
                  </div>
                ))}
              </div>}
        </section>

        <section>
          <SectionHeader icon={<Lightbulb className="w-3.5 h-3.5" />} label={`Opportunities ${r ? `(${r.opportunities.length})` : ''}`} />
          {r && r.opportunities.length === 0
            ? <Empty>No opportunities yet. Paste notes into <Link to="/ideas" className="underline">/ideas</Link> to extract some.</Empty>
            : <div className="space-y-1">
                {(r?.opportunities ?? []).slice(0, 5).map((o, i) => (
                  <div key={i} className="panel px-3 py-2 text-[12px] text-[var(--text-secondary)]">
                    {o.label}
                  </div>
                ))}
              </div>}
        </section>
      </div>

      {/* In-flight */}
      <section className="mb-8">
        <SectionHeader icon={<ListChecks className="w-3.5 h-3.5" />}
          label={`In flight ${r ? `(${r.active.length})` : ''}`}
          subtitle="Open work waiting on review, in build, or pending approval." />
        {r && r.active.length === 0
          ? <Empty>Nothing in flight.</Empty>
          : <div className="space-y-1">
              {(r?.active ?? []).slice(0, 6).map((a, i) => (
                <div key={i} className="panel px-3 py-2 text-[12px] text-[var(--text-secondary)] flex items-center gap-2">
                  <span className="w-1 h-1 rounded-full bg-[var(--accent-active)] shrink-0" />
                  {a.label}
                </div>
              ))}
            </div>}
      </section>

      {/* Quick entry points to session surfaces */}
      <section>
        <SectionHeader label="Surfaces" />
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
          <QuickLink to="/ideas"         icon={<Lightbulb className="w-3.5 h-3.5" />}      label="Ideas" />
          <QuickLink to="/issues"        icon={<Bug className="w-3.5 h-3.5" />}            label="Issues" />
          <QuickLink to="/connectors"    icon={<Plug className="w-3.5 h-3.5" />}           label="Connectors" />
          <QuickLink to="/skill-library" icon={<BookOpen className="w-3.5 h-3.5" />}       label="Skill library" />
          <QuickLink to="/war-room"      icon={<Network className="w-3.5 h-3.5" />}        label="War room" />
        </div>
      </section>
    </div>
  )
}

function SectionHeader({ icon, label, subtitle }: { icon?: React.ReactNode; label: string; subtitle?: string }) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.15em] text-[var(--text-muted)]">
        {icon} {label}
      </div>
      {subtitle && <div className="text-[11px] text-[var(--text-muted)] mt-1">{subtitle}</div>}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-[12px] text-[var(--text-muted)] italic py-2">{children}</div>
}

function QuickLink({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  return (
    <Link to={to}
      className="panel flex items-center gap-2 px-3 py-2.5 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] focus-ring">
      {icon} {label}
    </Link>
  )
}
