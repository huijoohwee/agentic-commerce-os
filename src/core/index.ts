import {
  createInvocationClient,
  DOCS_INVOCATION_ENDPOINT,
  DOCS_INVOCATION_TOOL,
  type InvocationCatalogSnapshot,
} from '../invocation'
import { readRoutingIntent } from '../domain/exclusive-category-router'
import { isHttpFailure, isRecord, jsonResponse, readJsonObject, readJsonResponse } from '../shared/http'
import {
  AgentRegistry,
  invocationAligned,
  type AgentRegistrationInput,
  type InvocationPinProof,
} from './agent-registry'
import {
  probeAcosAdmission,
  requestAcosAdmission,
  type AcosAdmissionInputs,
} from './acos-admission'
import { CheckoutSession } from './checkout-session'
import { checkoutInputFieldsAllowed, exactCheckoutConfirmInput, exactCheckoutPrepareInput } from './checkout-input'
import { normalizeDiscoveryReceipt, type DiscoveryOfferReceipt } from './discovery-receipt'
import { IntentRoute } from './intent-route'
import { listMcpToolNames } from './mcp-provider'
import {
  CHECKOUT_PROVIDER_CONTRACT,
  hasProviderContract,
  MARKETPLACE_PROVIDER_CONTRACT,
} from './provider-contract'
import {
  CHECKOUT_EVIDENCE_CHECKS,
  MARKETPLACE_EVIDENCE_CHECKS,
  readUpstreamEvidencePin,
  verifyUpstreamRuntimeEvidence,
} from './upstream-evidence'
export { AgentRegistry, CheckoutSession, IntentRoute }

const EDGE_CORE_CONTRACT = 'commerce.edge-core/v1'
const MAXIMUM_PROVIDER_RESPONSE_BYTES = 1_000_000
const DEPENDENCY_REQUEST_TIMEOUT_MS = 10_000

export default {
  async fetch(request: Request, env: CoreEnv): Promise<Response> {
    const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID()
    const url = new URL(request.url)
    try {
      if (request.method === 'GET' && url.pathname === '/internal/livez') {
        return respond({
          ok: true,
          contract: 'commerce.core-live/v1',
          lane: env.DEPLOY_LANE,
          releaseCandidateSha: env.RELEASE_CANDIDATE_SHA,
          version: env.CF_VERSION_METADATA,
        }, requestId)
      }
      if (request.method === 'GET' && url.pathname === '/internal/readyz') {
        const report = await readiness(env)
        return respond(report, requestId, report.ok ? 200 : 503)
      }
      if (request.headers.get('x-commerce-contract') !== EDGE_CORE_CONTRACT) {
        return respond(reject('core_contract_required'), requestId, 400)
      }
      if (request.headers.get('x-commerce-release-candidate') !== env.RELEASE_CANDIDATE_SHA) {
        return respond(reject('release_candidate_mismatch'), requestId, 409)
      }
      if (request.method === 'POST' && url.pathname === '/internal/v1/invocations/resolve') {
        const body = await readJsonObject(request)
        if (isHttpFailure(body)) return respond(body, requestId, 400)
        const tokens = readTokenArray(body.tokens)
        if (!tokens) return respond(reject('invocation_tokens_malformed'), requestId, 400)
        return respond(await resolvePinnedInvocations(env, tokens), requestId)
      }
      if (url.pathname === '/internal/v1/agents') {
        if (request.method === 'GET') return respond(await registryStub(env).list(), requestId)
        if (request.method === 'POST') return registerAgent(request, env, requestId)
      }
      const agentMatch = url.pathname.match(/^\/internal\/v1\/agents\/([^/]+)$/u)
      if (request.method === 'DELETE' && agentMatch) {
        const body = await readJsonObject(request)
        if (isHttpFailure(body)) return respond(body, requestId, 400)
        const agentId = decodeURIComponent(agentMatch[1] ?? '')
        const contentHash = typeof body.expectedContentHash === 'string' ? body.expectedContentHash : ''
        const result = await registryStub(env).deregister(agentId, contentHash)
        return respond(result, requestId, resultOk(result) ? 200 : 409)
      }
      if (request.method === 'GET' && url.pathname === '/internal/v1/registry/events') {
        const after = Number(url.searchParams.get('after') ?? 0)
        const limit = Number(url.searchParams.get('limit') ?? 100)
        return respond(await registryStub(env).events(after, limit), requestId)
      }
      if (request.method === 'POST' && url.pathname === '/internal/v1/intents/route') {
        return routeIntent(request, env, requestId)
      }
      const checkoutMatch = url.pathname.match(/^\/internal\/v1\/checkouts\/([^/]+)(?:\/(prepare|confirm))?$/u)
      if (checkoutMatch) {
        return checkout(request, env, requestId, decodeURIComponent(checkoutMatch[1] ?? ''), checkoutMatch[2] ?? '')
      }
      const vendorMatch = url.pathname.match(/^\/internal\/v1\/vendors\/([^/]+)\/transition$/u)
      if (request.method === 'POST' && vendorMatch) {
        return proxyVendorTransition(request, env, requestId, decodeURIComponent(vendorMatch[1] ?? ''))
      }
      if (request.method === 'GET' && url.pathname === '/internal/v1/vendors') {
        return proxyJson(
          env.MARKETPLACE_PROVIDER,
          '/v1/vendors',
          requestId,
          MARKETPLACE_PROVIDER_CONTRACT,
        )
      }
      const settlementMatch = url.pathname.match(/^\/internal\/v1\/settlements\/([^/]+)$/u)
      if (request.method === 'GET' && settlementMatch) {
        return proxyJson(
          env.MARKETPLACE_PROVIDER,
          `/v1/settlements/${encodeURIComponent(decodeURIComponent(settlementMatch[1] ?? ''))}`,
          requestId,
          MARKETPLACE_PROVIDER_CONTRACT,
        )
      }
      return respond(reject('not_found'), requestId, 404)
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'commerce_core_request_failed',
        requestId,
        method: request.method,
        path: url.pathname,
        code: classifyError(error),
      }))
      return respond(reject('internal_error'), requestId, 500)
    }
  },
} satisfies ExportedHandler<CoreEnv>

