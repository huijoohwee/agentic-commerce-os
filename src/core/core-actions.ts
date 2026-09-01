import { readRoutingIntent, type RoutingIntent } from '../domain/exclusive-category-router.js'
import {
  AGENT_REGISTRY_CLAIM,
  merchantThemeClaim,
  vendorTransitionClaim,
  readClaimMutationRequest,
} from '../domain/authoring-claim-policy.js'
import { isHttpFailure, isRecord, readJsonObject } from '../shared/http.js'
import {
  requestAcosAdmission,
  type AcosAdmissionInputs,
} from './acos-admission.js'
import {
  agentRegistrationMutationIntent,
  invocationAligned,
  type AgentRegistryRecord,
  type AgentRegistrationInput,
  type AgentRegistrationIntent,
  type InvocationPinProof,
} from './agent-registry.js'
import type { Claim } from './authoring-claim.js'
import { checkoutInputFieldsAllowed, exactCheckoutConfirmInput, exactCheckoutPrepareInput } from './checkout-input.js'
import {
  authoringClaimStub,
  checkoutSessionStub,
  intentRouteStub,
  registryStub,
  revenueLedgerStub,
} from './core-clients.js'
import { reject, readProviderResponse, respond, resultOk } from './core-http-utils.js'
import {
  configuredInvocationProof,
  configuredTokens,
  invocationProofFromResolution,
  readSelectionPolicyFromEnv,
  resolvePinnedInvocations,
} from './core-readiness.js'
import { normalizeDiscoveryReceipt, type DiscoveryOfferReceipt } from './discovery-receipt.js'
import { projectMerchantCatalog, readListing, type MerchantListing } from './merchant-catalog.js'
import { projectPublicCatalog } from './public-catalog.js'
import { MARKETPLACE_PROVIDER_CONTRACT } from './provider-contract.js'
import { admitOperatorMutation, reserveOperatorMutation } from './authoring-mutation.js'
import {
  authoringMutationHeaders,
  responseMatchesAuthoringMutation,
} from './authoring-mutation-headers.ts'
import {
  prepareMarketplaceProviderOperation,
  responseMatchesOperationalEvidence,
} from './provider-operation-gate.js'
import { runRegistrationDryRun } from './sandbox-registration.js'
import { activatePreparedTheme, currentTheme, prepareThemeDeployment } from './theme-deployment.js'
import { themeActivationMutationIntent } from './theme-deployment-store.js'
import { readUpstreamEvidencePin } from './upstream-evidence.js'

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const DEPENDENCY_REQUEST_TIMEOUT_MS = 10_000

