import { bearerAuthorized, originAllowed, validateSecretConfiguration } from '../shared/auth'
import { coreRequestTimeoutMs } from '../shared/registration-budget'
import { isHttpFailure, isRecord, jsonResponse, readJsonObject, readJsonResponse } from '../shared/http'
import { rejectLegacyIdentity, type LegacyIdentity } from '../shared/terminology-guard'
import { validateThemeManifest } from '../shared/theme-manifest'
import { STOREFRONT_CLIENT_MODULE } from './client/browser-module'
import { consoleResponse, dashboardResponse, type ConsoleMetadata } from './dashboard'
import {
  edgeExternalHumanPresenceRequired,
  edgeLoopbackAllowed,
  readEdgeDeployLane,
} from './deploy-lane'
import { handleMcpRequest, type CorePayload } from './mcp'
import { attachRouteReadinessHeaders, observeProductionRouteReadiness } from './readiness'
import { prefixedPath, projectEdgeRoute } from './production-prefix'
import { readAuthoringClaimHeaders } from './authoring-headers'
import { confirmHumanCheckout } from './checkout-confirmation-handler'
import { issueHumanConfirmation } from './human-confirmation'
import { readHumanPresenceTrustAnchor } from './human-presence'
import {
  authorizeStorefrontSession,
  issueStorefrontSession,
  validateStorefrontSessionSecret,
  type StorefrontSession,
} from './session'

const EDGE_CORE_CONTRACT = 'commerce.edge-core/v1'
const RUNTIME_LEGACY_IDENTITIES: readonly LegacyIdentity[] = Object.freeze([])
type EdgeRuntimeEnv = EdgeEnv & Readonly<{
  STOREFRONT_SESSION_SECRET?: string
  HUMAN_CONFIRMATION_TRUST_ANCHOR_JSON?: string
}>

