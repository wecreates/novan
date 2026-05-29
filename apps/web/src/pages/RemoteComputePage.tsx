/**
 * Remote Compute Hub — overview of AI provider routing system.
 * Links to all sub-pages: settings, health, cost, failures.
 */
import { useQuery }             from '@tanstack/react-query'
import { RefreshCw, Cpu, Settings, BarChart3, AlertCircle, CheckCircle, Clock, Zap, Server, ShieldAlert } from 'lucide-react'
import { Link }                 from 'react-router-dom'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

const API = '/api/v1/ai-router'

interface HealthOverview {
  providers: Array<{ provider: string; status: string; latencyMs: number | null; errorRate: number }>
  endpoints: Array<{ id: string; name: string; healthStatus: string; latencyMs: number | null }>
}
interface BudgetState {
  dailySpendUsd: number; monthlySpendUsd: number
  dailyLimitUsd: number; monthlyLimitUsd: number
}

function useHealth() {
  const { workspaceId } = useWorkspace()
  return useQuery<{ success: true; data: HealthOverview }>({
    queryKey: ['rc-health', workspaceId],
    queryFn:  () => fetch(`${API}/health?workspace_id=${workspaceId}`).then((r) => r.json()),
    refetchInterval: 30_000,
  })
}
function useBudget() {
  const { workspaceId } = useWorkspace()
  return useQuery<{ success: true; data: BudgetState }>({
    queryKey: ['rc-budget', workspaceId],
    queryFn:  () => fetch(`${API}/budget?workspace_id=${workspaceId}`).then((r) => r.json()),
    refetchInterval: 60_000,
  })
}

function StatCard({ label, value, icon: Icon, color, to }: {
  label: string; value: string | number; icon: React.ElementType; color: string; to?: string
}) {
  const content = (
    <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon style={{ width: 16, height: 16, color }} />
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color }}>{value}</div>
    </div>
  )
  if (to) return <Link to={to} style={{ textDecoration: 'none' }}>{content}</Link>
  return content
}

function QuickLink({ to, icon: Icon, label, description, badge }: {
  to: string; icon: React.ElementType; label: string; description: string; badge?: string
}) {
  return (
    <Link to={to} style={{ textDecoration: 'none' }}>
      <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: 16, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--bg-primary)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon style={{ width: 16, height: 16, color: 'var(--text-secondary)' }} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{label}</span>
            {badge && <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 10, background: '#6366f133', color: '#6366f1', border: '1px solid #6366f144' }}>{badge}</span>}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{description}</div>
        </div>
      </div>
    </Link>
  )
}

function pct(spend: number, limit: number) {
  return limit > 0 ? Math.min(100, Math.round((spend / limit) * 100)) : 0
}

export default function RemoteComputePage() {
  const { data: healthData, isLoading: healthLoading, refetch } = useHealth()
  const { data: budgetData } = useBudget()

  const health  = healthData?.data
  const budget  = budgetData?.data
  const healthy = health ? [...health.providers, ...health.endpoints].filter((p) => (p as { status?: string; healthStatus?: string }).status === 'healthy' || (p as { healthStatus?: string }).healthStatus === 'healthy').length : 0
  const total   = health ? health.providers.length + health.endpoints.length : 0
  const overallStatus = !health ? 'unknown' : healthy === total ? 'all healthy' : healthy === 0 ? 'all down' : `${healthy}/${total} healthy`

  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--bg-primary)' }}>
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 20px' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Remote Compute</h1>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>AI provider routing — every request visible, budgeted, logged, and controllable</p>
          </div>
          <button onClick={() => refetch()} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
            <RefreshCw style={{ width: 14, height: 14 }} />
          </button>
        </div>

        {/* Status bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 24, padding: '10px 14px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8 }}>
          {healthLoading
            ? <Clock style={{ width: 14, height: 14, color: '#f59e0b' }} />
            : healthy === total && total > 0
              ? <CheckCircle style={{ width: 14, height: 14, color: '#10b981' }} />
              : <AlertCircle style={{ width: 14, height: 14, color: '#f59e0b' }} />
          }
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            {healthLoading ? 'Loading…' : `Providers: ${overallStatus}`}
          </span>
          {budget && (
            <span style={{ marginLeft: 'auto', fontSize: 12, color: pct(budget.dailySpendUsd, budget.dailyLimitUsd) >= 80 ? '#f43f5e' : 'var(--text-muted)' }}>
              ${budget.dailySpendUsd.toFixed(3)} / ${budget.dailyLimitUsd} today
            </span>
          )}
        </div>

        {/* Stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 28 }}>
          <StatCard label="Providers"      value={health?.providers.length ?? '—'} icon={Zap}        color="#6366f1" to="/compute/settings" />
          <StatCard label="Endpoints"      value={health?.endpoints.length ?? '—'} icon={Server}     color="#0ea5e9" to="/compute/settings" />
          <StatCard label="Healthy"        value={total > 0 ? `${healthy}/${total}` : '—'}            icon={CheckCircle} color="#10b981" to="/compute/health" />
          <StatCard label="Daily Spend"    value={budget ? `$${budget.dailySpendUsd.toFixed(3)}` : '—'} icon={BarChart3}  color="#8b5cf6" to="/compute/cost" />
          <StatCard label="Daily Budget %"  value={budget ? `${pct(budget.dailySpendUsd, budget.dailyLimitUsd)}%` : '—'} icon={ShieldAlert} color={budget && pct(budget.dailySpendUsd, budget.dailyLimitUsd) >= 80 ? '#f43f5e' : '#f59e0b'} to="/compute/cost" />
        </div>

        {/* Nav cards */}
        <h2 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 12 }}>Manage</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          <QuickLink to="/compute/settings"  icon={Settings}    label="Provider Settings"   description="Manage API keys, remote endpoints, fallback chain, and routing priority" />
          <QuickLink to="/compute/health"    icon={Cpu}         label="Provider Health"      description="Real-time status, latency, and error rates across all providers and endpoints" />
          <QuickLink to="/compute/cost"      icon={BarChart3}   label="Cost Dashboard"       description="Spending per provider, budget limits, daily and monthly breakdowns" />
          <QuickLink to="/dead-letter"       icon={AlertCircle} label="Failure Log"          description="Every failed request with error type, fallback used, and cost incurred" />
        </div>

      </div>
    </div>
  )
}
