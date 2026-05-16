import React           from 'react'
import ReactDOM         from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import App                        from './App.js'
import { WorkspaceProvider }      from './contexts/WorkspaceContext.js'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime:  30_000,
      retry:      2,
      refetchOnWindowFocus: true,
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <WorkspaceProvider>
          <App />
        </WorkspaceProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
)