export default {
  async fetch(request: Request, env: EdgeRuntimeEnv, context: ExecutionContext): Promise<Response> {
    const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID()
    const route = projectEdgeRoute(new URL(request.url))
    const url = route.url
    try {
      const publicResponse = await routePublic(request, url, env, requestId, route.basePath)
      if (publicResponse) return finalizeResponse(publicResponse, requestId, request, env)

      if (!originAllowed(request, env.ALLOWED_ORIGINS_JSON)) {
        return finalizeResponse(jsonResponse({ ok: false, code: 'origin_forbidden' }, 403), requestId, request, env)
      }
      if (request.method === 'OPTIONS') return preflight(request, env, requestId)
      const legacy = rejectLegacyIdentity(url.pathname, RUNTIME_LEGACY_IDENTITIES)
      if (legacy) return finalizeResponse(jsonResponse(legacy, 409), requestId, request, env)

      const configuration = operationalConfiguration(env)
      if (!configuration.ok) {
        const response = url.pathname === '/mcp' || url.pathname === '/mcp/operator'
          ? Response.json({
            jsonrpc: '2.0',
            error: { code: -32_003, message: 'Runtime configuration is not ready.' },
            id: null,
          }, { status: 503 })
          : jsonResponse({ ok: false, code: 'runtime_configuration_invalid' }, 503)
        return finalizeResponse(response, requestId, request, env)
      }

      if (request.method === 'POST' && url.pathname === '/v1/session') {
        const payload = await readJsonObject(request)
        if (isHttpFailure(payload)
          || payload.purpose !== 'storefront-checkout-preparation'
          || Object.keys(payload).length !== 1) {
          return finalizeResponse(jsonResponse({ ok: false, code: 'storefront_session_request_invalid' }, 400), requestId, request, env)
        }
        const issued = await issueStorefrontSession(
          request,
          env.STOREFRONT_SESSION_SECRET,
          Date.now(),
          edgeLoopbackAllowed(env.DEPLOY_LANE),
        )
        if (!issued) {
          return finalizeResponse(jsonResponse({ ok: false, code: 'storefront_session_refused' }, 403), requestId, request, env)
        }
        const response = jsonResponse({
          ok: true,
          contract: 'agentic-graph-storefront-session/v1',
          expiresAt: new Date(issued.session.expiresAt * 1_000).toISOString(),
          scopes: issued.session.scopes,
        }, 201)
        response.headers.set('set-cookie', issued.cookie)
        return finalizeResponse(response, requestId, request, env)
      }

      const humanConfirmation = url.pathname.match(/^\/v1\/human\/checkouts\/([^/]+)\/confirm$/u)
      if (request.method === 'POST' && humanConfirmation?.[1]) {
        const response = await confirmHumanCheckout(
          request,
          env,
          requestId,
          decodeURIComponent(humanConfirmation[1]),
          (capabilityAction, path, init, id) => authorizedCoreCall(
            env, capabilityAction, path, init, id,
          ),
        )
        return finalizeResponse(response, requestId, request, env)
      }

      if (url.pathname === '/mcp' || url.pathname === '/mcp/operator') {
        const operator = url.pathname === '/mcp/operator'
        const secret = operator ? env.OPERATOR_BEARER_TOKEN : env.MCP_BEARER_TOKEN
        if (!await bearerAuthorized(request, secret)) {
          return finalizeResponse(Response.json({
            jsonrpc: '2.0',
            error: { code: -32_001, message: 'Unauthorized' },
            id: null,
          }, { status: 401 }), requestId, request, env)
        }
        if (request.method !== 'POST') {
          return finalizeResponse(jsonResponse({ ok: false, code: 'method_not_allowed' }, 405), requestId, request, env)
        }
        const response = await handleMcpRequest(
          request,
          context,
          requestId,
          createCorePayload(env, requestId, request, operator),
          operator ? 'operator' : 'agent',
        )
        return finalizeResponse(response, requestId, request, env)
      }

      const target = routeToCore(request, url)
      if (!target) return finalizeResponse(jsonResponse({ ok: false, code: 'not_found' }, 404), requestId, request, env)
      const authorized = await routeAuthorized(request, env, target.authority)
      if (!authorized.ok) {
        return finalizeResponse(jsonResponse({ ok: false, code: authorized.code }, 401), requestId, request, env)
      }
      const authoringClaim = target.authoringClaimRequired ? readAuthoringClaimHeaders(request) : null
      if (authoringClaim && !authoringClaim.ok) {
        return finalizeResponse(jsonResponse({ ok: false, code: authoringClaim.code }, 409), requestId, request, env)
      }
      const body = request.method === 'GET' ? undefined : await readJsonObject(request)
      if (body && isHttpFailure(body)) {
        return finalizeResponse(jsonResponse(body, 400), requestId, request, env)
      }
      const capabilityAuthorization = await authorizeCoreAction(env, target.capabilityAction, requestId)
      if (!capabilityAuthorization.response.ok
        || !isRecord(capabilityAuthorization.payload)
        || capabilityAuthorization.payload.ok !== true) {
        return finalizeResponse(
          jsonResponse(capabilityAuthorization.payload, capabilityAuthorization.response.status),
          requestId,
          request,
          env,
        )
      }
      if (target.checkoutAction === 'confirm') {
        return finalizeResponse(jsonResponse({ ok: false, code: 'human_confirmation_required' }, 409), requestId, request, env)
      }
      if (target.checkoutAction === 'prepare' && authorized.mode === 'agent') {
        return finalizeResponse(jsonResponse({
          ok: false,
          code: 'visual_handoff_required',
          storefrontPath: prefixedPath(route.basePath, '/'),
        }, 409), requestId, request, env)
      }
      const core = await coreCall(env, `${target.path}${target.copySearch ? url.search : ''}`, {
        method: request.method,
        ...(body ? { body: JSON.stringify(body) } : {}),
        ...(target.authority === 'operator' && authoringClaim?.ok
          ? { forwardedHeaders: authoringClaim.headers }
          : {}),
      }, requestId)
      if (target.checkoutAction === 'prepare' && authorized.mode === 'session' && core.response.ok) {
        const trustAnchor = readHumanPresenceTrustAnchor(env.HUMAN_CONFIRMATION_TRUST_ANCHOR_JSON)
        const issued = await issueHumanConfirmation(
          request,
          env.STOREFRONT_SESSION_SECRET,
          body,
          core.payload,
          {
            sessionNonce: authorized.session.nonce,
            trustAnchor,
          },
          Date.now(),
          edgeLoopbackAllowed(env.DEPLOY_LANE),
        )
        if (!issued || !isRecord(core.payload)) {
          return finalizeResponse(
            jsonResponse({ ok: false, code: 'human_confirmation_proof_unavailable' }, 502),
            requestId,
            request,
            env,
          )
        }
        const response = jsonResponse(issued.publicResult, core.response.status)
        response.headers.set('set-cookie', issued.cookie)
        return finalizeResponse(response, requestId, request, env)
      }
      return finalizeResponse(jsonResponse(core.payload, core.response.status), requestId, request, env)
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'commerce_edge_request_failed',
        requestId,
        method: request.method,
        path: url.pathname,
        code: error instanceof Error ? error.name : 'unknown_error',
      }))
      return finalizeResponse(jsonResponse({ ok: false, code: 'internal_error' }, 500), requestId, request, env)
    }
  },
} satisfies ExportedHandler<EdgeRuntimeEnv>

