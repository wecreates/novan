/**
 * MissingKeysBanner — items #1-5 ergonomics.
 *
 * Surfaces unconfigured provider keys to the operator with one-click
 * links to where to get them. No fake "configured" — sources of truth
 * are the real provider probes.
 */
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ExternalLink } from 'lucide-react'
import { api } from '../api.js'

interface ProvidersStatus {
  providers: Array<{ provider: string; configured: boolean; status: string }>
  flags: { researchEnabled: boolean; imageGenerationEnabled: boolean; searchProvider: string | null }
}

const KEY_HINTS: Record<string, { env: string; signup: string; why: string }> = {
  'search:none':   { env: 'SEARCH_API_KEY + SEARCH_PROVIDER', signup: 'https://tavily.com', why: 'Auto-discover sources for research topics (Tavily free tier works)' },
  replicate:       { env: 'REPLICATE_API_TOKEN', signup: 'https://replicate.com/account/api-tokens', why: 'Image generation (~$0.003/image flux-schnell)' },
  openai:          { env: 'OPENAI_API_KEY',      signup: 'https://platform.openai.com/api-keys', why: 'Image generation, embeddings' },
  stability:       { env: 'STABILITY_API_KEY',   signup: 'https://platform.stability.ai/', why: 'Stability Image generation' },
  fal:             { env: 'FAL_KEY',             signup: 'https://fal.ai/dashboard/keys', why: 'fal.ai image generation' },
}

const NOTIF_HINT = { env: 'NOTIFY_WEBHOOK_URL · PUSHOVER_TOKEN+USER · SLACK_WEBHOOK_URL · DISCORD_WEBHOOK_URL', signup: '', why: 'Get governance alerts out of the events table' }

export function MissingKeysBanner() {
  const { data } = useQuery({
    queryKey: ['providers-status'],
    queryFn:  () => api.get<{ success: true; data: ProvidersStatus }>('/api/v1/platform/providers?workspace_id=default'),
    refetchInterval: 5 * 60_000,
  })

  if (!data) return null
  const probe = data.data
  const missing: Array<{ id: string; env: string; signup: string; why: string }> = []

  // Image providers — only flag if NONE are configured
  const imgConfigured = probe.providers.some(p => ['openai', 'replicate', 'stability', 'fal'].includes(p.provider) && p.configured)
  if (!imgConfigured) {
    const r = KEY_HINTS['replicate']!
    missing.push({ id: 'image-providers', ...r, why: 'No image-generation provider configured. ' + r.why })
  }

  // Search
  if (!probe.flags.searchProvider) {
    const r = KEY_HINTS['search:none']!
    missing.push({ id: 'search', ...r })
  }

  // Notifications — check via the drivers endpoint (cheap probe)
  // Skipping a separate fetch here; if needed, ProvidersStatus could be extended.

  if (missing.length === 0) return null

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <AlertTriangle className="w-4 h-4 text-amber-400" />
        <span className="text-sm font-medium text-amber-300">
          {missing.length} provider{missing.length > 1 ? 's' : ''} not configured
        </span>
        <span className="text-xs text-[var(--text-muted)] ml-auto">
          set in <code className="font-mono">.env</code> at repo root and restart
        </span>
      </div>
      <ul className="space-y-1.5 text-xs">
        {missing.map(m => (
          <li key={m.id} className="flex items-start gap-2">
            <code className="font-mono text-amber-400 shrink-0">{m.env}</code>
            <span className="text-[var(--text-muted)]">— {m.why}</span>
            {m.signup && (
              <a href={m.signup} target="_blank" rel="noopener noreferrer"
                 className="text-sky-400 hover:underline flex items-center gap-0.5 ml-auto shrink-0">
                get key <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
