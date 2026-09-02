import { isHttpFailure, isRecord, jsonResponse, readJsonResponse } from '../shared/http.js'

const MAXIMUM_PROVIDER_RESPONSE_BYTES = 1_000_000
const DEPENDENCY_REQUEST_TIMEOUT_MS = 10_000

export function respond(value: unknown, requestId: string, status = 200): Response {
  const response = jsonResponse({ requestId, ...asResponseRecord(value) }, status)
  response.headers.set('x-request-id', requestId)
  return response
}

export function reject(code: string, detail: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return Object.freeze({ ok: false, code, ...detail })
}

export function resultOk(value: unknown): boolean {
  return isRecord(value) && value.ok === true
}

export async function proxyJson(
  binding: Fetcher,
  path: string,
  requestId: string,
  expectedContract: string,
): Promise<Response> {
  const response = await binding.fetch(new Request(new URL(path, 'https://dependency.internal'), {
    method: 'GET', signal: AbortSignal.timeout(DEPENDENCY_REQUEST_TIMEOUT_MS),
  }))
  const payload = await readProviderResponse(response)
  return isRecord(payload) && payload.contract === expectedContract
    ? respond(payload, requestId, response.status)
    : respond(reject('provider_contract_mismatch'), requestId, 502)
}

export async function readProviderResponse(response: Response): Promise<unknown> {
  const payload = await readJsonResponse(response, MAXIMUM_PROVIDER_RESPONSE_BYTES)
  return isHttpFailure(payload) ? reject(payload.code) : payload
}

export function classifyError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown_error'
  if (error.message.includes('pin')) return 'dependency_pin_mismatch'
  if (error.message.includes('catalog')) return 'invocation_catalog_unavailable'
  if (error.message.includes('MCP')) return 'mcp_dependency_unavailable'
  return 'dependency_unavailable'
}

function asResponseRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { ok: false, code: 'invalid_internal_result' }
}
