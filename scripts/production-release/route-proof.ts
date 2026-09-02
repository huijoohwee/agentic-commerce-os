import { fileURLToPath } from 'node:url'

import { sha256 } from '../evidence-integrity.ts'
import {
  PRODUCTION_ROUTE_PROOF_SCHEMA,
  PRODUCTION_ROUTE_URL,
} from './contracts.ts'

const CANDIDATE_PATTERN = /^[0-9a-f]{40}$/u
const CANDIDATE_DIGEST_PATTERN = /^[0-9a-f]{64}$/u
const VERSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u
const MAXIMUM_BODY_BYTES = 500_000
const MAXIMUM_JSON_BYTES = 1_000_000
const ROUTE_READINESS_CONTRACT = 'commerce.edge-route-live-readiness/v1'

const EXPECTED_STATIC_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-type': 'text/html; charset=utf-8',
  'x-commerce-live-readiness-contract': ROUTE_READINESS_CONTRACT,
  'x-commerce-live-readiness': 'ready',
  'x-commerce-live-readiness-reason': 'none',
})

export type ProductionRouteFetch = (request: Request) => Promise<Response>

export type ProductionRouteProof = Readonly<{
  schema: typeof PRODUCTION_ROUTE_PROOF_SCHEMA
  routeUrl: typeof PRODUCTION_ROUTE_URL
  candidateSha: string
  candidateDigest: string
  edgeVersionId: string
  coreVersionId: string
  status: 200
  contentType: 'text/html; charset=utf-8'
  readinessContract: typeof ROUTE_READINESS_CONTRACT
  readiness: 'ready'
  readinessReason: 'none'
  bodyBytes: number
  bodySha256: string
  behavior: Readonly<{
    asset: Readonly<{ status: 200; bodyBytes: number; bodySha256: string }>
    publicCatalog: Readonly<{ status: 200; bodySha256: string }>
    sessionBoundary: Readonly<{ status: 403; code: 'storefront_session_refused'; bodySha256: string }>
    checkoutBoundary: Readonly<{ status: 401; code: 'storefront_session_invalid'; bodySha256: string }>
    mcpBoundary: Readonly<{ status: 401; jsonRpcCode: -32_001; bodySha256: string }>
  }>
}>

export async function proveProductionRoute(input: Readonly<{
  candidateSha: string
  candidateDigest: string
  edgeVersionId: string
  coreVersionId: string
  fetch: ProductionRouteFetch
}>): Promise<ProductionRouteProof> {
  requireContract(CANDIDATE_PATTERN.test(input.candidateSha), 'candidate_sha_invalid')
  requireContract(CANDIDATE_DIGEST_PATTERN.test(input.candidateDigest), 'candidate_digest_invalid')
  requireContract(VERSION_ID_PATTERN.test(input.edgeVersionId), 'edge_version_id_invalid')
  requireContract(VERSION_ID_PATTERN.test(input.coreVersionId), 'core_version_id_invalid')
  const request = new Request(PRODUCTION_ROUTE_URL, {
    method: 'GET',
    headers: { accept: 'text/html' },
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
  })
  const response = await exactFetch(input.fetch, request)
  requireContract(response.status === 200, 'http_status_invalid')
  requireContract(!response.redirected && response.url === PRODUCTION_ROUTE_URL, 'response_route_mismatch')
  for (const [name, expected] of Object.entries(EXPECTED_STATIC_HEADERS)) {
    requireContract(response.headers.get(name) === expected, `header_${name.replaceAll('-', '_')}_invalid`)
  }
  requireContract(response.headers.get('x-commerce-release-candidate') === input.candidateSha,
    'header_candidate_invalid')
  requireContract(response.headers.get('x-commerce-release-candidate-digest') === input.candidateDigest,
    'header_candidate_digest_invalid')
  requireContract(response.headers.get('x-commerce-edge-version-id') === input.edgeVersionId,
    'header_edge_version_invalid')
  requireContract(response.headers.get('x-commerce-core-version-id') === input.coreVersionId,
    'header_core_version_invalid')
  const body = await readBoundedBody(response, MAXIMUM_BODY_BYTES)
  const html = new TextDecoder('utf-8', { fatal: true }).decode(body)
  requireContract(/^\s*<!doctype html>\s*<html\b/iu.test(html), 'html_document_invalid')
  requireContract(/<script\b[^>]*src="\/agentic-commerce-os\/assets\/storefront\.js"/iu.test(html),
    'storefront_script_missing')
  requireContract(html.includes('name="ag-runtime-base-path" content="/agentic-commerce-os"'),
    'storefront_base_path_missing')
  const behavior = await proveRuntimeBehavior(input.fetch)
  return Object.freeze({
    schema: PRODUCTION_ROUTE_PROOF_SCHEMA,
    routeUrl: PRODUCTION_ROUTE_URL,
    candidateSha: input.candidateSha,
    candidateDigest: input.candidateDigest,
    edgeVersionId: input.edgeVersionId,
    coreVersionId: input.coreVersionId,
    status: 200,
    contentType: 'text/html; charset=utf-8',
    readinessContract: ROUTE_READINESS_CONTRACT,
    readiness: 'ready',
    readinessReason: 'none',
    bodyBytes: body.byteLength,
    bodySha256: sha256(body),
    behavior,
  })
}

