import { isHttpFailure, isRecord, readJsonObject } from '../shared/http.js'
import { AGENT_REGISTRY_CLAIM } from '../domain/authoring-claim-policy.js'
import { isFieldChange, isMergedState, mergeSequences } from './sync-merge.js'
import {
  checkout,
  claimAction,
  deployMerchantTheme,
  merchantCatalog,
  publicAgents,
  registerAgent,
  revenuePeriod,
  routeIntent,
} from './core-actions.js'
import { admitOperatorMutation, reserveOperatorMutation } from './authoring-mutation.js'
import { registryStub, revenueLedgerStub } from './core-clients.js'
import { reject, respond, resultOk } from './core-http-utils.js'
import {
  authorizeCapabilityAction,
  readiness,
  resolvePresentedInvocations,
} from './core-readiness.js'
import {
  proxyMarketplaceSettlement,
  proxyMarketplaceVendors,
  proxyVendorTransition,
} from './marketplace-provider-client.js'
import { agentDeregistrationMutationIntent } from './agent-registry.js'
import { releaseBoundaryProjection } from './release-boundary-projection.js'
import { takeRateConfigurationFailure } from './take-rate.js'
import { currentTheme } from './theme-deployment.js'

const EDGE_CORE_CONTRACT = 'commerce.edge-core/v1'

