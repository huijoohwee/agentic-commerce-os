import { DEV_PROVIDER_PINS, devProviderFetch } from '../../src/dev/provider.ts'
import {
  ACOS_ADMISSION_FINDING_SCHEMA,
  ACOS_ADMISSION_PATH,
  agenticOsAdmissionHeaders,
  readAgenticOsAdmissionPermit,
} from '../../src/core/acos-admission.ts'
import { DOCS_INVOCATION_ENDPOINT } from '../../src/invocation/index.ts'
import { isRecord } from '../../src/shared/http.ts'
import { parseSandboxRequest, runIsolated } from '../../src/sandbox/isolation.ts'
import {
  DEV_CHECKOUT_PROVIDER_AUTH_SECRET,
  DEV_MARKETPLACE_PROVIDER_AUTH_SECRET,
} from '../../src/dev/provider-evidence.ts'
import { DEV_ACOS_ADMISSION_AUTH_SECRET } from '../../src/dev/acos-admission-provider.ts'

export const CORE_DISCOVERY_PROVIDER_CREDENTIAL = 'commerce-discovery-provider-test-credential'

export const CORE_TEST_BINDINGS = Object.freeze({
  DEPLOY_LANE: 'Test',
  RELEASE_CANDIDATE_SHA: DEV_PROVIDER_PINS.releaseCandidateSha,
  RELEASE_CANDIDATE_DIGEST: 'e'.repeat(64),
  REGISTRY_ID: 'primary',
  AG_TAKE_RATE_BASIS_POINTS: '250',
  AG_SELECTION_POLICY_JSON: JSON.stringify({
    schema: 'agentic-graph-selection-policy/v1',
    weights: { price: 1, quality: 1, latency: 1 },
    normalization: 'min-max',
  }),
  ACOS_SOURCE_REVISION: DEV_PROVIDER_PINS.sourceRevision,
  ACOS_CATALOG_DIGEST: DEV_PROVIDER_PINS.catalogDigest,
  ACOS_ROUTING_SCHEMA: DEV_PROVIDER_PINS.routingSchema,
  ACOS_ROUTING_DIGEST: DEV_PROVIDER_PINS.routingDigest,
  ACOS_CATALOG_COUNTS_JSON: JSON.stringify(DEV_PROVIDER_PINS.counts),
  ACOS_REQUIRED_TOKENS_JSON: JSON.stringify(DEV_PROVIDER_PINS.requiredTokens),
  ACOS_RUNTIME_SOURCE_REVISION: DEV_PROVIDER_PINS.acosDeployment.sourceRevision,
  ACOS_RUNTIME_CANDIDATE_DIGEST: DEV_PROVIDER_PINS.acosDeployment.candidateDigest,
  DISCOVERY_PROVIDER_EVIDENCE_PIN_JSON: JSON.stringify(DEV_PROVIDER_PINS.discoveryEvidence),
  CHECKOUT_PROVIDER_EVIDENCE_PIN_JSON: JSON.stringify(DEV_PROVIDER_PINS.checkoutEvidence),
  MARKETPLACE_PROVIDER_EVIDENCE_PIN_JSON: JSON.stringify(DEV_PROVIDER_PINS.marketplaceEvidence),
  DISCOVERY_PROVIDER_BEARER_TOKEN: CORE_DISCOVERY_PROVIDER_CREDENTIAL,
  ACOS_ADMISSION_AUTH_SECRET: DEV_ACOS_ADMISSION_AUTH_SECRET,
  CHECKOUT_PROVIDER_AUTH_SECRET: DEV_CHECKOUT_PROVIDER_AUTH_SECRET,
  MARKETPLACE_PROVIDER_AUTH_SECRET: DEV_MARKETPLACE_PROVIDER_AUTH_SECRET,
})

export const CORE_TEST_SERVICE_BINDINGS = Object.freeze({
  ACOS_ADMISSION: failureAwareAcosAdmissionProvider,
  DOCS_MCP: authenticatedDiscoveryProvider,
  CHECKOUT_PROVIDER: checkoutProviderFixture,
  MARKETPLACE_PROVIDER: devProviderFetch,
  COMMERCE_SANDBOX: fakeSandbox,
})

const ACOS_FAILURE_ATTEMPTS = new Map<string, number>()

