import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import * as z from 'zod/v4'

import { isHttpFailure, isRecord, readJsonObject } from '../shared/http'
import {
  readAuthoringClaimHeaders,
  type AuthoringClaimHeaderVerdict,
} from './authoring-headers'
import { capabilityBoundCore } from './capability-authorization'

export const PUBLIC_MCP_TOOL_NAMES = Object.freeze([
  'commerce.runtime.status',
  'commerce.invocation.resolve',
  'commerce.registry.list',
  'commerce.catalog.public.list',
  'commerce.catalog.merchant.read',
  'commerce.intent.route',
  'commerce.sync.merge',
  'commerce.checkout.prepare',
  'commerce.checkout.confirm',
  'commerce.revenue.period.read',
  'commerce.revenue.demand-evidence.read',
  'commerce.vendor.list',
  'commerce.settlement.get',
])

export const OPERATOR_MCP_TOOL_NAMES = Object.freeze([
  'commerce.agent.register',
  'commerce.agent.deregister',
  'commerce.registry.events',
  'commerce.vendor.transition',
  'commerce.theme.deploy',
  'commerce.release.boundary.read',
  'commerce.authoring.claim.acquire',
  'commerce.authoring.claim.release',
  'commerce.authoring.claim.admit',
])

export type CorePayload = (
  path: string,
  body?: Readonly<Record<string, unknown>>,
  method?: 'GET' | 'POST' | 'DELETE',
) => Promise<unknown>

export async function handleMcpRequest(
  request: Request,
  context: Pick<ExecutionContext, 'waitUntil'>,
  requestId: string,
  corePayload: CorePayload,
  authority: 'agent' | 'operator',
): Promise<Response> {
  const body = await readJsonObject(request)
  if (isHttpFailure(body)) {
    return Response.json({
      jsonrpc: '2.0',
      error: { code: -32_700, message: body.message },
      id: null,
    }, { status: 400 })
  }
  const server = createMcpServer(
    corePayload,
    authority,
    readAuthoringClaimHeaders(request),
  )
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
  await server.connect(transport)
  const response = await transport.handleRequest(request, { parsedBody: body })
  context.waitUntil(server.close())
  response.headers.set('x-request-id', requestId)
  return response
}

function createMcpServer(
  rawCore: CorePayload,
  authority: 'agent' | 'operator',
  authoringClaim: AuthoringClaimHeaderVerdict,
): McpServer {
  const core = capabilityBoundCore(rawCore)
  const server = new McpServer({
    name: authority === 'operator' ? 'agentic-commerce-os-operator' : 'agentic-commerce-os',
    version: '0.1.0',
  })
  if (authority === 'operator') registerOperatorTools(server, core, authoringClaim)
  else registerAgentTools(server, core, rawCore)
  return server
}

