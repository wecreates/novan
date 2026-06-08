/**
 * R146.341 — MCP Fallback Chains (closes tool_use.mcp_invocation 7→9)
 *
 * Many MCPs offer overlapping capabilities. When one is unavailable
 * (network down, key revoked, rate-limited), Novan should fall through
 * to the next-best alternative without operator intervention.
 *
 * Example: video analysis can come from claude-video-vision MCP OR
 * gemini-video OR a yt-dlp + frame-sample chain.
 */

export interface McpCapability {
  capability:   'video_analyze' | 'image_generate' | 'web_search' | 'document_parse' | 'audio_transcribe' | 'browser_drive'
  providers:    Array<{
    mcpName:    string
    toolName:   string
    cost:       'free' | 'cheap' | 'medium' | 'expensive'
    quality:    number       // 0-1
    fallbackOrder: number    // lower = try first
  }>
}

export const CAPABILITY_CHAINS: McpCapability[] = [
  {
    capability: 'video_analyze',
    providers: [
      { mcpName: 'claude-video-vision', toolName: 'mcp__claude-video-vision__video_analyze', cost: 'medium', quality: 0.9, fallbackOrder: 1 },
      // Alternates can be added as they become available
    ],
  },
  {
    capability: 'image_generate',
    providers: [
      { mcpName: 'internal',  toolName: 'image.generate',        cost: 'cheap',  quality: 0.75, fallbackOrder: 1 },
      { mcpName: 'internal',  toolName: 'art.public_domain_fetch', cost: 'free',  quality: 0.95, fallbackOrder: 2 },  // fallback when gen blocked
    ],
  },
  {
    capability: 'web_search',
    providers: [
      { mcpName: 'internal', toolName: 'web.fetch',            cost: 'free', quality: 0.6, fallbackOrder: 1 },
      { mcpName: 'internal', toolName: 'art.public_domain_fetch', cost: 'free', quality: 0.7, fallbackOrder: 2 },  // niche fallback
    ],
  },
  {
    capability: 'browser_drive',
    providers: [
      { mcpName: 'internal',          toolName: 'platform.poll_all',   cost: 'free', quality: 0.6, fallbackOrder: 1 },
      { mcpName: 'claude-in-chrome',  toolName: 'mcp__Claude_in_Chrome__computer', cost: 'free', quality: 0.85, fallbackOrder: 2 },
    ],
  },
]

export interface InvocationPlan {
  capability:   McpCapability['capability']
  primary:      McpCapability['providers'][number]
  fallbacks:    McpCapability['providers']
  rationale:    string
}

/**
 * Pick the best provider chain for a capability given current health state.
 * Skips providers whose underlying provider/key is known dead.
 */
export async function planInvocation(input: {
  capability:        McpCapability['capability']
  preferCost?:       'free' | 'cheap' | 'any'
  excludeProviders?: string[]    // e.g. ['fal'] when known dead
}): Promise<InvocationPlan | null> {
  const cap = CAPABILITY_CHAINS.find(c => c.capability === input.capability)
  if (!cap) return null
  let viable = cap.providers.slice()
  if (input.excludeProviders) {
    viable = viable.filter(p => !input.excludeProviders!.some(e => p.toolName.includes(e)))
  }
  if (input.preferCost === 'free') {
    viable.sort((a, b) => (a.cost === 'free' ? -1 : 1) - (b.cost === 'free' ? -1 : 1) || a.fallbackOrder - b.fallbackOrder)
  } else {
    viable.sort((a, b) => a.fallbackOrder - b.fallbackOrder)
  }
  if (viable.length === 0) return null

  // Hook into provider health monitor for image-related capabilities
  if (input.capability === 'image_generate') {
    try {
      const { canGenerateImagesNow } = await import('./r333-provider-health-monitor.js')
      const status = await canGenerateImagesNow()
      if (!status.ok) {
        // Auto-promote public domain fallback to primary
        viable.sort((a, b) => (a.toolName === 'art.public_domain_fetch' ? -1 : 0) - (b.toolName === 'art.public_domain_fetch' ? -1 : 0))
        return {
          capability: input.capability,
          primary:    viable[0]!,
          fallbacks:  viable.slice(1),
          rationale:  `image gen providers unhealthy (${status.reason}) — auto-promoted public_domain_fetch`,
        }
      }
    } catch { /* ignore */ }
  }

  return {
    capability: input.capability,
    primary:    viable[0]!,
    fallbacks:  viable.slice(1),
    rationale:  `Selected ${viable[0]!.mcpName}:${viable[0]!.toolName} by fallbackOrder + cost preference`,
  }
}