async function registerAgent(request: Request, env: CoreEnv, requestId: string): Promise<Response> {
  const body = await readJsonObject(request)
  if (isHttpFailure(body)) return respond(body, requestId, 400)
  const allowedFields = new Set([
    'agentDefinition',
    'toolAllowlistEntry',
    'invocationRegisterEntry',
    'operatorInstructionRef',
    'commerceProjection',
    'expectedPreviousContentHash',
  ])
  if (Object.keys(body).some((field) => !allowedFields.has(field))
    || !('agentDefinition' in body)
    || !('toolAllowlistEntry' in body)
    || !('invocationRegisterEntry' in body)
    || typeof body.operatorInstructionRef !== 'string'
    || !isRecord(body.commerceProjection)
    || (body.expectedPreviousContentHash !== null && typeof body.expectedPreviousContentHash !== 'string')) {
    return respond(reject('registration_malformed'), requestId, 400)
  }
  const admissionInputs: AcosAdmissionInputs = {
    agentDefinition: body.agentDefinition,
    toolAllowlistEntry: body.toolAllowlistEntry,
    invocationRegisterEntry: body.invocationRegisterEntry,
    operatorInstructionRef: body.operatorInstructionRef,
  }
  let invocationProof: InvocationPinProof
  try {
    invocationProof = invocationProofFromResolution(
      await resolvePinnedInvocations(env, configuredTokens(env)),
      configuredTokens(env),
    )
  } catch {
    return respond(reject('invocation_catalog_unavailable'), requestId, 503)
  }
  const admission = await requestAcosAdmission(env.ACOS_ADMISSION, admissionInputs)
  if (!admission.ok) {
    const status = admission.code === 'acos_admission_rejected'
      ? 409
      : admission.code === 'acos_admission_provider_unavailable' ? 503 : 502
    return respond(admission, requestId, status)
  }
  const input: AgentRegistrationInput = {
    admissionInputs,
    admissionReceipt: admission.receipt,
    invocationProof,
    commerceProjection: body.commerceProjection,
    expectedPreviousContentHash: body.expectedPreviousContentHash,
  }
  const result = await registryStub(env).register(input)
  return respond(result, requestId, resultOk(result) ? 200 : 409)
}

