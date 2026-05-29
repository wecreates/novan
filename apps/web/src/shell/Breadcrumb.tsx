/**
 * Breadcrumb.tsx — derived from the current URL via the taxonomy.
 *
 * Shows the trail from root to the current leaf. Each crumb except the
 * last is clickable and navigates to the parent's first leaf (since
 * parents themselves are folders, not destinations).
 */
import { Link, useLocation } from 'react-router-dom'
import { breadcrumbFor, type TreeNode } from './taxonomy'

function firstLeafIn(node: TreeNode): string | null {
  if (node.path && !node.children) return node.path
  for (const c of node.children ?? []) {
    const l = firstLeafIn(c)
    if (l) return l
  }
  return null
}

export function Breadcrumb(): JSX.Element {
  const location = useLocation()
  const trail = breadcrumbFor(location.pathname)
  if (trail.length === 0) return <div className="text-[12px] text-gray-400 px-4 py-2">{location.pathname}</div>

  return (
    <div className="flex items-center gap-1 px-4 py-2 text-[12px] text-gray-500 border-b border-gray-200 bg-white">
      {trail.map((n, i) => {
        const isLast = i === trail.length - 1
        const linkTo = isLast ? null : firstLeafIn(n)
        return (
          <span key={n.id} className="flex items-center gap-1">
            {linkTo
              ? <Link to={linkTo} className="hover:text-gray-800">{n.label}</Link>
              : <span className={isLast ? 'text-gray-800 font-medium' : ''}>{n.label}</span>}
            {!isLast && <span className="text-gray-300">/</span>}
          </span>
        )
      })}
    </div>
  )
}
