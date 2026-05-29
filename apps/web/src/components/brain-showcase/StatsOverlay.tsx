/**
 * StatsOverlay.tsx — The impressive numbers panel for presentation mode.
 *
 * "47 agents · 6 businesses · 12,000 tasks completed this month" —
 * the screenshot-worthy stats that the spec calls out by name.
 *
 * Numbers route through `formatCount` / `formatAmount` so the
 * anonymization toggle redacts in one place.
 */
import { formatCount, formatAmount } from './anonymize'

export interface ShowcaseStats {
  agents:         number
  businesses:     number
  workflows:      number
  tasksThisMonth: number
  eventsToday:    number
  revenueMonthly: number
}

interface Props {
  stats:      ShowcaseStats | null
  anonOn:     boolean
  brandLine?: string
}

export function StatsOverlay({ stats, anonOn, brandLine = 'Novan' }: Props): JSX.Element {
  return (
    <div className="absolute top-0 left-0 right-0 pointer-events-none z-10">
      <div className="flex items-center justify-between px-8 py-6">
        <div className="text-white/90">
          <div className="text-[11px] uppercase tracking-[0.2em] text-white/40 mb-1">{brandLine}</div>
          <div className="text-[28px] font-light tracking-tight">The Brain</div>
        </div>
        {anonOn && (
          <div className="text-[10px] uppercase tracking-[0.2em] text-amber-300/80 border border-amber-300/30 px-2 py-1 rounded bg-amber-300/5">
            Presentation mode · privacy on
          </div>
        )}
      </div>
      {stats && (
        <div className="px-8 mt-2">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 max-w-5xl">
            <Stat label="Agents"          value={formatCount(stats.agents, anonOn)} />
            <Stat label="Businesses"      value={formatCount(stats.businesses, anonOn)} />
            <Stat label="Workflows"       value={formatCount(stats.workflows, anonOn)} />
            <Stat label="Tasks this month" value={formatCount(stats.tasksThisMonth, anonOn)} />
            <Stat label="Events today"    value={formatCount(stats.eventsToday, anonOn)} />
            <Stat label="Revenue / mo"    value={formatAmount(stats.revenueMonthly, anonOn)} />
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.18em] text-white/40 mb-0.5">{label}</div>
      <div className="text-[22px] font-light text-white tabular-nums">{value}</div>
    </div>
  )
}
