/**
 * Simulation — scenario generation + forecast accuracy + recent scenarios.
 */
import React, { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { FlaskConical, Play, Activity, TrendingUp } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

interface Scenario {
  id: string; kind: string; name: string
  inputs: Record<string, unknown>
  bestCase: Record<string, unknown>
  likelyCase: Record<string, unknown>
  worstCase: Record<string, unknown>
  confidence: number
  mitigation: string[]
  evidenceRefs: Array<{ type: string; id: string; extract: string }>
  createdAt: number
}
interface WarRoom {
  recentScenarios: Scenario[]
  accuracy: { total: number; matched: number; matchRate: number | null; byKind: Record<string, { total: number; matched: number }> }
  availableKinds: string[]
}

export default function SimulationPage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState<string | null>(null)

  const room = useQuery({
    queryKey: ['sim-war', workspaceId],
    queryFn: () => api.get<{ data: WarRoom }>(`/api/v1/sim/war-room?workspace_id=${workspaceId}`),
    refetchInterval: 60_000,
  })

  const build = useMutation({
    mutationFn: (kind: string) => api.post(`/api/v1/sim/scenarios`, { workspace_id: workspaceId, kind }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sim-war', workspaceId] }),
  })

  const d = room.data?.data
  return (
    <div className="p-6 space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center gap-3">
        <FlaskConical className="w-5 h-5 text-amber-400" />
        <h1 className="text-xl font-semibold">Scenario Simulation</h1>
        <span className="text-xs text-[var(--text-muted)] ml-1">forecasts use persisted evidence · all cases marked estimate</span>
      </div>

      {/* Accuracy */}
      {d && (
        <Section title="Forecast accuracy" icon={<Activity className="w-4 h-4 text-sky-400" />}>
          <div className="p-4 flex items-center gap-6 text-sm">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Total</div>
              <div className="font-mono">{d.accuracy.total}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Matched</div>
              <div className="font-mono">{d.accuracy.matched}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">Match rate</div>
              <div className="font-mono">{d.accuracy.matchRate === null ? '— (need ≥5)' : `${(d.accuracy.matchRate * 100).toFixed(0)}%`}</div>
            </div>
          </div>
        </Section>
      )}

      {/* Available kinds */}
      {d && (
        <Section title="Build scenario" icon={<Play className="w-4 h-4 text-emerald-400" />}>
          <div className="p-4 flex flex-wrap gap-2">
            {d.availableKinds.map(k => (
              <button key={k} onClick={() => build.mutate(k)} disabled={build.isPending}
                className="px-3 py-1 text-xs rounded border border-[var(--border)] hover:bg-[var(--surface-hover)] font-mono">
                {k}
              </button>
            ))}
          </div>
          <div className="px-4 pb-3 text-[10px] text-[var(--text-muted)]">
            Honest: kinds backed by persisted history. Others (deployment_failure, traffic_surge, etc.) require data sources not yet wired.
          </div>
        </Section>
      )}

      {/* Recent scenarios */}
      <Section title={`Recent scenarios (${d?.recentScenarios.length ?? 0})`} icon={<TrendingUp className="w-4 h-4 text-purple-400" />}>
        {(d?.recentScenarios ?? []).length === 0 ? (
          <Empty msg="No scenarios. Pick a kind above to build one." />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {d!.recentScenarios.map(s => {
              const isOpen = expanded === s.id
              return (
                <li key={s.id} className="px-4 py-2 text-xs">
                  <button onClick={() => setExpanded(isOpen ? null : s.id)} className="w-full text-left flex items-center gap-2 hover:underline">
                    <span className="font-mono text-[10px] text-[var(--text-muted)]">{new Date(s.createdAt).toLocaleString().replace(',', '')}</span>
                    <span className="font-mono">{s.kind}</span>
                    <span className="flex-1">{s.name}</span>
                    <span className="text-[10px] text-sky-300">conf {s.confidence.toFixed(2)}</span>
                  </button>
                  {isOpen && (
                    <div className="mt-2 pl-4 space-y-2 text-[10px]">
                      <Case label="best"   data={s.bestCase} color="emerald" />
                      <Case label="likely" data={s.likelyCase} color="sky" />
                      <Case label="worst"  data={s.worstCase} color="red" />
                      {s.mitigation.length > 0 && (
                        <div>
                          <div className="text-purple-300 font-medium">Mitigation:</div>
                          <ul className="ml-2 text-[var(--text-muted)]">
                            {s.mitigation.map((m, i) => <li key={i}>• {m}</li>)}
                          </ul>
                        </div>
                      )}
                      {s.evidenceRefs.length > 0 && (
                        <div className="text-[var(--text-muted)]">
                          Evidence: {s.evidenceRefs.map(e => e.extract).join(' · ')}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Section>
    </div>
  )
}

function Case({ label, data, color }: { label: string; data: Record<string, unknown>; color: 'emerald' | 'sky' | 'red' }) {
  const cls = { emerald: 'text-emerald-300', sky: 'text-sky-300', red: 'text-red-300' }[color]
  return (
    <div>
      <span className={`font-medium ${cls}`}>{label}:</span>{' '}
      <span className="font-mono text-[var(--text-muted)]">{JSON.stringify(data)}</span>
    </div>
  )
}

function Section({ title, icon, children }: { title: string; icon?: JSX.Element; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <div className="px-4 py-2.5 border-b border-[var(--border)] flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-medium text-[var(--text)]">{title}</h3>
      </div>
      {children}
    </div>
  )
}

function Empty({ msg }: { msg: string }) {
  return <div className="px-4 py-3 text-xs text-[var(--text-muted)] italic">{msg}</div>
}
