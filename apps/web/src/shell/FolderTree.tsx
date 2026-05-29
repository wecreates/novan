/**
 * FolderTree.tsx — Windows-Explorer-style nested tree.
 *
 * Behavior:
 *   - Click folder → expand/collapse
 *   - Click leaf  → navigate
 *   - Keyboard:    ↑↓ move focus, → expand or descend, ← collapse or
 *                  ascend, Enter to activate
 *   - Expanded state persisted to localStorage per session
 *   - Filter input top of tree fuzzy-matches labels
 *
 * Visual: tight, monochrome, single accent for selection.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { TAXONOMY, type TreeNode } from './taxonomy'

const LS_KEY = 'novan.shell.expanded'

function loadExpanded(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return { dashboard: true }   // open Dashboard by default
    return JSON.parse(raw) as Record<string, boolean>
  } catch { return { dashboard: true } }
}

function saveExpanded(e: Record<string, boolean>): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(e)) } catch { /* tolerated */ }
}

/** Flatten visible (taking expanded state into account) into a linear
 *  list, for keyboard nav. */
function flatten(nodes: TreeNode[], expanded: Record<string, boolean>, depth = 0): Array<{ node: TreeNode; depth: number }> {
  const out: Array<{ node: TreeNode; depth: number }> = []
  for (const n of nodes) {
    out.push({ node: n, depth })
    if (n.children && expanded[n.id]) {
      out.push(...flatten(n.children, expanded, depth + 1))
    }
  }
  return out
}

function matchesFilter(node: TreeNode, q: string): boolean {
  if (!q) return true
  const ql = q.toLowerCase()
  if (node.label.toLowerCase().includes(ql)) return true
  if (node.children?.some(c => matchesFilter(c, q))) return true
  return false
}

function filteredTree(nodes: TreeNode[], q: string): TreeNode[] {
  if (!q) return nodes
  return nodes
    .filter(n => matchesFilter(n, q))
    .map(n => ({
      ...n,
      ...(n.children ? { children: filteredTree(n.children, q) } : {}),
    }))
}

interface Props {
  collapsed?: boolean
  onToggleCollapsed?: () => void
}

export function FolderTree({ collapsed, onToggleCollapsed }: Props): JSX.Element {
  const navigate = useNavigate()
  const location = useLocation()
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => loadExpanded())
  const [filter, setFilter] = useState('')
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const treeRef = useRef<HTMLDivElement>(null)

  useEffect(() => { saveExpanded(expanded) }, [expanded])

  // Auto-expand ancestors of current path so the selected leaf is visible.
  useEffect(() => {
    const newExp = { ...expanded }
    let changed = false
    const walk = (nodes: TreeNode[], ancestors: string[]): boolean => {
      for (const n of nodes) {
        if (n.path === location.pathname && !n.children) {
          for (const a of ancestors) {
            if (!newExp[a]) { newExp[a] = true; changed = true }
          }
          return true
        }
        if (n.children && walk(n.children, [...ancestors, n.id])) return true
      }
      return false
    }
    walk(TAXONOMY, [])
    if (changed) setExpanded(newExp)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])

  const tree = useMemo(() => filteredTree(TAXONOMY, filter), [filter])
  const flat = useMemo(() => flatten(tree, filter ? expandAllForFilter(tree) : expanded), [tree, expanded, filter])

  function expandAllForFilter(nodes: TreeNode[]): Record<string, boolean> {
    const r: Record<string, boolean> = {}
    const walk = (n: TreeNode): void => { r[n.id] = true; n.children?.forEach(walk) }
    nodes.forEach(walk); return r
  }

  function toggle(id: string): void {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }))
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (!focusedId) {
      if (flat[0]) setFocusedId(flat[0].node.id)
      return
    }
    const idx = flat.findIndex(f => f.node.id === focusedId)
    const cur = flat[idx]
    if (!cur) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const next = flat[idx + 1]
      if (next) setFocusedId(next.node.id)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const prev = flat[idx - 1]
      if (prev) setFocusedId(prev.node.id)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      if (cur.node.children) {
        if (!expanded[cur.node.id]) setExpanded(p => ({ ...p, [cur.node.id]: true }))
        else {
          const next = flat[idx + 1]
          if (next) setFocusedId(next.node.id)
        }
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      if (cur.node.children && expanded[cur.node.id]) {
        setExpanded(p => ({ ...p, [cur.node.id]: false }))
      }
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (cur.node.children) toggle(cur.node.id)
      else if (cur.node.path) navigate(cur.node.path)
    }
  }

  if (collapsed) {
    return (
      <div className="flex flex-col items-center pt-2 w-12 border-r border-gray-200 bg-white">
        <button
          onClick={onToggleCollapsed}
          className="w-8 h-8 flex items-center justify-center hover:bg-gray-100 rounded text-gray-600"
          title="Expand tree"
        >▸</button>
        {TAXONOMY.map(n => (
          <button
            key={n.id}
            onClick={() => { onToggleCollapsed?.(); setExpanded(p => ({ ...p, [n.id]: true })) }}
            className="w-8 h-8 mt-1 flex items-center justify-center hover:bg-gray-100 rounded text-xs text-gray-600"
            title={n.label}
          >{n.label.slice(0, 2)}</button>
        ))}
      </div>
    )
  }

  return (
    <div
      ref={treeRef}
      className="flex flex-col h-full border-r border-gray-200 bg-white text-[13px] text-gray-800 select-none"
      onKeyDown={onKeyDown}
      tabIndex={0}
      role="tree"
    >
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-gray-200">
        <input
          className="flex-1 px-2 py-1 text-[12px] border border-gray-200 rounded focus:outline-none focus:border-blue-500"
          placeholder="Filter…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <button
          onClick={onToggleCollapsed}
          className="w-6 h-6 flex items-center justify-center hover:bg-gray-100 rounded text-gray-500"
          title="Collapse tree"
        >◂</button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {flat.map(({ node, depth }) => {
          const isFolder = !!node.children
          const isOpen = !!expanded[node.id] || !!filter
          const isSelected = !isFolder && node.path === location.pathname
          const isFocused = focusedId === node.id
          return (
            <div
              key={node.id}
              role="treeitem"
              aria-expanded={isFolder ? isOpen : undefined}
              aria-selected={isSelected}
              className={[
                'flex items-center px-1.5 py-0.5 cursor-pointer text-[13px] leading-5',
                isSelected ? 'bg-blue-50 text-blue-700 border-l-2 border-blue-500' : 'border-l-2 border-transparent',
                isFocused && !isSelected ? 'bg-gray-50' : '',
                'hover:bg-gray-50',
              ].join(' ')}
              style={{ paddingLeft: `${depth * 12 + 6}px` }}
              onClick={() => {
                setFocusedId(node.id)
                if (isFolder) toggle(node.id)
                else if (node.path) navigate(node.path)
              }}
            >
              {isFolder && (
                <span className="inline-block w-3 text-gray-400 mr-0.5">{isOpen ? '▾' : '▸'}</span>
              )}
              {!isFolder && <span className="inline-block w-3 mr-0.5"></span>}
              <span className="truncate">{node.label}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
