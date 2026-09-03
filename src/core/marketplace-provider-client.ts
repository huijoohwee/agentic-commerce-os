import { vendorTransitionClaim } from '../domain/authoring-claim-policy.ts'
import { isHttpFailure, readJsonObject, readJsonResponse } from '../shared/http.ts'
import { admitOperatorMutation, reserveOperatorMutation } from './authoring-mutation.ts'
import { responseMatchesAuthoringMutation } from './authoring-mutation-headers.ts'
import { reject, respond } from './core-http-utils.ts'
import { MARKETPLACE_PROVIDER_CONTRACT } from './provider-contract.ts'
import {
  classifyVendorTransition,
  exactProviderError,
  isVendorState,
  validSettlement,
  validVendorList,
} from './marketplace-provider-response.ts'
import {
  prepareMarketplaceProviderOperation,
  responseMatchesOperationalEvidence,
} from './provider-operation-gate.ts'
import { prepareAuthenticatedMarketplaceVendorTransitionRequest } from './marketplace-transition-request.ts'
export { prepareAuthenticatedMarketplaceVendorTransitionRequest } from './marketplace-transition-request.ts'

const PROVIDER_TIMEOUT_MS = 10_000
const MAXIMUM_PROVIDER_RESPONSE_BYTES = 1_000_000
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  const exact = [...expected].sort()
  return keys.length === exact.length && keys.every((key, index) => key === exact[index])
}

export async function proxyMarketplaceVendors(env: CoreEnv, requestId: string): Promise<Response> {
  const operation = await prepareMarketplaceProviderOperation(env, new Request(
    'https://marketplace.internal/v1/vendors', {
      method: 'GET',
      headers: { accept: 'application/json', 'x-commerce-contract': MARKETPLACE_PROVIDER_CONTRACT },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    },
  ))
  if (!operation.ok) return respond(reject(operation.code), requestId, 503)
  try {
    const response = await env.MARKETPLACE_PROVIDER.fetch(operation.request)
    if (!responseMatchesOperationalEvidence(response, operation.binding)) {
      await response.body?.cancel('marketplace evidence binding mismatch')
      return respond(reject('marketplace_provider_evidence_binding_mismatch'), requestId, 502)
    }
    const payload = await readJsonResponse(response, MAXIMUM_PROVIDER_RESPONSE_BYTES)
    return validVendorList(response.status, payload)
      ? respond(payload, requestId, 200)
      : respond(reject('marketplace_provider_contract_mismatch'), requestId, 502)
  } catch {
    return respond(reject('marketplace_provider_unavailable'), requestId, 503)
  }
}

export async function proxyVendorTransition(
  request: Request,
  env: CoreEnv,
  requestId: string,
  vendorId: string,
): Promise<Response> {
  if (!IDENTIFIER_PATTERN.test(vendorId)) return respond(reject('vendor_id_malformed'), requestId, 400)
  const expectedClaim = vendorTransitionClaim(vendorId)
  const mutationAdmission = await admitOperatorMutation(request, env, requestId, expectedClaim)
  if (mutationAdmission) return mutationAdmission
  const body = await readJsonObject(request)
  if (isHttpFailure(body)) return respond(body, requestId, 400)
  if (!exactKeys(body, ['actorId', 'state'])
    || !IDENTIFIER_PATTERN.test(String(body.actorId))
    || !isVendorState(body.state)) return respond(reject('vendor_transition_malformed'), requestId, 400)
  const actorId = String(body.actorId)
  const state = body.state
  const reserved = await reserveOperatorMutation(
    request, env, requestId, expectedClaim, { vendorId, actorId, state },
  )
  if (!reserved.ok) return reserved.response
  const operation = await prepareAuthenticatedMarketplaceVendorTransitionRequest(env, {
    vendorId, actorId, state, permit: reserved.reservation.permit,
  })
  if (!operation.ok) return respond(reject(operation.code), requestId, 503)
  let upstream: Response
  try {
    upstream = await env.MARKETPLACE_PROVIDER.fetch(operation.request)
  } catch {
    return respond(reject('marketplace_provider_unavailable'), requestId, 503)
  }
  if (!responseMatchesOperationalEvidence(upstream, operation.binding)) {
    await upstream.body?.cancel('marketplace evidence binding mismatch')
    return respond(reject('marketplace_provider_evidence_binding_mismatch'), requestId, 502)
  }
  if (!responseMatchesAuthoringMutation(upstream, reserved.reservation.permit)) {
    await upstream.body?.cancel('marketplace fence mismatch')
    return respond(reject('marketplace_provider_fence_unconfirmed'), requestId, 502)
  }
  const payload = await readJsonResponse(upstream, MAXIMUM_PROVIDER_RESPONSE_BYTES)
  const classification = classifyVendorTransition(
    upstream.status, payload, vendorId, actorId, state, reserved.reservation.permit.mutationId,
  )
  if (classification === 'invalid') {
    return respond(reject(upstream.status >= 500
      ? 'marketplace_provider_unavailable' : 'marketplace_provider_contract_mismatch'), requestId,
    upstream.status >= 500 ? 503 : 502)
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
  if (!IDENTIFIER_PATTERN.test(splitId)) return respond(reject('settlement_id_malformed'), requestId, 400)
  const operation = await prepareMarketplaceProviderOperation(env, new Request(
    `https://marketplace.internal/v1/settlements/${encodeURIComponent(splitId)}`, {
      method: 'GET',
      headers: { accept: 'application/json', 'x-commerce-contract': MARKETPLACE_PROVIDER_CONTRACT },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
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
    await upstream.body?.cancel('marketplace evidence binding mismatch')
    return respond(reject('marketplace_provider_evidence_binding_mismatch'), requestId, 502)
  }
  const payload = await readJsonResponse(upstream, MAXIMUM_PROVIDER_RESPONSE_BYTES)
  if (validSettlement(upstream.status, payload, splitId)
    || exactProviderError(upstream.status, payload, 404, 'settlement_not_found')) {
    return respond(payload, requestId, upstream.status)
  }
  return respond(reject(upstream.status >= 500
    ? 'marketplace_provider_unavailable' : 'marketplace_provider_contract_mismatch'), requestId,
  upstream.status >= 500 ? 503 : 502)
}