async function failureAwareAcosAdmissionProvider(request: Request): Promise<Response> {
  if (request.method !== 'POST' || new URL(request.url).pathname !== ACOS_ADMISSION_PATH) {
    return devProviderFetch(request)
  }
  const body = await request.clone().json<Record<string, unknown>>().catch(() => null)
  const definition = isRecord(body?.agent_definition) ? body.agent_definition : null
  const agentId = typeof definition?.id === 'string' ? definition.id : ''
  if (!agentId.startsWith('test-acos-')) return devProviderFetch(request)
  const attempt = (ACOS_FAILURE_ATTEMPTS.get(agentId) ?? 0) + 1
  ACOS_FAILURE_ATTEMPTS.set(agentId, attempt)
  const status = agentId.startsWith('test-acos-forged-500') && attempt === 1 ? 500 : 409
  const reasonCode = agentId.startsWith('test-acos-unknown-409') && attempt === 1
    ? 'transient_provider_rejection' : 'agent_revision_conflict'
  const permit = readAgenticOsAdmissionPermit(request)
  return Response.json({
    status: 'rejected',
    record: null,
    finding: {
      schema: ACOS_ADMISSION_FINDING_SCHEMA,
      type: 'unfederated-tool',
      adapter_identity: null,
      reason_code: reasonCode,
      message: 'Synthetic ACOS admission response for the reservation lifecycle test.',
      details: {},
    },
  }, { status, headers: permit ? agenticOsAdmissionHeaders(permit) : {} })
}

const AMBIGUOUS_CONFIRMATIONS = new Set<string>()
const CHECKOUT_PROVIDER_COUNTS = new Map<string, { confirmPosts: number; statusGets: number }>()
const PREPARED_EDGE_CHECKOUTS = new Map<string, Readonly<{
  confirmationToken: string
  offerId: string
  amountMinor: number
}>>()

export async function authenticatedDiscoveryProvider(request: Request): Promise<Response> {
  if (new URL(request.url).pathname === new URL(DOCS_INVOCATION_ENDPOINT).pathname
    && request.headers.get('authorization') !== `Bearer ${CORE_DISCOVERY_PROVIDER_CREDENTIAL}`) {
    return Response.json({ ok: false, code: 'discovery_provider_unauthorized' }, { status: 401 })
  }
  return devProviderFetch(request)
}

async function checkoutProviderFixture(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const countPath = url.pathname.match(/^\/__test__\/checkout-provider-counts\/([^/]+)$/u)
  if (request.method === 'GET' && countPath?.[1]) {
    const checkoutId = decodeURIComponent(countPath[1])
    return Response.json(CHECKOUT_PROVIDER_COUNTS.get(checkoutId) ?? { confirmPosts: 0, statusGets: 0 })
  }
  if (request.method === 'GET' && url.pathname === '/internal/v1/checkouts/status') {
    const checkoutId = (url.searchParams.get('idempotencyKey') ?? '').replace(/^checkout-confirm:/u, '')
    incrementCheckoutProviderCount(checkoutId, 'statusGets')
    return devProviderFetch(request)
  }
  if (request.method !== 'POST' || url.pathname !== '/internal/v1/checkouts/confirm') {
    return devProviderFetch(request)
  }
  const body = await request.clone().json<Record<string, unknown>>()
  const checkoutId = typeof body.checkoutId === 'string' ? body.checkoutId : ''
  incrementCheckoutProviderCount(checkoutId, 'confirmPosts')
  const firstAmbiguous = !AMBIGUOUS_CONFIRMATIONS.has(checkoutId)
  if (checkoutId.startsWith('checkout-reconcile-alarm-unknown-') && firstAmbiguous) {
    AMBIGUOUS_CONFIRMATIONS.add(checkoutId)
    return Response.json({
      ok: false,
      contract: 'commerce.checkout-provider/v1',
      code: 'simulated_pre_commit_timeout',
    }, { status: 504 })
  }
  const response = await devProviderFetch(request)
  if ((checkoutId === 'checkout-reconcile'
      || checkoutId.startsWith('checkout-reconcile-alarm-settled-'))
    && response.ok && firstAmbiguous) {
    AMBIGUOUS_CONFIRMATIONS.add(checkoutId)
    return Response.json({
      ok: false,
      contract: 'commerce.checkout-provider/v1',
      code: 'simulated_post_commit_timeout',
    }, { status: 504 })
  }
  return response
}