export async function registerAgent(request: Request, env: CoreEnv, requestId: string): Promise<Response> {
  const body = await readJsonObject(request)
  if (isHttpFailure(body)) return respond(body, requestId, 400)
  const allowedFields = new Set([
    'agentDefinition', 'toolAllowlistEntry', 'invocationRegisterEntry', 'operatorInstructionRef',
    'commerceProjection', 'expectedPreviousContentHash',
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
  const mutationAdmission = await admitOperatorMutation(request, env, requestId, AGENT_REGISTRY_CLAIM)
  if (mutationAdmission) return mutationAdmission
  const admissionInputs: AcosAdmissionInputs = {
    agentDefinition: body.agentDefinition,
    toolAllowlistEntry: body.toolAllowlistEntry,
    invocationRegisterEntry: body.invocationRegisterEntry,
    operatorInstructionRef: body.operatorInstructionRef,
  }
  const dryRun = await runRegistrationDryRun(env, body.agentDefinition, body.toolAllowlistEntry)
  if (!dryRun.ok) {
    const status = dryRun.code === 'registration_dry_run_invalid'
      ? 400
      : dryRun.code === 'registration_dry_run_rejected' ? 409 : 503
    return respond(dryRun, requestId, status)
  }
  let invocationProof: InvocationPinProof
  try {
    const tokens = configuredTokens(env)
    invocationProof = invocationProofFromResolution(await resolvePinnedInvocations(env, tokens), tokens)
  } catch {
    return respond(reject('invocation_catalog_unavailable'), requestId, 503)
  }
  const intent: AgentRegistrationIntent = Object.freeze({
    admissionInputs,
    invocationProof,
    commerceProjection: body.commerceProjection,
    expectedPreviousContentHash: body.expectedPreviousContentHash,
    sandboxDryRun: dryRun.record,
  })
  const reserved = await reserveOperatorMutation(
    request,
    env,
    requestId,
    AGENT_REGISTRY_CLAIM,
    agentRegistrationMutationIntent(intent),
  )
  if (!reserved.ok) return reserved.response
  const registry = registryStub(env)
  const preflight = await registry.preflightRegistration(intent)
  if (!resultOk(preflight)) {
    if (!await reserved.reservation.finish()) {
      return respond(reject('authoring_mutation_completion_failed'), requestId, 503)
    }
    return respond(preflight, requestId, 409)
  }
  const admission = await requestAcosAdmission(
    env.ACOS_ADMISSION,
    admissionInputs,
    reserved.reservation.permit,
  )
  if (!admission.ok) {
    if (admission.reservationSafeToComplete && !await reserved.reservation.finish()) {
      return respond(reject('authoring_mutation_completion_failed'), requestId, 503)
    }
    const status = admission.code === 'acos_admission_rejected'
      ? 409
      : admission.code === 'acos_admission_provider_unavailable' ? 503 : 502
    return respond(admission, requestId, status)
  }
  const input: AgentRegistrationInput = {
    ...intent,
    admissionReceipt: admission.receipt,
  }
  const result = await registry.register(input, reserved.reservation.permit)
  if (!await reserved.reservation.finish()) {
    return respond(reject('authoring_mutation_completion_failed'), requestId, 503)
  }
  return respond(result, requestId, resultOk(result) ? 200 : 409)
}

export async function routeIntent(request: Request, env: CoreEnv, requestId: string): Promise<Response> {
  const body = await readJsonObject(request)
  if (isHttpFailure(body)) return respond(body, requestId, 400)
  const intent = readRoutingIntent(body)
  if (!intent) return respond(reject('intent_malformed'), requestId, 400)
  const registry = registryStub(env)
  const invocationProof = configuredInvocationProof(env)
  const selectionPolicy = readSelectionPolicyFromEnv(env)
  if (!selectionPolicy) return respond(reject('selection_policy_invalid'), requestId, 503)
  const merchantTarget = await resolveMerchantRouteTarget(env, registry, intent, invocationProof)
  if (!merchantTarget.ok) return respond(reject(merchantTarget.code), requestId, merchantTarget.status)
  const decision: unknown = await registry.route(
    intent,
    invocationProof,
    selectionPolicy,
    merchantTarget.agentId === null ? null : Object.freeze({
      pinnedAgentId: merchantTarget.agentId,
      fallbackAgentId: merchantTarget.fallbackAgentId,
    }),
  )
  const decisionFallbackId = isRecord(decision) && decision.fallbackAgentId === null
    ? null
    : isRecord(decision) && typeof decision.fallbackAgentId === 'string'
      ? decision.fallbackAgentId
      : undefined
  if (!isRecord(decision)
    || decision.status !== 'dispatch'
    || typeof decision.agentId !== 'string'
    || decisionFallbackId === undefined) {
    return respond(decision, requestId, 422)
  }
  if (merchantTarget.agentId !== null && (
    decision.agentId !== merchantTarget.agentId
    || decisionFallbackId !== merchantTarget.fallbackAgentId
  )) return respond(reject('registry_route_drift'), requestId, 503)
  const snapshot = await registry.list()
  const agent = eligibleRouteAgent(snapshot.agents, decision.agentId, intent.category, invocationProof)
  if (!agent) return respond(reject('registry_route_drift'), requestId, 503)
  const fallbackAgent = decisionFallbackId === null
    ? null
    : eligibleRouteAgent(snapshot.agents, decisionFallbackId, intent.category, invocationProof)
  if (decisionFallbackId !== null && !fallbackAgent) {
    return respond(reject('registry_route_drift'), requestId, 503)
  }
  const result = await intentRouteStub(env, intent.intentId).dispatch({ intent, agent, fallbackAgent })
  return respond(result, requestId, resultOk(result) ? 200 : 503)
}

export async function checkout(
  request: Request,
  env: CoreEnv,
  requestId: string,
  checkoutId: string,
  action: string,
): Promise<Response> {
  if (!IDENTIFIER_PATTERN.test(checkoutId)) return respond(reject('checkout_id_malformed'), requestId, 400)
  const session = checkoutSessionStub(env, checkoutId)
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
    const rejectedPreparation = await validateCheckoutPreparation(body, env, requestId)
    if (rejectedPreparation) return rejectedPreparation
  }
  const result = action === 'prepare'
    ? await session.prepare(exactCheckoutPrepareInput(body, checkoutId, String(body.offerProviderRevision)))
    : await session.confirm(exactCheckoutConfirmInput(body, checkoutId))
  return respond(result, requestId, resultOk(result) ? 200 : 409)
}

export async function publicAgents(env: CoreEnv, requestId: string): Promise<Response> {
  return respond(projectPublicCatalog(await registryStub(env).list()), requestId)
}

export async function merchantCatalog(
  env: CoreEnv,
  requestId: string,
  merchantId: string,
  listingId: string | null,
): Promise<Response> {
  if (!IDENTIFIER_PATTERN.test(merchantId)) return respond(reject('merchant_id_malformed'), requestId, 400)
  const theme = await currentTheme(env, merchantId)
  if (!theme) return respond(reject('theme_deployment_not_found'), requestId, 404)
  const listings = activeMerchantListings(await registryStub(env).list())
  const projected = projectMerchantCatalog(listings, theme.resolvedCatalogScope)
  if (listingId !== null) {
    const listing = readListing(projected, theme.resolvedCatalogScope, listingId)
    return listing ? respond({ ok: true, listing }, requestId) : respond(reject('listing_not_found'), requestId, 404)
  }
  return respond({ ok: true, merchantId, manifestDigest: theme.manifestDigest, listings: projected }, requestId)
}

type MerchantRouteTarget = Readonly<{ ok: true; agentId: string | null; fallbackAgentId: string | null }>
  | Readonly<{ ok: false; code: string; status: 404 | 409 }>

async function resolveMerchantRouteTarget(
  env: CoreEnv,
  registry: ReturnType<typeof registryStub>,
  intent: RoutingIntent,
  invocationProof: InvocationPinProof,
): Promise<MerchantRouteTarget> {
  if (!intent.merchantId || !intent.listingId) {
    return Object.freeze({ ok: true, agentId: null, fallbackAgentId: null })
  }
  const theme = await currentTheme(env, intent.merchantId)
  if (!theme) return Object.freeze({ ok: false, code: 'theme_deployment_not_found', status: 404 })
  const snapshot = await registry.list()
  const listings = activeMerchantListings(snapshot)
  const listing = readListing(listings, theme.resolvedCatalogScope, intent.listingId)
  if (!listing) return Object.freeze({ ok: false, code: 'listing_not_found', status: 404 })
  if (listing.category !== intent.category) {
    return Object.freeze({ ok: false, code: 'merchant_listing_category_mismatch', status: 409 })
  }
  const fallback = resolveEligibleMerchantFallback(
    snapshot.agents,
    listing.owningAgentId,
    intent.category,
    theme.resolvedCatalogScope,
    invocationProof,
  )
  return Object.freeze({
    ok: true,
    agentId: listing.owningAgentId,
    fallbackAgentId: fallback?.agentId ?? null,
  })
}

export function resolveEligibleMerchantFallback(
  agents: readonly AgentRegistryRecord[],
  ownerAgentId: string,
  category: string,
  resolvedCatalogScope: readonly string[],
  invocationProof: InvocationPinProof,
): AgentRegistryRecord | null {
  const scope = new Set(resolvedCatalogScope)
  if (!scope.has(ownerAgentId)) return null
  const owner = eligibleRouteAgent(agents, ownerAgentId, category, invocationProof)
  const fallbackAgentId = owner?.fallbackAgentId ?? null
  if (!fallbackAgentId || fallbackAgentId === ownerAgentId || !scope.has(fallbackAgentId)) return null
  return eligibleRouteAgent(agents, fallbackAgentId, category, invocationProof)
}

function eligibleRouteAgent(
  agents: readonly AgentRegistryRecord[],
  agentId: string,
  category: string,
  invocationProof: InvocationPinProof,
): AgentRegistryRecord | null {
  return agents.find((candidate) => (
    candidate.agentId === agentId
    && candidate.category === category
    && candidate.registrationState === 'active'
    && candidate.admissionVerified
    && invocationAligned(candidate, invocationProof)
  )) ?? null
}

function activeMerchantListings(snapshot: Awaited<ReturnType<ReturnType<typeof registryStub>['list']>>): MerchantListing[] {
  return projectPublicCatalog(snapshot).agents.map((agent) => Object.freeze({
    listingId: agent.agentId,
    owningAgentId: agent.agentId,
    category: agent.declaredCategory,
    capabilities: agent.declaredCapabilities,
  }))
}

export async function deployMerchantTheme(
  request: Request,
  env: CoreEnv,
  requestId: string,
  merchantId: string,
): Promise<Response> {
  if (!IDENTIFIER_PATTERN.test(merchantId)) return respond(reject('merchant_id_malformed'), requestId, 400)
  const admission = await admitOperatorMutation(request, env, requestId, merchantThemeClaim(merchantId))
  if (admission) return admission
  const body = await readJsonObject(request)
  if (isHttpFailure(body)) return respond(body, requestId, 400)
  const prepared = await prepareThemeDeployment(env, merchantId, body)
  if (!prepared.ok) return respond(prepared, requestId, 409)
  const reserved = await reserveOperatorMutation(
    request,
    env,
    requestId,
    merchantThemeClaim(merchantId),
    themeActivationMutationIntent(prepared.record),
  )
  if (!reserved.ok) return reserved.response
  const result = await activatePreparedTheme(env, prepared, reserved.reservation.permit)
  if (!await reserved.reservation.finish()) {
    return respond(reject('authoring_mutation_completion_failed'), requestId, 503)
  }
  return respond(result, requestId, resultOk(result) ? 200 : 409)
}

export async function revenuePeriod(url: URL, env: CoreEnv, requestId: string): Promise<Response> {
  const start = Number(url.searchParams.get('start'))
  const end = Number(url.searchParams.get('end'))
  const result = await revenueLedgerStub(env).readPeriod(start, end)
  return respond(result, requestId, resultOk(result) ? 200 : 400)
}

export async function claimAction(
  request: Request,
  env: CoreEnv,
  requestId: string,
  action: string,
): Promise<Response> {
  const body = await readJsonObject(request)
  if (isHttpFailure(body)) return respond(body, requestId, 400)
  if (typeof body.semanticScope !== 'string') return respond(reject('claim_scope_required'), requestId, 400)
  const stub = authoringClaimStub(env, body.semanticScope)
  let result: unknown
  if (action === 'acquire') {
    result = await stub.acquire(body as unknown as Claim)
  } else if (action === 'admit') {
    const admissionRequest = readClaimMutationRequest(body)
    if (!admissionRequest) return respond(reject('claim_admission_request_malformed'), requestId, 400)
    result = await stub.admitMutation(admissionRequest)
  } else if (action === 'status') {
    result = await stub.mutationStatus(body.semanticScope)
  } else if (action === 'release') {
    const headerScope = request.headers.get('x-authoring-semantic-scope') ?? ''
    const headerClaimId = request.headers.get('x-authoring-claim-id') ?? ''
    const headerLeaseEpoch = readLeaseEpochHeader(request)
    const headerFenceRevision = request.headers.get('x-authoring-fence-revision') ?? ''
    if (body.semanticScope !== headerScope
      || body.claimId !== headerClaimId
      || body.leaseEpoch !== headerLeaseEpoch
      || body.fenceRevision !== headerFenceRevision) {
      return respond(reject('claim_release_authority_mismatch'), requestId, 409)
    }
    result = await stub.release(body.semanticScope, headerClaimId, headerLeaseEpoch, headerFenceRevision)
  } else {
    return respond(reject('not_found'), requestId, 404)
  }
  return respond(result, requestId, resultOk(result) ? 200 : 409)
}

export async function proxyVendorTransition(
  request: Request,
  env: CoreEnv,
  requestId: string,
  vendorId: string,
): Promise<Response> {
  if (!IDENTIFIER_PATTERN.test(vendorId)) return respond(reject('vendor_id_malformed'), requestId, 400)
  const mutationAdmission = await admitOperatorMutation(request, env, requestId, vendorTransitionClaim(vendorId))
  if (mutationAdmission) return mutationAdmission
  const body = await readJsonObject(request)
  if (isHttpFailure(body)) return respond(body, requestId, 400)
  if (typeof body.actorId !== 'string' || typeof body.state !== 'string') {
    return respond(reject('vendor_transition_malformed'), requestId, 400)
  }
  const operation = await prepareMarketplaceProviderOperation(env, new Request(
    `https://marketplace.internal/v1/vendors/${encodeURIComponent(vendorId)}/transition`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-commerce-contract': MARKETPLACE_PROVIDER_CONTRACT,
        'x-operator-id': body.actorId,
      },
      body: JSON.stringify({ state: body.state }),
      signal: AbortSignal.timeout(DEPENDENCY_REQUEST_TIMEOUT_MS),
  }))
  if (!operation.ok) return respond(reject(operation.code), requestId, 503)
  const reserved = await reserveOperatorMutation(
    request,
    env,
    requestId,
    vendorTransitionClaim(vendorId),
    { vendorId, actorId: body.actorId, state: body.state },
  )
  if (!reserved.ok) return reserved.response
  const fencedHeaders = new Headers(operation.request.headers)
  for (const [name, value] of Object.entries(authoringMutationHeaders(reserved.reservation.permit))) {
    fencedHeaders.set(name, value)
  }
  const fencedRequest = new Request(operation.request, { headers: fencedHeaders })
  let upstream: Response
  try {
    upstream = await env.MARKETPLACE_PROVIDER.fetch(fencedRequest)
  } catch {
    return respond(reject('marketplace_provider_unavailable'), requestId, 503)
  }
  if (!responseMatchesOperationalEvidence(upstream, operation.binding)) {
    return respond(reject('marketplace_provider_evidence_binding_mismatch'), requestId, 502)
  }
  if (!responseMatchesAuthoringMutation(upstream, reserved.reservation.permit)) {
    return respond(reject('marketplace_provider_fence_unconfirmed'), requestId, 502)
  }
  const payload = await readProviderResponse(upstream).catch(() => null)
  if (!isRecord(payload) || payload.contract !== MARKETPLACE_PROVIDER_CONTRACT) {
    return respond(reject('marketplace_provider_contract_mismatch'), requestId, 502)
  }
  if (!await reserved.reservation.finish()) {
    return respond(reject('authoring_mutation_completion_failed'), requestId, 503)
  }
  return respond(payload, requestId, upstream.status)
}