export async function handleCoreRequest(request: Request, env: CoreEnv, requestId: string): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === 'GET' && url.pathname === '/internal/livez') {
    return respond({
      ok: true,
      contract: 'commerce.core-live/v1',
      lane: env.DEPLOY_LANE,
      releaseCandidateSha: env.RELEASE_CANDIDATE_SHA,
      releaseCandidateDigest: env.RELEASE_CANDIDATE_DIGEST,
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
  if (request.headers.get('x-commerce-release-candidate-digest') !== env.RELEASE_CANDIDATE_DIGEST) {
    return respond(reject('release_candidate_digest_mismatch'), requestId, 409)
  }
  const takeRateFailure = takeRateConfigurationFailure(env.AG_TAKE_RATE_BASIS_POINTS)
  if (takeRateFailure) return respond(takeRateFailure, requestId, 503)

  if (request.method === 'POST' && url.pathname === '/internal/v1/invocations/resolve') {
    const body = await readJsonObject(request)
    if (isHttpFailure(body)) return respond(body, requestId, 400)
    const tokens = Array.isArray(body.tokens) ? body.tokens : null
    if (!tokens || tokens.some((token) => typeof token !== 'string') || tokens.length > 500) {
      return respond(reject('invocation_tokens_malformed'), requestId, 400)
    }
    const result = await resolvePresentedInvocations(env, tokens as string[])
    const status = isRecord(result) && result.code === 'invocation_catalog_unavailable' ? 503 : 200
    return respond(result, requestId, status)
  }
  if (request.method === 'POST' && url.pathname === '/internal/v1/invocations/authorize') {
    const body = await readJsonObject(request)
    if (isHttpFailure(body)
      || Object.keys(body).length !== 1
      || typeof body.capabilityAction !== 'string') {
      return respond(reject('invocation_capability_request_malformed'), requestId, 400)
    }
    const result = await authorizeCapabilityAction(env, body.capabilityAction)
    const status = isRecord(result) && result.ok === true
      ? 200
      : isRecord(result) && result.code === 'invocation_capability_unmapped' ? 400 : 503
    return respond(result, requestId, status)
  }
  if (url.pathname === '/internal/v1/agents') {
    if (request.method === 'GET') return respond(await registryStub(env).list(), requestId)
    if (request.method === 'POST') return registerAgent(request, env, requestId)
  }
  if (request.method === 'GET' && url.pathname === '/internal/v1/public/agents') {
    return publicAgents(env, requestId)
  }
  const agentMatch = url.pathname.match(/^\/internal\/v1\/agents\/([^/]+)$/u)
  if (request.method === 'DELETE' && agentMatch) {
    const mutationAdmission = await admitOperatorMutation(request, env, requestId, AGENT_REGISTRY_CLAIM)
    if (mutationAdmission) return mutationAdmission
    const body = await readJsonObject(request)
    if (isHttpFailure(body)) return respond(body, requestId, 400)
    const agentId = decodeURIComponent(agentMatch[1] ?? '')
    const expectedContentHash = typeof body.expectedContentHash === 'string' ? body.expectedContentHash : ''
    const reserved = await reserveOperatorMutation(
      request,
      env,
      requestId,
      AGENT_REGISTRY_CLAIM,
      agentDeregistrationMutationIntent(agentId, expectedContentHash),
    )
    if (!reserved.ok) return reserved.response
    const result = await registryStub(env).deregister(
      agentId,
      expectedContentHash,
      reserved.reservation.permit,
    )
    if (!await reserved.reservation.finish()) {
      return respond(reject('authoring_mutation_completion_failed'), requestId, 503)
    }
    return respond(result, requestId, resultOk(result) ? 200 : 409)
  }
  if (request.method === 'GET' && url.pathname === '/internal/v1/registry/events') {
    return respond(await registryStub(env).events(
      Number(url.searchParams.get('after') ?? 0),
      Number(url.searchParams.get('limit') ?? 100),
    ), requestId)
  }
  if (request.method === 'POST' && url.pathname === '/internal/v1/intents/route') {
    return routeIntent(request, env, requestId)
  }
  const checkoutMatch = url.pathname.match(/^\/internal\/v1\/checkouts\/([^/]+)(?:\/(prepare|confirm))?$/u)
  if (checkoutMatch) {
    return checkout(request, env, requestId, decodeURIComponent(checkoutMatch[1] ?? ''), checkoutMatch[2] ?? '')
  }
  if (request.method === 'GET' && url.pathname === '/internal/v1/revenue') {
    return revenuePeriod(url, env, requestId)
  }
  if (request.method === 'GET' && url.pathname === '/internal/v1/revenue/demand-evidence') {
    return respond(await revenueLedgerStub(env).demandEvidence(), requestId)
  }
  if (request.method === 'GET' && url.pathname === '/internal/v1/release-boundaries') {
    return respond({ ok: true, register: releaseBoundaryProjection() }, requestId)
  }
  const themeMatch = url.pathname.match(/^\/internal\/v1\/operator\/merchants\/([^/]+)\/theme$/u)
  if (request.method === 'POST' && themeMatch) {
    return deployMerchantTheme(request, env, requestId, decodeURIComponent(themeMatch[1] ?? ''))
  }
  const currentThemeMatch = url.pathname.match(/^\/internal\/v1\/merchants\/([^/]+)\/theme$/u)
  if (request.method === 'GET' && currentThemeMatch) {
    const theme = await currentTheme(env, decodeURIComponent(currentThemeMatch[1] ?? ''))
    return theme ? respond({ ok: true, record: theme }, requestId) : respond(reject('theme_deployment_not_found'), requestId, 404)
  }
  const catalogMatch = url.pathname.match(/^\/internal\/v1\/merchants\/([^/]+)\/catalog(?:\/([^/]+))?$/u)
  if (request.method === 'GET' && catalogMatch) {
    return merchantCatalog(
      env,
      requestId,
      decodeURIComponent(catalogMatch[1] ?? ''),
      catalogMatch[2] ? decodeURIComponent(catalogMatch[2]) : url.searchParams.get('listingId'),
    )
  }
  const claimMatch = url.pathname.match(/^\/internal\/v1\/operator\/claims\/(acquire|release|admit|status)$/u)
  if (request.method === 'POST' && claimMatch) return claimAction(request, env, requestId, claimMatch[1] ?? '')
  if (request.method === 'POST' && url.pathname === '/internal/v1/sync/merge') {
    return mergeSyncRequest(request, requestId)
  }
  const vendorMatch = url.pathname.match(/^\/internal\/v1\/vendors\/([^/]+)\/transition$/u)
  if (request.method === 'POST' && vendorMatch) {
    return proxyVendorTransition(request, env, requestId, decodeURIComponent(vendorMatch[1] ?? ''))
  }
  if (request.method === 'GET' && url.pathname === '/internal/v1/vendors') {
    return proxyMarketplaceVendors(env, requestId)
  }
  const settlementMatch = url.pathname.match(/^\/internal\/v1\/settlements\/([^/]+)$/u)
  if (request.method === 'GET' && settlementMatch) {
    return proxyMarketplaceSettlement(
      env,
      requestId,
      decodeURIComponent(settlementMatch[1] ?? ''),
    )
  }
  return respond(reject('not_found'), requestId, 404)
}

async function mergeSyncRequest(request: Request, requestId: string): Promise<Response> {
  const body = await readJsonObject(request)
  if (isHttpFailure(body)
    || !isMergedState(body.base)
    || !Array.isArray(body.left)
    || !body.left.every(isFieldChange)
    || !Array.isArray(body.right)
    || !body.right.every(isFieldChange)) return respond(reject('sync_merge_malformed'), requestId, 400)
  return respond({
    ok: true,
    state: mergeSequences(body.base, body.left, body.right),
  }, requestId)
}