function incrementCheckoutProviderCount(
  checkoutId: string,
  field: 'confirmPosts' | 'statusGets',
): void {
  if (!checkoutId) return
  const count = CHECKOUT_PROVIDER_COUNTS.get(checkoutId) ?? { confirmPosts: 0, statusGets: 0 }
  count[field] += 1
  CHECKOUT_PROVIDER_COUNTS.set(checkoutId, count)
}

export const EDGE_MCP_TOKEN = 'mcp-test-secret-that-is-longer-than-thirty-two'
export const EDGE_OPERATOR_TOKEN = 'operator-test-secret-that-is-longer-than-thirty-two'
export const EDGE_TEST_VERSION = Object.freeze({
  id: 'commerce-edge-worker-test-version',
  tag: DEV_PROVIDER_PINS.releaseCandidateSha,
  timestamp: '2026-08-26T00:00:00.000Z',
})

export const EDGE_HUMAN_PRESENCE_ISSUER = 'shopper-presence-test'
export const EDGE_HUMAN_PRESENCE_PUBLIC_KEY_SPKI_BASE64 = 'MCowBQYDK2VwAyEAHuYvy6osry9+g67k7Q/3kAGgpv/SOkEyhb4aEBqJQqk='
export const EDGE_HUMAN_PRESENCE_PRIVATE_KEY_PKCS8_BASE64 = 'MC4CAQAwBQYDK2VwBCIEIMEIYdy4qcJTDr7Fy2lWx/hXDUPh3l3PeW6KIpDvc8oE'

export const EDGE_TEST_BINDINGS = Object.freeze({
  CF_VERSION_METADATA: EDGE_TEST_VERSION,
  DEPLOY_LANE: 'Production',
  RELEASE_CANDIDATE_SHA: DEV_PROVIDER_PINS.releaseCandidateSha,
  RELEASE_CANDIDATE_DIGEST: 'e'.repeat(64),
  ALLOWED_ORIGINS_JSON: JSON.stringify(['https://airvio.co']),
  MCP_BEARER_TOKEN: EDGE_MCP_TOKEN,
  OPERATOR_BEARER_TOKEN: EDGE_OPERATOR_TOKEN,
  STOREFRONT_SESSION_SECRET: 'storefront-session-test-secret-that-is-longer-than-thirty-two',
  HUMAN_CONFIRMATION_TRUST_ANCHOR_JSON: JSON.stringify({
    schema: 'agentic-graph-human-presence-trust-anchor/v1',
    issuer: EDGE_HUMAN_PRESENCE_ISSUER,
    publicKeySpkiBase64: EDGE_HUMAN_PRESENCE_PUBLIC_KEY_SPKI_BASE64,
  }),
})

