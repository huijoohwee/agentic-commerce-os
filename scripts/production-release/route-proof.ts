import { fileURLToPath } from 'node:url'

import { sha256 } from '../evidence-integrity.ts'
import {
  PRODUCTION_ROUTE_PROOF_SCHEMA,
  PRODUCTION_ROUTE_URL,
} from './contracts.ts'

const CANDIDATE_PATTERN = /^[0-9a-f]{40}$/u
const VERSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u
const MAXIMUM_BODY_BYTES = 500_000
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
  edgeVersionId: string
  coreVersionId: string
  status: 200
  contentType: 'text/html; charset=utf-8'
  readinessContract: typeof ROUTE_READINESS_CONTRACT
  readiness: 'ready'
  readinessReason: 'none'
  bodyBytes: number
  bodySha256: string
}>

export async function proveProductionRoute(input: Readonly<{
  candidateSha: string
  edgeVersionId: string
  coreVersionId: string
  fetch: ProductionRouteFetch
}>): Promise<ProductionRouteProof> {
  requireContract(CANDIDATE_PATTERN.test(input.candidateSha), 'candidate_sha_invalid')
  requireContract(VERSION_ID_PATTERN.test(input.edgeVersionId), 'edge_version_id_invalid')
  requireContract(VERSION_ID_PATTERN.test(input.coreVersionId), 'core_version_id_invalid')
  const request = new Request(PRODUCTION_ROUTE_URL, {
    method: 'GET',
    headers: { accept: 'text/html' },
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
  })
  const response = await input.fetch(request)
  requireContract(response.status === 200, 'http_status_invalid')
  requireContract(!response.redirected && response.url === PRODUCTION_ROUTE_URL, 'response_route_mismatch')
  for (const [name, expected] of Object.entries(EXPECTED_STATIC_HEADERS)) {
    requireContract(response.headers.get(name) === expected, `header_${name.replaceAll('-', '_')}_invalid`)
  }
  requireContract(response.headers.get('x-commerce-release-candidate') === input.candidateSha,
    'header_candidate_invalid')
  requireContract(response.headers.get('x-commerce-edge-version-id') === input.edgeVersionId,
    'header_edge_version_invalid')
  requireContract(response.headers.get('x-commerce-core-version-id') === input.coreVersionId,
    'header_core_version_invalid')
  const body = await readBoundedBody(response, MAXIMUM_BODY_BYTES)
  const html = new TextDecoder('utf-8', { fatal: true }).decode(body)
  requireContract(/^\s*<!doctype html>\s*<html\b/iu.test(html), 'html_document_invalid')
  requireContract(!/<script\b/iu.test(html), 'delivery_route_script_authority_present')
  return Object.freeze({
    schema: PRODUCTION_ROUTE_PROOF_SCHEMA,
    routeUrl: PRODUCTION_ROUTE_URL,
    candidateSha: input.candidateSha,
    edgeVersionId: input.edgeVersionId,
    coreVersionId: input.coreVersionId,
    status: 200,
    contentType: 'text/html; charset=utf-8',
    readinessContract: ROUTE_READINESS_CONTRACT,
    readiness: 'ready',
    readinessReason: 'none',
    bodyBytes: body.byteLength,
    bodySha256: sha256(body),
  })
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
  const [command, candidateArgument, edgeArgument, coreArgument, ...extra] = process.argv.slice(2)
  if (command !== 'probe' || extra.length > 0) {
    throw new Error('usage: route-proof.ts probe [candidate-sha edge-version-id core-version-id]')
  }
  const candidateSha = exactInput(candidateArgument, 'CANDIDATE_SHA')
  const edgeVersionId = exactInput(edgeArgument, 'EDGE_VERSION_ID')
  const coreVersionId = exactInput(coreArgument, 'CORE_VERSION_ID')
  const proof = await proveProductionRoute({
    candidateSha,
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
