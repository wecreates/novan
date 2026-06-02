/**
 * ProposalsPage — R146.122
 *
 * Operator-facing review surface for novan.proposeCode drafts.
 * Lists code_proposals, lets you approve, build the patch, and view
 * the generated code_patches files. No auto-apply — review-only.
 */
import { useEffect, useState } from 'react'
import { API_BASE as BASE } from '../api.js'

interface Proposal {
  id: string
  title: string
  summary: string
  riskLevel: string
  status: string
  estimatedLoc: number
  filesToCreate: Array<{ path: string; purpose: string; estLoc: number }>
  filesToModify: Array<{ path: string; purpose: string; estLoc: number }>
  reasoning: string[]
  createdAt: number
  shippedAt: number | null
  shippedCommitSha: string | null
}

interface Patch {
  id: string
  proposalId: string
  status: string
  agent: string
  files: Array<{ path: string; contents: string; op: 'create' | 'modify' }>
  blockReason: string | null
  tokensUsed: number
  costUsdUsed: number
  createdAt: number
}

async function callOp<T>(op: string, params: Record<string, unknown> = {}): Promise<T | null> {
  try {
    const r = await fetch(`${BASE}/api/brain/op`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, params }), credentials: 'include',
    })
    if (!r.ok) return null
    const d = await r.json() as { result?: T }
    return d.result ?? null
  } catch { return null }
}