export const EDGE_INVALID_TEST_BINDINGS = Object.freeze({
  ...EDGE_TEST_BINDINGS,
  MCP_BEARER_TOKEN: 'weak',
  OPERATOR_BEARER_TOKEN: 'also-weak',
  STOREFRONT_SESSION_SECRET: 'weak-session-secret',
  HUMAN_CONFIRMATION_TRUST_ANCHOR_JSON: 'invalid-anchor',
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
      lane: 'Production',
      releaseCandidateSha: DEV_PROVIDER_PINS.releaseCandidateSha,
      releaseCandidateDigest: CORE_TEST_BINDINGS.RELEASE_CANDIDATE_DIGEST,
      version,
    })
  }
  if (path === '/internal/readyz') {
    return Response.json({
      ok: false,
      contract: 'commerce.core-readiness/v2',
      lane: 'Production',
      releaseCandidateSha: DEV_PROVIDER_PINS.releaseCandidateSha,
      releaseCandidateDigest: CORE_TEST_BINDINGS.RELEASE_CANDIDATE_DIGEST,
      version,
      sourceReadiness: { ok: true, checks: [] },
      liveReleaseReadiness: {
        ok: false,
        reason: 'delivery_route_live_unknown',
        servingCandidateSha: null,
      },
      convergence: [],
    }, { status: 503 })
  }
  if (request.method === 'POST' && path === '/internal/v1/invocations/authorize') {
    const body: unknown = await request.json()
    return isRecord(body) && typeof body.capabilityAction === 'string'
      ? Response.json({ ok: true, capabilityAction: body.capabilityAction })
      : Response.json({ ok: false, code: 'invocation_capability_request_malformed' }, { status: 400 })
  }
  if (path === '/internal/v1/agents') {
    return Response.json({ ok: true, revision: 0, digest: 'test', agents: [] })
  }
  if (path === '/internal/v1/vendors/vendor-1/transition') {
    return Response.json({ ok: true, vendorId: 'vendor-1', state: 'active' })
  }
  const checkout = path.match(/^\/internal\/v1\/checkouts\/([^/]+)\/(prepare|confirm)$/u)
  if (request.method === 'POST' && checkout?.[1] && checkout[2]) {
    const checkoutId = decodeURIComponent(checkout[1])
    const body: unknown = await request.json()
    if (!isRecord(body) || body.checkoutId !== checkoutId) {
      return Response.json({ ok: false, code: 'checkout_input_invalid' }, { status: 400 })
    }
    if (checkout[2] === 'prepare') {
      if (typeof body.offerId !== 'string' || !Number.isSafeInteger(body.amountMinor) || Number(body.amountMinor) <= 0) {
        return Response.json({ ok: false, code: 'checkout_input_invalid' }, { status: 400 })
      }
      const confirmationToken = crypto.randomUUID().repeat(2)
      PREPARED_EDGE_CHECKOUTS.set(checkoutId, Object.freeze({
        confirmationToken,
        offerId: body.offerId,
        amountMinor: Number(body.amountMinor),
      }))
      return Response.json({
        ok: true,
        status: 'confirmation_required',
        checkoutId,
        confirmationToken,
        confirmationExpiresAt: Date.now() + 90_000,
        guardrailReceipt: { ok: true, checkoutId },
      })
    }
    const prepared = PREPARED_EDGE_CHECKOUTS.get(checkoutId)
    if (!prepared
      || body.confirmationToken !== prepared.confirmationToken
      || body.offerId !== prepared.offerId
      || body.amountMinor !== prepared.amountMinor) {
      return Response.json({ ok: false, code: 'confirmation_token_invalid' }, { status: 409 })
    }
    PREPARED_EDGE_CHECKOUTS.delete(checkoutId)
    return Response.json({ ok: true, status: 'settled', checkoutId, settlementId: `settlement-${checkoutId}` })
  }
  return Response.json({ ok: false, code: 'not_found' }, { status: 404 })
}

async function fakeSandbox(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === 'GET' && url.pathname === '/readyz') {
    return Response.json({
      ok: true,
      contract: 'agentic-commerce-registration-sandbox/v1',
      lane: CORE_TEST_BINDINGS.DEPLOY_LANE,
      releaseCandidateSha: CORE_TEST_BINDINGS.RELEASE_CANDIDATE_SHA,
      releaseCandidateDigest: CORE_TEST_BINDINGS.RELEASE_CANDIDATE_DIGEST,
      version: {
        id: 'commerce-sandbox-worker-test-version',
        tag: CORE_TEST_BINDINGS.RELEASE_CANDIDATE_SHA,
        timestamp: '2026-09-03T00:00:00.000Z',
      },
      containerProbe: { ok: true, runtime: 'node', version: 'v22.22.3' },
    })
  }
  if (request.method !== 'POST' || url.pathname !== '/v1/run') {
    return Response.json({ ok: false, code: 'not_found' }, { status: 404 })
  }
  const value: unknown = await request.json().catch(() => null)
  const parsed = parseSandboxRequest(value)
  if (!parsed) return Response.json({ ok: false, code: 'sandbox_request_invalid' }, { status: 400 })
  const result = await runIsolated(parsed, {
    executor: Object.freeze({
      async execute(input) {
        const allowlist = new Set(input.declaredAllowlist)
        const calls = isRecord(input.payload) && Array.isArray(input.payload.toolCalls)
          ? input.payload.toolCalls
          : []
        const attemptedCalls = []
        for (const call of calls) {
          if (!isRecord(call) || typeof call.toolId !== 'string') continue
          const allowlisted = allowlist.has(call.toolId)
          attemptedCalls.push(Object.freeze({
            toolId: call.toolId,
            allowlisted,
            outcome: allowlisted ? 'executed' as const : 'refused' as const,
          }))
          if (!allowlisted) break
        }
        return Object.freeze({
          ok: attemptedCalls.every(({ allowlisted }) => allowlisted),
          exceededLimit: null,
          attemptedCalls: Object.freeze(attemptedCalls),
        })
      },
      async terminate() {},
    }),
  })
  return Response.json(result, {
    status: result.ok ? 200 : result.code === 'sandbox_call_not_allowlisted' ? 409 : 503,
  })
}
