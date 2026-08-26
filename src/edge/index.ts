import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import * as z from 'zod/v4'

import { bearerAuthorized, originAllowed, validateSecretConfiguration } from '../shared/auth'
import { isHttpFailure, isRecord, jsonResponse, readJsonObject, readJsonResponse } from '../shared/http'
import { dashboardResponse } from './dashboard'

const EDGE_CORE_CONTRACT = 'commerce.edge-core/v1'
const CORE_REQUEST_TIMEOUT_MS = 10_000

export default {
  async fetch(request: Request, env: EdgeEnv, context: ExecutionContext): Promise<Response> {
    const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID()
    const url = new URL(request.url)
    try {
      if (request.method === 'GET' && url.pathname === '/livez') {
        return finalizeResponse(jsonResponse({
          ok: true,
          contract: 'commerce.edge-live/v1',
          lane: env.DEPLOY_LANE,
          releaseCandidateSha: env.RELEASE_CANDIDATE_SHA,
          version: env.CF_VERSION_METADATA,
        }), requestId, request, env)
      }
      if (request.method === 'GET' && url.pathname === '/') {
        return finalizeResponse(dashboardResponse({
          lane: env.DEPLOY_LANE,
          releaseCandidateSha: env.RELEASE_CANDIDATE_SHA,
          version: env.CF_VERSION_METADATA,
        }), requestId, request, env)
      }
      if (request.method === 'GET' && url.pathname === '/readyz') {
        const secrets = validateSecretConfiguration(
          env.DEPLOY_LANE,
          env.MCP_BEARER_TOKEN,
          env.OPERATOR_BEARER_TOKEN,
        )
        const [core, coreLive] = await Promise.all([
          coreCall(env, '/internal/readyz', { method: 'GET' }, requestId),
          coreCall(env, '/internal/livez', { method: 'GET' }, requestId),
        ])
        const releaseCandidate = releaseCandidateCheck(env, coreLive.payload)
        const ok = secrets.ok
          && releaseCandidate.ok
          && core.response.ok
          && isRecord(core.payload)
          && core.payload.ok === true
        return finalizeResponse(jsonResponse({
          ok,
          contract: 'commerce.edge-readiness/v1',
          lane: env.DEPLOY_LANE,
          releaseCandidateSha: env.RELEASE_CANDIDATE_SHA,
          version: env.CF_VERSION_METADATA,
          coreVersion: isRecord(coreLive.payload) ? coreLive.payload.version ?? null : null,
          checks: [
            { name: 'secret_configuration', ok: secrets.ok },
            { name: 'release_candidate', ...releaseCandidate },
            { name: 'commerce_core', ok: core.response.ok, detail: core.payload },
          ],
        }, ok ? 200 : 503), requestId, request, env)
      }
      if (!originAllowed(request, env.ALLOWED_ORIGINS_JSON)) {
        return finalizeResponse(jsonResponse({ ok: false, code: 'origin_forbidden' }, 403), requestId, request, env)
      }
      if (request.method === 'OPTIONS') return preflight(request, env, requestId)
      const configuration = operationalConfiguration(env)
      if (!configuration.ok) {
        const response = url.pathname === '/mcp'
          ? Response.json({
            jsonrpc: '2.0',
            error: { code: -32_003, message: 'Runtime configuration is not ready.' },
            id: null,
          }, { status: 503 })
          : jsonResponse({ ok: false, code: 'runtime_configuration_invalid' }, 503)
        return finalizeResponse(response, requestId, request, env)
      }
      if (url.pathname === '/mcp') {
        if (!await bearerAuthorized(request, env.MCP_BEARER_TOKEN)) {
          return finalizeResponse(Response.json({
            jsonrpc: '2.0',
            error: { code: -32_001, message: 'Unauthorized' },
            id: null,
          }, { status: 401 }), requestId, request, env)
        }
        if (request.method !== 'POST') {
          return finalizeResponse(jsonResponse({ ok: false, code: 'method_not_allowed' }, 405), requestId, request, env)
        }
        return handleMcp(request, env, context, requestId)
      }

      const operatorRoute = url.pathname.startsWith('/v1/operator/')
      const expectedSecret = operatorRoute ? env.OPERATOR_BEARER_TOKEN : env.MCP_BEARER_TOKEN
      if (!await bearerAuthorized(request, expectedSecret)) {
        return finalizeResponse(jsonResponse({ ok: false, code: 'unauthorized' }, 401), requestId, request, env)
      }
      const target = routeToCore(request, url)
      if (!target) return finalizeResponse(jsonResponse({ ok: false, code: 'not_found' }, 404), requestId, request, env)
      const body = request.method === 'GET' ? undefined : await readJsonObject(request)
      if (body && isHttpFailure(body)) {
        return finalizeResponse(jsonResponse(body, 400), requestId, request, env)
      }
      const core = await coreCall(env, target.path, {
        method: request.method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      }, requestId)
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
} satisfies ExportedHandler<EdgeEnv>

async function handleMcp(
  request: Request,
  env: EdgeEnv,
  context: ExecutionContext,
  requestId: string,
): Promise<Response> {
  const body = await readJsonObject(request)
  if (isHttpFailure(body)) {
    return finalizeResponse(Response.json({
      jsonrpc: '2.0',
      error: { code: -32_700, message: body.message },
      id: null,
    }, { status: 400 }), requestId, request, env)
  }
  const server = createMcpServer(env, requestId)
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  })
  await server.connect(transport)
  const response = await transport.handleRequest(request, { parsedBody: body })
  context.waitUntil(server.close())
  return finalizeResponse(response, requestId, request, env)
}