async function routeIntent(request: Request, env: CoreEnv, requestId: string): Promise<Response> {
  const body = await readJsonObject(request)
  if (isHttpFailure(body)) return respond(body, requestId, 400)
  const intent = readRoutingIntent(body)
  if (!intent) return respond(reject('intent_malformed'), requestId, 400)
  const registry = registryStub(env)
  const invocationProof = configuredInvocationProof(env)
  const decision: unknown = await registry.route(intent, invocationProof)
  if (!isRecord(decision) || decision.status !== 'dispatch' || typeof decision.agentId !== 'string') {
    return respond(decision, requestId, 422)
  }
  const snapshot = await registry.list()
  const agent = snapshot.agents.find((candidate) => (
    candidate.agentId === decision.agentId
    && candidate.registrationState === 'active'
    && candidate.admissionVerified
    && invocationAligned(candidate, invocationProof)
  ))
  if (!agent) return respond(reject('registry_route_drift'), requestId, 503)
  const route = env.INTENT_ROUTE.getByName(intent.intentId) as unknown as DurableObjectStub<IntentRoute>
  const result = await route.dispatch({ intent, agent })
  return respond(result, requestId, resultOk(result) ? 200 : 503)
}

async function checkout(
  request: Request,
  env: CoreEnv,
  requestId: string,
  checkoutId: string,
  action: string,
): Promise<Response> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(checkoutId)) {
    return respond(reject('checkout_id_malformed'), requestId, 400)
  }
  const session = env.CHECKOUT_SESSION.getByName(checkoutId) as unknown as DurableObjectStub<CheckoutSession>
  if (request.method === 'GET' && !action) return respond(await session.status(), requestId)
  if (request.method !== 'POST' || (action !== 'prepare' && action !== 'confirm')) {
    return respond(reject('not_found'), requestId, 404)
  }
  const body = await readJsonObject(request)
  if (isHttpFailure(body)) return respond(body, requestId, 400)
  if (body.checkoutId !== undefined && body.checkoutId !== checkoutId) {
    return respond(reject('checkout_id_mismatch'), requestId, 400)
  }
  if (!checkoutInputFieldsAllowed(body, action)) return respond(reject('checkout_input_fields_unsupported'), requestId, 400)
  if (action === 'prepare') {
    if (typeof body.intentId !== 'string'
      || typeof body.agentId !== 'string'
      || typeof body.offerId !== 'string'
      || typeof body.offerReceiptDigest !== 'string'
      || !Number.isSafeInteger(body.amountMinor)
      || typeof body.currency !== 'string') {
      return respond(reject('checkout_routing_evidence_malformed'), requestId, 400)
    }
    const route = env.INTENT_ROUTE.getByName(body.intentId) as unknown as DurableObjectStub<IntentRoute>
    const routeStatus: unknown = await route.status()
    if (!isRecord(routeStatus)
      || routeStatus.ok !== true
      || routeStatus.agentId !== body.agentId
      || routeStatus.intentId !== body.intentId) {
      return respond(reject('checkout_routing_evidence_required'), requestId, 409)
    }
    const offer = await findDiscoveredOffer(routeStatus.receipt, body)
    if (!offer) return respond(reject('checkout_offer_receipt_required'), requestId, 409)
    const checkoutEvidencePin = readUpstreamEvidencePin(env.CHECKOUT_PROVIDER_EVIDENCE_PIN_JSON)
    if (!checkoutEvidencePin || offer.providerRevision !== checkoutEvidencePin.sourceRevision) {
      return respond(reject('checkout_provider_evidence_pin_mismatch'), requestId, 503)
    }
    const registry = await registryStub(env).list()
    const registered = registry.agents.some((agent) => (
      agent.registrationState === 'active'
      && agent.admissionVerified
      && agent.agentId === body.agentId
    ))
    if (!registered) return respond(reject('checkout_agent_not_registered'), requestId, 409)
    body.offerProviderRevision = offer.providerRevision
  }
  const result = action === 'prepare'
    ? await session.prepare(exactCheckoutPrepareInput(body, checkoutId, String(body.offerProviderRevision)))
    : await session.confirm(exactCheckoutConfirmInput(body, checkoutId))
  return respond(result, requestId, resultOk(result) ? 200 : 409)
}

