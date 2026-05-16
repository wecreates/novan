/**
 * @ops/provider-router — AI provider routing, fallback, and cost governance.
 *
 * Routing tiers:
 *   HEAVY   — complex reasoning, architecture, security analysis
 *   MEDIUM  — coding, refactoring, API work, frontend work
 *   LIGHT   — summaries, formatting, compression, lint fixes
 *   LOCAL   — embeddings, retrieval, offline workflows (Ollama)
 *
 * Provider health is tracked per-workspace with circuit breaker semantics.
 * Routing decisions are logged for cost analytics.
 */
import type { WorkspaceId } from '@ops/shared-types'

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProviderName = 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'groq'
export type RoutingTier  = 'heavy' | 'medium' | 'light' | 'local'
export type CircuitState = 'closed' | 'open' | 'half_open'

export interface ModelSpec {
  provider:    ProviderName
  model:       string
  tier:        RoutingTier
  contextWindow: number
  inputCostPer1k:  number   // USD
  outputCostPer1k: number   // USD
  supportsStreaming: boolean
  maxConcurrency:   number
}

export const MODEL_REGISTRY: ModelSpec[] = [
  // Heavy
  { provider: 'anthropic', model: 'claude-opus-4-5',      tier: 'heavy',  contextWindow: 200_000, inputCostPer1k: 0.015,  outputCostPer1k: 0.075,  supportsStreaming: true,  maxConcurrency: 10 },
  { provider: 'openai',    model: 'o3',                    tier: 'heavy',  contextWindow: 128_000, inputCostPer1k: 0.01,   outputCostPer1k: 0.04,   supportsStreaming: true,  maxConcurrency: 10 },
  // Medium
  { provider: 'anthropic', model: 'claude-sonnet-4-5',    tier: 'medium', contextWindow: 200_000, inputCostPer1k: 0.003,  outputCostPer1k: 0.015,  supportsStreaming: true,  maxConcurrency: 50 },
  { provider: 'openai',    model: 'gpt-4o',               tier: 'medium', contextWindow: 128_000, inputCostPer1k: 0.0025, outputCostPer1k: 0.01,   supportsStreaming: true,  maxConcurrency: 50 },
  { provider: 'gemini',    model: 'gemini-2.0-flash',     tier: 'medium', contextWindow: 1_000_000, inputCostPer1k: 0.000075, outputCostPer1k: 0.0003, supportsStreaming: true, maxConcurrency: 100 },
  // Light
  { provider: 'anthropic', model: 'claude-haiku-3-5',     tier: 'light',  contextWindow: 200_000, inputCostPer1k: 0.0008, outputCostPer1k: 0.004,  supportsStreaming: true,  maxConcurrency: 200 },
  { provider: 'openai',    model: 'gpt-4o-mini',          tier: 'light',  contextWindow: 128_000, inputCostPer1k: 0.00015, outputCostPer1k: 0.0006, supportsStreaming: true, maxConcurrency: 200 },
  { provider: 'groq',      model: 'llama-3.3-70b',        tier: 'light',  contextWindow: 128_000, inputCostPer1k: 0.00059, outputCostPer1k: 0.00079, supportsStreaming: true, maxConcurrency: 100 },
  // Local
  { provider: 'ollama',    model: 'nomic-embed-text',     tier: 'local',  contextWindow: 8_192,   inputCostPer1k: 0,      outputCostPer1k: 0,      supportsStreaming: false, maxConcurrency: 10 },
]

export interface RoutingRequest {
  workspaceId:  WorkspaceId
  tier:         RoutingTier
  taskType:     string
  estimatedTokens: number
  requireStreaming: boolean
  budgetCeiling: number | null   // max USD for this call
}

export interface RoutingDecision {
  provider:    ProviderName
  model:       string
  fallbackChain: ModelSpec[]
  estimatedCost: number
  reason:      string
}

export interface ProviderHealth {
  provider:    ProviderName
  state:       CircuitState
  successRate: number   // rolling 5min
  p50LatencyMs: number
  p99LatencyMs: number
  errorRate:   number
  lastError:   string | null
  lastUpdated: number
}

export interface ProviderUsage {
  workspaceId:    WorkspaceId
  provider:       ProviderName
  model:          string
  promptTokens:   number
  outputTokens:   number
  costUsd:        number
  latencyMs:      number
  cached:         boolean
  tier:           RoutingTier
  taskType:       string
  timestamp:      number
}

// ─── Concrete router implementation ──────────────────────────────────────────
export type { ProviderConfig, ModelConfig, CompletionResult, EmbeddingResult, ModelTier, Message } from './types.js'
export { DEFAULT_PROVIDERS, getEnabledProviders } from './config.js'
export { ProviderRouter as ConcreteProviderRouter, defaultRouter } from './router.js'

// ─── Router interface ─────────────────────────────────────────────────────────

export interface ProviderRouter {
  /** Select best provider+model for a request. */
  route(req: RoutingRequest): Promise<RoutingDecision>
  /** Report call outcome to update health stats. */
  reportOutcome(provider: ProviderName, model: string, latencyMs: number, success: boolean, error?: string): void
  /** Get current health for all providers. */
  getHealth(): ProviderHealth[]
  /** Force-open circuit breaker for a provider. */
  disableProvider(provider: ProviderName, reason: string): void
  /** Close circuit breaker (re-enable provider). */
  enableProvider(provider: ProviderName): void
}

// ─── Token budget ─────────────────────────────────────────────────────────────

export interface TokenBudget {
  workspaceId:  WorkspaceId
  dailyLimitUsd:   number
  monthlyLimitUsd: number
  usedTodayUsd:    number
  usedThisMonthUsd: number
  remaining:       number
  resetAt:         number
}

export interface BudgetCheck {
  allowed:     boolean
  remaining:   number
  reason:      string | null
}
