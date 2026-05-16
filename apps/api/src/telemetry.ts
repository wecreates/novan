/**
 * OpenTelemetry instrumentation — must be imported BEFORE any other module.
 *
 * Instruments: HTTP, Fastify, PostgreSQL, Redis, BullMQ
 */
import { NodeSDK }              from '@opentelemetry/sdk-node'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { OTLPTraceExporter }    from '@opentelemetry/exporter-trace-otlp-http'
import { Resource }             from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'

const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4318'
const service  = process.env['OTEL_SERVICE_NAME'] ?? 'ops-platform-api'

const sdk = new NodeSDK({
  resource: new Resource({
    [ATTR_SERVICE_NAME]:    service,
    [ATTR_SERVICE_VERSION]: '0.1.0',
    environment:            process.env['NODE_ENV'] ?? 'development',
  }),
  traceExporter: new OTLPTraceExporter({
    url: `${endpoint}/v1/traces`,
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
})

try {
  sdk.start()
} catch (err) {
  // Non-fatal: app runs without telemetry if OTEL collector unavailable
  console.warn('OpenTelemetry failed to start:', err)
}
