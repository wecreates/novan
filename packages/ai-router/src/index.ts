// ─── Public API ───────────────────────────────────────────────────────────────

export { chat, embed }                   from './client.js'
export { resolveRoute, estimateCost }    from './routing.js'
export { PROVIDERS, getProvider, getModel, enabledProviders } from './providers.js'
export { getProviderHealth, getProviderStatus, recordProviderResult, recordProviderLatency } from './health.js'
export { checkBudget, recordSpend, getBudgetState, getBudgetLimits } from './budget.js'
export { initTracker, trackUsage }       from './tracker.js'
export { encrypt, decrypt, encryptionAvailable } from './encryption.js'
export type { Encrypted } from './encryption.js'
export {
  discoverModels, checkEndpointHealth, remoteChat, remoteChatStream,
  buildAuthHeaders, endpointTypeLabel, ENDPOINT_TYPES,
} from './remote-endpoint-client.js'
export type {
  RemoteEndpointConfig, DiscoveredModel, RemoteCompletionRequest,
  RemoteCompletionResult, HealthCheckResult, StreamChunk,
} from './remote-endpoint-client.js'

export {
  checkJobAllowed, getThrottleLevel, checkSessionDuration,
  detectRunaway, checkBudgetAlerts, isWorkerIdle,
  DEFAULT_BUDGET_RULES,
} from './governor.js'
export type {
  JobType, KillSwitchType, ThrottleLevel, RunawayReason, AlertType,
  BudgetRules, SpendState, JobCheckResult, RunawayCheckResult, AlertCheckResult,
} from './governor.js'

export {
  computeLatencyScore, computeSuccessRateScore, computeCostScore,
  computeCapabilityScore, computeCompositeScore,
  evaluateCircuit, nextCircuitState,
  DEFAULT_SCORE_WEIGHTS,
} from './scorer.js'
export type {
  ScoreWeights, ProviderScoreInput, CircuitState, CircuitStatus,
} from './scorer.js'

export {
  checkBudgetPreflight, evaluateKillSwitches, detectRunaway2,
  mergeRunawayLimits, DEFAULT_RUNAWAY_LIMITS,
} from './guards.js'
export type {
  BudgetCap, PreflightResult, KillSwitchRecord,
  RunawayLimits, RunawayReason2, RunawayCheckResult2,
} from './guards.js'

export type {
  ProviderId, TaskType, ModelSpec, ProviderConfig,
  RouteRequest, RouteResult,
  ChatMessage, ChatContentPart,
  CompletionRequest, CompletionResponse,
  EmbeddingRequest, EmbeddingResponse,
  ProviderHealth, ProviderStatus,
  BudgetState, BudgetLimits,
} from './types.js'
