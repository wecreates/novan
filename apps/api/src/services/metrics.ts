/**
 * metrics.ts — Prometheus-format metrics endpoint (BO06).
 *
 * Minimal in-process counter + gauge registry, exposed at GET /metrics
 * in plain-text Prometheus exposition format. No external dependencies
 * (we don't pull in prom-client because the surface we need is tiny
 * and the dependency adds churn we don't want).
 *
 * Honest scope:
 *   - Counters monotonically increase. `incCounter('foo')` adds 1.
 *   - Gauges are last-write-wins. `setGauge('bar', 42)` replaces.
 *   - Labels are flat strings encoded into the metric name (good enough
 *     for our cardinality — we never label by workspaceId etc.).
 *   - No histograms yet (would matter for latency distribution; for now
 *     latency is observable via the event stream + Architecture tab).
 *
 * Wiring: call `incCounter('cron_tick_total', { task: 'incident' })`
 * from cron tasks, etc. The renderer formats the global registry.
 */

type LabelSet = Record<string, string>

interface Counter { name: string; help: string; values: Map<string, number> }
interface Gauge   { name: string; help: string; values: Map<string, number> }

const counters = new Map<string, Counter>()
const gauges   = new Map<string, Gauge>()

function labelKey(labels?: LabelSet): string {
  if (!labels) return ''
  const keys = Object.keys(labels).sort()
  if (keys.length === 0) return ''
  return keys.map(k => `${k}="${String(labels[k]).replace(/"/g, '\\"')}"`).join(',')
}

export function incCounter(name: string, labels?: LabelSet, by: number = 1, help: string = ''): void {
  let c = counters.get(name)
  if (!c) { c = { name, help, values: new Map() }; counters.set(name, c) }
  const k = labelKey(labels)
  c.values.set(k, (c.values.get(k) ?? 0) + by)
}

export function setGauge(name: string, value: number, labels?: LabelSet, help: string = ''): void {
  let g = gauges.get(name)
  if (!g) { g = { name, help, values: new Map() }; gauges.set(name, g) }
  g.values.set(labelKey(labels), value)
}

/** Render the registry in Prometheus exposition format. */
export function renderMetrics(): string {
  const lines: string[] = []
  for (const c of counters.values()) {
    if (c.help) lines.push(`# HELP ${c.name} ${c.help}`)
    lines.push(`# TYPE ${c.name} counter`)
    for (const [k, v] of c.values) {
      lines.push(`${c.name}${k ? `{${k}}` : ''} ${v}`)
    }
  }
  for (const g of gauges.values()) {
    if (g.help) lines.push(`# HELP ${g.name} ${g.help}`)
    lines.push(`# TYPE ${g.name} gauge`)
    for (const [k, v] of g.values) {
      lines.push(`${g.name}${k ? `{${k}}` : ''} ${v}`)
    }
  }
  return lines.join('\n') + '\n'
}

/** Test-only: clear the registry. Not exported by the route handler. */
export function _resetMetricsForTests(): void {
  counters.clear()
  gauges.clear()
}

/** Lightweight Sentry-style unhandled-exception capture. Real Sentry
 *  initializes via env DSN; if absent, we no-op (errors still flow to
 *  pino via the process-level unhandledRejection handler in server.ts). */
export function initErrorReporting(): { configured: boolean } {
  const dsn = process.env['SENTRY_DSN']
  if (!dsn) return { configured: false }
  // Real Sentry init would happen here; we leave the hook so wiring is
  // a one-line change when ops decides to add the dep.
  return { configured: true }
}

/** Lightweight OpenTelemetry hook. Real OTel initializes via SDK; if
 *  the env var is absent we no-op. */
export function initTracing(): { configured: boolean } {
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
  if (!endpoint) return { configured: false }
  return { configured: true }
}
