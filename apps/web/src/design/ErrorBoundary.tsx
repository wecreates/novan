/**
 * ErrorBoundary — route-level safety net.
 *
 * If a single page throws, the rest of the app keeps working.
 * Shows a calm recovery surface with the error message and a
 * "back to home" escape.
 */
import React from 'react'
import { AlertOctagon } from 'lucide-react'

interface State { hasError: boolean; message: string }

export class RouteErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  override state: State = { hasError: false, message: '' }

  static getDerivedStateFromError(err: Error): State {
    return { hasError: true, message: err.message || String(err) }
  }

  override componentDidCatch(err: Error, info: React.ErrorInfo) {
    // Best-effort: log to console + (optionally) backend telemetry endpoint.
    console.error('[RouteErrorBoundary]', err, info)
    // Fire-and-forget telemetry — never await, never throw
    try {
      fetch('/api/v1/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'ui.route_error',
          workspace_id: 'global',
          payload: {
            message: err.message?.slice(0, 500),
            stack: err.stack?.slice(0, 2000),
            componentStack: info.componentStack?.slice(0, 1000),
            url: typeof window !== 'undefined' ? window.location.pathname : null,
          },
          source: 'web/route-error-boundary',
        }),
      }).catch(() => null)
    } catch { /* tolerated */ }
  }

  reset = () => { this.setState({ hasError: false, message: '' }) }

  override render() {
    if (!this.state.hasError) return this.props.children
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="drawer-edge max-w-md p-5 fade-up">
          <div className="flex items-center gap-2 mb-2">
            <AlertOctagon className="w-4 h-4 text-critical" />
            <h2 className="text-sm font-medium text-primary">This page failed to render</h2>
          </div>
          <p className="text-xs text-secondary mb-3">
            The rest of Novan is still running. The error was logged to <span className="font-mono">ui.route_error</span>.
          </p>
          <pre className="text-2xs text-muted mono bg-bg border border-border rounded p-2 overflow-x-auto max-h-40 mb-3">{this.state.message}</pre>
          <div className="flex gap-2">
            <button onClick={this.reset} className="btn btn-primary text-xs">Retry</button>
            <a href="/home" className="btn text-xs">Home</a>
          </div>
        </div>
      </div>
    )
  }
}