function registerAgentTools(server: McpServer, core: CorePayload, rawCore: CorePayload): void {
  const changeOrigin = z.object({
    deviceId: z.string().min(1).max(256),
    sequence: z.number().int().nonnegative().safe(),
    recordedAtMs: z.number().int().nonnegative().safe(),
  }).strict()
  const fieldChange = z.object({
    scope: z.string().min(1).max(256),
    field: z.string().min(1).max(256),
    value: z.unknown(),
    origin: changeOrigin,
  }).strict()
  const mergedState = z.object({
    fields: z.array(fieldChange).max(500),
    eventLog: z.array(fieldChange).max(500),
  }).strict()

  server.registerTool('commerce.runtime.status', toolDefinition(
    'Commerce Runtime Status', 'Read the dependency-readiness report.', {}, true,
  ), async () => toolResult(await canonicalAction(core, () => core('/internal/readyz'))))

  server.registerTool('commerce.invocation.resolve', toolDefinition(
    'Resolve Canonical Invocation Tokens', 'Resolve exact /, #, and @ tokens through the pinned catalog.',
    { tokens: z.array(z.string().min(2).max(128)).min(1).max(500) }, true,
  ), async ({ tokens }) => toolResult(await core(
    '/internal/v1/invocations/resolve', { tokens }, 'POST',
  )))

  server.registerTool('commerce.registry.list', toolDefinition(
    'List Registered Commerce Agents', 'Read the authority-bearing agent registry snapshot.', {}, true,
  ), async () => toolResult(await canonicalAction(core, () => core('/internal/v1/agents'))))

  server.registerTool('commerce.catalog.public.list', toolDefinition(
    'List Public Commerce Agents', 'Read the allowlisted public active-agent projection.', {}, true,
  ), async () => toolResult(await canonicalAction(core, () => core('/internal/v1/public/agents'))))

  server.registerTool('commerce.catalog.merchant.read', toolDefinition(
    'Read Merchant Catalog', 'Read the scope-filtered listing projection for one merchant.',
    { merchantId: z.string().min(1).max(128) }, true,
  ), async ({ merchantId }) => toolResult(await canonicalAction(core, () => core(
    `/internal/v1/merchants/${encodeURIComponent(merchantId)}/catalog`,
  ))))

  server.registerTool('commerce.intent.route', toolDefinition(
    'Route a Commerce Intent', 'Select and invoke at most one registered discovery tool.',
    {
      intentId: z.string().min(1).max(256),
      category: z.string().min(1).max(64),
      constraints: z.record(z.string(), z.unknown()),
      merchantId: z.string().min(1).max(128).optional(),
      listingId: z.string().min(1).max(128).optional(),
    }, false,
  ), async (input) => toolResult(await canonicalAction(core, () => core(
    '/internal/v1/intents/route', input, 'POST',
  ))))

  server.registerTool('commerce.sync.merge', toolDefinition(
    'Merge Local Changes', 'Merge bounded local-first changes using the canonical convergence contract.',
    {
      base: mergedState,
      left: z.array(fieldChange).max(500),
      right: z.array(fieldChange).max(500),
    }, false,
  ), async (input) => toolResult(await canonicalAction(core, () => core(
    '/internal/v1/sync/merge', input, 'POST',
  ))))

  server.registerTool('commerce.checkout.prepare', toolDefinition(
    'Prepare a Guarded Checkout', 'Hand checkout preparation to the visual storefront without exposing a proof.',
    {
      checkoutId: z.string().min(1).max(128),
      intentId: z.string().min(1).max(128),
      agentId: z.string().min(1).max(128),
      offerId: z.string().min(1).max(128),
      offerReceiptDigest: z.string().regex(/^[0-9a-f]{64}$/u),
      amountMinor: z.number().int().positive().safe(),
      budgetMinor: z.number().int().positive().safe(),
      currency: z.string().regex(/^[A-Z]{3}$/u),
    }, false,
  ), async () => toolResult(await visualOnlyCheckout(rawCore, 'checkout.prepare', 'visual_handoff_required')))

  server.registerTool('commerce.checkout.confirm', toolDefinition(
    'Confirm a Guarded Checkout',
    'Require the shopper to confirm through the visual storefront; MCP cannot substitute a proof.',
    {
      checkoutId: z.string().min(1).max(128),
    }, false,
  ), async () => toolResult(await visualOnlyCheckout(rawCore, 'checkout.confirm', 'human_confirmation_required')))

  server.registerTool('commerce.revenue.period.read', toolDefinition(
    'Read Revenue Period', 'Read ordered markup lines and a recomputed period total.',
    {
      startInclusiveMs: z.number().int().nonnegative().safe(),
      endExclusiveMs: z.number().int().nonnegative().safe(),
    }, true,
  ), async ({ startInclusiveMs, endExclusiveMs }) => toolResult(await canonicalAction(core, () => core(
    `/internal/v1/revenue?start=${startInclusiveMs}&end=${endExclusiveMs}`,
  ))))

  server.registerTool('commerce.revenue.demand-evidence.read', toolDefinition(
    'Read Revenue Demand Evidence',
    'Read the capability-scoped count without claiming unproven paying demand.',
    {}, true,
  ), async () => toolResult(await canonicalAction(core, () => core(
    '/internal/v1/revenue/demand-evidence',
  ))))

  server.registerTool('commerce.vendor.list', toolDefinition(
    'List Marketplace Vendors', 'Read the private vendor-owner projection.', {}, true,
  ), async () => toolResult(await canonicalAction(core, () => core('/internal/v1/vendors'))))

  server.registerTool('commerce.settlement.get', toolDefinition(
    'Read a Settlement', 'Reconstruct one vendor split and payout state from stored evidence.',
    { splitId: z.string().min(1).max(128) }, true,
  ), async ({ splitId }) => toolResult(await canonicalAction(core, () => core(
    `/internal/v1/settlements/${encodeURIComponent(splitId)}`,
  ))))
}

