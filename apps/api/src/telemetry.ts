/**
 * OpenTelemetry instrumentation — gated by OTEL_EXPORTER_OTLP_ENDPOINT.
 *
 * Only loads the SDK when an OTLP endpoint is configured. Without one,
 * the import does nothing — avoids tsx/ESM loader friction with the
 * OpenTelemetry CJS deep require chain in production.
 *
 * To enable: set OTEL_EXPORTER_OTLP_ENDPOINT in env.
 */
const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT']

if (endpoint) {
  try {
    // Dynamic import — keeps the CJS chain out of cold-boot when telemetry is off
    const { NodeSDK }                       = await import('@opentelemetry/sdk-node')
    const { getNodeAutoInstrumentations }   = await import('@opentelemetry/auto-instrumentations-node')
    const { OTLPTraceExporter }             = await import('@opentelemetry/exporter-trace-otlp-http')
    const { Resource }                      = await import('@opentelemetry/resources')
    const semconv                            = await import('@opentelemetry/semantic-conventions')
    const ATTR_SERVICE_NAME    = semconv.ATTR_SERVICE_NAME    ?? 'service.name'
    const ATTR_SERVICE_VERSION = semconv.ATTR_SERVICE_VERSION ?? 'service.version'

    const service  = process.env['OTEL_SERVICE_NAME'] ?? 'novan-api'

    const sdk = new NodeSDK({
      resource: new Resource({
        [ATTR_SERVICE_NAME]:    service,
        [ATTR_SERVICE_VERSION]: '0.1.0',
        environment:            process.env['NODE_ENV'] ?? 'development',
      }),
      traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      instrumentations: [
        getNodeAutoInstrumentations({
          '@opentelemetry/instrumentation-fs': { enabled: false },
        }),
      ],
    })

    sdk.start()
    process.on('SIGTERM', () => sdk.shutdown().catch(() => null))
    // eslint-disable-next-line no-console
    console.log(`[telemetry] OpenTelemetry started → ${endpoint}`)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[telemetry] failed to start (non-fatal):', (err as Error).message)
  }
} else {
  // eslint-disable-next-line no-console
  console.log('[telemetry] disabled (no OTEL_EXPORTER_OTLP_ENDPOINT)')
}

export {}
