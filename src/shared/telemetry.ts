import { metrics, trace, Tracer } from '@opentelemetry/api'
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  ConsoleMetricExporter,
} from '@opentelemetry/sdk-metrics'
import { NodeTracerProvider, SimpleSpanProcessor, ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node'
import { Resource } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import { config } from './config'

let started = false

/**
 * Traces and metrics both go to the console: this is a demo project with no
 * collector to ship to. Swapping the exporters is the only change needed to
 * point it at a real backend.
 */
export function startTelemetry(): void {
  if (started) {
    return
  }
  started = true

  const resource = new Resource({ [ATTR_SERVICE_NAME]: config.serviceName })

  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
  })
  tracerProvider.register()

  metrics.setGlobalMeterProvider(
    new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: new ConsoleMetricExporter(),
          exportIntervalMillis: 60_000,
        }),
      ],
    }),
  )
}

export function tracer(): Tracer {
  return trace.getTracer(config.serviceName)
}

const meter = () => metrics.getMeter(config.serviceName)

/** Metrics are created lazily so importing this module has no side effects. */
export const telemetry = {
  blockchainRequestDuration: () =>
    meter().createHistogram('blockchain.request.duration', {
      description: 'Blockchain API response time',
      unit: 'ms',
    }),
  apiRequestDuration: () =>
    meter().createHistogram('api.request.duration', {
      description: 'GraphQL request handling time',
      unit: 'ms',
    }),
  blocksIngested: () =>
    meter().createCounter('worker.blocks.ingested', {
      description: 'Blocks written to the database',
    }),
  tickDuration: () =>
    meter().createHistogram('worker.tick.duration', {
      description: 'Time taken by a full worker tick',
      unit: 'ms',
    }),
}

/** Structured logging with a shared namespace, so worker and API lines correlate. */
type LogFields = Record<string, unknown>

function emit(level: 'info' | 'warn' | 'error', module: string, message: string, fields?: LogFields): void {
  const line = JSON.stringify({
    level,
    service: config.serviceName,
    module,
    message,
    ...fields,
  })
  if (level === 'error') {
    console.error(line)
  } else if (level === 'warn') {
    console.warn(line)
  } else {
    console.log(line)
  }
}

export function createLogger(module: string) {
  return {
    info: (message: string, fields?: LogFields) => emit('info', module, message, fields),
    warn: (message: string, fields?: LogFields) => emit('warn', module, message, fields),
    error: (message: string, fields?: LogFields) => emit('error', module, message, fields),
  }
}

export type Logger = ReturnType<typeof createLogger>