export async function proxyMarketplaceSettlement(
  env: CoreEnv,
  requestId: string,
  splitId: string,
): Promise<Response> {
  const operation = await prepareMarketplaceProviderOperation(env, new Request(
    `https://marketplace.internal/v1/settlements/${encodeURIComponent(splitId)}`,
    {
      method: 'GET',
      headers: { accept: 'application/json', 'x-commerce-contract': MARKETPLACE_PROVIDER_CONTRACT },
      signal: AbortSignal.timeout(DEPENDENCY_REQUEST_TIMEOUT_MS),
    },
  ))
  if (!operation.ok) return respond(reject(operation.code), requestId, 503)
  let upstream: Response
  try {
    upstream = await env.MARKETPLACE_PROVIDER.fetch(operation.request)
  } catch {
    return respond(reject('marketplace_provider_unavailable'), requestId, 503)
  }
  if (!responseMatchesOperationalEvidence(upstream, operation.binding)) {
    return respond(reject('marketplace_provider_evidence_binding_mismatch'), requestId, 502)
  }
  const payload = await readProviderResponse(upstream).catch(() => null)
  return isRecord(payload) && payload.contract === MARKETPLACE_PROVIDER_CONTRACT
    ? respond(payload, requestId, upstream.status)
    : respond(reject('marketplace_provider_contract_mismatch'), requestId, 502)
}