export default function ProposalsPage(): JSX.Element {
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [patches, setPatches] = useState<Record<string, Patch[]>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const load = async () => {
    const r = await callOp<{ proposals: Proposal[] }>('proposals.list', statusFilter ? { status: statusFilter, limit: 50 } : { limit: 50 })
    if (r) setProposals(r.proposals)
  }
  const loadPatches = async (proposalId: string) => {
    const r = await callOp<{ patches: Patch[] }>('patches.list', { proposalId })
    if (r) setPatches(p => ({ ...p, [proposalId]: r.patches }))
  }

  useEffect(() => { void load() }, [statusFilter])

  const approve = async (id: string) => {
    setBusy(id)
    await callOp('proposals.approve', { proposalId: id, approvedBy: 'operator' })
    await load(); setBusy(null)
  }
  const build = async (id: string) => {
    setBusy(id)
    await callOp('proposals.build', { proposalId: id })
    await loadPatches(id); setBusy(null)
  }

  const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
  const riskColor = (r: string) => r === 'critical' ? '#ef4444' : r === 'high' ? '#f97316' : r === 'medium' ? '#ffd47a' : '#7adfff'

  return (
    <div style={{ padding: 32, color: 'rgba(255,255,255,0.9)', fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace', height: '100%', overflow: 'auto', background: '#000' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 18 }}>
        <h1 style={{ color: '#ffd47a', fontSize: 18, fontWeight: 600, letterSpacing: '0.18em', margin: 0 }}>CODE PROPOSALS · {proposals.length}</h1>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={{ background: '#0a0a0e', color: '#ffd47a', border: '1px solid rgba(255,212,122,0.3)', borderRadius: 4, padding: '4px 8px', fontFamily: 'inherit', fontSize: 11 }}>
          <option value="">all</option><option value="proposed">proposed</option><option value="approved">approved</option><option value="rejected">rejected</option><option value="shipped">shipped</option>
        </select>
        <button onClick={() => void load()} style={{ padding: '4px 10px', background: 'transparent', color: '#7adfff', border: '1px solid rgba(122,223,255,0.3)', borderRadius: 4, fontFamily: 'inherit', fontSize: 11, cursor: 'pointer' }}>↻ refresh</button>
      </div>

      {proposals.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', opacity: 0.4, fontSize: 12 }}>no proposals — create one via Cmd+K → "add/change/fix …"</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {proposals.map(p => {
          const expanded = expandedId === p.id
          const ps = patches[p.id] ?? []
          return (
            <div key={p.id} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, padding: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 9, padding: '2px 6px', background: `${riskColor(p.riskLevel)}22`, color: riskColor(p.riskLevel), borderRadius: 3, letterSpacing: '0.1em' }}>{p.riskLevel.toUpperCase()}</span>
                    <span style={{ fontSize: 9, padding: '2px 6px', background: 'rgba(255,255,255,0.06)', borderRadius: 3, letterSpacing: '0.1em' }}>{p.status.toUpperCase()}</span>
                    <span style={{ fontSize: 10, opacity: 0.4 }}>{fmtDate(p.createdAt)} · ~{p.estimatedLoc} LOC</span>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{p.title}</div>
                  <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>{p.summary.slice(0, 200)}{p.summary.length > 200 ? '…' : ''}</div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {p.status === 'proposed' && (
                    <button onClick={() => void approve(p.id)} disabled={busy === p.id} style={{ padding: '5px 12px', background: '#22c55e', color: '#000', border: 'none', borderRadius: 4, fontFamily: 'inherit', fontSize: 10, letterSpacing: '0.08em', cursor: 'pointer', opacity: busy === p.id ? 0.5 : 1 }}>{busy === p.id ? '…' : 'APPROVE'}</button>
                  )}
                  {p.status === 'approved' && (
                    <button onClick={() => void build(p.id)} disabled={busy === p.id} style={{ padding: '5px 12px', background: '#ffd47a', color: '#000', border: 'none', borderRadius: 4, fontFamily: 'inherit', fontSize: 10, letterSpacing: '0.08em', cursor: 'pointer', opacity: busy === p.id ? 0.5 : 1 }}>{busy === p.id ? '…' : 'BUILD PATCH'}</button>
                  )}
                  <button onClick={() => { setExpandedId(expanded ? null : p.id); if (!expanded) void loadPatches(p.id) }} style={{ padding: '5px 10px', background: 'transparent', color: 'rgba(255,255,255,0.6)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 4, fontFamily: 'inherit', fontSize: 10, cursor: 'pointer' }}>{expanded ? '▼' : '▸'} details</button>
                </div>
              </div>

              {expanded && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  {(p.filesToCreate.length > 0 || p.filesToModify.length > 0) && (
                    <div style={{ fontSize: 11, marginBottom: 10 }}>
                      <div style={{ opacity: 0.5, letterSpacing: '0.1em', fontSize: 9, marginBottom: 4 }}>FILES</div>
                      {p.filesToCreate.map((f, i) => <div key={`c${i}`} style={{ marginLeft: 8 }}><span style={{ color: '#22c55e' }}>+ create </span>{f.path} <span style={{ opacity: 0.4 }}>· {f.purpose}</span></div>)}
                      {p.filesToModify.map((f, i) => <div key={`m${i}`} style={{ marginLeft: 8 }}><span style={{ color: '#ffd47a' }}>± modify </span>{f.path} <span style={{ opacity: 0.4 }}>· {f.purpose}</span></div>)}
                    </div>
                  )}
                  {p.reasoning.length > 0 && (
                    <div style={{ fontSize: 11, marginBottom: 10 }}>
                      <div style={{ opacity: 0.5, letterSpacing: '0.1em', fontSize: 9, marginBottom: 4 }}>REASONING</div>
                      {p.reasoning.map((r, i) => <div key={i} style={{ marginLeft: 8, opacity: 0.7 }}>· {r}</div>)}
                    </div>
                  )}
                  {ps.length > 0 && (
                    <div style={{ fontSize: 11 }}>
                      <div style={{ opacity: 0.5, letterSpacing: '0.1em', fontSize: 9, marginBottom: 4 }}>PATCHES ({ps.length})</div>
                      {ps.map(patch => (
                        <div key={patch.id} style={{ marginLeft: 8, marginTop: 6, padding: 8, background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 4 }}>
                          <div style={{ fontSize: 10, opacity: 0.6 }}>{patch.agent} · {patch.status} · {patch.tokensUsed} tok · ${patch.costUsdUsed.toFixed(4)}</div>
                          {patch.blockReason && <div style={{ fontSize: 10, color: '#ef4444', marginTop: 4 }}>blocked: {patch.blockReason}</div>}
                          {patch.files.map((f, i) => (
                            <details key={i} style={{ marginTop: 6 }}>
                              <summary style={{ cursor: 'pointer', fontSize: 11, opacity: 0.85 }}>{f.op === 'create' ? '+' : '±'} {f.path}</summary>
                              <pre style={{ marginTop: 4, padding: 8, background: '#000', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 4, maxHeight: 320, overflow: 'auto', fontSize: 10, color: 'rgba(122,223,255,0.85)', whiteSpace: 'pre-wrap' }}>{f.contents.slice(0, 6000)}{f.contents.length > 6000 ? '\n... [truncated]' : ''}</pre>
                            </details>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                  {ps.length === 0 && p.status === 'approved' && (
                    <div style={{ fontSize: 10, opacity: 0.4 }}>no patches yet — click BUILD PATCH</div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
