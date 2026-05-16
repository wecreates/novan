/**
 * WorkspaceSwitcher — compact dropdown for the 48px icon sidebar.
 * Shows current workspace initial + chevron; expands to list all workspaces.
 */
import { useState, useRef, useEffect } from 'react'
import { useQuery }                    from '@tanstack/react-query'
import { ChevronDown, Building2 }      from 'lucide-react'
import { useWorkspace }                from '../contexts/WorkspaceContext.js'
import { api }                         from '../api.js'

interface Workspace {
  id:   string
  name: string
  slug: string
  plan: string
}

interface ApiResponse {
  success: boolean
  data:    Workspace[]
}

export function WorkspaceSwitcher() {
  const { workspaceId, workspaceName, setWorkspace } = useWorkspace()
  const [open, setOpen] = useState(false)
  const ref             = useRef<HTMLDivElement>(null)

  const { data } = useQuery<ApiResponse>({
    queryKey: ['workspaces'],
    queryFn:  () => api.get<ApiResponse>('/api/v1/workspaces'),
    staleTime: 60_000,
  })

  const workspaceList: Workspace[] = data?.data ?? []

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const initial = workspaceName.charAt(0).toUpperCase()

  return (
    <div ref={ref} className="relative flex flex-col items-center">
      <button
        onClick={() => setOpen(o => !o)}
        title={workspaceName}
        className="w-9 h-9 rounded-lg flex items-center justify-center gap-0.5 transition-colors
          bg-[var(--bg-elevated)] hover:bg-[var(--bg-surface)] border border-[var(--border)]
          text-[var(--text-secondary)]"
      >
        <span className="text-[10px] font-bold leading-none">{initial}</span>
        <ChevronDown className="w-2.5 h-2.5 opacity-60" />
      </button>

      {open && (
        <div
          className="absolute left-11 top-0 z-50 min-w-[180px] rounded-lg border border-[var(--border)]
            bg-[var(--bg-surface)] shadow-xl py-1"
        >
          <div className="px-3 py-1.5 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
            Workspaces
          </div>

          {workspaceList.length === 0 && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-muted)]">
              <Building2 className="w-3 h-3" />
              No workspaces found
            </div>
          )}

          {workspaceList.map(ws => (
            <button
              key={ws.id}
              onClick={() => { setWorkspace(ws.id, ws.name); setOpen(false) }}
              className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left transition-colors
                hover:bg-[var(--bg-elevated)]
                ${ws.id === workspaceId
                  ? 'text-blue-400'
                  : 'text-[var(--text-secondary)]'
                }`}
            >
              <span className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold
                bg-[var(--bg-elevated)] border border-[var(--border)] shrink-0">
                {ws.name.charAt(0).toUpperCase()}
              </span>
              <span className="truncate flex-1">{ws.name}</span>
              {ws.id === workspaceId && (
                <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-blue-400" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