function releaseCandidateCheck(
  env: EdgeEnv,
  coreLive: unknown,
): Readonly<{ ok: boolean; expected: string; observed: string | null }> {
  const observed = isRecord(coreLive) && typeof coreLive.releaseCandidateSha === 'string'
    ? coreLive.releaseCandidateSha
    : null
  const production = env.DEPLOY_LANE.toLowerCase() === 'production'
  const ownPinValid = !production || /^[0-9a-f]{40}$/u.test(env.RELEASE_CANDIDATE_SHA)
  return Object.freeze({
    ok: ownPinValid && observed === env.RELEASE_CANDIDATE_SHA,
    expected: env.RELEASE_CANDIDATE_SHA,
    observed,
  })
}

function operationalConfiguration(env: EdgeEnv): Readonly<{ ok: boolean }> {
  const secrets = validateSecretConfiguration(
    env.DEPLOY_LANE,
    env.MCP_BEARER_TOKEN,
    env.OPERATOR_BEARER_TOKEN,
  )
  const production = env.DEPLOY_LANE.toLowerCase() === 'production'
  return Object.freeze({
    ok: secrets.ok && (!production || /^[0-9a-f]{40}$/u.test(env.RELEASE_CANDIDATE_SHA)),
  })
}

function createMcpServer(env: EdgeEnv, requestId: string): McpServer {
  const server = new McpServer({ name: 'agentic-commerce-os', version: '0.1.0' })
  server.registerTool('commerce.runtime.status', {
    title: 'Commerce Runtime Status',
    description: 'Read the exact Dev or Production dependency-readiness report.',
    inputSchema: {},
    outputSchema: { result: z.unknown() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => toolResult(await corePayload(env, '/internal/readyz', requestId)))

  server.registerTool('commerce.invocation.resolve', {
    title: 'Resolve Canonical Invocation Tokens',
    description: 'Resolve /, #, and @ tokens through the pinned MCP projection of Agentic Canvas OS docs.',
    inputSchema: { tokens: z.array(z.string().min(2).max(128)).min(1).max(12) },
    outputSchema: { result: z.unknown() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ tokens }) => toolResult(await corePayload(
    env, '/internal/v1/invocations/resolve', requestId, { tokens },
  )))

  server.registerTool('commerce.registry.list', {
    title: 'List Registered Commerce Agents',
    description: 'Return the revision- and digest-bound canonical agent registry snapshot.',
    inputSchema: {},
    outputSchema: { result: z.unknown() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => toolResult(await corePayload(env, '/internal/v1/agents', requestId)))

  server.registerTool('commerce.intent.route', {
    title: 'Route a Commerce Intent',
    description: 'Select and invoke at most one registered discovery tool for one typed category.',
    inputSchema: {
      intentId: z.string().min(1).max(256),
      category: z.string().min(1).max(64),
      constraints: z.record(z.string(), z.unknown()),
    },
    outputSchema: { result: z.unknown() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => toolResult(await corePayload(
    env, '/internal/v1/intents/route', requestId, input,
  )))

  server.registerTool('commerce.checkout.prepare', {
    title: 'Prepare a Guarded Checkout',
    description: 'Request a guardrail decision and one-time human-confirmation token without issuing payment.',
    inputSchema: {
      checkoutId: z.string().min(1).max(128),
      intentId: z.string().min(1).max(128),
      agentId: z.string().min(1).max(128),
      offerId: z.string().min(1).max(128),
      offerReceiptDigest: z.string().regex(/^[0-9a-f]{64}$/u),
      amountMinor: z.number().int().positive().safe(),
      budgetMinor: z.number().int().positive().safe(),
      currency: z.string().regex(/^[A-Z]{3}$/u),
    },
    outputSchema: { result: z.unknown() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => toolResult(await corePayload(
    env, `/internal/v1/checkouts/${encodeURIComponent(input.checkoutId)}/prepare`, requestId, input,
  )))

  server.registerTool('commerce.checkout.confirm', {
    title: 'Confirm a Guarded Checkout',
    description: 'Consume the one-time human approval and invoke the private settlement owner exactly once.',
    inputSchema: {
      checkoutId: z.string().min(1).max(128),
      confirmationToken: z.string().min(64).max(128),
      offerId: z.string().min(1).max(128),
      amountMinor: z.number().int().positive().safe(),
    },
    outputSchema: { result: z.unknown() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async (input) => toolResult(await corePayload(
    env, `/internal/v1/checkouts/${encodeURIComponent(input.checkoutId)}/confirm`, requestId, input,
  )))

  server.registerTool('commerce.vendor.list', {
    title: 'List Marketplace Vendors',
    description: 'Read the private vendor-owner projection through the commerce core.',
    inputSchema: {},
    outputSchema: { result: z.unknown() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => toolResult(await corePayload(env, '/internal/v1/vendors', requestId)))

  server.registerTool('commerce.settlement.get', {
    title: 'Read a Settlement',
    description: 'Reconstruct one vendor split and payout state from stored evidence.',
    inputSchema: { splitId: z.string().min(1).max(128) },
    outputSchema: { result: z.unknown() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ splitId }) => toolResult(await corePayload(
    env, `/internal/v1/settlements/${encodeURIComponent(splitId)}`, requestId,
  )))
  return server
}

async function corePayload(
  env: EdgeEnv,
  path: string,
  requestId: string,
  body?: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const result = await coreCall(env, path, {
    method: body ? 'POST' : 'GET',
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, requestId)
  return result.payload
}

async function coreCall(
  env: EdgeEnv,
  path: string,
  init: Readonly<{ method: string; body?: string }>,
  requestId: string,
): Promise<Readonly<{ response: Response; payload: unknown }>> {
  const response = await env.COMMERCE_CORE.fetch(new Request(
    new URL(path, 'https://commerce-core.internal'),
    {
      method: init.method,
      headers: {
        'content-type': 'application/json',
        'x-commerce-contract': EDGE_CORE_CONTRACT,
        'x-commerce-release-candidate': env.RELEASE_CANDIDATE_SHA,
        'x-request-id': requestId,
      },
      ...(init.body ? { body: init.body } : {}),
      signal: AbortSignal.timeout(CORE_REQUEST_TIMEOUT_MS),
    },
  ))
  const payload = await readJsonResponse(response, 1_000_000)
  return Object.freeze({ response, payload })
}

function routeToCore(request: Request, url: URL): Readonly<{ path: string }> | null {
  if (request.method === 'GET' && url.pathname === '/v1/registry') return { path: '/internal/v1/agents' }
  if (request.method === 'POST' && url.pathname === '/v1/intents/route') return { path: '/internal/v1/intents/route' }
  if (/^\/v1\/checkouts\/[^/]+(?:\/(?:prepare|confirm))?$/u.test(url.pathname)) {
    return { path: `/internal${url.pathname}` }
  }
  if (request.method === 'GET' && url.pathname === '/v1/vendors') return { path: '/internal/v1/vendors' }
  if (request.method === 'GET' && /^\/v1\/settlements\/[^/]+$/u.test(url.pathname)) {
    return { path: `/internal${url.pathname}` }
  }
  if (url.pathname === '/v1/operator/agents') return { path: '/internal/v1/agents' }
  const agent = url.pathname.match(/^\/v1\/operator\/agents\/([^/]+)$/u)
  if (agent) return { path: `/internal/v1/agents/${agent[1]}` }
  if (request.method === 'GET' && url.pathname === '/v1/operator/registry/events') {
    return { path: `/internal/v1/registry/events${url.search}` }
  }
  const vendor = url.pathname.match(/^\/v1\/operator\/vendors\/([^/]+)\/transition$/u)
  return vendor ? { path: `/internal/v1/vendors/${vendor[1]}/transition` } : null
}

function toolResult(result: unknown) {
  const serialized = JSON.stringify(result)
  return {
    content: [{ type: 'text' as const, text: serialized }],
    structuredContent: { result },
    ...(isRecord(result) && result.ok === false ? { isError: true } : {}),
  }
}

function preflight(request: Request, env: EdgeEnv, requestId: string): Response {
  const origin = request.headers.get('origin') ?? ''
  const response = new Response(null, { status: 204 })
  if (origin && originAllowed(request, env.ALLOWED_ORIGINS_JSON)) {
    response.headers.set('access-control-allow-origin', origin)
    response.headers.set('vary', 'origin')
    response.headers.set('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
    response.headers.set('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version, mcp-session-id')
    response.headers.set('access-control-max-age', '600')
  }
  return finalizeResponse(response, requestId, request, env)
}

function finalizeResponse(response: Response, requestId: string, request: Request, env: EdgeEnv): Response {
  response.headers.set('x-request-id', requestId)
  response.headers.set('x-content-type-options', 'nosniff')
  const origin = request.headers.get('origin')
  if (origin && originAllowed(request, env.ALLOWED_ORIGINS_JSON)) {
    response.headers.set('access-control-allow-origin', origin)
    response.headers.append('vary', 'origin')
  }
  return response
}
