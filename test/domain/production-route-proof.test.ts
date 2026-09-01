import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PRODUCTION_ROUTE_URL } from '../../scripts/production-release/contracts.ts'
import { proveProductionRoute } from '../../scripts/production-release/route-proof.ts'

const CANDIDATE = 'a'.repeat(40)
const EDGE_VERSION = 'edge-version-1'
const CORE_VERSION = 'core-version-1'
const HTML = '<!doctype html><html lang="en"><body>closed</body></html>'

test('Injected fetch proves the exact HTML route headers and emits body metadata only', async () => {
  const observed: Request[] = []
  const proof = await proveProductionRoute({
    candidateSha: CANDIDATE,
    edgeVersionId: EDGE_VERSION,
    coreVersionId: CORE_VERSION,
    fetch: async (request) => {
      observed.push(request)
      return routeResponse()
    },
  })
  const request = observed[0]
  assert.ok(request)
  assert.equal(request.url, PRODUCTION_ROUTE_URL)
  assert.equal(request.method, 'GET')
  assert.equal(request.headers.get('authorization'), null)
  assert.equal(proof.readiness, 'ready')
  assert.match(proof.bodySha256, /^[0-9a-f]{64}$/u)
  assert.doesNotMatch(JSON.stringify(proof), /<body>/u)
})

test('Route proof rejects stale identity headers, redirects, scripts, and oversized bodies', async () => {
  await assert.rejects(() => proveProductionRoute({
    candidateSha: CANDIDATE,
    edgeVersionId: EDGE_VERSION,
    coreVersionId: CORE_VERSION,
    fetch: async () => routeResponse({ candidate: 'b'.repeat(40) }),
  }), /header_candidate_invalid/u)
  await assert.rejects(() => proveProductionRoute({
    candidateSha: CANDIDATE,
    edgeVersionId: EDGE_VERSION,
    coreVersionId: CORE_VERSION,
    fetch: async () => routeResponse({ redirected: true }),
  }), /response_route_mismatch/u)
  await assert.rejects(() => proveProductionRoute({
    candidateSha: CANDIDATE,
    edgeVersionId: EDGE_VERSION,
    coreVersionId: CORE_VERSION,
    fetch: async () => routeResponse({ body: '<!doctype html><html><script></script></html>' }),
  }), /script_authority_present/u)
  await assert.rejects(() => proveProductionRoute({
    candidateSha: CANDIDATE,
    edgeVersionId: EDGE_VERSION,
    coreVersionId: CORE_VERSION,
    fetch: async () => routeResponse({ contentLength: '500001' }),
  }), /content_length_invalid/u)
})

function routeResponse(options: Readonly<{
  candidate?: string
  body?: string
  redirected?: boolean
  contentLength?: string
}> = {}): Response {
  const body = options.body ?? HTML
  const response = new Response(body, {
    status: 200,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
      'x-commerce-live-readiness-contract': 'commerce.edge-route-live-readiness/v1',
      'x-commerce-live-readiness': 'ready',
      'x-commerce-live-readiness-reason': 'none',
      'x-commerce-release-candidate': options.candidate ?? CANDIDATE,
      'x-commerce-edge-version-id': EDGE_VERSION,
      'x-commerce-core-version-id': CORE_VERSION,
      ...(options.contentLength ? { 'content-length': options.contentLength } : {}),
    },
  })
  setResponseIdentity(response, PRODUCTION_ROUTE_URL, options.redirected ?? false)
  return response
}

function setResponseIdentity(response: Response, url: string, redirected: boolean): void {
  Object.defineProperty(response, 'url', { configurable: true, value: url })
  Object.defineProperty(response, 'redirected', { configurable: true, value: redirected })
}
