export type ProviderName = 'openai' | 'anthropic' | 'ollama' | 'groq'

export type ModelTier = 'lightweight' | 'standard' | 'premium'

export interface ProviderConfig {
  name:       ProviderName
  baseUrl:    string
  apiKey?:    string
  models:     ModelConfig[]
  enabled:    boolean
  priority:   number   // lower = preferred
  maxRpm:     number   // requests per minute limit
}

export interface ModelConfig {
  id:              string   // e.g. 'gpt-4o-mini'
  displayName:     string
  tier:            ModelTier
  contextWindow:   number
  costPer1kInput:  number   // USD
  costPer1kOutput: number   // USD
  supportsTools:   boolean
  supportsVision:  boolean
}

export interface RoutingRequest {
  taskType:        'embedding' | 'completion' | 'chat' | 'vision' | 'tool_call'
  tier?:           ModelTier
  preferProvider?: ProviderName
  maxTokens?:      number
  systemPrompt?:   string
  messages:        Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  tools?:          unknown[]
  temperature?:    number
  stream?:         boolean
}

export interface RoutingDecision {
  provider:         ProviderName
  model:            string
  tier:             ModelTier
  estimatedCostUsd: number
  reason:           string
}

export interface Message {
  role:    'system' | 'user' | 'assistant'
  content: string
}

export interface CompletionResult {
  provider:     ProviderName
  model:        string
  content:      string
  promptTokens: number
  outputTokens: number
  usage:        { promptTokens: number; outputTokens: number }
  costUsd:      number
  latencyMs:    number
  cached:       boolean
  finishReason: string
}

export interface EmbeddingResult {
  provider:     ProviderName
  model:        string
  embedding:    number[]
  promptTokens: number
  costUsd:      number
  latencyMs:    number
}

export interface ProviderHealth {
  name:          ProviderName
  healthy:       boolean
  latencyMs?:    number
  lastCheckedAt: number
  errorMessage?: string
}
