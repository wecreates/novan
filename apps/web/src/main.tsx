import React           from 'react'
import ReactDOM         from 'react-dom/client'
import { QueryClient, QueryClientProvider, MutationCache } from '@tanstack/react-query'
import { reportToBrain } from './components/Toaster.js'
import { BrowserRouter } from 'react-router-dom'
import App                        from './App.js'
import { WorkspaceProvider }      from './contexts/WorkspaceContext.js'
import { VoiceVisualProvider }    from './contexts/VoiceVisualContext.js'
// Self-hosted Inter — avoids FOUT, eliminates Google Fonts dependency
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import './index.css'
import { initTheme } from './design/theme.js'
import { registerServiceWorker } from './pwa/registerSW.js'

// Apply saved color-token overrides before the first React render so
// the initial paint already reflects the operator's customizations.
initTheme()

// R128 — install the PWA service worker. Production-only; dev skips
// to avoid HMR/cache fights. Best-effort; PWA degrades gracefully.
registerServiceWorker()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime:  30_000,
      retry:      2,
      // Always pull fresh data when the operator returns to the tab or
      // the laptop wakes from sleep — combined with per-query intervals
      // this is what makes the brain feel "alive 24/7".
      refetchOnWindowFocus:        true,
      refetchOnReconnect:          true,
      // Off by default — individual queries (e.g. brain graph) opt in.
      refetchIntervalInBackground: false,
    },
  },
  // Global mutation-error pipeline: errors flow to the BRAIN, not the
  // operator. The brain ingests the failure, diagnoses it, and (when
  // the pattern is known + low-risk + safe paths) kicks off the
  // auto-loop to patch it. The operator sees a short "Brain is on it"
  // toast instead of a raw error trace.
  //
  // Mutations can still override with their own onError.
  mutationCache: new MutationCache({
    onError: (err, _vars, _ctx, mutation) => {
      const e = err as Error & { status?: number; url?: string; method?: string }
      const msg = e.message ?? 'Mutation failed'
      if (mutation.options.onError) return
      void reportToBrain({
        message:    msg.length > 500 ? msg.slice(0, 500) + '…' : msg,
        source:     'ui',
        ...(e.stack      ? { stack:      e.stack } : {}),
        ...(e.url        ? { url:        e.url } : {}),
        ...(e.method     ? { method:     e.method } : {}),
        ...(e.status     ? { statusCode: e.status } : {}),
      })
    },
  }),
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <WorkspaceProvider>
          <VoiceVisualProvider>
            <App />
          </VoiceVisualProvider>
        </WorkspaceProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
)
