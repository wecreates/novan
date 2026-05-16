import { createContext, useContext, useState, type ReactNode } from 'react'

interface WorkspaceContextValue {
  workspaceId:   string
  workspaceName: string
  setWorkspace:  (id: string, name: string) => void
}

const WorkspaceContext = createContext<WorkspaceContextValue>({
  workspaceId:   'default',
  workspaceName: 'Default',
  setWorkspace:  () => {},
})

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaceId, setWorkspaceId]     = useState(() => localStorage.getItem('ops_workspace_id')   ?? 'default')
  const [workspaceName, setWorkspaceName] = useState(() => localStorage.getItem('ops_workspace_name') ?? 'Default')

  const setWorkspace = (id: string, name: string) => {
    setWorkspaceId(id)
    setWorkspaceName(name)
    localStorage.setItem('ops_workspace_id',   id)
    localStorage.setItem('ops_workspace_name', name)
  }

  return (
    <WorkspaceContext.Provider value={{ workspaceId, workspaceName, setWorkspace }}>
      {children}
    </WorkspaceContext.Provider>
  )
}

export const useWorkspace = () => useContext(WorkspaceContext)
