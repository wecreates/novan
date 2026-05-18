/**
 * Commerce War Room — browser sessions + accounts + concepts + listings
 * + social posts + trends + blocked actions.
 */
import React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ShoppingBag, Globe, Lock, Sparkles, Hash, TrendingUp, ShieldAlert, Pause, Play,
} from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

interface Account { platform: string; accountRef: string; grantedScopes: string[]; paused: boolean; vaultSecretId: string | null }
interface Session { id: string; platform: string; accountRef: string; status: string; eventsCount: number }
interface Concept { id: string; brief: string; prompt: string; originalityScore: number | null; slopScore: number | null; qualityScore: number | null; status: string }
interface Listing { id: string; platform: string; title: string; status: string; qualityScore: number | null }
interface SocialPost { id: string; platform: string; accountRef: string; body: string; status: string; spamScore: number | null }
interface Trend { id: string; source: string; niche: string; signal: string; score: number; confidence: number; citations: Array<{ url: string; title: string }> }

interface WarRoom {
  accounts: Account[]
  activeSessions: Session[]
  drafts: Concept[]
  pendingPosts: SocialPost[]
  recentTrends: Trend[]
  listings: Listing[]
  blocks24h: Record<string, number>
}

export default function CommerceWarRoomPage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const room = useQuery({
    queryKey: ['commerce-war', workspaceId],
    queryFn:  () => api.get<{ data: WarRoom }>(`/api/v1/commerce/war-room?workspace_id=${workspaceId}`),
    refetchInterval: 30_000,
  })

  const pauseAccount = useMutation({
    mutationFn: ({ platform, accountRef, paused }: { platform: string; accountRef: string; paused: boolean }) =>
      api.post(`/api/v1/commerce/accounts/pause`, { workspace_id: workspaceId, platform, account_ref: accountRef, paused }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['commerce-war', workspaceId] }),
  })

  const d = room.data?.data

  return (
    <div className="p-6 space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center gap-3">
        <ShoppingBag className="w-5 h-5 text-emerald-400" />
        <h1 className="text-xl font-semibold">Commerce War Room</h1>
        <span className="text-xs text-muted ml-1">browser-permission · POD · social · NEVER purchases</span>
      </div>

      {/* Blocks summary */}
      {d && Object.keys(d.blocks24h).length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs">
          <div className="flex items-center gap-2 mb-1">
            <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
            <span className="font-medium text-amber-300">Policy blocks (24h)</span>
          </div>
          <div className="flex gap-4">
            {Object.entries(d.blocks24h).map(([k, v]) => (
              <span key={k} className="font-mono"><span className="text-muted">{k}:</span> {v}</span>
            ))}
          </div>
        </div>
      )}

      {/* Accounts */}
      <Section title={`Connected accounts (${d?.accounts.length ?? 0})`} icon={<Lock className="w-4 h-4 text-sky-400" />}>
        {(d?.accounts ?? []).length === 0 ? <Empty msg="No connected accounts. Register via /api/v1/commerce/accounts." /> : (
          <ul className="divide-y divide-[var(--border)]">
            {d!.accounts.map(a => (
              <li key={`${a.platform}/${a.accountRef}`} className="px-4 py-2 text-sm flex items-center gap-3">
                <span className="text-[10px] uppercase tracking-wider w-20 text-muted">{a.platform}</span>
                <span className="font-mono">{a.accountRef}</span>
                <span className="text-[10px] text-muted">{a.grantedScopes.join(', ') || 'no scopes'}</span>
                {a.vaultSecretId && <span className="text-[10px] text-emerald-400">creds: redacted</span>}
                <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded ${a.paused ? 'text-amber-300 bg-amber-500/10' : 'text-emerald-300 bg-emerald-500/10'}`}>
                  {a.paused ? 'PAUSED' : 'active'}
                </span>
                <button onClick={() => pauseAccount.mutate({ platform: a.platform, accountRef: a.accountRef, paused: !a.paused })}
                  className="p-1 hover:bg-[var(--surface-hover)] rounded">
                  {a.paused ? <Play className="w-3.5 h-3.5 text-emerald-400" /> : <Pause className="w-3.5 h-3.5 text-amber-400" />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Active browser sessions */}
        <Section title={`Active browser sessions (${d?.activeSessions.length ?? 0})`} icon={<Globe className="w-4 h-4 text-purple-400" />}>
          {(d?.activeSessions ?? []).length === 0 ? <Empty msg="No active sessions. Requests start pending → operator approves." /> : (
            <ul className="divide-y divide-[var(--border)]">
              {d!.activeSessions.map(s => (
                <li key={s.id} className="px-4 py-2 text-xs flex items-center gap-3">
                  <span className="font-mono w-20">{s.platform}</span>
                  <span>{s.accountRef}</span>
                  <span className="ml-auto text-muted">{s.eventsCount} events</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Pending posts */}
        <Section title={`Pending social posts (${d?.pendingPosts.length ?? 0})`} icon={<Sparkles className="w-4 h-4 text-amber-400" />}>
          {(d?.pendingPosts ?? []).length === 0 ? <Empty msg="No pending posts." /> : (
            <ul className="divide-y divide-[var(--border)]">
              {d!.pendingPosts.slice(0, 6).map(p => (
                <li key={p.id} className="px-4 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] uppercase tracking-wider text-muted">{p.platform}</span>
                    {p.spamScore !== null && <span className={`text-[10px] ${p.spamScore > 0.3 ? 'text-amber-400' : 'text-muted'}`}>slop {p.spamScore.toFixed(2)}</span>}
                  </div>
                  <p className="mt-0.5 truncate">{p.body}</p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {/* Concepts */}
      <Section title={`Design concepts (${d?.drafts.length ?? 0})`} icon={<Sparkles className="w-4 h-4 text-purple-400" />}>
        {(d?.drafts ?? []).length === 0 ? <Empty msg="No concept drafts. Create via /api/v1/commerce/concepts." /> : (
          <ul className="divide-y divide-[var(--border)]">
            {d!.drafts.map(c => (
              <li key={c.id} className="px-4 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-muted w-24 truncate" title={c.brief}>{c.brief.slice(0, 28)}</span>
                  <span className="text-[10px] text-emerald-300">orig {(c.originalityScore ?? 0).toFixed(2)}</span>
                  <span className={`text-[10px] ${(c.slopScore ?? 0) > 0.3 ? 'text-amber-400' : 'text-muted'}`}>slop {(c.slopScore ?? 0).toFixed(2)}</span>
                  <span className="text-[10px] text-sky-300">quality {(c.qualityScore ?? 0).toFixed(2)}</span>
                  <span className="ml-auto text-[10px] uppercase tracking-wider text-muted">{c.status}</span>
                </div>
                <p className="mt-0.5 text-muted truncate" title={c.prompt}>{c.prompt}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Listings */}
      <Section title={`POD listings (${d?.listings.length ?? 0})`} icon={<Hash className="w-4 h-4 text-emerald-400" />}>
        {(d?.listings ?? []).length === 0 ? <Empty msg="No listings yet." /> : (
          <ul className="divide-y divide-[var(--border)]">
            {d!.listings.map(l => (
              <li key={l.id} className="px-4 py-2 text-xs flex items-center gap-3">
                <span className="text-[10px] uppercase tracking-wider text-muted w-16">{l.platform}</span>
                <span className="flex-1 truncate">{l.title}</span>
                <span className="text-[10px] text-sky-300">quality {(l.qualityScore ?? 0).toFixed(2)}</span>
                <span className="text-[10px] uppercase tracking-wider text-muted">{l.status}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Trends */}
      <Section title={`Recent trends (${d?.recentTrends.length ?? 0})`} icon={<TrendingUp className="w-4 h-4 text-sky-400" />}>
        {(d?.recentTrends ?? []).length === 0 ? <Empty msg="No trend findings. POST /api/v1/commerce/trends to record." /> : (
          <ul className="divide-y divide-[var(--border)]">
            {d!.recentTrends.map(t => (
              <li key={t.id} className="px-4 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-wider text-muted w-20">{t.source}</span>
                  <span className="font-medium">{t.niche}</span>
                  <span className="text-[10px] text-emerald-300">score {t.score.toFixed(2)}</span>
                  <span className="text-[10px] text-muted">conf {t.confidence.toFixed(2)}</span>
                </div>
                <p className="mt-0.5 text-muted">{t.signal}</p>
                {t.citations.length > 0 && (
                  <div className="mt-0.5 text-[10px] text-muted">
                    cited: {t.citations.slice(0, 2).map(c => c.title).join(' · ')}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}

function Section({ title, icon, children }: { title: string; icon?: JSX.Element; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-medium text-primary">{title}</h3>
      </div>
      {children}
    </div>
  )
}

function Empty({ msg }: { msg: string }) {
  return <div className="px-4 py-3 text-xs text-muted italic">{msg}</div>
}