async function routePublic(
  request: Request,
  url: URL,
  env: EdgeRuntimeEnv,
  requestId: string,
  basePath: string,
): Promise<Response | null> {
  if (request.method === 'GET' && url.pathname === '/livez') {
    return jsonResponse({
      ok: true,
      contract: 'commerce.edge-live/v1',
      lane: env.DEPLOY_LANE,
      releaseCandidateSha: env.RELEASE_CANDIDATE_SHA,
      releaseCandidateDigest: env.RELEASE_CANDIDATE_DIGEST,
      version: env.CF_VERSION_METADATA,
    })
  }
  if (request.method === 'GET' && url.pathname === '/') {
    const dashboard = dashboardResponse(metadata(env), { basePath, graphWorkspaceUrl: env.GRAPH_WORKSPACE_URL })
    if (!basePath) return dashboard
    const routeReadiness = await observeProductionRouteReadiness(request, {
      lane: env.DEPLOY_LANE,
      releaseCandidateSha: env.RELEASE_CANDIDATE_SHA,
      releaseCandidateDigest: env.RELEASE_CANDIDATE_DIGEST,
      version: env.CF_VERSION_METADATA,
      configurationOk: operationalConfiguration(env).ok,
    }, async (path) => {
      const core = await coreCall(env, path, { method: 'GET' }, requestId)
      return Object.freeze({ status: core.response.status, payload: core.payload })
    })
    return attachRouteReadinessHeaders(dashboard, routeReadiness)
  }
  if (request.method === 'GET' && url.pathname === '/assets/storefront.js') {
    return new Response(STOREFRONT_CLIENT_MODULE, {
      headers: {
        'cache-control': 'public, max-age=300',
        'content-type': 'text/javascript; charset=utf-8',
        'content-security-policy': "default-src 'none'",
        'x-content-type-options': 'nosniff',
      },
    })
  }
  if (request.method === 'GET' && url.pathname === '/readyz') return readinessResponse(env, requestId)
  if (request.method === 'GET' && url.pathname === '/v1/public/agents') {
    return publicCoreResponse(env, 'catalog.public.read', `/internal/v1/public/agents${url.search}`, requestId)
  }
  const merchantCatalog = url.pathname.match(/^\/v1\/public\/merchants\/([^/]+)\/catalog$/u)
  if (request.method === 'GET' && merchantCatalog?.[1]) {
    return publicCoreResponse(
      env,
      'catalog.merchant.read',
      `/internal/v1/merchants/${encodeURIComponent(decodeURIComponent(merchantCatalog[1]))}/catalog${url.search}`,
      requestId,
    )
  }
  const storefront = url.pathname.match(/^\/s\/([^/]+)$/u)
  if (request.method === 'GET' && storefront?.[1]) {
    return merchantStorefront(env, decodeURIComponent(storefront[1]), requestId, basePath)
  }
  return null
}

