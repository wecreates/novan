/**
 * Trace ID generation and distributed trace context.
 * Provides correlation/causation IDs for cross-service observability.
 * Pure — no external dependencies.
 */

/** Generate a new trace ID (prefixed, no-dash UUID). */
export function generateTraceId(prefix = 'tr'): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`
}

/** Generate a correlation ID for grouping related causally-linked events. */
export function generateCorrelationId(): string {
  return `corr_${crypto.randomUUID().replace(/-/g, '')}`
}

/** Generate a causation ID linking cause → effect. */
export function generateCausationId(): string {
  return `cause_${crypto.randomUUID().replace(/-/g, '')}`
}

export interface TraceContext {
  traceId:        string
  correlationId:  string
  causationId?:   string
  source:         string
  workspaceId:    string
  parentTraceId?: string
}

/** Create a new trace context, optionally inheriting correlation from a parent. */
export function createTraceContext(
  source:      string,
  workspaceId: string,
  parent?:     Pick<TraceContext, 'traceId' | 'correlationId'>,
): TraceContext {
  return {
    traceId:       generateTraceId(),
    correlationId: parent?.correlationId ?? generateCorrelationId(),
    source,
    workspaceId,
    ...(parent?.traceId !== undefined ? { causationId: parent.traceId, parentTraceId: parent.traceId } : {}),
  }
}

/** Extract trace fields from generic job/event data. */
export function extractTraceContext(data: Record<string, unknown>): Partial<TraceContext> {
  return {
    ...(typeof data['traceId']       === 'string' ? { traceId:       data['traceId']       } : {}),
    ...(typeof data['correlationId'] === 'string' ? { correlationId: data['correlationId'] } : {}),
    ...(typeof data['causationId']   === 'string' ? { causationId:   data['causationId']   } : {}),
    ...(typeof data['workspaceId']   === 'string' ? { workspaceId:   data['workspaceId']   } : {}),
  }
}