function readLeaseEpochHeader(request: Request): number {
  const value = request.headers.get('x-authoring-lease-epoch') ?? ''
  if (!/^[1-9]\d*$/u.test(value)) return 0
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : 0
}

async function validateCheckoutPreparation(
  body: Record<string, unknown>,
  env: CoreEnv,
  requestId: string,
): Promise<Response | null> {
  if (typeof body.intentId !== 'string'
    || typeof body.agentId !== 'string'
    || typeof body.offerId !== 'string'
    || typeof body.offerReceiptDigest !== 'string'
    || !Number.isSafeInteger(body.amountMinor)
    || typeof body.currency !== 'string') {
    return respond(reject('checkout_routing_evidence_malformed'), requestId, 400)
  }
  const routeStatus: unknown = await intentRouteStub(env, body.intentId).status()
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
  const registered = (await registryStub(env).list()).agents.some((agent) => (
    agent.registrationState === 'active' && agent.admissionVerified && agent.agentId === body.agentId
  ))
  if (!registered) return respond(reject('checkout_agent_not_registered'), requestId, 409)
  body.offerProviderRevision = offer.providerRevision
  return null
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
  const candidate = receipt.offers.find((offer) => isRecord(offer) && offer.receiptDigest === request.offerReceiptDigest)
  if (!isRecord(candidate) || typeof candidate.intentDigest !== 'string') return null
  try {
    const normalized = await normalizeDiscoveryReceipt(receipt, request.intentId, candidate.intentDigest, request.agentId)
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
