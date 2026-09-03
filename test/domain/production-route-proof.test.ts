import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PRODUCTION_ROUTE_URL } from '../../scripts/production-release/contracts.ts'
import { proveProductionRoute } from '../../scripts/production-release/route-proof.ts'

const CANDIDATE = 'a'.repeat(40)
const CANDIDATE_DIGEST = 'c'.repeat(64)
const EDGE_VERSION = 'edge-version-1'
const CORE_VERSION = 'core-version-1'
const HTML = '<!doctype html><html><head><meta name="ag-runtime-base-path" content="/agentic-commerce-os"></head><body><script type="module" src="/agentic-commerce-os/assets/storefront.js"></script></body></html>'
const ASSET = "const base=document.querySelector('meta[name=\"ag-runtime-base-path\"]'); runtimePath('/v1/session');"

test('Injected fetch proves storefront, asset, catalog, session, checkout, and MCP boundaries', async () => {
  const observed: Request[] = []
  const proof = await proveProductionRoute({
    candidateSha: CANDIDATE,
    candidateDigest: CANDIDATE_DIGEST,
    edgeVersionId: EDGE_VERSION,
    coreVersionId: CORE_VERSION,
    fetch: async (request) => {
      observed.push(request)
      return routeResponse(request)
    },
  })
  assert.deepEqual(observed.map(({ method, url }) => [method, url]), [
    ['GET', PRODUCTION_ROUTE_URL],
    ['GET', `${PRODUCTION_ROUTE_URL}assets/storefront.js`],
    ['GET', `${PRODUCTION_ROUTE_URL}v1/public/agents?limit=1`],
    ['POST', `${PRODUCTION_ROUTE_URL}v1/session`],
    ['POST', `${PRODUCTION_ROUTE_URL}v1/checkouts/release-probe/prepare`],
    ['POST', `${PRODUCTION_ROUTE_URL}mcp`],
  ])
  assert.equal(observed.some((request) => request.headers.has('authorization')), false)
  assert.equal(proof.readiness, 'ready')
  assert.equal(proof.behavior.asset.status, 200)
  assert.equal(proof.behavior.publicCatalog.status, 200)
  assert.equal(proof.behavior.sessionBoundary.code, 'storefront_session_refused')
  assert.equal(proof.behavior.checkoutBoundary.code, 'storefront_session_invalid')
  assert.equal(proof.behavior.mcpBoundary.jsonRpcCode, -32_001)
  assert.doesNotMatch(JSON.stringify(proof), /<body>/u)
})

test('Route proof rejects stale identity, missing storefront authority, malformed boundaries, and bounds', async () => {
  await assert.rejects(() => probe((request) => routeResponse(request, {
    rootHeaders: { 'x-commerce-release-candidate': 'b'.repeat(40) },
  })), /header_candidate_invalid/u)
  await assert.rejects(() => probe((request) => routeResponse(request, {
    rootBody: '<!doctype html><html><body>status only</body></html>',
  })), /storefront_script_missing/u)
  await assert.rejects(() => probe((request) => routeResponse(request, {
    sessionBody: { ok: false, code: 'unexpected' },
  })), /session_boundary_invalid/u)
  await assert.rejects(() => probe((request) => routeResponse(request, {
    rootHeaders: { 'content-length': '500001' },
  })), /content_length_invalid/u)
})

function probe(fetcher: (request: Request) => Response): Promise<unknown> {
  return proveProductionRoute({
    candidateSha: CANDIDATE,
    candidateDigest: CANDIDATE_DIGEST,
    edgeVersionId: EDGE_VERSION,
    coreVersionId: CORE_VERSION,
    fetch: async (request) => fetcher(request),
  })
}

function routeResponse(request: Request, options: Readonly<{
  rootBody?: string
  rootHeaders?: Record<string, string>
  sessionBody?: Record<string, unknown>
}> = {}): Response {
  const url = new URL(request.url)
  let body: BodyInit
  let status = 200
  let contentType = 'application/json; charset=utf-8'
  if (url.pathname === '/agentic-commerce-os/') {
    body = options.rootBody ?? HTML
    contentType = 'text/html; charset=utf-8'
  } else if (url.pathname.endsWith('/assets/storefront.js')) {
    body = ASSET
    contentType = 'text/javascript; charset=utf-8'
  } else if (url.pathname.endsWith('/v1/public/agents')) {
    body = JSON.stringify({ ok: true, revision: 0, digest: 'd'.repeat(64), agents: [] })
  } else if (url.pathname.endsWith('/v1/session')) {
    status = 403
    body = JSON.stringify(options.sessionBody ?? { ok: false, code: 'storefront_session_refused' })
  } else if (url.pathname.endsWith('/v1/checkouts/release-probe/prepare')) {
    status = 401
    body = JSON.stringify({ ok: false, code: 'storefront_session_invalid' })
  } else {
    status = 401
    body = JSON.stringify({ jsonrpc: '2.0', error: { code: -32_001, message: 'Unauthorized' }, id: null })
  }
  const response = new Response(body, {
    status,
    headers: {
      'content-type': contentType,
      ...(url.pathname === '/agentic-commerce-os/' ? rootHeaders() : {}),
      ...options.rootHeaders,
    },
  })
  Object.defineProperty(response, 'url', { configurable: true, value: request.url })
  Object.defineProperty(response, 'redirected', { configurable: true, value: false })
  return response
}

function rootHeaders(): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'x-commerce-live-readiness-contract': 'commerce.edge-route-live-readiness/v1',
    'x-commerce-live-readiness': 'ready',
    'x-commerce-live-readiness-reason': 'none',
    'x-commerce-release-candidate': CANDIDATE,
    'x-commerce-release-candidate-digest': CANDIDATE_DIGEST,
    'x-commerce-edge-version-id': EDGE_VERSION,
    'x-commerce-core-version-id': CORE_VERSION,
  }
}
