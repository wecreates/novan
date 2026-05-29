/**
 * DetailPanel.tsx — Side drawer that slides in when a node is clicked.
 *
 * Per spec: "Every element responds. Click: Node selects, opens detail
 * panel (slides in from side). Detail panel shows everything about
 * that element. Edit controls available inline."
 *
 * Honest scope for showcase: this is READ-ONLY + a deep-link to the
 * operational `/brain/graph` view where the full edit surface lives.
 * The showcase is the presentation channel; editing happens in the
 * operational channel. That's the right separation per the spec's
 * own "presentation vs. operation" contrast.
 */
import { Link } from 'react-router-dom'
import { aliasFor, formatCount } from './anonymize'

export interface DetailNode {
  id:        string
  label:     string
  group:     string
  activity?: number
  size?:     number
  /** Optional rollups the GET /brain/nodes/:id endpoint may return. */
  recentEvents24h?: number
  lastActiveAt?:    number
}

interface Props {
  node:   DetailNode | null
  anonOn: boolean
  onClose: () => void
}

export function DetailPanel({ node, anonOn, onClose }: Props): JSX.Element | null {
  if (!node) return null
  const label = anonOn ? aliasFor(node.label) : node.label
  const group = anonOn ? aliasFor(node.group) : node.group
  const lastActive = node.lastActiveAt
    ? new Date(node.lastActiveAt).toLocaleString()
    : 'unknown'

  return (
    <div className="absolute top-0 right-0 h-full w-[340px] z-20 bg-black/80 backdrop-blur border-l border-white/10 text-white/90 overflow-y-auto">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <span className="text-[11px] uppercase tracking-[0.18em] text-white/40">Node detail</span>
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-white/10 text-white/60 hover:text-white"
          aria-label="Close detail panel"
        >×</button>
      </div>
      <div className="px-4 py-4 space-y-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-white/40 mb-1">Name</div>
          <div className="text-[18px] font-light">{label}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-white/40 mb-1">Group</div>
          <div className="text-[14px]">{group}</div>
        </div>
        {typeof node.activity === 'number' && (
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-white/40 mb-1">Activity</div>
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1.5 bg-white/10 rounded overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-blue-400 to-emerald-400"
                  style={{ width: `${Math.round(Math.max(0, Math.min(1, node.activity)) * 100)}%` }}
                />
              </div>
              <span className="text-[11px] tabular-nums text-white/60">
                {Math.round(node.activity * 100)}%
              </span>
            </div>
          </div>
        )}
        {typeof node.recentEvents24h === 'number' && (
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-white/40 mb-1">Events (24h)</div>
            <div className="text-[14px] tabular-nums">{formatCount(node.recentEvents24h, anonOn)}</div>
          </div>
        )}
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-white/40 mb-1">Last active</div>
          <div className="text-[13px] text-white/70">{lastActive}</div>
        </div>
        <div className="pt-2 border-t border-white/10">
          <Link
            to={`/brain/graph?focus=${encodeURIComponent(node.id)}`}
            className="block w-full text-center py-2 px-3 rounded border border-white/15 text-[12px] hover:bg-white/10 transition-colors"
          >Open in operational view</Link>
          <p className="text-[10px] text-white/30 mt-2 leading-relaxed">
            Edits go through the operational view, not the showcase. This panel is read-only by design.
          </p>
        </div>
      </div>
    </div>
  )
}
