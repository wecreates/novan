import type { ProviderConfig } from './types.js'

export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    name: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    ...(process.env['OPENAI_API_KEY'] ? { apiKey: process.env['OPENAI_API_KEY'] } : {}),
    enabled: Boolean(process.env['OPENAI_API_KEY']),
    priority: 1,
    maxRpm: 500,
    models: [
      { id: 'gpt-4o-mini', displayName: 'GPT-4o Mini', tier: 'lightweight', contextWindow: 128_000, costPer1kInput: 0.00015, costPer1kOutput: 0.0006, supportsTools: true, supportsVision: true },
      { id: 'gpt-4o', displayName: 'GPT-4o', tier: 'standard', contextWindow: 128_000, costPer1kInput: 0.0025, costPer1kOutput: 0.01, supportsTools: true, supportsVision: true },
      { id: 'gpt-4.1', displayName: 'GPT-4.1', tier: 'premium', contextWindow: 1_000_000, costPer1kInput: 0.002, costPer1kOutput: 0.008, supportsTools: true, supportsVision: true },
      { id: 'text-embedding-3-small', displayName: 'Embedding 3 Small', tier: 'lightweight', contextWindow: 8_191, costPer1kInput: 0.00002, costPer1kOutput: 0, supportsTools: false, supportsVision: false },
    ],
  },
  {
    name: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    ...(process.env['ANTHROPIC_API_KEY'] ? { apiKey: process.env['ANTHROPIC_API_KEY'] } : {}),
    enabled: Boolean(process.env['ANTHROPIC_API_KEY']),
    priority: 2,
    maxRpm: 400,
    models: [
      { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', tier: 'lightweight', contextWindow: 200_000, costPer1kInput: 0.0008, costPer1kOutput: 0.004, supportsTools: true, supportsVision: true },
      { id: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5', tier: 'standard', contextWindow: 200_000, costPer1kInput: 0.003, costPer1kOutput: 0.015, supportsTools: true, supportsVision: true },
      { id: 'claude-opus-4-5', displayName: 'Claude Opus 4.5', tier: 'premium', contextWindow: 200_000, costPer1kInput: 0.015, costPer1kOutput: 0.075, supportsTools: true, supportsVision: true },
    ],
  },
  {
    name: 'ollama',
    baseUrl: process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434',
    enabled: true,
    priority: 3,
    maxRpm: 60,
    models: [
      { id: 'llama3.2:3b', displayName: 'Llama 3.2 3B', tier: 'lightweight', contextWindow: 128_000, costPer1kInput: 0, costPer1kOutput: 0, supportsTools: false, supportsVision: false },
      { id: 'nomic-embed-text', displayName: 'Nomic Embed Text', tier: 'lightweight', contextWindow: 8_192, costPer1kInput: 0, costPer1kOutput: 0, supportsTools: false, supportsVision: false },
    ],
  },
]

export function getEnabledProviders(providers = DEFAULT_PROVIDERS): ProviderConfig[] {
  return providers.filter((p) => p.enabled).sort((a, b) => a.priority - b.priority)
}