async function readinessResponse(env: EdgeRuntimeEnv, requestId: string): Promise<Response> {
  const secrets = validateSecretConfiguration(env.DEPLOY_LANE, env.MCP_BEARER_TOKEN, env.OPERATOR_BEARER_TOKEN)
  const sessionSecret = validateStorefrontSessionSecret(env.STOREFRONT_SESSION_SECRET)
  const humanPresenceTrustAnchor = readHumanPresenceTrustAnchor(env.HUMAN_CONFIRMATION_TRUST_ANCHOR_JSON)
  const humanPresenceReady = !edgeExternalHumanPresenceRequired(env.DEPLOY_LANE)
    || humanPresenceTrustAnchor !== null
  const [core, coreLive] = await Promise.all([
    coreCall(env, '/internal/readyz', { method: 'GET' }, requestId),
    coreCall(env, '/internal/livez', { method: 'GET' }, requestId),
  ])
  const releaseCandidate = releaseCandidateCheck(env, coreLive.payload)
  const sourceReadiness = isRecord(core.payload) && isRecord(core.payload.sourceReadiness)
    ? core.payload.sourceReadiness
    : Object.freeze({ ok: core.response.ok && isRecord(core.payload) && core.payload.ok === true })
  const liveReleaseReadiness = isRecord(core.payload) && isRecord(core.payload.liveReleaseReadiness)
    ? core.payload.liveReleaseReadiness
    : Object.freeze({ ok: releaseCandidate.ok, reason: releaseCandidate.ok ? null : 'release_candidate_mismatch' })
  const ok = secrets.ok && sessionSecret && humanPresenceReady && releaseCandidate.ok && core.response.ok
    && sourceReadiness.ok === true && liveReleaseReadiness.ok === true
  return jsonResponse({
    ok,
    contract: 'commerce.edge-readiness/v2',
    lane: env.DEPLOY_LANE,
    releaseCandidateSha: env.RELEASE_CANDIDATE_SHA,
    releaseCandidateDigest: env.RELEASE_CANDIDATE_DIGEST,
    version: env.CF_VERSION_METADATA,
    coreVersion: isRecord(coreLive.payload) ? coreLive.payload.version ?? null : null,
    sourceReadiness,
    liveReleaseReadiness,
    checks: [
      { name: 'secret_configuration', ok: secrets.ok },
      { name: 'storefront_session_secret', ok: sessionSecret },
      { name: 'human_presence_trust_anchor', ok: humanPresenceReady },
      { name: 'release_candidate', ...releaseCandidate },
      { name: 'commerce_core', ok: core.response.ok, detail: core.payload },
    ],
  }, ok ? 200 : 503)
}

async function merchantStorefront(
  env: EdgeRuntimeEnv,
  merchantId: string,
  requestId: string,
  basePath: string,
): Promise<Response> {
  if (!validIdentifier(merchantId)) return jsonResponse({ ok: false, code: 'merchant_not_found' }, 404)
  const path = `/internal/v1/merchants/${encodeURIComponent(merchantId)}/catalog`
  const [core, theme] = await Promise.all([
    authorizedCoreCall(env, 'catalog.merchant.read', path, { method: 'GET' }, requestId),
    coreCall(env, `/internal/v1/merchants/${encodeURIComponent(merchantId)}/theme`, { method: 'GET' }, requestId),
  ])
  if (!core.response.ok || !isRecord(core.payload)) return jsonResponse(core.payload, core.response.status)
  if (!theme.response.ok || !isRecord(theme.payload)) return jsonResponse(theme.payload, theme.response.status)
  const record = isRecord(theme.payload.record) ? theme.payload.record : null
  const manifestValue = record?.manifest
  const verdict = await validateThemeManifest(manifestValue)
  if (!verdict.ok || verdict.manifest.merchantId !== merchantId) {
    return jsonResponse({ ok: false, code: 'merchant_theme_unavailable' }, 502)
  }
  return consoleResponse(metadata(env), verdict.manifest, {
    basePath,
    catalogPath: `${basePath}/v1/public/merchants/${encodeURIComponent(merchantId)}/catalog`,
  })
}

