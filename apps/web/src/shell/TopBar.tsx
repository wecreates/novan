/**
 * TopBar.tsx — thin always-visible top bar.
 *
 * Reuses existing GlobalSearch, NotificationCenter, WorkspaceSwitcher
 * primitives. No new visual chrome — the shell deliberately stays
 * minimal so the content underneath dominates.
 */
import { Link } from 'react-router-dom'

interface Props {
  /** Slot for the existing GlobalSearch component (or anything else
   *  the App wants to inject — kept generic so the shell doesn't take
   *  a hard dependency on its callers' components). */
  searchSlot?:        React.ReactNode
  notificationSlot?:  React.ReactNode
  workspaceSlot?:     React.ReactNode
  userSlot?:          React.ReactNode
}

export function TopBar({ searchSlot, notificationSlot, workspaceSlot, userSlot }: Props): JSX.Element {
  return (
    <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 bg-white">
      <div className="flex items-center gap-3">
        <Link to="/today" className="flex items-center gap-2 text-gray-900 hover:opacity-80">
          <div className="w-6 h-6 rounded bg-gray-900 flex items-center justify-center text-white text-[10px] font-bold">N</div>
          <span className="font-medium text-[15px] tracking-tight">Novan</span>
        </Link>
        {workspaceSlot && <div className="ml-2">{workspaceSlot}</div>}
      </div>
      <div className="flex-1 max-w-2xl mx-4">{searchSlot}</div>
      <div className="flex items-center gap-2">
        {notificationSlot}
        {userSlot}
        <Link to="/settings" className="w-7 h-7 flex items-center justify-center text-gray-500 hover:text-gray-800 hover:bg-gray-100 rounded" title="Settings">⚙</Link>
      </div>
    </div>
  )
}
