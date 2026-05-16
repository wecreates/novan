// ─── Provider + Model types ───────────────────────────────────────────────────

export type ProviderId =
  | 'groq'
  | 'openrouter'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'ollama_local'
  | 'ollama_remote'

export type TaskType =
  | 'embedding'
  | 'fast_chat'
  | 'reasoning'
  | 'code'
  | 'vision'
  | 'summarize'
  | 'classify'
  | 'extract'

export interface ModelSpec {
  provider:        ProviderId
  modelId:         string            // model string sent to API
  displayName:     string
  contextWindow:   number
  promptPer1k:     number            // USD per 1k prompt tokens (0 for local)
  outputPer1k:     number            // USD per 1k output tokens
  supportsVision:  boolean
  supportsStream:  boolean
  maxOutputTokens: number
  taskAffinities:  TaskType[]        // preferred task types
}

export interface ProviderConfig {
  id:          ProviderId
  baseUrl:     string
  apiKeyEnv:   string               // env var name
  enabled:     () => boolean        // checked at runtime
  models:      ModelSpec[]
  rateLimit?:  { rpm: number; tpm: number }
}

// ─── Routing ──────────────────────────────────────────────────────────────────

export interface RouteRequest {
  taskType:        TaskType
  workspaceId:     string
  promptTokensEst: number          // estimated prompt tokens
  requireVision?:  boolean | undefined
  preferProvider?: ProviderId | undefined
  maxCostUsd?:     number | undefined
}

export interface RouteResult {
  provider:    ProviderId
  model:       ModelSpec
  fallbacks:   ModelSpec[]
  estimatedCostUsd: number
}

// ─── Client ───────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role:    'system' | 'user' | 'assistant'
  content: string | ChatContentPart[]
}

export interface ChatContentPart {
  type:     'text' | 'image_url'
  text?:    string
  image_url?: { url: string }
}

export interface CompletionRequest {
  messages:        ChatMessage[]
  taskType:        TaskType
  workspaceId:     string
  maxTokens?:      number | undefined
  temperature?:    number | undefined
  stream?:         boolean | undefined
  preferProvider?: ProviderId | undefined
  maxCostUsd?:     number | undefined
}

export interface CompletionResponse {
  content:      string
  provider:     ProviderId
  model:        string
  promptTokens: number
  outputTokens: number
  costUsd:      number
  latencyMs:    number
  cached:       boolean
}

export interface EmbeddingRequest {
  text:         string
  workspaceId:  string
  dimensions?:  768 | 1536 | undefined
}

export interface EmbeddingResponse {
  embedding:    number[]
  provider:     ProviderId
  model:        string
  promptTokens: number
  costUsd:      number
  latencyMs:    number
}

// ─── Health ───────────────────────────────────────────────────────────────────

export type ProviderStatus = 'healthy' | 'degraded' | 'down'

export interface ProviderHealth {
  provider:   ProviderId
  status:     ProviderStatus
  latencyMs:  number | null
  lastCheck:  number
  errorRate:  number           // 0–1 rolling window
}

// ─── Budget ───────────────────────────────────────────────────────────────────

export interface BudgetState {
  workspaceId:  string
  dailySpendUsd:   number
  monthlySpendUsd: number
  lastReset:    number
}

export interface BudgetLimits {
  dailyUsd:   number   // default: 10
  monthlyUsd: number   // default: 100
}