async function publicCoreResponse(
  env: EdgeRuntimeEnv,
  capabilityAction: string,
  path: string,
  requestId: string,
): Promise<Response> {
  const core = await authorizedCoreCall(env, capabilityAction, path, { method: 'GET' }, requestId)
  return jsonResponse(core.payload, core.response.status)
}

async function routeAuthorized(
  request: Request,
  env: EdgeRuntimeEnv,
  authority: 'agent' | 'operator' | 'session-or-agent' | 'storefront-read-or-agent',
): Promise<
  | Readonly<{ ok: true; mode: 'agent' | 'operator' }>
  | Readonly<{ ok: true; mode: 'session'; session: StorefrontSession }>
  | Readonly<{ ok: false; code: string }>
> {
  if (authority === 'operator') {
    return await bearerAuthorized(request, env.OPERATOR_BEARER_TOKEN)
      ? { ok: true, mode: 'operator' }
      : { ok: false, code: 'unauthorized' }
  }
  if (authority === 'session-or-agent' || authority === 'storefront-read-or-agent') {
    if (await bearerAuthorized(request, env.MCP_BEARER_TOKEN)) return { ok: true, mode: 'agent' }
    const session = await authorizeStorefrontSession(
      request,
      env.STOREFRONT_SESSION_SECRET,
      authority === 'session-or-agent' ? 'checkout:prepare' : 'storefront:read',
      Date.now(),
      edgeLoopbackAllowed(env.DEPLOY_LANE),
    )
    return session.ok
      ? { ok: true, mode: 'session', session: session.session }
      : { ok: false, code: session.code }
  }
  return await bearerAuthorized(request, env.MCP_BEARER_TOKEN)
    ? { ok: true, mode: 'agent' }
    : { ok: false, code: 'unauthorized' }
}

type CoreRoute = Readonly<{
  path: string
  capabilityAction: string
  authority: 'agent' | 'operator' | 'session-or-agent' | 'storefront-read-or-agent'
  copySearch?: true
  authoringClaimRequired?: true
  checkoutAction?: 'prepare' | 'confirm'
}>

