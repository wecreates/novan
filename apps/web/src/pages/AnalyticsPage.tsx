import { useState }            from 'react'
import { useQuery }            from '@tanstack/react-query'
import { analyticsApi, type AIUsageSummary, type AIUsageDay, type AnalyticsSummary } from '../api.js'
import { MetricCard }          from '../components/MetricCard.js'
import { SectionPanel }        from '../components/SectionPanel.js'

// ─── Types ────────────────────────────────────────────────────────────────────

type Window = '1d' | '7d' | '30d'

const WINDOW_MS: Record<Window, number> = {
  '1d':  86_400_000,
  '7d':  604_800_000,
  '30d': 2_592_000_000,
}

// ─── CSS Bar ─────────────────────────────────────────────────────────────────

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  return (
    <div style={{ background: 'var(--bg-elevated)', borderRadius: 3, height: 8, overflow: 'hidden' }}>
      <div
        style={{
          width:      `${Math.min(100, max > 0 ? (value / max) * 100 : 0)}%`,
          height:     '100%',
          background: color,
          borderRadius: 3,
          transition: 'width 0.3s',
        }}
      />
    </div>
  )
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtCost(v: number): string {
  return `$${v.toFixed(5)}`
}

function fmtNum(v: number): string {
  return v.toLocaleString()
}

function fmtPct(v: number): string {
  return `${v.toFixed(1)}%`
}

// ─── AI Usage Summary Cards ───────────────────────────────────────────────────

function UsageCards({ data }: { data: AIUsageSummary }) {
  const cacheHitPct =
    data.totalRequests > 0
      ? (data.cachedRequests / data.totalRequests) * 100
      : 0

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <MetricCard
        label="Total Requests"
        value={fmtNum(data.totalRequests)}
        sub={`${fmtNum(data.cachedRequests)} cached`}
        accent="blue"
      />
      <MetricCard
        label="Total Cost"
        value={fmtCost(data.totalCostUsd)}
        accent="yellow"
      />
      <MetricCard
        label="Total Tokens"
        value={fmtNum(data.totalPromptTokens + data.totalOutputTokens)}
        sub={`${fmtNum(data.totalPromptTokens)} prompt · ${fmtNum(data.totalOutputTokens)} output`}
        accent="purple"
      />
      <MetricCard
        label="Avg Latency"
        value={`${data.avgLatencyMs.toFixed(0)} ms`}
        accent="green"
      />
      <MetricCard
        label="Cache Hit Rate"
        value={fmtPct(cacheHitPct)}
        sub={`${fmtNum(data.cachedRequests)} / ${fmtNum(data.totalRequests)}`}
        accent={cacheHitPct >= 50 ? 'green' : 'red'}
      />
    </div>
  )
}

// ─── Cost by Provider ─────────────────────────────────────────────────────────

function CostByProvider({ byProvider }: { byProvider: AIUsageSummary['byProvider'] }) {
  const rows = Object.entries(byProvider)
    .map(([provider, v]) => ({ provider, ...v }))
    .sort((a, b) => b.costUsd - a.costUsd)

  const maxCost = rows[0]?.costUsd ?? 1

  return (
    <SectionPanel title="Cost by Provider">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-[var(--text-secondary)] text-xs uppercase tracking-wider">
            <th className="text-left px-4 py-2 font-medium">Provider</th>
            <th className="text-right px-4 py-2 font-medium">Requests</th>
            <th className="text-right px-4 py-2 font-medium">Tokens</th>
            <th className="text-right px-4 py-2 font-medium">Cost</th>
            <th className="px-4 py-2 w-28" />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="text-center py-6 text-[var(--text-muted)]">No data</td>
            </tr>
          ) : rows.map((r) => (
            <tr key={r.provider} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-elevated)]">
              <td className="px-4 py-2 font-medium text-[var(--text-primary)]">{r.provider}</td>
              <td className="px-4 py-2 text-right tabular-nums text-[var(--text-secondary)]">{fmtNum(r.requests)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-[var(--text-secondary)]">{fmtNum(r.promptTokens + r.outputTokens)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-amber-400">{fmtCost(r.costUsd)}</td>
              <td className="px-4 py-2">
                <Bar value={r.costUsd} max={maxCost} color="var(--accent-yellow)" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </SectionPanel>
  )
}

// ─── Cost by Model ────────────────────────────────────────────────────────────

