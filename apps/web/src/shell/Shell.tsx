/**
 * Shell.tsx — outer layout: TopBar / [Tree | Content] / StatusBar.
 *
 * The shell is intentionally plain. Tailwind utility classes only.
 * White background, dark text, tight typography. Existing pages render
 * inside `children` (or via React Router outlet wherever the caller
 * wires it). The shell does not own routing — App.tsx still does.
 */
import { useState } from 'react'
import { FolderTree } from './FolderTree'
import { Breadcrumb } from './Breadcrumb'
import { StatusBar } from './StatusBar'
import { TopBar } from './TopBar'

interface ShellProps {
  children: React.ReactNode
  /** Optional content-area chrome injected by App (Toaster, etc.). */
  searchSlot?:       React.ReactNode
  notificationSlot?: React.ReactNode
  workspaceSlot?:    React.ReactNode
  userSlot?:         React.ReactNode
}

export function Shell({
  children, searchSlot, notificationSlot, workspaceSlot, userSlot,
}: ShellProps): JSX.Element {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div className="flex flex-col h-screen min-h-screen bg-white text-gray-900 font-sans antialiased">
      <TopBar
        {...(searchSlot       !== undefined ? { searchSlot }       : {})}
        {...(notificationSlot !== undefined ? { notificationSlot } : {})}
        {...(workspaceSlot    !== undefined ? { workspaceSlot }    : {})}
        {...(userSlot         !== undefined ? { userSlot }         : {})}
      />
      <div className="flex flex-1 min-h-0">
        <div className={collapsed ? 'w-12 flex-shrink-0' : 'w-[280px] flex-shrink-0'}>
          <FolderTree collapsed={collapsed} onToggleCollapsed={() => setCollapsed(c => !c)} />
        </div>
        <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-[#FAFAFA]">
          <Breadcrumb />
          <div className="flex-1 overflow-auto">
            {children}
          </div>
        </div>
      </div>
      <StatusBar />
    </div>
  )
}
