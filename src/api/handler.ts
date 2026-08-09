import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { createLogger, startTelemetry, telemetry } from '../shared/telemetry'
import { yoga } from './yoga'

const log = createLogger('api')

function toHeaders(headers: APIGatewayProxyEventV2['headers']): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      result[key] = value
    }
  }
  return result
}

/**
 * Adapts API Gateway v2 events onto Yoga's fetch interface. Node 20 provides
 * Request/Response globally, so no polyfill is needed.
 */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  startTelemetry()
  const startedAt = Date.now()

  const method = event.requestContext.http.method
  const url = new URL(
    event.rawPath + (event.rawQueryString ? `?${event.rawQueryString}` : ''),
    `https://${event.requestContext.domainName ?? 'localhost'}`,
  )

  const hasBody = method !== 'GET' && method !== 'HEAD' && event.body !== undefined
  const body = hasBody && event.isBase64Encoded ? Buffer.from(event.body!, 'base64').toString() : event.body

  try {
    const response = await yoga.fetch(url, {
      method,
      headers: toHeaders(event.headers),
      body: hasBody ? body : undefined,
    })

    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      headers[key] = value
    })

    const duration = Date.now() - startedAt
    telemetry.apiRequestDuration().record(duration, { 'http.response.status_code': response.status })

    return { statusCode: response.status, headers, body: await response.text() }
  } catch (error) {
    log.error('request failed', { path: event.rawPath, error: (error as Error).message })
    throw error
  }
}
