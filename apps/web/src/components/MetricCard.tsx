import { clsx } from 'clsx'

interface Props {
  label:      string
  value:      string | number
  sub?:       string
  trend?:     'up' | 'down' | 'neutral'
  trendValue?: string
  accent?:    'blue' | 'green' | 'yellow' | 'red' | 'purple'
  className?: string
}

const ACCENT_STYLES = {
  blue:   'border-blue-500/20   text-blue-400',
  green:  'border-emerald-500/20 text-emerald-400',
  yellow: 'border-amber-500/20  text-amber-400',
  red:    'border-red-500/20    text-red-400',
  purple: 'border-violet-500/20 text-violet-400',
}

export function MetricCard({ label, value, sub, trend, trendValue, accent = 'blue', className }: Props) {
  const accentStyle = ACCENT_STYLES[accent]

  return (
    <div className={clsx(
      'rounded-xl border bg-[var(--bg-surface)] p-4 flex flex-col gap-2',
      accentStyle,
      className,
    )}>
      <div className="text-xs text-[var(--text-secondary)] font-medium uppercase tracking-wider">
        {label}
      </div>
      <div className="flex items-end gap-2">
        <div className="text-2xl font-semibold text-[var(--text-primary)] tabular-nums">
          {value}
        </div>
        {trendValue && (
          <div className={clsx(
            'text-sm font-medium mb-0.5',
            trend === 'up'   && 'text-emerald-400',
            trend === 'down' && 'text-red-400',
            trend === 'neutral' && 'text-[var(--text-secondary)]',
          )}>
            {trend === 'up' ? '↑' : trend === 'down' ? '↓' : '–'} {trendValue}
          </div>
        )}
      </div>
      {sub && (
        <div className="text-xs text-[var(--text-secondary)]">{sub}</div>
      )}
    </div>
  )
}