async function proxyVendorTransition(
  request: Request,
  env: CoreEnv,
  requestId: string,
  vendorId: string,
): Promise<Response> {
  const body = await readJsonObject(request)
  if (isHttpFailure(body)) return respond(body, requestId, 400)
  if (typeof body.actorId !== 'string' || typeof body.state !== 'string') {
    return respond(reject('vendor_transition_malformed'), requestId, 400)
  }
  const upstream = await env.MARKETPLACE_PROVIDER.fetch(
    new Request(`https://marketplace.internal/v1/vendors/${encodeURIComponent(vendorId)}/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-operator-id': body.actorId },
      body: JSON.stringify({ state: body.state }),
      signal: AbortSignal.timeout(DEPENDENCY_REQUEST_TIMEOUT_MS),
    }),
  )
  const payload = await readProviderResponse(upstream)
  if (!hasProviderContract(payload, MARKETPLACE_PROVIDER_CONTRACT)) {
    return respond(reject('marketplace_provider_contract_mismatch'), requestId, 502)
  }
  return respond(payload, requestId, upstream.status)
}

async function readiness(env: CoreEnv): Promise<Readonly<{
  ok: boolean
  contract: string
  lane: string
  releaseCandidateSha: string
  version: WorkerVersionMetadata
  checks: readonly unknown[]
}>> {
  const requiredTokens = configuredTokens(env)
  const invocationResolution = resolvePinnedInvocations(env, requiredTokens)
  const checks = await Promise.all([
    check('release_candidate', async () => releaseCandidateCheck(env.DEPLOY_LANE, env.RELEASE_CANDIDATE_SHA)),
    check('acos_admission', async () => probeAcosAdmission(env.ACOS_ADMISSION)),
    check('registry', async () => registryStub(env).health(invocationProofFromResolution(
      await invocationResolution,
      requiredTokens,
    ))),
    check('invocation_catalog', async () => invocationResolution),
    check('mcp_tools', async () => {
      const registered = (await registryStub(env).list()).agents
        .filter((agent) => agent.registrationState === 'active' && agent.admissionVerified)
        .map((agent) => agent.discoveryTool)
      const names = await listMcpToolNames(env.DOCS_MCP)
      const required = [DOCS_INVOCATION_TOOL, ...registered]
      const missing = required.filter((name) => !names.includes(name))
      return { ok: missing.length === 0, missing }
    }),
    check('commerce_provider', async () => probe(env.CHECKOUT_PROVIDER, '/readyz')),
    check('commerce_provider_contract', async () => probeCapabilities(
      env.CHECKOUT_PROVIDER,
      'checkout-provider.internal',
      CHECKOUT_PROVIDER_CONTRACT,
      ['prepare', 'confirm', 'status'],
    )),
    check('checkout_provider_evidence', async () => probeRuntimeEvidence(
      env.CHECKOUT_PROVIDER,
      'checkout-provider.internal',
      CHECKOUT_PROVIDER_CONTRACT,
      env.CHECKOUT_PROVIDER_EVIDENCE_PIN_JSON,
      CHECKOUT_EVIDENCE_CHECKS,
    )),
    check('marketplace_provider', async () => probe(env.MARKETPLACE_PROVIDER, '/readyz')),
    check('marketplace_provider_contract', async () => probeCapabilities(
      env.MARKETPLACE_PROVIDER,
      'marketplace-provider.internal',
      MARKETPLACE_PROVIDER_CONTRACT,
      ['vendor-list', 'vendor-transition', 'settlement-read'],
    )),
    check('marketplace_provider_evidence', async () => probeRuntimeEvidence(
      env.MARKETPLACE_PROVIDER,
      'marketplace-provider.internal',
      MARKETPLACE_PROVIDER_CONTRACT,
      env.MARKETPLACE_PROVIDER_EVIDENCE_PIN_JSON,
      MARKETPLACE_EVIDENCE_CHECKS,
    )),
  ])
  return Object.freeze({
    ok: checks.every((entry) => entry.ok),
    contract: 'commerce.core-readiness/v1',
    lane: env.DEPLOY_LANE,
    releaseCandidateSha: env.RELEASE_CANDIDATE_SHA,
    version: env.CF_VERSION_METADATA,
    checks: Object.freeze(checks),
  })
}

function releaseCandidateCheck(lane: string, releaseCandidateSha: string): Readonly<{ ok: boolean }> {
  const production = lane.toLowerCase() === 'production'
  return Object.freeze({ ok: !production || /^[0-9a-f]{40}$/u.test(releaseCandidateSha) })
}

async function resolvePinnedInvocations(env: CoreEnv, tokens: readonly string[]) {
  const client = createInvocationClient({
    endpoint: DOCS_INVOCATION_ENDPOINT,
    fetcher: env.DOCS_MCP,
  })
  try {
    const signal = AbortSignal.timeout(10_000)
    const snapshot = await client.hydrate({ signal })
    assertPinnedSnapshot(env, snapshot)
    const invocations = await Promise.all(tokens.map(async (token) => (
      await client.resolve(token, { signal })
    ).invocation))
    return Object.freeze({
      ok: true,
      sourceRevision: snapshot.sourceRevision,
      catalogDigest: snapshot.catalogDigest,
      routingSchema: snapshot.routingSchema,
      routingDigest: snapshot.routingDigest,
      counts: snapshot.counts,
      invocations: Object.freeze(invocations),
    })
  } finally {
    await client.close({ signal: AbortSignal.timeout(1_000) })
  }
}

function assertPinnedSnapshot(env: CoreEnv, snapshot: InvocationCatalogSnapshot): void {
  const expectedCounts = JSON.parse(env.ACOS_CATALOG_COUNTS_JSON) as unknown
  if (snapshot.sourceRevision !== env.ACOS_SOURCE_REVISION
    || snapshot.catalogDigest !== env.ACOS_CATALOG_DIGEST
    || snapshot.routingSchema !== env.ACOS_ROUTING_SCHEMA
    || snapshot.routingDigest !== env.ACOS_ROUTING_DIGEST
    || JSON.stringify(snapshot.counts) !== JSON.stringify(expectedCounts)) {
    throw new Error('invocation_catalog_pin_mismatch')
  }
}

function configuredTokens(env: CoreEnv): readonly string[] {
  const tokens = readTokenArray(JSON.parse(env.ACOS_REQUIRED_TOKENS_JSON) as unknown)
  if (!tokens) throw new Error('configured_invocation_tokens_invalid')
  return tokens
}

function configuredInvocationProof(env: CoreEnv): InvocationPinProof {
  const counts = JSON.parse(env.ACOS_CATALOG_COUNTS_JSON) as unknown
  if (!isRecord(counts)) throw new Error('invocation_catalog_pin_mismatch')
  return Object.freeze({
    sourceRevision: env.ACOS_SOURCE_REVISION,
    catalogDigest: env.ACOS_CATALOG_DIGEST,
    routingSchema: env.ACOS_ROUTING_SCHEMA,
    routingDigest: env.ACOS_ROUTING_DIGEST,
    counts: Object.freeze({
      command: Number(counts.command),
      semantic: Number(counts.semantic),
      binding: Number(counts.binding),
    }),
    requiredTokens: configuredTokens(env),
  })
}

function invocationProofFromResolution(
  resolution: Awaited<ReturnType<typeof resolvePinnedInvocations>>,
  requiredTokens: readonly string[],
): InvocationPinProof {
  const resolvedTokens = resolution.invocations.map((invocation) => invocation.token)
  if (JSON.stringify(resolvedTokens) !== JSON.stringify(requiredTokens)) {
    throw new Error('invocation_catalog_pin_mismatch')
  }
  return Object.freeze({
    sourceRevision: resolution.sourceRevision,
    catalogDigest: resolution.catalogDigest,
    routingSchema: resolution.routingSchema,
    routingDigest: resolution.routingDigest,
    counts: Object.freeze({ ...resolution.counts }),
    requiredTokens: Object.freeze([...requiredTokens]),
  })
}

async function findDiscoveredOffer(
  receipt: unknown,
  request: Record<string, unknown>,
): Promise<DiscoveryOfferReceipt | null> {
  if (!isRecord(receipt)
    || !Array.isArray(receipt.offers)
    || typeof request.intentId !== 'string'
    || typeof request.agentId !== 'string'
    || typeof request.offerReceiptDigest !== 'string') return null
  const candidate = receipt.offers.find((offer) => (
    isRecord(offer) && offer.receiptDigest === request.offerReceiptDigest
  ))
  if (!isRecord(candidate) || typeof candidate.intentDigest !== 'string') return null
  try {
    const normalized = await normalizeDiscoveryReceipt(
      receipt,
      request.intentId,
      candidate.intentDigest,
      request.agentId,
    )
    return normalized.offers.find((offer) => (
      offer.receiptDigest === request.offerReceiptDigest
      && offer.offerId === request.offerId
      && offer.amountMinor === request.amountMinor
      && offer.currency === request.currency
    )) ?? null
  } catch {
    return null
  }
}

function readTokenArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) return null
  const tokens = value.filter((entry): entry is string => typeof entry === 'string')
  if (tokens.length !== value.length
    || new Set(tokens).size !== tokens.length
    || tokens.some((token) => !/^[/#@][A-Za-z0-9][A-Za-z0-9._-]{0,95}:?$/u.test(token))) return null
  return Object.freeze(tokens)
}

type AgentRegistryClient = Readonly<{
  register: AgentRegistry['register']
  deregister: AgentRegistry['deregister']
  list: AgentRegistry['list']
  route: AgentRegistry['route']
  health: AgentRegistry['health']
  events: AgentRegistry['events']
}>

function registryStub(env: CoreEnv): AgentRegistryClient {
  return env.AGENT_REGISTRY.getByName(env.REGISTRY_ID) as unknown as AgentRegistryClient
}

async function probe(binding: Fetcher, path: string): Promise<unknown> {
  const response = await binding.fetch(new Request(new URL(path, 'https://dependency.internal'), {
    method: 'GET', signal: AbortSignal.timeout(3_000),
  }))
  const payload = await readProviderResponse(response)
  return Object.freeze({ ok: response.ok && isRecord(payload) && payload.ok === true, status: response.status })
}

async function probeCapabilities(
  binding: Fetcher,
  hostname: string,
  expectedContract: string,
  requiredOperations: readonly string[],
): Promise<unknown> {
  const response = await binding.fetch(new Request(`https://${hostname}/v1/capabilities`, {
    method: 'GET',
    signal: AbortSignal.timeout(3_000),
  }))
  const payload = await readProviderResponse(response)
  const operations = hasProviderContract(payload, expectedContract) && Array.isArray(payload.operations)
    ? payload.operations
    : []
  const missing = requiredOperations.filter((operation) => !operations.includes(operation))
  return Object.freeze({ ok: response.ok && missing.length === 0, missing })
}

