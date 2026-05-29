/**
 * useBusinessGraph — steady-state business + systems read.
 *
 * Pairs with `useBusinessConstructionStream`:
 *   - stream = transient fade-in cascade during construction
 *   - graph  = persistent truth (what's actually in the DB)
 *
 * The brain canvas renders both: the persistent layer is always-on
 * once a business exists; the stream layer overlays during active
 * construction so the eye tracks the moment of spawning.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api.js'

export interface BusinessRow {
  id:          string
  workspaceId: string
  name:        string
  industry:    string | null
  stage:       string
  health:      string
  vision:      string | null
  brief:       string | null
  dna:         Record<string, unknown>
  createdAt:   number
  updatedAt:   number
}

export interface BusinessSystem {
  id:          string
  workspaceId: string
  businessId:  string
  kind:        'department' | 'workflow' | 'agent_slot' | 'asset' | 'analytics' | 'integration'
  layer:       'executive' | 'operations' | 'finance' | 'creative' | 'growth' | 'intelligence' | 'security'
  name:        string
  summary:     string | null
  status:      'forming' | 'active' | 'paused' | 'archived'
  agentSlug:   string | null
  parentId:    string | null
  position:    { x: number; y: number; z: number } | null
  metadata:    Record<string, unknown>
  createdAt:   number
  updatedAt:   number
}

/**
 * Fetches every business in the workspace + the systems for the
 * currently focused one. Defaults the focus to the most-recently-
 * created business. The brain canvas only renders one business at a
 * time so the spatial scene stays calm; the operator can switch via
 * the focus chip.
 */
export function useBusinessGraph(workspaceId: string, focusBusinessId?: string | null) {
  const businesses = useQuery({
    queryKey: ['businesses-list', workspaceId],
    queryFn:  () => api.get<{ data: BusinessRow[] }>(`/api/v1/businesses`)
                       .then(r => r.data),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  })

  // Resolve focus: explicit arg → most recent → null
  const list = businesses.data ?? []
  const focused: BusinessRow | null = useMemo(() => {
    if (focusBusinessId) return list.find(b => b.id === focusBusinessId) ?? null
    if (list.length === 0) return null
    // Most recently created first (API already sorts desc createdAt? defensive sort here)
    return [...list].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
  }, [list, focusBusinessId])

  const systems = useQuery({
    queryKey: ['business-systems', workspaceId, focused?.id ?? null],
    queryFn:  () => focused
      ? api.get<{ data: BusinessSystem[] }>(`/api/v1/businesses/${focused.id}/systems`)
          .then(r => r.data)
      : Promise.resolve([] as BusinessSystem[]),
    enabled:  !!focused,
    refetchInterval: 30_000,
  })

  return {
    businesses: list,
    focused,
    systems:    systems.data ?? [],
    loading:    businesses.isLoading || systems.isLoading,
  }
}
