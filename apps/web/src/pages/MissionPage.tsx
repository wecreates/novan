/**
 * Mission — Novan's canonical operating contract + live adherence.
 *
 * The 21 principles from the master directive made permanent in code.
 * Each one shows: statement, required services, observable invariants,
 * and current satisfaction state with live signals.
 */
import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { Compass, CheckCircle2, AlertCircle } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

interface Principle {
  id: string; section: string; statement: string
  requires: string[]; invariants: string[]
}
interface Charter {
  hash: string; totalPrinciples: number; principles: Principle[]
}
interface Adherence {
  generatedAt: number; charterHash: string
  totalPrinciples: number; satisfied: number; missing: number
  bySection: Record<string, { satisfied: boolean; signals: string[] }>
  overall: number
}

export default function MissionPage() {
  const { workspaceId } = useWorkspace()
  const charter   = useQuery({
    queryKey: ['mission-charter'],
    queryFn: () => api.get<{ data: Charter }>(`/api/v1/mission/charter`),
    staleTime: 24 * 60 * 60_000,
  })
  const adherence = useQuery({
    queryKey: ['mission-adherence', workspaceId],
    queryFn: () => api.get<{ data: Adherence }>(`/api/v1/mission/adherence?workspace_id=${workspaceId}`),
    refetchInterval: 60_000,
  })

  const c = charter.data?.data
  const a = adherence.data?.data
  return (
    <div className="p-6 space-y-4 max-w-5xl mx-auto">
      <div className="flex items-center gap-3">
        <Compass className="w-5 h-5 text-emerald-400" />
        <h1 className="text-xl font-semibold">Mission Charter</h1>
        <span className="text-xs text-muted ml-1">
          {c ? `${c.totalPrinciples} principles · ${c.hash}` : 'loading…'}
        </span>
        {a && (
          <span className="ml-auto text-sm font-mono">
            adherence <span className={a.overall >= 0.9 ? 'text-emerald-300' : a.overall >= 0.7 ? 'text-sky-300' : 'text-amber-300'}>
              {(a.overall * 100).toFixed(0)}%
            </span>{' '}
            <span className="text-muted">({a.satisfied}/{a.totalPrinciples})</span>
          </span>
        )}
      </div>

      {/* Mission statement banner */}
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-5 py-4 text-sm">
        <p className="text-emerald-300 font-medium mb-1">Core directive</p>
        <p className="text-primary leading-relaxed">
          Continuously build, improve, secure, optimize, govern, and evolve Novan 24/7
          without losing stability, trust, safety, or operator alignment.
        </p>
      </div>

      {/* Principles */}
      {c && (
        <ul className="space-y-2">
          {c.principles.map(p => {
            const adh = a?.bySection[p.id]
            const ok = adh?.satisfied ?? null
            return (
              <li key={p.id} className="rounded-lg border border-border bg-surface">
                <div className="px-4 py-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-mono text-muted">{p.id.toUpperCase()}</span>
                    <span className="text-[10px] uppercase tracking-wider text-muted">{p.section}</span>
                    {ok === true && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 ml-auto" />}
                    {ok === false && <AlertCircle className="w-3.5 h-3.5 text-amber-400 ml-auto" />}
                  </div>
                  <p className="text-sm text-primary mb-2">{p.statement}</p>
                  <div className="flex gap-4 text-[10px]">
                    <div className="flex-1">
                      <div className="text-muted uppercase tracking-wider mb-0.5">requires</div>
                      <div className="font-mono text-sky-300/80">{p.requires.join(' · ')}</div>
                    </div>
                    <div className="flex-1">
                      <div className="text-muted uppercase tracking-wider mb-0.5">invariants</div>
                      <div className="font-mono text-muted">{p.invariants.join(' · ')}</div>
                    </div>
                  </div>
                  {adh && adh.signals.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-border text-[10px] text-muted font-mono">
                      live: {adh.signals.join(' · ')}
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <div className="rounded-lg border border-border bg-surface px-5 py-3 text-[11px] text-muted">
        Charter hash <span className="font-mono text-primary">{c?.hash ?? '…'}</span> is committed to source. Changes require a code review.
        Adherence signals come from live database state; principles never silently auto-pass.
      </div>
    </div>
  )
}
