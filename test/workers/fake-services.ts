import { DEV_PROVIDER_PINS, devProviderFetch } from '../../src/dev/provider.ts'

export const CORE_TEST_BINDINGS = Object.freeze({
  DEPLOY_LANE: 'Test',
  RELEASE_CANDIDATE_SHA: DEV_PROVIDER_PINS.releaseCandidateSha,
  REGISTRY_ID: 'primary',
  ACOS_SOURCE_REVISION: DEV_PROVIDER_PINS.sourceRevision,
  ACOS_CATALOG_DIGEST: DEV_PROVIDER_PINS.catalogDigest,
  ACOS_ROUTING_SCHEMA: DEV_PROVIDER_PINS.routingSchema,
  ACOS_ROUTING_DIGEST: DEV_PROVIDER_PINS.routingDigest,
  ACOS_CATALOG_COUNTS_JSON: JSON.stringify(DEV_PROVIDER_PINS.counts),
  ACOS_REQUIRED_TOKENS_JSON: JSON.stringify(DEV_PROVIDER_PINS.requiredTokens),
  CHECKOUT_PROVIDER_EVIDENCE_PIN_JSON: JSON.stringify(DEV_PROVIDER_PINS.checkoutEvidence),
  MARKETPLACE_PROVIDER_EVIDENCE_PIN_JSON: JSON.stringify(DEV_PROVIDER_PINS.marketplaceEvidence),
})

export const CORE_TEST_SERVICE_BINDINGS = Object.freeze({
  ACOS_ADMISSION: devProviderFetch,
  DOCS_MCP: devProviderFetch,
  CHECKOUT_PROVIDER: checkoutProviderFixture,
  MARKETPLACE_PROVIDER: devProviderFetch,
})

const AMBIGUOUS_CONFIRMATIONS = new Set<string>()

async function checkoutProviderFixture(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (request.method !== 'POST' || url.pathname !== '/internal/v1/checkouts/confirm') {
    return devProviderFetch(request)
  }
  const body = await request.clone().json<Record<string, unknown>>()
  const checkoutId = typeof body.checkoutId === 'string' ? body.checkoutId : ''
  const response = await devProviderFetch(request)
  if (checkoutId === 'checkout-reconcile' && response.ok && !AMBIGUOUS_CONFIRMATIONS.has(checkoutId)) {
    AMBIGUOUS_CONFIRMATIONS.add(checkoutId)
    return Response.json({
      ok: false,
      contract: 'commerce.checkout-provider/v1',
      code: 'simulated_post_commit_timeout',
    }, { status: 504 })
  }
  return response
}

export const EDGE_MCP_TOKEN = 'mcp-test-secret-that-is-longer-than-thirty-two'
export const EDGE_OPERATOR_TOKEN = 'operator-test-secret-that-is-longer-than-thirty-two'

export const EDGE_TEST_BINDINGS = Object.freeze({
  DEPLOY_LANE: 'Production',
  RELEASE_CANDIDATE_SHA: DEV_PROVIDER_PINS.releaseCandidateSha,
  ALLOWED_ORIGINS_JSON: JSON.stringify(['https://airvio.co']),
  MCP_BEARER_TOKEN: EDGE_MCP_TOKEN,
  OPERATOR_BEARER_TOKEN: EDGE_OPERATOR_TOKEN,
})

export const EDGE_INVALID_TEST_BINDINGS = Object.freeze({
  ...EDGE_TEST_BINDINGS,
  MCP_BEARER_TOKEN: 'weak',
  OPERATOR_BEARER_TOKEN: 'also-weak',
})

export const EDGE_TEST_SERVICE_BINDINGS = Object.freeze({
  COMMERCE_CORE: fakeCore,
})

async function fakeCore(request: Request): Promise<Response> {
  if (request.headers.get('x-commerce-contract') !== 'commerce.edge-core/v1') {
    return Response.json({ ok: false, code: 'core_contract_required' }, { status: 400 })
  }
  if (request.headers.get('x-commerce-release-candidate') !== DEV_PROVIDER_PINS.releaseCandidateSha) {
    return Response.json({ ok: false, code: 'release_candidate_mismatch' }, { status: 409 })
  }
  const path = new URL(request.url).pathname
  const version = Object.freeze({
    id: 'commerce-core-worker-test-version',
    tag: DEV_PROVIDER_PINS.releaseCandidateSha,
    timestamp: '2026-08-26T00:00:00.000Z',
  })
  if (path === '/internal/livez') {
    return Response.json({
      ok: true,
      contract: 'commerce.core-live/v1',
      releaseCandidateSha: DEV_PROVIDER_PINS.releaseCandidateSha,
      version,
    })
  }
  if (path === '/internal/readyz') {
    return Response.json({
      ok: true,
      contract: 'commerce.core-readiness/v1',
      releaseCandidateSha: DEV_PROVIDER_PINS.releaseCandidateSha,
      version,
      checks: [],
    })
  }
  if (path === '/internal/v1/agents') {
    return Response.json({ ok: true, revision: 0, digest: 'test', agents: [] })
  }
  if (path === '/internal/v1/vendors/vendor-1/transition') {
    return Response.json({ ok: true, vendorId: 'vendor-1', state: 'active' })
  }
  return Response.json({ ok: false, code: 'not_found' }, { status: 404 })
}