async function probeRuntimeEvidence(
  binding: Fetcher,
  hostname: string,
  expectedContract: string,
  evidencePinJson: string,
  requiredChecks: readonly string[],
): Promise<unknown> {
  const response = await binding.fetch(new Request(`https://${hostname}/v1/runtime-evidence`, {
    method: 'GET',
    signal: AbortSignal.timeout(3_000),
  }))
  const payload = await readProviderResponse(response)
  const result = await verifyUpstreamRuntimeEvidence(
    payload,
    expectedContract,
    readUpstreamEvidencePin(evidencePinJson),
    requiredChecks,
  )
  return Object.freeze({ ...result, status: response.status, ok: response.ok && result.ok === true })
}

async function proxyJson(
  binding: Fetcher,
  path: string,
  requestId: string,
  expectedContract: string,
): Promise<Response> {
  const response = await binding.fetch(new Request(new URL(path, 'https://dependency.internal'), {
    method: 'GET',
    signal: AbortSignal.timeout(DEPENDENCY_REQUEST_TIMEOUT_MS),
  }))
  const payload = await readProviderResponse(response)
  return hasProviderContract(payload, expectedContract)
    ? respond(payload, requestId, response.status)
    : respond(reject('provider_contract_mismatch'), requestId, 502)
}

async function readProviderResponse(response: Response): Promise<unknown> {
  const payload = await readJsonResponse(response, MAXIMUM_PROVIDER_RESPONSE_BYTES)
  return isHttpFailure(payload) ? reject(payload.code) : payload
}

async function check(name: string, operation: () => Promise<unknown>): Promise<Readonly<{ name: string; ok: boolean; detail?: unknown; code?: string }>> {
  try {
    const detail = await operation()
    return Object.freeze({ name, ok: resultOk(detail), detail })
  } catch (error) {
    return Object.freeze({ name, ok: false, code: classifyError(error) })
  }
}

function resultOk(value: unknown): boolean {
  return isRecord(value) && value.ok === true
}

function respond(value: unknown, requestId: string, status = 200): Response {
  const response = jsonResponse({ requestId, ...asResponseRecord(value) }, status)
  response.headers.set('x-request-id', requestId)
  return response
}

function asResponseRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { ok: false, code: 'invalid_internal_result' }
}

function reject(code: string): Readonly<{ ok: false; code: string }> {
  return Object.freeze({ ok: false, code })
}

function classifyError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown_error'
  if (error.message.includes('pin')) return 'dependency_pin_mismatch'
  if (error.message.includes('catalog')) return 'invocation_catalog_unavailable'
  if (error.message.includes('MCP')) return 'mcp_dependency_unavailable'
  return 'dependency_unavailable'
}
