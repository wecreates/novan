/**
 * API client — typed fetch wrapper for the Fastify API.
 */
const BASE = import.meta.env['VITE_API_URL'] ?? 'http://localhost:3001'

let authToken: string | null =
  typeof localStorage !== 'undefined' ? localStorage.getItem('ops_auth_token') : null

export function setAuthToken(token: string): void {
  authToken = token
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('ops_auth_token', token)
  }
}

export function clearAuthToken(): void {
  authToken = null
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('ops_auth_token')
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
  }

  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
    throw new Error(err.error ?? `HTTP ${res.status}`)
  }

  return res.json() as Promise<T>
}

export const api = {
  get:    <T>(path: string) => request<T>(path),
  post:   <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  put:    <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT',  body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}

// ─── Typed API calls ──────────────────────────────────────────────────────────

export interface WorkflowRun {
  id:          string
  workflowId:  string
  status:      string
  triggeredAt: number
  startedAt?:  number
  completedAt?: number
  errorMessage?: string
}

export interface Approval {
  id:             string
  runId:          string
  stepId:         string
  status:         string
  operationLabel: string
  requestedAt:    number
  expiresAt:      number
  risk:           string
  context:        Record<string, unknown>
}

export interface QueueMetrics {
  [queue: string]: { waiting: number; active: number; failed: number }
}

export interface RunStats {
  running?:           number
  pending?:           number
  completed?:         number
  failed?:            number
  awaiting_approval?: number
  cancelled?:         number
}

export interface OpsEvent {
  id:          string
  type:        string
  workspaceId: string
  payload:     Record<string, unknown>
  traceId:     string
  source:      string
  createdAt:   number
}

export interface BrowserSession {
  id:              string
  workspaceId:     string
  jobId:           string
  url:             string
  status:          string
  pageTitle?:      string
  pageText?:       string
  screenshotPath?: string
  errorMessage?:   string
  durationMs?:     number
  startedAt:       number
  completedAt?:    number
}

export interface BrowserAction {
  id:              string
  sessionId:       string
  actionType:      string
  actionInput:     Record<string, unknown>
  success:         boolean
  output?:         Record<string, unknown>
  error?:          string
  screenshotPath?: string
  durationMs?:     number
  executedAt:      number
}

export interface RollbackResult {
  requestId:     string
  status:        'completed' | 'failed' | 'no_snapshot'
  itemsRestored: number
  itemsFailed:   number
  warnings:      string[]
}

export interface Opportunity {
  id:                  string
  workspaceId:         string
  businessId?:         string
  title:               string
  description?:        string
  type:                string
  status:              string
  priority:            number
  valuePotential?:     number
  confidence:          number
  category:            string
  // Scoring inputs (all labeled "estimated")
  estimatedROI?:       number
  estimatedEffort?:    string
  riskLevel?:          string
  strategicAlignment?: number
  // Computed score
  score?:              number
  scoreBreakdown?:     Record<string, number>
  // Linked
  linkedMemoryIds:     string[]
  linkedWorkflowIds:   string[]
  // Conversion
  convertedRunId?:     string
  convertedWorkflowId?: string
  convertedAt?:        number
  // Lifecycle
  acceptedAt?:         number
  rejectedAt?:         number
  tags:                string[]
  createdAt:           number
  updatedAt:           number
}

export interface OpportunityDetail extends Opportunity {
  linkedMemories: { id: string; content: string; confidence: number }[]
}

export interface Risk {
  id:          string
  workspaceId: string
  businessId?: string | null
  title:       string
  description?: string | null
  severity:    'low' | 'medium' | 'high' | 'critical'
  probability: number
  impact:      number
  riskScore:   number
  category:    string
  status:      'open' | 'mitigating' | 'resolved' | 'accepted'
  mitigations: Array<{ id: string; description: string; addedAt: number }>
  detectedAt:  number
  resolvedAt?: number | null
  createdAt:   number
  updatedAt:   number
}

export interface Memory {
  id:         string
  type:       string
  content:    string
  summary?:   string
  confidence: number
  tags:       string[]
  source:     string
  sourceRef?: string
  isStale:    boolean
  createdAt:  number
  updatedAt:  number
  expiresAt?: number
}

export interface MemorySearchResult extends Memory {
  score?: number
}

export const warRoomApi = {
  getApprovals:    () => api.get<{ success: true; data: Approval[] }>('/api/v1/approvals'),
  approve:         (id: string) => api.post(`/api/v1/approvals/${id}/approve`, {}),
  reject:          (id: string, reason: string) => api.post(`/api/v1/approvals/${id}/reject`, { reason }),
  getMetrics:      () => api.get<string>('/metrics'),
  getWorkflowRuns: () => api.get<{ success: true; data: WorkflowRun[] }>('/api/v1/workflow-runs'),
  getRunStats:     () => api.get<{ success: true; data: RunStats }>('/api/v1/workflow-runs/stats/summary'),
  getEvents:       (params?: { since?: number; limit?: number }) => {
    const q = new URLSearchParams()
    if (params?.since) q.set('since', String(params.since))
    if (params?.limit) q.set('limit', String(params.limit))
    const qs = q.toString()
    return api.get<{ success: true; data: OpsEvent[]; meta: { count: number } }>(`/api/v1/events${qs ? `?${qs}` : ''}`)
  },
  rollback: (runId: string, reason?: string) =>
    api.post<{ success: true; data: RollbackResult }>(`/api/v1/workflow-runs/${runId}/rollback`, { reason }),

  submitBrowserTask: (url: string, label?: string) =>
    api.post<{ success: true; status: string; jobId?: string; traceId: string }>(
      '/api/v1/browser/tasks',
      { url, ...(label !== undefined ? { label } : {}) },
    ),
  getBrowserSessions: () =>
    api.get<{ success: true; data: BrowserSession[] }>('/api/v1/browser/sessions'),
  getBrowserSession:  (id: string) =>
    api.get<{ success: true; data: BrowserSession & { actions: BrowserAction[] } }>(
      `/api/v1/browser/sessions/${id}`,
    ),

  // Memory
  createMemory: (body: { type: string; content: string; confidence?: number; tags?: string[]; source?: string }) =>
    api.post<{ success: true; data: Memory; warning?: string }>('/api/v1/memory', body),
  searchMemory: (query: string, opts?: { limit?: number; minScore?: number }) => {
    const q = new URLSearchParams({ query })
    if (opts?.limit !== undefined)    q.set('limit',    String(opts.limit))
    if (opts?.minScore !== undefined) q.set('minScore', String(opts.minScore))
    return api.get<{ success: true; data: MemorySearchResult[] }>(`/api/v1/memory/search?${q.toString()}`)
  },
  listMemories: (opts?: { limit?: number; includeStale?: boolean }) => {
    const q = new URLSearchParams({ limit: String(opts?.limit ?? 20) })
    if (opts?.includeStale) q.set('includeStale', 'true')
    return api.get<{ success: true; data: Memory[] }>(`/api/v1/memory?${q.toString()}`)
  },
  markMemoryStale: (id: string) =>
    api.post<{ success: true }>(`/api/v1/memory/${id}/mark-stale`, {}),
}

// ─── Briefing types ───────────────────────────────────────────────────────────

export interface BriefingItem {
  id:                  string
  briefingId:          string
  section:             string
  title:               string
  body:                string
  confidence:          number
  isLowConfidence:     boolean
  source:              string
  sourceRef:           string | null
  sourceLabel:         string | null
  converted:           boolean
  convertedAt?:        number
  convertedRunId?:     string
  priority:            number
  metadata:            Record<string, unknown>
  createdAt:           number
}

export interface Briefing {
  id:           string
  status:       string   // generating | ready | failed
  requestedBy:  string
  summary:      string | null
  generatedAt:  number | null
  createdAt:    number
  errorMessage: string | null
}

export interface BriefingDetail extends Briefing {
  items: BriefingItem[]
}

export const briefingApi = {
  request: (opts?: { windowMs?: number; requestedBy?: string }) =>
    api.post<{ success: true; data: { briefingId: string; status: string; traceId: string } }>(
      '/api/v1/briefings',
      { windowMs: opts?.windowMs ?? 86_400_000, requestedBy: opts?.requestedBy ?? 'user' },
    ),
  list: (limit = 10) =>
    api.get<{ success: true; data: Briefing[] }>(`/api/v1/briefings?limit=${limit}`),
  get: (id: string) =>
    api.get<{ success: true; data: BriefingDetail }>(`/api/v1/briefings/${id}`),
  convertItem: (
    briefingId: string,
    itemId: string,
    opts?: { workflowId?: string; context?: Record<string, unknown>; convertedBy?: string },
  ) =>
    api.post<{ success: true; data: { runId: string; workflowId: string; status: string; traceId: string } }>(
      `/api/v1/briefings/${briefingId}/items/${itemId}/convert`,
      { ...opts },
    ),
}

// ─── Opportunity API ──────────────────────────────────────────────────────────

export type OpportunityStatus =
  | 'identified' | 'evaluating' | 'active' | 'won' | 'lost' | 'deferred'
  | 'accepted' | 'rejected' | 'stale' | 'completed'

export type OpportunityType =
  | 'revenue' | 'content' | 'seo' | 'automation' | 'business' | 'operational' | 'strategic'

export type EffortLevel = 'low' | 'medium' | 'high' | 'very_high'
export type RiskLevel   = 'low' | 'medium' | 'high' | 'critical'

export interface CreateOpportunityInput {
  title:               string
  description?:        string
  type?:               OpportunityType
  businessId?:         string
  estimatedROI?:       number
  estimatedEffort?:    EffortLevel
  riskLevel?:          RiskLevel
  confidence?:         number
  strategicAlignment?: number
  linkedMemoryIds?:    string[]
  tags?:               string[]
  priority?:           number
  valuePotential?:     number
  dueDate?:            number
}

export const opportunityApi = {
  create: (body: CreateOpportunityInput) =>
    api.post<{ success: true; data: Opportunity }>('/api/v1/opportunities', body),

  list: (opts?: { status?: OpportunityStatus; type?: OpportunityType; limit?: number }) => {
    const q = new URLSearchParams()
    if (opts?.status) q.set('status', opts.status)
    if (opts?.type)   q.set('type',   opts.type)
    if (opts?.limit)  q.set('limit',  String(opts.limit))
    const qs = q.toString()
    return api.get<{ success: true; data: Opportunity[]; meta: { count: number } }>(
      `/api/v1/opportunities${qs ? `?${qs}` : ''}`,
    )
  },

  get: (id: string) =>
    api.get<{ success: true; data: OpportunityDetail }>(`/api/v1/opportunities/${id}`),

  update: (id: string, body: Partial<CreateOpportunityInput>) =>
    api.put<{ success: true; data: Opportunity }>(`/api/v1/opportunities/${id}`, body),

  score: (id: string) =>
    api.post<{ success: true; data: { score: number; scoreBreakdown: Record<string, number> } }>(
      `/api/v1/opportunities/${id}/score`, {},
    ),

  setStatus: (id: string, status: OpportunityStatus, changedBy?: string) =>
    api.post<{ success: true; data: { id: string; status: string } }>(
      `/api/v1/opportunities/${id}/status`,
      { status, changedBy: changedBy ?? 'user' },
    ),

  convert: (id: string, opts?: { workflowId?: string; convertedBy?: string; context?: Record<string, unknown> }) =>
    api.post<{ success: true; data: { runId: string; workflowId: string; status: string; traceId: string } }>(
      `/api/v1/opportunities/${id}/convert`,
      { ...opts },
    ),

  linkMemory: (id: string, memoryIds: string[]) =>
    api.post<{ success: true; data: { linkedMemoryIds: string[] } }>(
      `/api/v1/opportunities/${id}/link-memory`,
      { memoryIds },
    ),
}

// ─── Risk API ─────────────────────────────────────────────────────────────────

export const riskApi = {
  create: (body: { title: string; severity?: string; probability?: number; impact?: number; category?: string; description?: string; businessId?: string }) =>
    api.post<{ success: true; data: Risk }>('/api/v1/risks', body),
  list: (opts?: { status?: string; severity?: string; limit?: number }) => {
    const q = new URLSearchParams()
    if (opts?.status)   q.set('status',   opts.status)
    if (opts?.severity) q.set('severity', opts.severity)
    if (opts?.limit)    q.set('limit',    String(opts.limit))
    const qs = q.toString()
    return api.get<{ success: true; data: Risk[]; meta: { count: number } }>(`/api/v1/risks${qs ? `?${qs}` : ''}`)
  },
  get:      (id: string) => api.get<{ success: true; data: Risk }>(`/api/v1/risks/${id}`),
  update:   (id: string, body: Partial<{ title: string; severity: string; probability: number; impact: number; category: string; description: string }>) =>
    api.put<{ success: true; data: Risk }>(`/api/v1/risks/${id}`, body),
  resolve:  (id: string) => api.post<{ success: true; data: Risk }>(`/api/v1/risks/${id}/resolve`, {}),
  mitigate: (id: string, description: string) => api.post<{ success: true; data: Risk }>(`/api/v1/risks/${id}/mitigate`, { description }),
}

// ─── Insight API ──────────────────────────────────────────────────────────────

export interface Insight {
  id:         string
  workspaceId: string
  title:      string
  body:       string
  category:   string
  confidence: number
  source:     string
  sourceRef?: string | null
  tags:       string[]
  dismissed:  boolean
  actedOn:    boolean
  expiresAt?: number | null
  createdAt:  number
}

export const insightApi = {
  create: (body: { title: string; body: string; source: string; category?: string; confidence?: number; sourceRef?: string; tags?: string[]; expiresAt?: number }) =>
    api.post<{ success: true; data: Insight }>('/api/v1/insights', body),
  list: (opts?: { category?: string; dismissed?: boolean; limit?: number }) => {
    const q = new URLSearchParams()
    if (opts?.category !== undefined)  q.set('category',  opts.category)
    if (opts?.dismissed !== undefined) q.set('dismissed', String(opts.dismissed))
    if (opts?.limit !== undefined)     q.set('limit',     String(opts.limit))
    const qs = q.toString()
    return api.get<{ success: true; data: Insight[]; meta: { count: number } }>(`/api/v1/insights${qs ? `?${qs}` : ''}`)
  },
  get:     (id: string) => api.get<{ success: true; data: Insight }>(`/api/v1/insights/${id}`),
  dismiss: (id: string) => api.post<{ success: true; data: Insight }>(`/api/v1/insights/${id}/dismiss`, {}),
  actOn:   (id: string) => api.post<{ success: true; data: Insight }>(`/api/v1/insights/${id}/act-on`, {}),
}

// ─── Goal API ─────────────────────────────────────────────────────────────────

export interface KeyResult {
  id:      string
  title:   string
  target:  number
  current: number
  unit:    string
}

export interface Goal {
  id:           string
  workspaceId:  string
  businessId?:  string | null
  parentGoalId?: string | null
  title:        string
  description?: string | null
  status:       'draft' | 'active' | 'paused' | 'completed' | 'abandoned'
  horizon:      string
  targetDate?:  number | null
  progress:     number
  keyResults:   KeyResult[]
  owners:       string[]
  tags:         string[]
  completedAt?: number | null
  createdAt:    number
  updatedAt:    number
}

export const goalApi = {
  create: (body: { title: string; description?: string; horizon?: string; targetDate?: number; owners?: string[]; tags?: string[]; businessId?: string; keyResults?: KeyResult[] }) =>
    api.post<{ success: true; data: Goal }>('/api/v1/goals', body),
  list: (opts?: { status?: string; horizon?: string; limit?: number }) => {
    const q = new URLSearchParams()
    if (opts?.status)  q.set('status',  opts.status)
    if (opts?.horizon) q.set('horizon', opts.horizon)
    if (opts?.limit)   q.set('limit',   String(opts.limit))
    const qs = q.toString()
    return api.get<{ success: true; data: Goal[]; meta: { count: number } }>(`/api/v1/goals${qs ? `?${qs}` : ''}`)
  },
  get:      (id: string) => api.get<{ success: true; data: Goal }>(`/api/v1/goals/${id}`),
  update:   (id: string, body: Partial<Goal>) => api.put<{ success: true; data: Goal }>(`/api/v1/goals/${id}`, body),
  progress: (id: string, progress: number) => api.post<{ success: true; data: Goal }>(`/api/v1/goals/${id}/progress`, { progress }),
  complete: (id: string) => api.post<{ success: true; data: Goal }>(`/api/v1/goals/${id}/complete`, {}),
  activate: (id: string) => api.post<{ success: true; data: Goal }>(`/api/v1/goals/${id}/activate`, {}),
}

// ─── Agent API ────────────────────────────────────────────────────────────────

export type AgentStatus = 'idle' | 'running' | 'paused' | 'error' | 'offline'

export interface Agent {
  id:           string
  workspaceId:  string
  name:         string
  description?: string | null
  type:         string
  status:       AgentStatus
  capabilities: string[]
  config:       Record<string, unknown>
  lastActiveAt?: number | null
  heartbeatAt?:  number | null
  createdAt:    number
  updatedAt:    number
}

export const agentApi = {
  register: (body: { name: string; type: string; description?: string; capabilities?: string[]; config?: Record<string, unknown> }) =>
    api.post<{ success: true; data: Agent }>('/api/v1/agents', body),
  list: (opts?: { status?: AgentStatus; type?: string; limit?: number }) => {
    const q = new URLSearchParams()
    if (opts?.status) q.set('status', opts.status)
    if (opts?.type)   q.set('type',   opts.type)
    if (opts?.limit)  q.set('limit',  String(opts.limit))
    const qs = q.toString()
    return api.get<{ success: true; data: Agent[] }>(`/api/v1/agents${qs ? `?${qs}` : ''}`)
  },
  get:       (id: string) => api.get<{ success: true; data: Agent }>(`/api/v1/agents/${id}`),
  update:    (id: string, body: Partial<{ name: string; description: string; capabilities: string[]; config: Record<string, unknown> }>) =>
    api.put<{ success: true; data: Agent }>(`/api/v1/agents/${id}`, body),
  heartbeat: (id: string) => api.post<{ success: true }>(`/api/v1/agents/${id}/heartbeat`, {}),
  setStatus: (id: string, status: AgentStatus) => api.post<{ success: true; data: Agent }>(`/api/v1/agents/${id}/status`, { status }),
  remove:    (id: string) => api.delete<{ success: true }>(`/api/v1/agents/${id}`),
}

// ─── Business API ─────────────────────────────────────────────────────────────

export interface Business {
  id:          string
  workspaceId: string
  name:        string
  domain?:     string | null
  industry?:   string | null
  stage:       string
  health:      'green' | 'yellow' | 'red'
  metrics:     Record<string, unknown>
  metadata:    Record<string, unknown>
  createdAt:   number
  updatedAt:   number
}

export const businessApi = {
  create: (body: { name: string; domain?: string; industry?: string; stage?: string; health?: string }) =>
    api.post<{ success: true; data: Business }>('/api/v1/businesses', body),
  list: () => api.get<{ success: true; data: Business[] }>('/api/v1/businesses'),
  get:     (id: string) => api.get<{ success: true; data: Business }>(`/api/v1/businesses/${id}`),
  update:  (id: string, body: Partial<Business>) => api.put<{ success: true; data: Business }>(`/api/v1/businesses/${id}`, body),
  metrics: (id: string, metrics: Record<string, unknown>) => api.post<{ success: true; data: Business }>(`/api/v1/businesses/${id}/metrics`, { metrics }),
}

// ─── Analytics API ────────────────────────────────────────────────────────────

export interface AIUsageSummary {
  totalPromptTokens:  number
  totalOutputTokens:  number
  totalCostUsd:       number
  totalRequests:      number
  cachedRequests:     number
  avgLatencyMs:       number
  byProvider:         Record<string, { requests: number; promptTokens: number; outputTokens: number; costUsd: number }>
  byModel:            Record<string, { requests: number; costUsd: number }>
  byTaskType:         Record<string, number>
}

export interface AIUsageDay {
  date:     string
  requests: number
  tokens:   number
  costUsd:  number
}

export interface AnalyticsSummary {
  workflowRuns:   Record<string, number>
  recentEvents:   Array<{ type: string; count: number }>
}

export const analyticsApi = {
  aiUsage:        (windowMs?: number) => {
    const q = windowMs ? `?windowMs=${windowMs}` : ''
    return api.get<{ success: true; data: AIUsageSummary }>(`/api/v1/analytics/ai-usage${q}`)
  },
  aiUsageHistory: (days?: number) => {
    const q = days ? `?days=${days}` : ''
    return api.get<{ success: true; data: AIUsageDay[] }>(`/api/v1/analytics/ai-usage/history${q}`)
  },
  summary:        () => api.get<{ success: true; data: AnalyticsSummary }>('/api/v1/analytics/summary'),
}

// ─── SSE stream helper ────────────────────────────────────────────────────────

// ─── Notifications API ────────────────────────────────────────────────────────

export interface OpsNotification {
  id:          string
  workspaceId: string
  title:       string
  body:        string
  type:        'info' | 'warning' | 'error' | 'success'
  category:    'system' | 'workflow' | 'approval' | 'risk' | 'opportunity' | 'goal'
  read:        boolean
  dismissed:   boolean
  sourceType?: string | null
  sourceId?:   string | null
  actionUrl?:  string | null
  expiresAt?:  number | null
  createdAt:   number
}
/** @deprecated use OpsNotification */
export type Notification = OpsNotification

export const notificationApi = {
  create: (body: { title: string; body: string; type?: string; category?: string; sourceType?: string; sourceId?: string; actionUrl?: string }) =>
    api.post<{ success: true; data: Notification }>('/api/v1/notifications', body),
  list: (opts?: { read?: boolean; dismissed?: boolean; limit?: number }) => {
    const q = new URLSearchParams()
    if (opts?.read      !== undefined) q.set('read',      String(opts.read))
    if (opts?.dismissed !== undefined) q.set('dismissed', String(opts.dismissed))
    if (opts?.limit     !== undefined) q.set('limit',     String(opts.limit))
    const qs = q.toString()
    return api.get<{ success: true; data: OpsNotification[]; meta: { count: number; unreadCount: number } }>(`/api/v1/notifications${qs ? `?${qs}` : ''}`)
  },
  markRead:    (id: string) => api.post<{ success: true }>(`/api/v1/notifications/${id}/read`, {}),
  dismiss:     (id: string) => api.post<{ success: true }>(`/api/v1/notifications/${id}/dismiss`, {}),
  markAllRead: ()           => api.post<{ success: true }>('/api/v1/notifications/read-all', {}),
}

// ─── Auth API ─────────────────────────────────────────────────────────────────

export interface ApiToken {
  id:          string
  name:        string
  prefix:      string
  scopes:      string[]
  lastUsedAt?: number | null
  expiresAt?:  number | null
  createdAt:   number
}

export const authApi = {
  createToken: (name: string, scopes?: string[]) =>
    api.post<{ success: true; data: { token: string; id: string; prefix: string } }>(
      '/api/v1/auth/tokens',
      { name, ...(scopes ? { scopes } : {}) },
    ),
  listTokens:  () =>
    api.get<{ success: true; data: ApiToken[] }>('/api/v1/auth/tokens'),
  revokeToken: (id: string) =>
    api.delete<{ success: true }>(`/api/v1/auth/tokens/${id}`),
  verify:      (token: string) =>
    api.post<{ success: true; data: { valid: boolean; workspaceId?: string; scopes?: string[] } }>(
      '/api/v1/auth/verify',
      { token },
    ),
  me:          () =>
    api.get<{ success: true; data: { workspaceId: string } }>('/api/v1/auth/me'),
}

// ─── Search API ───────────────────────────────────────────────────────────────

export type SearchEntityType = 'memory' | 'opportunity' | 'risk' | 'insight' | 'goal' | 'agent' | 'business' | 'workflow'

export interface SearchHit {
  type:      SearchEntityType
  id:        string
  title:     string
  subtitle?: string
  status?:   string
  score?:    number
  createdAt: number
}

export const searchApi = {
  search: (q: string, opts?: { types?: SearchEntityType[]; limit?: number }) => {
    const params = new URLSearchParams({ q })
    if (opts?.types?.length) params.set('types', opts.types.join(','))
    if (opts?.limit)         params.set('limit', String(opts.limit))
    return api.get<{ success: true; data: SearchHit[]; meta: { count: number; query: string } }>(`/api/v1/search?${params.toString()}`)
  },
}

// ─── Webhook API ─────────────────────────────────────────────────────────────

export interface Webhook {
  id:          string
  workspaceId: string
  name:        string
  events:      string[]
  workflowId?: string | null
  active:      boolean
  callCount:   number
  lastCalledAt?: number | null
  createdAt:   number
  updatedAt:   number
}

export interface WebhookDelivery {
  id:         string
  webhookId:  string
  eventType:  string
  status:     string
  runId?:     string | null
  error?:     string | null
  createdAt:  number
}

export const webhookApi = {
  create:       (body: { name: string; events?: string[]; workflowId?: string }) =>
    api.post<{ success: true; data: Webhook & { secret: string } }>('/api/v1/webhooks', body),
  list:         () => api.get<{ success: true; data: Webhook[]; meta: { count: number } }>('/api/v1/webhooks'),
  get:          (id: string) => api.get<{ success: true; data: Webhook & { deliveries: WebhookDelivery[] } }>(`/api/v1/webhooks/${id}`),
  update:       (id: string, body: Partial<{ name: string; events: string[]; workflowId: string }>) =>
    api.put<{ success: true; data: Webhook }>(`/api/v1/webhooks/${id}`, body),
  remove:       (id: string) => api.delete<{ success: true }>(`/api/v1/webhooks/${id}`),
  rotateSecret: (id: string) => api.post<{ success: true; data: { secret: string } }>(`/api/v1/webhooks/${id}/rotate-secret`, {}),
}

// ── Scheduler ──────────────────────────────────────────────────────────────

export interface ScheduledTrigger {
  id:             string
  workspaceId:    string
  name:           string
  description?:   string | null
  workflowId:     string
  cronExpression: string
  timezone:       string
  enabled:        boolean
  lastRunAt?:     number | null
  nextRunAt?:     number | null
  lastRunStatus?: string | null
  runCount:       number
  failureCount:   number
  payload?:       Record<string, unknown> | null
  createdAt:      number
  updatedAt:      number
}

export const schedulerApi = {
  list: (params?: { enabled?: boolean }) => {
    const q = new URLSearchParams()
    if (params?.enabled !== undefined) q.set('enabled', String(params.enabled))
    const qs = q.toString()
    return api.get<{ data: ScheduledTrigger[] }>(`/api/v1/scheduler${qs ? `?${qs}` : ''}`)
  },
  get: (id: string) =>
    api.get<{ data: ScheduledTrigger }>(`/api/v1/scheduler/${id}`),
  create: (body: Partial<ScheduledTrigger>) =>
    api.post<{ data: ScheduledTrigger }>('/api/v1/scheduler', body),
  update: (id: string, body: Partial<ScheduledTrigger>) =>
    api.put<{ data: ScheduledTrigger }>(`/api/v1/scheduler/${id}`, body),
  delete: (id: string) =>
    api.delete<{ success: boolean }>(`/api/v1/scheduler/${id}`),
  enable: (id: string) =>
    api.post<{ data: ScheduledTrigger }>(`/api/v1/scheduler/${id}/enable`, {}),
  disable: (id: string) =>
    api.post<{ data: ScheduledTrigger }>(`/api/v1/scheduler/${id}/disable`, {}),
  trigger: (id: string) =>
    api.post<{ data: { runId: string } }>(`/api/v1/scheduler/${id}/trigger`, {}),
}

// ── Workers ────────────────────────────────────────────────────────────────

export interface QueueStat {
  name:      string
  waiting:   number
  active:    number
  completed: number
  failed:    number
  delayed?:  number
}

export interface WorkerHealth {
  queues:  QueueStat[]
  totals:  { waiting: number; active: number; completed: number; failed: number }
}

export interface QueueFailure {
  id?:           string
  name:          string
  failedReason?: string
  attemptsMade:  number
  timestamp:     number
}

export interface QueueDetail {
  name:           string
  waiting:        number
  active:         number
  recentFailures: QueueFailure[]
}

export const workersApi = {
  health: () => api.get<{ success: true; data: WorkerHealth }>('/api/v1/workers/health'),
  queues: () => api.get<{ success: true; data: QueueDetail[] }>('/api/v1/workers/queues'),
}

// ─── Strategic Intelligence client ────────────────────────────────────────────

export interface StrategicHomePayload {
  workspaceId: string
  composedAt:  number
  headline: { status: 'critical' | 'attention_needed' | 'healthy'; summary: string }
  topRecommendations: Array<{
    id: string; kind: string; title: string
    decision: { score: number; bucket: 'P0' | 'P1' | 'P2' | 'P3'; autoApplyOk: boolean; warnings: string[] }
    estimatedImpact: 'low' | 'medium' | 'high' | 'critical'
    evidence: Record<string, unknown>
  }>
  missions: {
    active:    Array<{ id: string; title: string; horizon: string; progress: number; targetDate: number | null; estimatedImpact: string }>
    blocked:   Array<{ id: string; title: string; horizon: string }>
    completed: Array<{ id: string; title: string }>
    pendingApprovals: number
  }
  accomplishments24h: Array<{ kind: string; count: number; latestAt: number | null }>
  sinceLastVisit: {
    windowStart: number; windowEnd: number
    newIncidents: number; resolvedIncidents: number
    newResearchFindings: number; newApprovals: number; newRoadmapItems: number
    newFeedback: number; rollbacks: number
    failureRateDelta: number | null
  }
  unresolvedCritical: { openIncidents: number; pendingApprovals: number; securityAudit: number }
}

export interface GovernanceSnapshot {
  capturedAt: number
  stability: {
    overall: 'stable' | 'attention' | 'unstable'
    indicators: Array<{ name: string; value: number; threshold: number; unstable: boolean; detail?: string }>
    recommendedThrottle: boolean
  }
  runtimeGovernor: {
    limits: Record<string, number>
    state:  Record<string, unknown>
    dailyCounters: { autonomousPatchesToday: number; deploymentsToday: number; limits: Record<string, number> }
  }
}

export interface ExplanationDTO {
  recommendationId: string
  recommendation:   StrategicHomePayload['topRecommendations'][number]
  why:              string
  score:            number
  confidenceProvenance: 'model_reported' | 'heuristic' | 'verified'
  estimatedImpact:  'low' | 'medium' | 'high' | 'critical'
  risks:            string[]
  rollbackProven:   boolean
  rollbackEngineAvailable: boolean
  whatHappensIfIgnored: string
  interpretationType: 'template' | 'model'
}

export const intelligenceApi = {
  home: (workspaceId: string) =>
    api.get<{ success: true; data: StrategicHomePayload }>(
      `/api/v1/intelligence/war-room/home?workspace_id=${encodeURIComponent(workspaceId)}`,
    ),
  governance: (workspaceId: string) =>
    api.get<{ success: true; data: GovernanceSnapshot }>(
      `/api/v1/governance/snapshot?workspace_id=${encodeURIComponent(workspaceId)}`,
    ),
  explainTop: (workspaceId: string, limit = 5) =>
    api.get<{ success: true; data: ExplanationDTO[] }>(
      `/api/v1/explain/top?workspace_id=${encodeURIComponent(workspaceId)}&limit=${limit}`,
    ),
  notificationDrivers: () =>
    api.get<{ success: true; data: { configured: string[] } }>(`/api/v1/governance/notifications/drivers`),
  continuity: (workspaceId: string) =>
    api.get<{ success: true; data: ContinuitySnapshotDTO }>(
      `/api/v1/intelligence/continuity?workspace_id=${encodeURIComponent(workspaceId)}`,
    ),
  trends: (workspaceId: string) =>
    api.get<{ success: true; data: AllTrendsDTO }>(
      `/api/v1/intelligence/trends?workspace_id=${encodeURIComponent(workspaceId)}`,
    ),
  rankedMemory: (workspaceId: string, limit = 20, tags?: string[]) => {
    const q = new URLSearchParams({ workspace_id: workspaceId, limit: String(limit) })
    if (tags && tags.length > 0) q.set('tags', tags.join(','))
    return api.get<{ success: true; data: RankedMemoryItemDTO[] }>(`/api/v1/intelligence/memory/ranked?${q.toString()}`)
  },
  priorityHeatmap: (workspaceId: string) =>
    api.get<{ success: true; data: { categories: string[]; heatmap: Record<string, { total: number; active: number; completed: number; avgProgress: number }>; dominant: string[] } }>(
      `/api/v1/intelligence/priorities/heatmap?workspace_id=${encodeURIComponent(workspaceId)}`,
    ),
  forecasts: (workspaceId: string) =>
    api.get<{ success: true; data: AllForecastsDTO }>(`/api/v1/intelligence/forecasts?workspace_id=${encodeURIComponent(workspaceId)}`),
  tradeoffs: (workspaceId: string, limit = 5) =>
    api.get<{ success: true; data: TradeoffDTO[] }>(`/api/v1/intelligence/tradeoffs?workspace_id=${encodeURIComponent(workspaceId)}&limit=${limit}`),
  executiveWeekly: (workspaceId: string) =>
    api.get<{ success: true; data: WeeklyReportDTO }>(`/api/v1/intelligence/executive/weekly?workspace_id=${encodeURIComponent(workspaceId)}`),
  executiveReliability: (workspaceId: string) =>
    api.get<{ success: true; data: ReliabilitySummaryDTO }>(`/api/v1/intelligence/executive/reliability?workspace_id=${encodeURIComponent(workspaceId)}`),
  executiveSecurity: (workspaceId: string) =>
    api.get<{ success: true; data: SecuritySummaryDTO }>(`/api/v1/intelligence/executive/security?workspace_id=${encodeURIComponent(workspaceId)}`),
  executiveCost: (workspaceId: string) =>
    api.get<{ success: true; data: CostSummaryDTO }>(`/api/v1/intelligence/executive/cost?workspace_id=${encodeURIComponent(workspaceId)}`),
  executiveMissionProgress: (workspaceId: string) =>
    api.get<{ success: true; data: MissionProgressDTO }>(`/api/v1/intelligence/executive/mission-progress?workspace_id=${encodeURIComponent(workspaceId)}`),
  divisions: (workspaceId: string) =>
    api.get<{ success: true; data: { divisions: string[]; snapshot: Record<string, DivisionSnapshotDTO> } }>(
      `/api/v1/intelligence/divisions?workspace_id=${encodeURIComponent(workspaceId)}`,
    ),
  crossDivisionBlockers: (workspaceId: string) =>
    api.get<{ success: true; data: CrossDivisionBlockerDTO[] }>(
      `/api/v1/intelligence/divisions-coordination/blockers?workspace_id=${encodeURIComponent(workspaceId)}`,
    ),
  companyMissionStatus: (workspaceId: string) =>
    api.get<{ success: true; data: Array<{ status: string; horizon: string; count: number; avgProgress: number }> }>(
      `/api/v1/intelligence/company/mission-status?workspace_id=${encodeURIComponent(workspaceId)}`,
    ),
  engineeringHealth: (workspaceId: string) =>
    api.get<{ success: true; data: { facts: Record<string, number>; division: DivisionSnapshotDTO } }>(
      `/api/v1/intelligence/company/engineering-health?workspace_id=${encodeURIComponent(workspaceId)}`,
    ),
  operationalEfficiency: (workspaceId: string) =>
    api.get<{ success: true; data: { facts: Record<string, number | null>; division: DivisionSnapshotDTO } }>(
      `/api/v1/intelligence/company/operational-efficiency?workspace_id=${encodeURIComponent(workspaceId)}`,
    ),
  growthOpportunity: (workspaceId: string) =>
    api.get<{ success: true; data: { facts: { highConfidenceResearchFindings: number; featureUseEvents7d: number; distinctFeaturesUsed7d: number; growthKeywordFindings: Array<{ summary: string; sourceUrl: string; confidence: number }> }; division: DivisionSnapshotDTO } }>(
      `/api/v1/intelligence/company/growth-opportunity?workspace_id=${encodeURIComponent(workspaceId)}`,
    ),
  seedOrganizationalAgents: (workspaceId: string) =>
    api.post<{ success: true; data: { created: number; skipped: number } }>(
      `/api/v1/intelligence/company/seed-organizational-agents`, { workspace_id: workspaceId },
    ),
  autoTagMissions: (workspaceId: string) =>
    api.post<{ success: true; data: { scanned: number; updated: number; bindings: Array<{ missionId: string; title: string; added: string[] }> } }>(
      `/api/v1/intelligence/company/auto-tag-missions`, { workspace_id: workspaceId },
    ),
  generateWeeklyBriefing: (workspaceId: string) =>
    api.post<{ success: true; data: WeeklyReportDTO }>(
      `/api/v1/intelligence/company/generate-weekly-briefing`, { workspace_id: workspaceId },
    ),
  forecastsByDivision: (workspaceId: string, division: string) =>
    api.get<{ success: true; data: { division: string; forecasts: ForecastDTO[]; generatedAt: number } }>(
      `/api/v1/intelligence/divisions/${encodeURIComponent(division)}/forecasts?workspace_id=${encodeURIComponent(workspaceId)}`,
    ),
  searchByTag: (workspaceId: string, tag: string) =>
    api.get<{ success: true; data: { tag: string; missions: Array<{ id: string; title: string; horizon: string; status: string; progress: number; tags: string[]; divisions: string[] }> } }>(
      `/api/v1/intelligence/search/by-tag?workspace_id=${encodeURIComponent(workspaceId)}&tag=${encodeURIComponent(tag)}`,
    ),
}

export interface OperatorPreferencesDTO {
  workspaceId: string
  theme: 'dark' | 'light'
  defaultPage: string | null
  maxConcurrentAgents: number | null
  maxResearchPerHour: number | null
  maxImagesPerHour: number | null
  maxAutonomousPatchesPerDay: number | null
  maxDeploymentsPerDay: number | null
  approvalAutoApplyMinConfidence: number
  riskTolerance: 'conservative' | 'balanced' | 'aggressive'
}

export const enhancementsApi = {
  getPreferences: (workspaceId: string) =>
    api.get<{ success: true; data: OperatorPreferencesDTO }>(`/api/v1/x/preferences?workspace_id=${encodeURIComponent(workspaceId)}`),
  setPreferences: (workspaceId: string, patch: Partial<OperatorPreferencesDTO>) =>
    api.post<{ success: true; data: OperatorPreferencesDTO }>(`/api/v1/x/preferences`, { workspace_id: workspaceId, ...patch }),
  actOnRecommendation: (workspaceId: string, recommendationId: string, action: string, outcome?: string) =>
    api.post<{ success: true; data: { eventId: string; recommendationId: string } }>(
      `/api/v1/x/recommendations/${encodeURIComponent(recommendationId)}/act-on`,
      { workspace_id: workspaceId, action, outcome },
    ),
  rewritePrompt: (workspaceId: string, prompt: string, purpose: 'image' | 'research' | 'general' = 'general') =>
    api.post<{ success: true; data: { improved: string; rationale: string[]; modelProvenance: string; cacheHit: boolean } }>(
      `/api/v1/x/rewrite-prompt`, { workspace_id: workspaceId, prompt, purpose },
    ),
  divisionsCsvUrl: (workspaceId: string): string =>
    `${(import.meta as { env?: Record<string, string> }).env?.['VITE_API_URL'] ?? 'http://localhost:3001'}/api/v1/x/export/divisions.csv?workspace_id=${encodeURIComponent(workspaceId)}`,
}

// ─── Image Studio client ────────────────────────────────────────────────────

export interface ImageGenRecord {
  id: string; workspaceId: string
  prompt: string; enhancedPrompt: string | null
  negativePrompt: string | null
  provider: string; model: string | null
  aspectRatio: string | null; width: number | null; height: number | null
  seed: number | null; batchId: string | null
  brandCategory: string | null
  costEstimateUsd: number; actualCostUsd: number | null
  status: 'pending' | 'succeeded' | 'failed' | 'blocked'
  blockedReason: string | null
  imageUrl: string | null
  errorMessage: string | null
  userRating: number | null
  isFavorite: boolean
  qualityScore: number | null
  routerProvenance: string | null
  latencyMs: number | null
  createdAt: number; completedAt: number | null
}

export interface PromptTemplate {
  id: string; workspaceId: string
  name: string; category: string
  brandCategory: string | null
  prompt: string; negativePrompt: string | null
  defaultProvider: string | null; defaultModel: string | null
  defaultAspectRatio: string | null
  tags: string[]; useCount: number
  createdAt: number; updatedAt: number
}

export interface StudioStats {
  today:    { count: number; spendUsd: number }
  week:     { count: number; spendUsd: number }
  failed24h: number; favorites: number
  byProvider: Array<{ provider: string; count: number; spendUsd: number; avgRating: number }>
}

export interface RouterScore {
  provider: string; configured: boolean
  successRate: number; avgLatency: number
  estimate: number; qualityAvg: number; reasons: string[]
}

export const studioApi = {
  generate: (body: {
    workspace_id: string; prompt: string
    negative_prompt?: string; provider?: string; model?: string
    aspect_ratio?: string; width?: number; height?: number; seed?: number
    source_image_url?: string; brand_category?: string
    style_preset?: string; budget_cap_usd?: number; enhance_prompt?: boolean
  }) =>
    api.post<{ success: boolean; data: ImageGenRecord & { router: { provenance: string; reasons: string[]; estimateUsd: number } } }>(`/api/v1/studio/generate`, body),
  batch: (body: { workspace_id: string; prompt: string; count: number; provider?: string; aspect_ratio?: string; base_seed?: number; brand_category?: string; enhance_prompt?: boolean }) =>
    api.post<{ success: true; data: { batchId: string; results: ImageGenRecord[] } }>(`/api/v1/studio/batch`, body),
  rate: (workspaceId: string, id: string, rating: number) =>
    api.post<{ success: true }>(`/api/v1/studio/rate`, { workspace_id: workspaceId, id, rating }),
  favorite: (workspaceId: string, id: string, favorite: boolean) =>
    api.post<{ success: true }>(`/api/v1/studio/favorite`, { workspace_id: workspaceId, id, favorite }),
  history: (workspaceId: string, opts?: { favorites?: boolean; brandCategory?: string; limit?: number }) => {
    const q = new URLSearchParams({ workspace_id: workspaceId })
    if (opts?.favorites)       q.set('favorites', 'true')
    if (opts?.brandCategory)   q.set('brand_category', opts.brandCategory)
    if (opts?.limit !== undefined) q.set('limit', String(opts.limit))
    return api.get<{ success: true; data: ImageGenRecord[] }>(`/api/v1/studio/history?${q.toString()}`)
  },
  routerScores: (workspaceId: string) =>
    api.get<{ success: true; data: { available: string[]; scores: RouterScore[] } }>(`/api/v1/studio/router/scores?workspace_id=${encodeURIComponent(workspaceId)}`),
  templates: (workspaceId: string) =>
    api.get<{ success: true; data: PromptTemplate[] }>(`/api/v1/studio/templates?workspace_id=${encodeURIComponent(workspaceId)}`),
  createTemplate: (body: { workspace_id: string; name: string; prompt: string; brand_category?: string; default_provider?: string; default_aspect_ratio?: string }) =>
    api.post<{ success: true; data: { id: string } }>(`/api/v1/studio/templates`, body),
  useTemplate: (workspaceId: string, id: string) =>
    api.post<{ success: true; data: PromptTemplate }>(`/api/v1/studio/templates/${encodeURIComponent(id)}/use`, { workspace_id: workspaceId }),
  deleteTemplate: (workspaceId: string, id: string) =>
    api.delete<{ success: true }>(`/api/v1/studio/templates/${encodeURIComponent(id)}?workspace_id=${encodeURIComponent(workspaceId)}`),
  stats: (workspaceId: string) =>
    api.get<{ success: true; data: StudioStats }>(`/api/v1/studio/stats?workspace_id=${encodeURIComponent(workspaceId)}`),
}

// ─── Capability Gap Builder client ──────────────────────────────────────────

export interface CapabilityStatusDTO {
  id: string; dimension: string; title: string; description: string
  exists: boolean
  maturity: 'missing' | 'scaffolded' | 'basic' | 'healthy' | 'mature'
  evidence: string[]
  recentEventCount: number
  buildVsBuy: {
    score: number
    verdict: 'build' | 'buy' | 'hybrid' | 'defer'
    rationale: string
    notes: string
  }
}

export interface BuildPlanDTO {
  capabilityId: string; capabilityTitle: string; rationale: string
  buildVsBuy: CapabilityStatusDTO['buildVsBuy']
  architecture: { services: string[]; routes: string[]; tables: string[]; ui: string[]; workers: string[] }
  tasks: Array<{ title: string; description: string; phase: string; category: string; impact: number; risk: number; requiresApproval: boolean; assignedAgent?: string }>
  agentAssignments: Array<{ role: string; agentId: string | null }>
  rolloutPlan: string[]; rollbackPlan: string[]; approvalsRequired: string[]
}

export const capabilityApi = {
  status: (workspaceId: string) =>
    api.get<{ success: true; data: CapabilityStatusDTO[] }>(`/api/v1/capability/status?workspace_id=${encodeURIComponent(workspaceId)}`),
  gaps: (workspaceId: string) =>
    api.get<{ success: true; data: CapabilityStatusDTO[] }>(`/api/v1/capability/gaps?workspace_id=${encodeURIComponent(workspaceId)}`),
  dimensions: (workspaceId: string) =>
    api.get<{ success: true; data: Array<{ dimension: string; total: number; missing: number; scaffolded: number; basic: number; healthy: number; mature: number }> }>(
      `/api/v1/capability/dimensions?workspace_id=${encodeURIComponent(workspaceId)}`),
  plan: (workspaceId: string, capabilityId: string) =>
    api.get<{ success: true; data: BuildPlanDTO }>(`/api/v1/capability/plan/${encodeURIComponent(capabilityId)}?workspace_id=${encodeURIComponent(workspaceId)}`),
  persistPlan: (workspaceId: string, capabilityId: string) =>
    api.post<{ success: true; data: { plan: BuildPlanDTO; persisted: { created: number; skipped: number } } }>(
      `/api/v1/capability/plan/${encodeURIComponent(capabilityId)}/persist`, { workspace_id: workspaceId }),
  planAllGaps: (workspaceId: string) =>
    api.post<{ success: true; data: { planned: BuildPlanDTO[]; totalTasksCreated: number; skipped: Array<{ capabilityId: string; reason: string }> } }>(
      `/api/v1/capability/plan-all-gaps`, { workspace_id: workspaceId }),
}

export interface DivisionSnapshotDTO {
  division:   string
  capturedAt: number
  health:     'thriving' | 'healthy' | 'attention' | 'critical'
  metrics: {
    activeAgents:   number
    activeMissions: number
    openBlockers:   number
    eventsLast24h:  number
  }
  missions: {
    active:    Array<{ id: string; title: string; horizon: string; progress: number }>
    completed: number
    total:     number
  }
  blockers: Array<{ kind: string; title: string; severity?: string; createdAt: number }>
  recommendations: Array<{ id: string; kind: string; title: string; decision: { score: number; bucket: string } }>
  recentReports: Array<{ type: string; at: number; summary: string }>
}

export interface CrossDivisionBlockerDTO {
  from: string
  to:   string[]
  blockerId: string
  kind:      'incident' | 'audit_cluster' | 'pending_approval' | 'failed_workflow'
  title:     string
  severity:  string
  ageDays:   number
}

export interface ForecastDTO {
  type:         string
  factType:     'prediction'
  likelihood:   'low' | 'medium' | 'high' | 'critical' | 'insufficient_data'
  confidence:   number
  horizonWeeks: number
  basis: { historicalSeries: number[]; slopePerWeek: number; projectedValue: number | null; sampleSize: number }
  evidence:     string
}
export interface AllForecastsDTO {
  forecasts: ForecastDTO[]
  generatedAt: number
  summary: { critical: number; high: number; medium: number; low: number; insufficientData: number }
}

export interface TradeoffDTO {
  recommendationId: string
  recommendation:   { id: string; kind: string; title: string; decision: { score: number; bucket: string } }
  expectedBenefit:  { value: number; unit: string; provenance: string; derivedFrom: string }
  expectedRisk:     { value: number; unit: string; provenance: string; derivedFrom: string }
  estimatedCost:    { value: number; unit: string; provenance: string; derivedFrom: string }
  operationalImpact: 'low' | 'medium' | 'high' | 'critical'
  implementationComplexity: { value: number; unit: string; provenance: string; derivedFrom: string }
  rollbackDifficulty:       { value: number; unit: string; provenance: string; derivedFrom: string }
  netScore:         number
}

export interface WeeklyReportDTO {
  workspaceId: string; composedAt: number; windowStart: number; windowEnd: number
  facts: {
    week:      Record<string, number>
    priorWeek: Record<string, number>
    deltas:    Record<string, number>
  }
  predictions: { forecasts: ForecastDTO[] }
}

export interface ReliabilitySummaryDTO {
  facts: {
    openIncidents: number; openCriticalIncidents: number
    failedWorkflows24h: number; rollbacks24h: number
  }
  predictions: { runtimeBottleneck: ForecastDTO | null; deploymentInstability: ForecastDTO | null }
}

export interface SecuritySummaryDTO {
  facts: {
    securityAuditFindings: number; criticalSecurityFindings: number
    governanceBlocks7d:    number; patchesBlocked7d:         number
  }
  predictions: { securityRiskGrowing: ForecastDTO | null }
}

export interface CostSummaryDTO {
  facts: {
    dailyBudget:   { limitUsd: number; spentUsd: number; pctUsed: number } | null
    monthlyBudget: { limitUsd: number; spentUsd: number; pctUsed: number } | null
    imageSpend24h: { spendUsd: number; count: number }
    imageSpend7d:  { spendUsd: number; count: number }
  }
  predictions: { budgetOverrun: ForecastDTO | null }
}

export interface MissionProgressDTO {
  facts: {
    counts: { active: number; completed: number; paused: number }
    activeMissions: Array<{ id: string; title: string; horizon: string; progress: number; targetDate: number | null }>
    atRisk: Array<{ id: string; title: string; progress: number; daysUntilTarget: number | null }>
    unresolvedRisks:      Array<{ source: string; id: string; title: string; severity: string; ageDays: number }>
    recurringBottlenecks: Array<{ signature: string; type: string; occurrences: number }>
  }
}

export interface ContinuitySnapshotDTO {
  workspaceId: string
  capturedAt:  number
  previousIncidents: Array<{ id: string; title: string; severity: string; status: string; ageDays: number }>
  previousFixes:     Array<{ signature: string; description: string; appliedCount: number; lastAppliedAt: number | null }>
  previousFailures:  Array<{ signature: string; type: string; occurrences: number; blocked: boolean; lastSeenAt: number | null }>
  operatorDecisions: {
    patchApprovals: { approved: number; rejected: number; pending: number; approvalRate: number | null }
    feedbackByKind: Record<string, number>
  }
  unresolvedRisks:      Array<{ source: string; id: string; title: string; severity: string; ageDays: number }>
  recurringBottlenecks: Array<{ signature: string; type: string; occurrences: number }>
  lessonsLearned:       Array<{ pattern: string; fix: string; provenAppliedCount: number }>
}

export interface TrendBucketDTO {
  weekStart: number
  weekEnd:   number
  weekLabel: string
  metrics:   Record<string, number>
}
export interface TrendSeriesDTO {
  series:    TrendBucketDTO[]
  direction: 'improving' | 'degrading' | 'flat' | 'insufficient_data'
  delta:     number | null
  note:      string
}
export interface AllTrendsDTO {
  reliability:     TrendSeriesDTO
  providerQuality: TrendSeriesDTO
  cost:            TrendSeriesDTO
  incident:        TrendSeriesDTO
  deployment:      TrendSeriesDTO
  productivity:    TrendSeriesDTO
  generatedAt:     number
}

export interface RankedMemoryItemDTO {
  kind:           'successful_fix' | 'failure_pattern'
  id:             string
  text:           string
  reinforcement:  number
  ageDays:        number
  decayWeight:    number
  relevanceScore: number
  matchedTags?:   string[]
}

// ─── SSE stream helper ────────────────────────────────────────────────────────

export function createEventStream(
  workspaceId: string,
  onEvent: (type: string, data: unknown) => void,
  onError?: (err: Event) => void,
): () => void {
  const BASE = (import.meta as { env?: Record<string, string> }).env?.['VITE_API_URL'] ?? 'http://localhost:3001'
  const url = `${BASE}/api/v1/stream`
  const es = new EventSource(url)

  es.addEventListener('event', (e: MessageEvent<string>) => {
    try { onEvent('event', JSON.parse(e.data) as unknown) } catch { /* ignore */ }
  })
  es.addEventListener('connected', (e: MessageEvent<string>) => {
    try { onEvent('connected', JSON.parse(e.data) as unknown) } catch { /* ignore */ }
  })
  if (onError) es.onerror = onError

  return () => es.close()
}