function CostByModel({ byModel }: { byModel: AIUsageSummary['byModel'] }) {
  const rows = Object.entries(byModel)
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.costUsd - a.costUsd)

  const maxCost = rows[0]?.costUsd ?? 1

  return (
    <SectionPanel title="Cost by Model">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-[var(--text-secondary)] text-xs uppercase tracking-wider">
            <th className="text-left px-4 py-2 font-medium">Model</th>
            <th className="text-right px-4 py-2 font-medium">Requests</th>
            <th className="text-right px-4 py-2 font-medium">Cost</th>
            <th className="px-4 py-2 w-28" />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="text-center py-6 text-[var(--text-muted)]">No data</td>
            </tr>
          ) : rows.map((r) => (
            <tr key={r.model} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-elevated)]">
              <td className="px-4 py-2 font-medium text-[var(--text-primary)] font-mono text-xs">{r.model}</td>
              <td className="px-4 py-2 text-right tabular-nums text-[var(--text-secondary)]">{fmtNum(r.requests)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-amber-400">{fmtCost(r.costUsd)}</td>
              <td className="px-4 py-2">
                <Bar value={r.costUsd} max={maxCost} color="var(--accent-orange)" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </SectionPanel>
  )
}

// ─── Usage by Task Type ───────────────────────────────────────────────────────

function UsageByTaskType({ byTaskType }: { byTaskType: AIUsageSummary['byTaskType'] }) {
  const rows = Object.entries(byTaskType).sort((a, b) => b[1] - a[1])
  const maxCount = rows[0]?.[1] ?? 1

  return (
    <SectionPanel title="Usage by Task Type">
      <div className="px-4 py-2 flex flex-col gap-3">
        {rows.length === 0 ? (
          <p className="text-[var(--text-muted)] text-sm py-4 text-center">No data</p>
        ) : rows.map(([type, count]) => (
          <div key={type} className="flex flex-col gap-1">
            <div className="flex justify-between text-xs">
              <span className="text-[var(--text-secondary)]">{type}</span>
              <span className="tabular-nums text-[var(--text-primary)]">{fmtNum(count)}</span>
            </div>
            <Bar value={count} max={maxCount} color="var(--accent-blue)" />
          </div>
        ))}
      </div>
    </SectionPanel>
  )
}

// ─── History Table ─────────────────────────────────────────────────────────────

function HistoryTable({ data }: { data: AIUsageDay[] }) {
  const rows = [...data].sort((a, b) => b.date.localeCompare(a.date))
  const maxTokens = Math.max(...rows.map((r) => r.tokens), 1)
  const maxCost   = Math.max(...rows.map((r) => r.costUsd), 0.000001)

  return (
    <SectionPanel title="7-Day Usage History">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-[var(--text-secondary)] text-xs uppercase tracking-wider">
            <th className="text-left px-4 py-2 font-medium">Date</th>
            <th className="text-right px-4 py-2 font-medium">Requests</th>
            <th className="text-right px-4 py-2 font-medium">Tokens</th>
            <th className="px-4 py-2 w-24" />
            <th className="text-right px-4 py-2 font-medium">Cost</th>
            <th className="px-4 py-2 w-24" />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={6} className="text-center py-6 text-[var(--text-muted)]">No data</td>
            </tr>
          ) : rows.map((r) => (
            <tr key={r.date} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-elevated)]">
              <td className="px-4 py-2 tabular-nums text-[var(--text-secondary)] font-mono text-xs">{r.date}</td>
              <td className="px-4 py-2 text-right tabular-nums text-[var(--text-primary)]">{fmtNum(r.requests)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-[var(--text-secondary)]">{fmtNum(r.tokens)}</td>
              <td className="px-4 py-2">
                <Bar value={r.tokens} max={maxTokens} color="var(--accent-blue)" />
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-amber-400">{fmtCost(r.costUsd)}</td>
              <td className="px-4 py-2">
                <Bar value={r.costUsd} max={maxCost} color="var(--accent-yellow)" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </SectionPanel>
  )
}

// ─── Workflow Run Status ───────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  completed: 'var(--accent-green)',
  failed:    'var(--accent-red)',
  running:   'var(--accent-blue)',
  pending:   'var(--accent-yellow)',
  cancelled: 'var(--text-muted)',
}