function registerOperatorTools(
  server: McpServer,
  core: CorePayload,
  authoringClaim: AuthoringClaimHeaderVerdict,
): void {
  server.registerTool('commerce.agent.register', operatorDefinition(
    'Register Commerce Agent', 'Submit one bounded agent registration.',
    { registration: z.record(z.string(), z.unknown()) },
  ), async ({ registration }) => toolResult(await claimedOperatorAction(core, authoringClaim, () => core(
    '/internal/v1/agents', registration, 'POST',
  ))))

  server.registerTool('commerce.agent.deregister', operatorDefinition(
    'Deregister Commerce Agent', 'Deregister one exact agent identifier.',
    {
      agentId: z.string().min(1).max(128),
      expectedContentHash: z.string().regex(/^[0-9a-f]{64}$/u),
    },
  ), async ({ agentId, expectedContentHash }) => toolResult(await claimedOperatorAction(core, authoringClaim, () => core(
    `/internal/v1/agents/${encodeURIComponent(agentId)}`, { expectedContentHash }, 'DELETE',
  ))))

  server.registerTool('commerce.registry.events', toolDefinition(
    'Read Registry Events', 'Read ordered registration evidence.',
    { afterSequence: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional() }, true,
  ), async ({ afterSequence, limit }) => {
    const query = new URLSearchParams()
    if (afterSequence !== undefined) query.set('after', String(afterSequence))
    if (limit !== undefined) query.set('limit', String(limit))
    return toolResult(await canonicalAction(core, () => core(
      `/internal/v1/registry/events${query.size ? `?${query}` : ''}`,
    )))
  })

  server.registerTool('commerce.vendor.transition', operatorDefinition(
    'Transition Vendor State', 'Apply one authority-checked vendor state transition.',
    {
      vendorId: z.string().min(1).max(128),
      transition: z.record(z.string(), z.unknown()),
    },
  ), async ({ vendorId, transition }) => toolResult(await claimedOperatorAction(core, authoringClaim, () => core(
    `/internal/v1/vendors/${encodeURIComponent(vendorId)}/transition`, transition, 'POST',
  ))))

  server.registerTool('commerce.theme.deploy', operatorDefinition(
    'Deploy Merchant Theme', 'Validate and activate one merchant-scoped theme manifest.',
    {
      merchantId: z.string().min(1).max(128),
      manifest: z.record(z.string(), z.unknown()),
    },
  ), async ({ merchantId, manifest }) => toolResult(await claimedOperatorAction(core, authoringClaim, () => core(
    `/internal/v1/operator/merchants/${encodeURIComponent(merchantId)}/theme`, manifest, 'POST',
  ))))

  server.registerTool('commerce.release.boundary.read', toolDefinition(
    'Read Release Boundaries', 'Read the closed or open state without advancing a boundary.', {}, true,
  ), async () => toolResult(await canonicalAction(core, () => core('/internal/v1/release-boundaries'))))

  for (const action of ['acquire', 'release', 'admit'] as const) {
    server.registerTool(`commerce.authoring.claim.${action}`, operatorDefinition(
      `${capitalize(action)} Authoring Claim`, `${capitalize(action)} one authority-bearing authoring claim.`,
      { claim: z.record(z.string(), z.unknown()) },
    ), async ({ claim }) => toolResult(await (
      action === 'release'
        ? claimedOperatorAction(core, authoringClaim, () => core(
          `/internal/v1/operator/claims/${action}`, claim, 'POST',
        ))
        : canonicalAction(core, () => core(`/internal/v1/operator/claims/${action}`, claim, 'POST'))
    )))
  }
}

async function claimedOperatorAction(
  _core: CorePayload,
  authoringClaim: AuthoringClaimHeaderVerdict,
  action: () => Promise<unknown>,
): Promise<unknown> {
  if (!authoringClaim.ok) return Object.freeze({ ok: false, code: authoringClaim.code })
  return action()
}

async function canonicalAction(core: CorePayload, action: () => Promise<unknown>): Promise<unknown> {
  void core
  return action()
}

async function visualOnlyCheckout(core: CorePayload, capabilityAction: string, code: string): Promise<unknown> {
  const authorization = await core('/internal/v1/invocations/authorize', { capabilityAction }, 'POST')
  if (!isRecord(authorization) || authorization.ok !== true) return authorization
  return Object.freeze({ ok: false, status: 'rejected', code, storefrontPath: '/' })
}

function toolDefinition<T extends Readonly<Record<string, z.ZodType>>>(
  title: string,
  description: string,
  inputSchema: T,
  readOnly: boolean,
) {
  return {
    title,
    description,
    inputSchema,
    outputSchema: { result: z.unknown() },
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: false,
      idempotentHint: readOnly,
      openWorldHint: true,
    },
  }
}

function operatorDefinition<T extends Readonly<Record<string, z.ZodType>>>(
  title: string,
  description: string,
  inputSchema: T,
) {
  return toolDefinition(title, description, inputSchema, false)
}

function toolResult(result: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    structuredContent: { result },
    ...(isRecord(result) && result.ok === false ? { isError: true } : {}),
  }
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
}