async function proveRuntimeBehavior(fetcher: ProductionRouteFetch): Promise<ProductionRouteProof['behavior']> {
  const assetResponse = await exactFetch(fetcher, routeRequest('assets/storefront.js', { accept: 'text/javascript' }))
  requireContract(assetResponse.status === 200
    && assetResponse.headers.get('content-type') === 'text/javascript; charset=utf-8', 'asset_response_invalid')
  const asset = await readBoundedBody(assetResponse, MAXIMUM_BODY_BYTES)
  const javascript = new TextDecoder('utf-8', { fatal: true }).decode(asset)
  requireContract(javascript.includes('ag-runtime-base-path') && javascript.includes("runtimePath('/v1/session')"),
    'asset_prefix_runtime_invalid')

  const catalogResponse = await exactFetch(fetcher, routeRequest('v1/public/agents?limit=1', {
    accept: 'application/json',
  }))
  requireContract(catalogResponse.status === 200, 'public_catalog_status_invalid')
  const catalog = await readJson(catalogResponse, MAXIMUM_JSON_BYTES, 'public_catalog')
  validatePublicCatalog(catalog)

  const sessionResponse = await exactFetch(fetcher, routeRequest('v1/session', {
    accept: 'application/json', 'content-type': 'application/json',
  }, { method: 'POST', body: JSON.stringify({ purpose: 'storefront-checkout-preparation' }) }))
  const sessionBody = await readJson(sessionResponse, 65_536, 'session_boundary')
  exactFailure(sessionResponse.status, sessionBody, 403, 'storefront_session_refused', 'session_boundary')

  const checkoutResponse = await exactFetch(fetcher, routeRequest('v1/checkouts/release-probe/prepare', {
    accept: 'application/json', 'content-type': 'application/json',
  }, { method: 'POST', body: JSON.stringify({ checkoutId: 'release-probe' }) }))
  const checkoutBody = await readJson(checkoutResponse, 65_536, 'checkout_boundary')
  exactFailure(checkoutResponse.status, checkoutBody, 401, 'storefront_session_invalid', 'checkout_boundary')

  const mcpResponse = await exactFetch(fetcher, routeRequest('mcp', {
    accept: 'application/json', 'content-type': 'application/json', 'mcp-protocol-version': '2025-06-18',
  }, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) }))
  const mcpBody = await readJson(mcpResponse, 65_536, 'mcp_boundary')
  validateMcpBoundary(mcpResponse.status, mcpBody)
  return Object.freeze({
    asset: Object.freeze({ status: 200, bodyBytes: asset.byteLength, bodySha256: sha256(asset) }),
    publicCatalog: Object.freeze({ status: 200, bodySha256: sha256Json(catalog) }),
    sessionBoundary: Object.freeze({
      status: 403, code: 'storefront_session_refused', bodySha256: sha256Json(sessionBody),
    }),
    checkoutBoundary: Object.freeze({
      status: 401, code: 'storefront_session_invalid', bodySha256: sha256Json(checkoutBody),
    }),
    mcpBoundary: Object.freeze({ status: 401, jsonRpcCode: -32_001, bodySha256: sha256Json(mcpBody) }),
  })
}

function routeRequest(path: string, headers: Record<string, string>, init: RequestInit = {}): Request {
  return new Request(new URL(path, PRODUCTION_ROUTE_URL), {
    ...init, headers, cache: 'no-store', credentials: 'omit', redirect: 'error',
  })
}

async function exactFetch(fetcher: ProductionRouteFetch, request: Request): Promise<Response> {
  const response = await fetcher(request)
  requireContract(!response.redirected && response.url === request.url, 'response_route_mismatch')
  return response
}