function routeToCore(request: Request, url: URL): CoreRoute | null {
  if (request.method === 'GET' && url.pathname === '/v1/registry') {
    return { path: '/internal/v1/agents', capabilityAction: 'registry.read', authority: 'agent' }
  }
  if (request.method === 'POST' && url.pathname === '/v1/intents/route') {
    return { path: '/internal/v1/intents/route', capabilityAction: 'intent.route', authority: 'storefront-read-or-agent' }
  }
  if (request.method === 'POST' && url.pathname === '/v1/sync/merge') {
    return { path: '/internal/v1/sync/merge', capabilityAction: 'sync.merge', authority: 'storefront-read-or-agent' }
  }
  const checkout = url.pathname.match(/^\/v1\/checkouts\/([^/]+)\/(prepare|confirm)$/u)
  if (checkout?.[1] && checkout[2]) {
    return {
      path: `/internal/v1/checkouts/${checkout[1]}/${checkout[2]}`,
      capabilityAction: `checkout.${checkout[2]}`,
      authority: checkout[2] === 'prepare' ? 'session-or-agent' : 'agent',
      checkoutAction: checkout[2] === 'prepare' ? 'prepare' : 'confirm',
    }
  }
  if (request.method === 'GET' && url.pathname === '/v1/revenue') {
    return { path: '/internal/v1/revenue', capabilityAction: 'revenue.period.read', authority: 'agent', copySearch: true }
  }
  if (request.method === 'GET' && url.pathname === '/v1/revenue/demand-evidence') {
    return { path: '/internal/v1/revenue/demand-evidence', capabilityAction: 'revenue.demand-evidence.read', authority: 'agent' }
  }
  if (request.method === 'GET' && url.pathname === '/v1/vendors') {
    return { path: '/internal/v1/vendors', capabilityAction: 'vendor.read', authority: 'agent' }
  }
  if (request.method === 'GET' && /^\/v1\/settlements\/[^/]+$/u.test(url.pathname)) {
    return { path: `/internal${url.pathname}`, capabilityAction: 'settlement.read', authority: 'agent' }
  }
  if (url.pathname === '/v1/operator/agents') {
    return {
      path: '/internal/v1/agents',
      capabilityAction: request.method === 'POST' ? 'agent.register' : 'registry.read',
      authority: 'operator',
      ...(request.method === 'POST' ? { authoringClaimRequired: true as const } : {}),
    }
  }
  const agent = url.pathname.match(/^\/v1\/operator\/agents\/([^/]+)$/u)
  if (agent?.[1]) return {
    path: `/internal/v1/agents/${agent[1]}`,
    capabilityAction: 'agent.deregister',
    authority: 'operator',
    ...(request.method === 'DELETE' ? { authoringClaimRequired: true as const } : {}),
  }
  if (request.method === 'GET' && url.pathname === '/v1/operator/registry/events') {
    return { path: '/internal/v1/registry/events', capabilityAction: 'registry.events.read', authority: 'operator', copySearch: true }
  }
  const vendor = url.pathname.match(/^\/v1\/operator\/vendors\/([^/]+)\/transition$/u)
  if (vendor?.[1]) return {
    path: `/internal/v1/vendors/${vendor[1]}/transition`,
    capabilityAction: 'vendor.transition',
    authority: 'operator',
    ...(request.method === 'POST' ? { authoringClaimRequired: true as const } : {}),
  }
  const theme = url.pathname.match(/^\/v1\/operator\/merchants\/([^/]+)\/theme$/u)
  if (request.method === 'POST' && theme?.[1]) {
    return {
      path: `/internal/v1/operator/merchants/${theme[1]}/theme`,
      capabilityAction: 'theme.deploy',
      authority: 'operator',
      authoringClaimRequired: true,
    }
  }
  const claim = url.pathname.match(/^\/v1\/operator\/claims\/(acquire|release|admit)$/u)
  if (request.method === 'POST' && claim?.[1]) {
    return {
      path: `/internal/v1/operator/claims/${claim[1]}`,
      capabilityAction: `authoring.claim.${claim[1]}`,
      authority: 'operator',
      ...(claim[1] === 'release' ? { authoringClaimRequired: true as const } : {}),
    }
  }
  if (request.method === 'GET' && url.pathname === '/v1/operator/release-boundaries') {
    return { path: '/internal/v1/release-boundaries', capabilityAction: 'release.boundary.read', authority: 'operator' }
  }
  return null
}

function createCorePayload(env: EdgeRuntimeEnv, requestId: string, request: Request, operator: boolean): CorePayload {
  return async (path, body, method = body ? 'POST' : 'GET') => {
    const authoringClaim = readAuthoringClaimHeaders(request)
    const result = await coreCall(env, path, {
      method,
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(operator && authoringClaim.ok
        ? { forwardedHeaders: authoringClaim.headers }
        : {}),
    }, requestId)
    return result.payload
  }
}

async function coreCall(
  env: EdgeRuntimeEnv,
  path: string,
  init: Readonly<{ method: string; body?: string; forwardedHeaders?: Readonly<Record<string, string>> }>,
  requestId: string,
): Promise<Readonly<{ response: Response; payload: unknown }>> {
  const response = await env.COMMERCE_CORE.fetch(new Request(new URL(path, 'https://commerce-core.internal'), {
    method: init.method,
    headers: {
      'content-type': 'application/json',
      'x-commerce-contract': EDGE_CORE_CONTRACT,
      'x-commerce-release-candidate': env.RELEASE_CANDIDATE_SHA,
      'x-commerce-release-candidate-digest': env.RELEASE_CANDIDATE_DIGEST,
      'x-request-id': requestId,
      ...init.forwardedHeaders,
    },
    ...(init.body ? { body: init.body } : {}),
    signal: AbortSignal.timeout(coreRequestTimeoutMs(path, init.method)),
  }))
  const payload = await readJsonResponse(response, 1_000_000)
  return Object.freeze({ response, payload })
}

async function authorizeCoreAction(
  env: EdgeRuntimeEnv,
  capabilityAction: string,
  requestId: string,
): Promise<Readonly<{ response: Response; payload: unknown }>> {
  return coreCall(env, '/internal/v1/invocations/authorize', {
    method: 'POST',
    body: JSON.stringify({ capabilityAction }),
  }, requestId)
}

