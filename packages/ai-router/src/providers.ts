import type { ProviderConfig, ModelSpec } from './types.js'

// ─── Provider registry ────────────────────────────────────────────────────────

export const PROVIDERS: ProviderConfig[] = [
  // ── Groq — cheapest fast inference ────────────────────────────────────────
  {
    id:        'groq',
    baseUrl:   'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    enabled:   () => !!process.env['GROQ_API_KEY'],
    rateLimit: { rpm: 30, tpm: 14_400 },
    models: [
      {
        provider: 'groq', modelId: 'llama-3.3-70b-versatile', displayName: 'Llama 3.3 70B',
        contextWindow: 128_000, promptPer1k: 0.00059, outputPer1k: 0.00079,
        supportsVision: false, supportsStream: true, maxOutputTokens: 32_768,
        taskAffinities: ['fast_chat', 'summarize', 'classify', 'extract', 'reasoning'],
      },
      {
        provider: 'groq', modelId: 'llama-3.1-8b-instant', displayName: 'Llama 3.1 8B',
        contextWindow: 128_000, promptPer1k: 0.00005, outputPer1k: 0.00008,
        supportsVision: false, supportsStream: true, maxOutputTokens: 8192,
        taskAffinities: ['fast_chat', 'classify'],
      },
      {
        provider: 'groq', modelId: 'mixtral-8x7b-32768', displayName: 'Mixtral 8x7B',
        contextWindow: 32768, promptPer1k: 0.00024, outputPer1k: 0.00024,
        supportsVision: false, supportsStream: true, maxOutputTokens: 32768,
        taskAffinities: ['fast_chat', 'summarize', 'extract'],
      },
    ],
  },

  // ── OpenRouter — multi-model gateway ──────────────────────────────────────
  {
    id:        'openrouter',
    baseUrl:   'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    enabled:   () => !!process.env['OPENROUTER_API_KEY'],
    models: [
      {
        provider: 'openrouter', modelId: 'google/gemini-flash-1.5', displayName: 'Gemini Flash 1.5',
        contextWindow: 1_000_000, promptPer1k: 0.000075, outputPer1k: 0.0003,
        supportsVision: true, supportsStream: true, maxOutputTokens: 8192,
        taskAffinities: ['fast_chat', 'vision', 'summarize', 'extract'],
      },
      {
        provider: 'openrouter', modelId: 'anthropic/claude-3-haiku', displayName: 'Claude 3 Haiku',
        contextWindow: 200_000, promptPer1k: 0.00025, outputPer1k: 0.00125,
        supportsVision: true, supportsStream: true, maxOutputTokens: 4096,
        taskAffinities: ['fast_chat', 'classify', 'extract'],
      },
      {
        provider: 'openrouter', modelId: 'mistralai/mistral-7b-instruct', displayName: 'Mistral 7B',
        contextWindow: 32768, promptPer1k: 0.000035, outputPer1k: 0.000035,
        supportsVision: false, supportsStream: true, maxOutputTokens: 4096,
        taskAffinities: ['fast_chat', 'classify'],
      },
    ],
  },

  // ── OpenAI ────────────────────────────────────────────────────────────────
  {
    id:        'openai',
    baseUrl:   process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    enabled:   () => !!process.env['OPENAI_API_KEY'],
    models: [
      {
        provider: 'openai', modelId: 'gpt-4o-mini', displayName: 'GPT-4o Mini',
        contextWindow: 128_000, promptPer1k: 0.00015, outputPer1k: 0.0006,
        supportsVision: true, supportsStream: true, maxOutputTokens: 16384,
        taskAffinities: ['fast_chat', 'code', 'vision', 'extract'],
      },
      {
        provider: 'openai', modelId: 'gpt-4o', displayName: 'GPT-4o',
        contextWindow: 128_000, promptPer1k: 0.005, outputPer1k: 0.015,
        supportsVision: true, supportsStream: true, maxOutputTokens: 16384,
        taskAffinities: ['reasoning', 'code', 'vision'],
      },
      {
        provider: 'openai', modelId: 'text-embedding-3-small', displayName: 'text-embedding-3-small',
        contextWindow: 8191, promptPer1k: 0.00002, outputPer1k: 0,
        supportsVision: false, supportsStream: false, maxOutputTokens: 0,
        taskAffinities: ['embedding'],
      },
    ],
  },

  // ── Anthropic (via OpenAI-compat proxy through openrouter or direct) ───────
  {
    id:        'anthropic',
    baseUrl:   'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    enabled:   () => !!process.env['ANTHROPIC_API_KEY'],
    models: [
      {
        provider: 'anthropic', modelId: 'claude-3-5-sonnet-20241022', displayName: 'Claude 3.5 Sonnet',
        contextWindow: 200_000, promptPer1k: 0.003, outputPer1k: 0.015,
        supportsVision: true, supportsStream: true, maxOutputTokens: 8192,
        taskAffinities: ['reasoning', 'code', 'vision', 'summarize'],
      },
      {
        provider: 'anthropic', modelId: 'claude-3-haiku-20240307', displayName: 'Claude 3 Haiku',
        contextWindow: 200_000, promptPer1k: 0.00025, outputPer1k: 0.00125,
        supportsVision: true, supportsStream: true, maxOutputTokens: 4096,
        taskAffinities: ['fast_chat', 'classify', 'extract'],
      },
    ],
  },

  // ── Gemini direct ────────────────────────────────────────────────────────
  {
    id:        'gemini',
    baseUrl:   'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GEMINI_API_KEY',
    enabled:   () => !!process.env['GEMINI_API_KEY'],
    models: [
      {
        provider: 'gemini', modelId: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash',
        contextWindow: 1_000_000, promptPer1k: 0.00015, outputPer1k: 0.0006,
        supportsVision: true, supportsStream: true, maxOutputTokens: 8192,
        taskAffinities: ['fast_chat', 'vision', 'summarize', 'classify'],
      },
      {
        provider: 'gemini', modelId: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash Lite',
        contextWindow: 1_000_000, promptPer1k: 0.00010, outputPer1k: 0.0004,
        supportsVision: true, supportsStream: true, maxOutputTokens: 8192,
        taskAffinities: ['fast_chat', 'classify'],
      },
      {
        provider: 'gemini', modelId: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro',
        contextWindow: 2_000_000, promptPer1k: 0.00125, outputPer1k: 0.010,
        supportsVision: true, supportsStream: true, maxOutputTokens: 8192,
        taskAffinities: ['reasoning', 'code', 'vision'],
      },
    ],
  },

  // ── Ollama local ──────────────────────────────────────────────────────────
  {
    id:        'ollama_local',
    baseUrl:   process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434/v1',
    apiKeyEnv: '',
    enabled:   () => !!process.env['OLLAMA_BASE_URL'] || true, // always attempt local
    models: [
      {
        provider: 'ollama_local', modelId: 'llama3', displayName: 'Llama3 (local)',
        contextWindow: 8192, promptPer1k: 0, outputPer1k: 0,
        supportsVision: false, supportsStream: true, maxOutputTokens: 4096,
        taskAffinities: ['fast_chat', 'summarize', 'classify'],
      },
      {
        provider: 'ollama_local', modelId: 'nomic-embed-text', displayName: 'nomic-embed-text (local)',
        contextWindow: 8192, promptPer1k: 0, outputPer1k: 0,
        supportsVision: false, supportsStream: false, maxOutputTokens: 0,
        taskAffinities: ['embedding'],
      },
    ],
  },

  // ── Ollama remote (RunPod / Vast.ai) ──────────────────────────────────────
  {
    id:        'ollama_remote',
    baseUrl:   process.env['RUNPOD_OLLAMA_URL'] ?? '',
    apiKeyEnv: 'RUNPOD_API_KEY',
    enabled:   () => !!process.env['RUNPOD_OLLAMA_URL'],
    models: [
      {
        provider: 'ollama_remote', modelId: 'llama3', displayName: 'Llama3 (remote GPU)',
        contextWindow: 8192, promptPer1k: 0.0002, outputPer1k: 0.0002, // est. RunPod cost
        supportsVision: false, supportsStream: true, maxOutputTokens: 4096,
        taskAffinities: ['fast_chat', 'reasoning', 'code'],
      },
      {
        provider: 'ollama_remote', modelId: 'llama3:70b', displayName: 'Llama3 70B (remote GPU)',
        contextWindow: 8192, promptPer1k: 0.0005, outputPer1k: 0.0005,
        supportsVision: false, supportsStream: true, maxOutputTokens: 4096,
        taskAffinities: ['reasoning', 'code'],
      },
      {
        provider: 'ollama_remote', modelId: 'nomic-embed-text', displayName: 'nomic-embed-text (remote)',
        contextWindow: 8192, promptPer1k: 0, outputPer1k: 0,
        supportsVision: false, supportsStream: false, maxOutputTokens: 0,
        taskAffinities: ['embedding'],
      },
    ],
  },
]

// ─── Lookup helpers ───────────────────────────────────────────────────────────

export function getProvider(id: string): ProviderConfig | undefined {
  return PROVIDERS.find((p) => p.id === id)
}

export function getModel(providerId: string, modelId: string): ModelSpec | undefined {
  return getProvider(providerId)?.models.find((m) => m.modelId === modelId)
}

export function enabledProviders(): ProviderConfig[] {
  return PROVIDERS.filter((p) => p.enabled())
}