async function readJson(response: Response, limit: number, code: string): Promise<Record<string, unknown>> {
  requireContract(response.headers.get('content-type')?.startsWith('application/json') === true,
    `${code}_content_type_invalid`)
  const bytes = await readBoundedBody(response, limit)
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    requireContract(isRecord(value), `${code}_json_invalid`)
    return value
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('production_route_proof:')) throw error
    throw new Error(`production_route_proof:${code}_json_invalid`)
  }
}

function validatePublicCatalog(value: Record<string, unknown>): void {
  exactKeys(value, ['agents', 'digest', 'ok', 'revision'], 'public_catalog_shape_invalid')
  requireContract(value.ok === true && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0
    && typeof value.digest === 'string' && /^[0-9a-f]{64}$/u.test(value.digest)
    && Array.isArray(value.agents) && value.agents.length <= 10_000, 'public_catalog_identity_invalid')
  for (const entry of value.agents) {
    requireContract(isRecord(entry), 'public_catalog_agent_invalid')
    exactKeys(entry, ['agentId', 'declaredCapabilities', 'declaredCategory', 'trustStatus'],
      'public_catalog_agent_shape_invalid')
    requireContract(typeof entry.agentId === 'string' && typeof entry.declaredCategory === 'string'
      && entry.trustStatus === 'declared-and-present' && Array.isArray(entry.declaredCapabilities)
      && entry.declaredCapabilities.every((capability) => typeof capability === 'string'),
    'public_catalog_agent_identity_invalid')
  }
}

function exactFailure(
  status: number,
  body: Record<string, unknown>,
  expectedStatus: number,
  code: string,
  label: string,
): void {
  exactKeys(body, ['code', 'ok'], `${label}_shape_invalid`)
  requireContract(status === expectedStatus && body.ok === false && body.code === code, `${label}_invalid`)
}

function validateMcpBoundary(status: number, body: Record<string, unknown>): void {
  exactKeys(body, ['error', 'id', 'jsonrpc'], 'mcp_boundary_shape_invalid')
  requireContract(status === 401 && body.jsonrpc === '2.0' && body.id === null && isRecord(body.error),
    'mcp_boundary_invalid')
  const error = body.error as Record<string, unknown>
  exactKeys(error, ['code', 'message'], 'mcp_boundary_error_shape_invalid')
  requireContract(error.code === -32_001 && error.message === 'Unauthorized', 'mcp_boundary_error_invalid')
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], code: string): void {
  requireContract(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()), code)
}

function sha256Json(value: unknown): string {
  return sha256(JSON.stringify(value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    requireContract(/^\d+$/u.test(declared) && Number.isSafeInteger(Number(declared))
      && Number(declared) > 0 && Number(declared) <= maximumBytes, 'content_length_invalid')
  }
  requireContract(response.body !== null, 'html_body_missing')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > maximumBytes) {
        await reader.cancel('production route body exceeded bound')
        throw new Error('production_route_proof:html_body_too_large')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  requireContract(length > 0, 'html_body_empty')
  if (declared !== null) requireContract(length === Number(declared), 'content_length_mismatch')
  const body = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function requireContract(condition: boolean, code: string): asserts condition {
  if (!condition) throw new Error(`production_route_proof:${code}`)
}

function exactInput(argument: string | undefined, environmentName: string): string {
  const environment = process.env[environmentName]
  if (argument !== undefined && environment !== undefined && argument !== environment) {
    throw new Error(`production_route_proof:${environmentName.toLowerCase()}_conflict`)
  }
  const value = argument ?? environment
  if (!value) throw new Error(`production_route_proof:${environmentName.toLowerCase()}_missing`)
  return value
}

async function main(): Promise<void> {
  const [command, candidateArgument, digestArgument, edgeArgument, coreArgument, ...extra] = process.argv.slice(2)
  if (command !== 'probe' || extra.length > 0) {
    throw new Error('usage: route-proof.ts probe [candidate-sha candidate-digest edge-version-id core-version-id]')
  }
  const candidateSha = exactInput(candidateArgument, 'CANDIDATE_SHA')
  const candidateDigest = exactInput(digestArgument, 'CANDIDATE_DIGEST')
  const edgeVersionId = exactInput(edgeArgument, 'EDGE_VERSION_ID')
  const coreVersionId = exactInput(coreArgument, 'CORE_VERSION_ID')
  const proof = await proveProductionRoute({
    candidateSha,
    candidateDigest,
    edgeVersionId,
    coreVersionId,
    fetch: async (request) => fetch(new Request(request, { signal: AbortSignal.timeout(30_000) })),
  })
  process.stdout.write(`${JSON.stringify(proof)}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'production_route_proof:unknown_error'}\n`)
    process.exitCode = 1
  })
}