function WorkflowRunStatus({ workflowRuns }: { workflowRuns: AnalyticsSummary['workflowRuns'] }) {
  const rows = Object.entries(workflowRuns).sort((a, b) => b[1] - a[1])
  const total = rows.reduce((s, [, v]) => s + v, 0)

  return (
    <SectionPanel title="Workflow Run Status" subtitle={`${fmtNum(total)} total`}>
      <div className="px-4 py-3 flex flex-col gap-3">
        {/* Pie-like stacked bar */}
        {total > 0 && (
          <div className="flex h-3 rounded-full overflow-hidden gap-px">
            {rows.map(([status, count]) => (
              <div
                key={status}
                title={`${status}: ${count}`}
                style={{
                  flex:       count / total,
                  background: STATUS_COLORS[status] ?? 'var(--text-muted)',
                  transition: 'flex 0.3s',
                }}
              />
            ))}
          </div>
        )}
        {/* Legend */}
        <div className="flex flex-col gap-1.5">
          {rows.map(([status, count]) => (
            <div key={status} className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <div
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ background: STATUS_COLORS[status] ?? 'var(--text-muted)' }}
                />
                <span className="text-[var(--text-secondary)] capitalize">{status}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="tabular-nums text-[var(--text-primary)]">{fmtNum(count)}</span>
                <span className="text-[var(--text-muted)] w-10 text-right">{total > 0 ? fmtPct((count / total) * 100) : '—'}</span>
              </div>
            </div>
          ))}
          {rows.length === 0 && (
            <p className="text-[var(--text-muted)] text-sm text-center py-2">No data</p>
          )}
        </div>
      </div>
    </SectionPanel>
  )
}

// ─── Recent Event Types ────────────────────────────────────────────────────────

function RecentEventTypes({ recentEvents }: { recentEvents: AnalyticsSummary['recentEvents'] }) {
  const top10 = recentEvents.slice(0, 10)
  const maxCount = top10[0]?.count ?? 1

  return (
    <SectionPanel title="Recent Event Types" subtitle="Top 10">
      <div className="px-4 py-2 flex flex-col gap-2.5">
        {top10.length === 0 ? (
          <p className="text-[var(--text-muted)] text-sm py-4 text-center">No data</p>
        ) : top10.map((e) => (
          <div key={e.type} className="flex flex-col gap-1">
            <div className="flex justify-between text-xs">
              <span className="text-[var(--text-secondary)] font-mono">{e.type}</span>
              <span className="tabular-nums text-[var(--text-primary)]">{fmtNum(e.count)}</span>
            </div>
            <Bar value={e.count} max={maxCount} color="var(--accent-green)" />
          </div>
        ))}
      </div>
    </SectionPanel>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const [window, setWindow] = useState<Window>('7d')

  const windowMs = WINDOW_MS[window]

  const aiUsageQ = useQuery({
    queryKey:        ['analytics', 'ai-usage', window],
    queryFn:         () => analyticsApi.aiUsage(windowMs),
    refetchInterval: 60_000,
  })

  const historyQ = useQuery({
    queryKey:        ['analytics', 'ai-usage-history'],
    queryFn:         () => analyticsApi.aiUsageHistory(7),
    refetchInterval: 300_000,
  })

  const summaryQ = useQuery({
    queryKey:        ['analytics', 'summary'],
    queryFn:         () => analyticsApi.summary(),
    refetchInterval: 60_000,
  })

  const usage   = aiUsageQ.data?.data
  const history = historyQ.data?.data ?? []
  const summary = summaryQ.data?.data

  return (
    <div className="h-full overflow-auto bg-[var(--bg-primary)]">
      <div className="max-w-7xl mx-auto px-6 py-6 flex flex-col gap-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-[var(--text-primary)]">Analytics</h1>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">AI usage, costs, and operational metrics</p>
          </div>
          <div className="flex items-center gap-1 bg-[var(--bg-elevated)] rounded-lg p-1 border border-[var(--border)]">
            {(['1d', '7d', '30d'] as const).map((w) => (
              <button
                key={w}
                onClick={() => setWindow(w)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                  window === w
                    ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {w}
              </button>
            ))}
          </div>
        </div>

        {/* AI Usage Summary Cards */}
        {aiUsageQ.isLoading ? (
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-24 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] animate-pulse" />
            ))}
          </div>
        ) : usage ? (
          <UsageCards data={usage} />
        ) : (
          <div className="text-[var(--text-muted)] text-sm text-center py-6">Failed to load usage data</div>
        )}

        {/* Provider + Model tables */}
        {usage && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <CostByProvider byProvider={usage.byProvider} />
            <CostByModel    byModel={usage.byModel} />
          </div>
        )}

        {/* Task type + History */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {usage && (
            <UsageByTaskType byTaskType={usage.byTaskType} />
          )}
          <div className={usage ? 'lg:col-span-2' : 'lg:col-span-3'}>
            <HistoryTable data={history} />
          </div>
        </div>

        {/* Operational Summary */}
        {summaryQ.isLoading ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {[0, 1].map((i) => (
              <div key={i} className="h-48 rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] animate-pulse" />
            ))}
          </div>
        ) : summary ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <WorkflowRunStatus workflowRuns={summary.workflowRuns} />
            <RecentEventTypes  recentEvents={summary.recentEvents} />
          </div>
        ) : null}

      </div>
    </div>
  )
}