async function authorizedCoreCall(
  env: EdgeRuntimeEnv,
  capabilityAction: string,
  path: string,
  init: Readonly<{ method: string; body?: string; forwardedHeaders?: Readonly<Record<string, string>> }>,
  requestId: string,
): Promise<Readonly<{ response: Response; payload: unknown }>> {
  const authorization = await authorizeCoreAction(env, capabilityAction, requestId)
  if (!authorization.response.ok
    || !isRecord(authorization.payload)
    || authorization.payload.ok !== true) return authorization
  return coreCall(env, path, init, requestId)
}

function releaseCandidateCheck(
  env: EdgeRuntimeEnv,
  coreLive: unknown,
): Readonly<{ ok: boolean; expected: string; observed: string | null }> {
  const observed = isRecord(coreLive) && typeof coreLive.releaseCandidateSha === 'string'
    ? coreLive.releaseCandidateSha
    : null
  const lane = readEdgeDeployLane(env.DEPLOY_LANE)
  const ownPinValid = lane !== null
    && (lane !== 'Production' || /^[0-9a-f]{40}$/u.test(env.RELEASE_CANDIDATE_SHA))
  return Object.freeze({ ok: ownPinValid && observed === env.RELEASE_CANDIDATE_SHA, expected: env.RELEASE_CANDIDATE_SHA, observed })
}

function operationalConfiguration(env: EdgeRuntimeEnv): Readonly<{ ok: boolean }> {
  const lane = readEdgeDeployLane(env.DEPLOY_LANE)
  if (!lane) return Object.freeze({ ok: false })
  const secrets = validateSecretConfiguration(lane, env.MCP_BEARER_TOKEN, env.OPERATOR_BEARER_TOKEN)
  return Object.freeze({
    ok: secrets.ok
      && validateStorefrontSessionSecret(env.STOREFRONT_SESSION_SECRET)
      && (!edgeExternalHumanPresenceRequired(lane)
        || readHumanPresenceTrustAnchor(env.HUMAN_CONFIRMATION_TRUST_ANCHOR_JSON) !== null)
      && (lane !== 'Production' || (/^[0-9a-f]{40}$/u.test(env.RELEASE_CANDIDATE_SHA)
        && /^[0-9a-f]{64}$/u.test(env.RELEASE_CANDIDATE_DIGEST))),
  })
}

function metadata(env: EdgeRuntimeEnv): ConsoleMetadata {
  return Object.freeze({
    lane: env.DEPLOY_LANE,
    releaseCandidateSha: env.RELEASE_CANDIDATE_SHA,
    version: env.CF_VERSION_METADATA,
  })
}

function preflight(request: Request, env: EdgeRuntimeEnv, requestId: string): Response {
  const origin = request.headers.get('origin') ?? ''
  const response = new Response(null, { status: 204 })
  if (origin && originAllowed(request, env.ALLOWED_ORIGINS_JSON)) {
    response.headers.set('access-control-allow-origin', origin)
    response.headers.set('access-control-allow-credentials', 'true')
    response.headers.set('vary', 'origin')
    response.headers.set('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
    response.headers.set(
      'access-control-allow-headers',
      'authorization, content-type, mcp-protocol-version, mcp-session-id, x-human-confirmation-csrf, x-authoring-semantic-scope, x-authoring-claim-id, x-authoring-lease-epoch, x-authoring-fence-revision',
    )
    response.headers.set('access-control-max-age', '600')
  }
  return finalizeResponse(response, requestId, request, env)
}

function finalizeResponse(response: Response, requestId: string, request: Request, env: EdgeRuntimeEnv): Response {
  response.headers.set('x-request-id', requestId)
  response.headers.set('x-content-type-options', 'nosniff')
  const origin = request.headers.get('origin')
  if (origin && originAllowed(request, env.ALLOWED_ORIGINS_JSON)) {
    response.headers.set('access-control-allow-origin', origin)
    response.headers.set('access-control-allow-credentials', 'true')
    response.headers.append('vary', 'origin')
  }
  return response
}

function validIdentifier(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value)
}
