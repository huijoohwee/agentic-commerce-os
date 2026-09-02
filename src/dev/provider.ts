import { isHttpFailure, isRecord, readJsonObject } from '../shared/http.js'
import {
  CHECKOUT_PROVIDER_CONTRACT,
  DISCOVERY_PROVIDER_CONTRACT,
  MARKETPLACE_PROVIDER_CONTRACT,
} from '../core/provider-contract.js'
import {
  ACOS_ADMISSION_PATH,
  ACOS_ADMISSION_PROVIDER_CONTRACT,
  ACOS_ADMISSION_RECEIPT_SCHEMA,
} from '../core/acos-admission.js'
import {
  DOCS_INVOCATION_ENDPOINT,
  DOCS_INVOCATION_TOOL,
  MCP_PROTOCOL_VERSION,
} from '../invocation/index.js'
import {
  DISCOVERY_OFFER_SCHEMA,
  DISCOVERY_RECEIPT_CONTRACT,
  digestDiscoveryOffer,
  type DiscoveryOfferReceipt,
} from '../core/discovery-receipt.js'
import {
  GUARDRAIL_RECEIPT_SCHEMA,
  SETTLEMENT_RECEIPT_SCHEMA,
  digestGuardrailReceipt,
  digestSettlementReceipt,
  type GuardrailReceipt,
  type SettlementReceipt,
} from '../core/checkout-receipts.js'
import { sha256Hex } from '../shared/digest.js'
import {
  operationalEvidenceResponseHeaders,
  type OperationalEvidenceBinding,
} from '../core/provider-operation-gate.js'
import { AGENT_REGISTRY_CLAIM, vendorTransitionClaim, type ClaimMutationPermit } from '../domain/authoring-claim-policy.js'
import { admitDevAuthoringMutation, devAuthoringHeaders } from './authoring-fence.js'
import {
  DEV_CHECKOUT_EVIDENCE_PIN,
  DEV_DISCOVERY_EVIDENCE_PIN,
  DEV_MARKETPLACE_EVIDENCE_PIN,
  checkoutOperationBinding,
  devRuntimeEvidenceResponse,
  discoveryOperationBinding,
  marketplaceOperationBinding,
} from './provider-evidence.js'

const INVOCATION_PATH = new URL(DOCS_INVOCATION_ENDPOINT).pathname
const DEMO_CONTRACT = 'commerce.dev-provider/v1'

const DEV_SETTLEMENTS = new Map<string, SettlementReceipt>()

const CATALOG = Object.freeze([
  Object.freeze({
    token: '/tool.route',
    kind: 'command',
    label: 'Route tool',
    summary: 'Route one canonical tool invocation.',
    sourcePath: 'docs/commands/tool-route.md',
  }),
  Object.freeze({
    token: '#mcp',
    kind: 'semantic',
    label: 'MCP semantic',
    summary: 'Select the canonical MCP semantic.',
    sourcePath: 'docs/semantics/mcp.md',
  }),
  Object.freeze({
    token: '@mcp-gateway',
    kind: 'binding',
    label: 'MCP gateway',
    summary: 'Bind the canonical MCP gateway.',
    sourcePath: 'docs/bindings/mcp-gateway.md',
  }),
])

const DEV_INVOCATION_METADATA = Object.freeze({
  sourceRevision: 'a'.repeat(40),
  catalogDigest: '7402c37fc46de9914a6fd9ccff48ccfaae2e975ec66bb6e81530c8c599e376d1',
  routingSchema: 'agentic-canvas-os-docs-routing/v1',
  routingDigest: 'e7e127092bf699af87abf7426071b6b0126ece232a7ec324d0289c8ba4b470a4',
  counts: Object.freeze({ command: 1, semantic: 1, binding: 1 }),
})

export const DEV_PROVIDER_PINS = Object.freeze({
  ...DEV_INVOCATION_METADATA,
  requiredTokens: Object.freeze(CATALOG.map(({ token }) => token)),
  releaseCandidateSha: 'b'.repeat(40),
  discoveryEvidence: DEV_DISCOVERY_EVIDENCE_PIN,
  checkoutEvidence: DEV_CHECKOUT_EVIDENCE_PIN,
  marketplaceEvidence: DEV_MARKETPLACE_EVIDENCE_PIN,
})

type DevProviderEnv = Readonly<{ DEMO_ONLY: string }>

export default {
  async fetch(request: Request, env: DevProviderEnv): Promise<Response> {
    if (env.DEMO_ONLY !== 'true') {
      return Response.json({ ok: false, code: 'demo_provider_disabled' }, { status: 503 })
    }
    return devProviderFetch(request)
  },
} satisfies ExportedHandler<DevProviderEnv>

export async function devProviderFetch(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === INVOCATION_PATH) return mcpResponse(request)
  if (request.method === 'GET' && url.pathname === `${ACOS_ADMISSION_PATH}/readyz`) {
    return Response.json({
      ok: true,
      contract: ACOS_ADMISSION_PROVIDER_CONTRACT,
      receiptSchema: ACOS_ADMISSION_RECEIPT_SCHEMA,
      operations: ['register-fenced'],
    })
  }
  if (request.method === 'POST' && url.pathname === ACOS_ADMISSION_PATH) {
    return admissionResponse(request)
  }
  if (request.method === 'GET' && url.pathname === '/readyz') {
    return Response.json({ ok: true, contract: DEMO_CONTRACT, demo: true })
  }
  if (request.method === 'GET' && url.pathname === '/v1/capabilities') {
    return capabilityResponse(url.hostname)
  }
  if (request.method === 'GET' && url.pathname === '/v1/runtime-evidence') {
    return devRuntimeEvidenceResponse(url.hostname)
  }
  if (request.method === 'POST' && url.pathname === '/internal/v1/checkouts/prepare') {
    return checkoutPrepareResponse(request)
  }
  if (request.method === 'POST' && url.pathname === '/internal/v1/checkouts/confirm') {
    return checkoutConfirmResponse(request)
  }
  if (request.method === 'GET' && url.pathname === '/internal/v1/checkouts/status') {
    return checkoutStatusResponse(request)
  }
  if (request.method === 'GET' && /^\/internal\/v1\/offers\/[^/]+\/observe$/u.test(url.pathname)) {
    return offerObservationResponse(request)
  }
  if (request.method === 'GET' && url.pathname === '/v1/vendors') {
    return Response.json({ ok: true, contract: MARKETPLACE_PROVIDER_CONTRACT, demo: true, vendors: [] })
  }
  if (request.method === 'GET' && /^\/v1\/settlements\/[^/]+$/u.test(url.pathname)) {
    const binding = await marketplaceOperationBinding(request)
    if (!binding) return providerError(MARKETPLACE_PROVIDER_CONTRACT, 'operational_evidence_binding_invalid', 409)
    return providerJson({
      ok: true,
      contract: MARKETPLACE_PROVIDER_CONTRACT,
      demo: true,
      splitId: url.pathname.split('/').at(-1),
      state: 'settled',
    }, 200, binding)
  }
  if (request.method === 'POST' && /^\/v1\/vendors\/[^/]+\/transition$/u.test(url.pathname)) {
    const binding = await marketplaceOperationBinding(request)
    if (!binding) return providerError(MARKETPLACE_PROVIDER_CONTRACT, 'operational_evidence_binding_invalid', 409)
    const body = await bodyRecord(request)
    const vendorId = decodeURIComponent(url.pathname.split('/')[3] ?? '')
    const fenced = admitDevAuthoringMutation(request, vendorTransitionClaim(vendorId))
    if (!fenced.ok) {
      return providerError(MARKETPLACE_PROVIDER_CONTRACT, fenced.code, 409, binding, fenced.permit)
    }
    if (!body || typeof body.state !== 'string') {
      return providerError(MARKETPLACE_PROVIDER_CONTRACT, 'vendor_transition_malformed', 400, binding, fenced.permit)
    }
    return providerJson({
      ok: true,
      contract: MARKETPLACE_PROVIDER_CONTRACT,
      demo: true,
      vendorId,
      state: body.state,
    }, 200, binding, fenced.permit)
  }
  return Response.json({ ok: false, contract: DEMO_CONTRACT, code: 'not_found' }, { status: 404 })
}

async function admissionResponse(request: Request): Promise<Response> {
  const body = await bodyRecord(request)
  const fenced = admitDevAuthoringMutation(request, AGENT_REGISTRY_CLAIM)
  if (!fenced.ok) return admissionRejection(fenced.code, fenced.permit)
  const fields = body ? Object.keys(body).sort() : []
  if (!body || JSON.stringify(fields) !== JSON.stringify([
    'agent_definition',
    'invocation_register_entry',
    'operator_instruction_ref',
    'tool_allowlist_entry',
  ])) return admissionRejection('registration_input_invalid', fenced.permit)

  const definition = isRecord(body.agent_definition) ? body.agent_definition : null
  const allowlist = isRecord(body.tool_allowlist_entry) ? body.tool_allowlist_entry : null
  const invocation = isRecord(body.invocation_register_entry) ? body.invocation_register_entry : null
  const reference = body.operator_instruction_ref
  const invocationTokens = invocation
    ? ['route', 'tag', 'binding', 'tool_identity'].map((field) => invocation[field])
    : []
  const declaredTokens = new Set([...CATALOG.map(({ token }) => token), 'acos.adapter.register'])
  if (!definition
    || typeof definition.id !== 'string'
    || (definition.status !== undefined && definition.status !== 'active')
    || !allowlist
    || typeof allowlist.entry_id !== 'string'
    || allowlist.agent_definition_id !== definition.id
    || typeof allowlist.adapter_identity !== 'string'
    || !Array.isArray(allowlist.tool_names)
    || allowlist.tool_names.length === 0
    || allowlist.tool_names.some((tool) => typeof tool !== 'string')
    || !invocation
    || invocationTokens.some((token) => typeof token !== 'string' || !declaredTokens.has(token))
    || typeof reference !== 'string'
    || reference.trim().length === 0) return admissionRejection('registration_input_rejected', fenced.permit)

  return Response.json({
    status: 'registered',
    record: {
      schema: ACOS_ADMISSION_RECEIPT_SCHEMA,
      adapter_identity: allowlist.adapter_identity,
      agent_definition_id: definition.id,
      tool_allowlist_entry_id: allowlist.entry_id,
      invocation_register_tokens: invocationTokens,
      resulting_status: 'active',
      operator_instruction_reference: reference,
      registered_at_ms: 1_787_702_400_000,
    },
    finding: null,
  }, { headers: devAuthoringHeaders(fenced.permit) })
}

function admissionRejection(reasonCode: string, permit: ClaimMutationPermit | null): Response {
  return Response.json({
    status: 'rejected',
    record: null,
    finding: {
      schema: 'acos-adapter-registration-finding/v1',
      type: 'unfederated-tool',
      adapter_identity: null,
      reason_code: reasonCode,
      message: 'The demo-only ACOS admission fixture rejected the registration.',
      details: {},
    },
  }, { status: 409, headers: devAuthoringHeaders(permit) })
}

function capabilityResponse(hostname: string): Response {
  if (hostname === 'discovery-provider.internal') {
    return Response.json({
      ok: true,
      contract: DISCOVERY_PROVIDER_CONTRACT,
      demo: true,
      operations: ['mcp-dispatch-evidence-bound'],
    })
  }
  if (hostname === 'checkout-provider.internal') {
    return Response.json({
      ok: true,
      contract: CHECKOUT_PROVIDER_CONTRACT,
      demo: true,
      operations: ['prepare', 'confirm', 'status', 'offer-observe'],
    })
  }
  if (hostname === 'marketplace-provider.internal') {
    return Response.json({
      ok: true,
      contract: MARKETPLACE_PROVIDER_CONTRACT,
      demo: true,
      operations: ['vendor-list', 'vendor-transition-fenced', 'settlement-read'],
    })
  }
  return Response.json({ ok: false, contract: DEMO_CONTRACT, code: 'provider_unknown' }, { status: 404 })
}

async function checkoutPrepareResponse(request: Request): Promise<Response> {
  const binding = await checkoutOperationBinding(request)
  if (!binding) return providerError(CHECKOUT_PROVIDER_CONTRACT, 'operational_evidence_binding_invalid', 409)
  const body = await bodyRecord(request)
  if (!body
    || Object.keys(body).sort().join(',') !== 'agentId,amountMinor,budgetMinor,checkoutId,contract,currency,idempotencyKey,intentId,offerId,offerProviderRevision,offerReceiptDigest'
    || body.contract !== CHECKOUT_PROVIDER_CONTRACT
    || !validIdentifier(body.checkoutId)
    || !validIdentifier(body.intentId)
    || !validIdentifier(body.agentId)
    || !validIdentifier(body.offerId)
    || !validSha256(body.offerReceiptDigest)
    || !Number.isSafeInteger(body.amountMinor)
    || Number(body.amountMinor) <= 0
    || !Number.isSafeInteger(body.budgetMinor)
    || Number(body.budgetMinor) <= 0
    || Number(body.amountMinor) > Number(body.budgetMinor)
    || typeof body.currency !== 'string'
    || !/^[A-Z]{3}$/u.test(body.currency)) {
    return providerError(CHECKOUT_PROVIDER_CONTRACT, 'checkout_prepare_malformed', 400, binding)
  }
  const partial: Omit<GuardrailReceipt, 'receiptDigest'> = Object.freeze({
    schema: GUARDRAIL_RECEIPT_SCHEMA,
    receiptId: `guardrail-${(await sha256Hex(String(body.checkoutId))).slice(0, 32)}`,
    checkoutId: body.checkoutId,
    intentId: body.intentId,
    agentId: body.agentId,
    offerReceiptDigest: body.offerReceiptDigest,
    amountMinor: Number(body.amountMinor),
    budgetMinor: Number(body.budgetMinor),
    currency: body.currency,
    providerRevision: DEV_CHECKOUT_EVIDENCE_PIN.sourceRevision,
  })
  const guardrailReceipt: GuardrailReceipt = Object.freeze({
    ...partial,
    receiptDigest: await digestGuardrailReceipt(partial),
  })
  return providerJson({
    ok: true,
    contract: CHECKOUT_PROVIDER_CONTRACT,
    guardrailPassed: true,
    guardrailReceipt,
  }, 200, binding)
}

async function checkoutConfirmResponse(request: Request): Promise<Response> {
  const binding = await checkoutOperationBinding(request)
  if (!binding) return providerError(CHECKOUT_PROVIDER_CONTRACT, 'operational_evidence_binding_invalid', 409)
  const body = await bodyRecord(request)
  if (!body
    || Object.keys(body).sort().join(',') !== 'amountMinor,checkoutId,contract,currency,guardrailReceipt,guardrailReceiptDigest,humanConfirmationDigest,idempotencyKey,offerId'
    || body.contract !== CHECKOUT_PROVIDER_CONTRACT
    || !validIdentifier(body.checkoutId)
    || !validIdentifier(body.offerId)
    || !Number.isSafeInteger(body.amountMinor)
    || Number(body.amountMinor) <= 0
    || typeof body.currency !== 'string'
    || !/^[A-Z]{3}$/u.test(body.currency)
    || typeof body.idempotencyKey !== 'string'
    || body.idempotencyKey.length < 1
    || body.idempotencyKey.length > 256
    || !validSha256(body.humanConfirmationDigest)
    || !validSha256(body.guardrailReceiptDigest)) {
    return providerError(CHECKOUT_PROVIDER_CONTRACT, 'checkout_confirmation_malformed', 400, binding)
  }
  const prior = DEV_SETTLEMENTS.get(body.idempotencyKey)
  if (prior) {
    const sameRequest = prior.checkoutId === body.checkoutId
      && prior.offerId === body.offerId
      && prior.amountMinor === body.amountMinor
      && prior.currency === body.currency
      && prior.humanConfirmationDigest === body.humanConfirmationDigest
      && prior.guardrailReceiptDigest === body.guardrailReceiptDigest
    return sameRequest
      ? settlementResponse(prior, binding)
      : providerError(CHECKOUT_PROVIDER_CONTRACT, 'checkout_confirmation_precondition_failed', 409, binding)
  }
  const partial: Omit<SettlementReceipt, 'receiptDigest'> = Object.freeze({
    schema: SETTLEMENT_RECEIPT_SCHEMA,
    settlementId: `settlement-${(await sha256Hex(body.idempotencyKey)).slice(0, 32)}`,
    checkoutId: body.checkoutId,
    offerId: body.offerId,
    amountMinor: Number(body.amountMinor),
    currency: body.currency,
    idempotencyKey: body.idempotencyKey,
    humanConfirmationDigest: body.humanConfirmationDigest,
    guardrailReceiptDigest: body.guardrailReceiptDigest,
    providerRevision: DEV_CHECKOUT_EVIDENCE_PIN.sourceRevision,
    state: 'settled',
  })
  const receipt: SettlementReceipt = Object.freeze({
    ...partial,
    receiptDigest: await digestSettlementReceipt(partial),
  })
  DEV_SETTLEMENTS.set(body.idempotencyKey, receipt)
  return settlementResponse(receipt, binding)
}

async function checkoutStatusResponse(request: Request): Promise<Response> {
  const binding = await checkoutOperationBinding(request)
  if (!binding) return providerError(CHECKOUT_PROVIDER_CONTRACT, 'operational_evidence_binding_invalid', 409)
  const url = new URL(request.url)
  const idempotencyKey = url.searchParams.get('idempotencyKey')
  if (!idempotencyKey || [...url.searchParams.keys()].join(',') !== 'idempotencyKey') {
    return providerError(CHECKOUT_PROVIDER_CONTRACT, 'checkout_status_malformed', 400, binding)
  }
  const receipt = DEV_SETTLEMENTS.get(idempotencyKey)
  return receipt
    ? settlementResponse(receipt, binding)
    : providerError(CHECKOUT_PROVIDER_CONTRACT, 'settlement_not_found', 404, binding)
}

async function offerObservationResponse(request: Request): Promise<Response> {
  const binding = await checkoutOperationBinding(request)
  if (!binding) return providerError(CHECKOUT_PROVIDER_CONTRACT, 'operational_evidence_binding_invalid', 409)
  const url = new URL(request.url)
  const offerId = decodeURIComponent(url.pathname.split('/')[4] ?? '')
  const agentId = url.searchParams.get('agentId')
  if (!validIdentifier(offerId) || !validIdentifier(agentId)) {
    return providerError(CHECKOUT_PROVIDER_CONTRACT, 'offer_observation_malformed', 400, binding)
  }
  return providerJson({
    ok: true,
    contract: CHECKOUT_PROVIDER_CONTRACT,
    observed: { priceMinor: 12_500, available: true },
  }, 200, binding)
}

function settlementResponse(receipt: SettlementReceipt, binding: OperationalEvidenceBinding): Response {
  return providerJson({ ok: true, contract: CHECKOUT_PROVIDER_CONTRACT, settlementReceipt: receipt }, 200, binding)
}

async function mcpResponse(request: Request): Promise<Response> {
  if (request.method === 'DELETE') return new Response(null, { status: 204 })
  const discoveryBinding = request.headers.get('x-commerce-contract') === DISCOVERY_PROVIDER_CONTRACT
    ? await discoveryOperationBinding(request)
    : null
  const rpc = await bodyRecord(request)
  if (!rpc) return rpcError(null, -32_700, 'Parse error')
  if (rpc.method === 'notifications/initialized') return new Response(null, { status: 204 })
  if (rpc.method === 'initialize') {
    return rpcResult(rpc.id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'commerce-dev-provider', version: '1.0.0' },
    }, { 'mcp-session-id': 'commerce-dev-session' })
  }
  if (rpc.method === 'tools/list') {
    return rpcResult(rpc.id, { tools: [
      { name: DOCS_INVOCATION_TOOL },
      { name: 'commerce.flight.discover' },
      { name: 'commerce.shopping.discover' },
    ] })
  }
  if (rpc.method !== 'tools/call' || !isRecord(rpc.params)) {
    return rpcError(rpc.id, -32_601, 'Method not found')
  }
  const args = isRecord(rpc.params.arguments) ? rpc.params.arguments : {}
  const invocationCall = rpc.params.name === DOCS_INVOCATION_TOOL
  if (!invocationCall
    && !discoveryBinding) {
    return rpcError(rpc.id, -32_003, 'Discovery operational evidence binding invalid')
  }
  const payload = invocationCall
    ? invocationPayload(args)
    : await discoveryPayload(rpc.params.name, args)
  return rpcResult(rpc.id, {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: payload.ok === false,
  }, discoveryBinding ? operationalEvidenceResponseHeaders(discoveryBinding) : {})
}

function invocationPayload(args: Record<string, unknown>): Record<string, unknown> {
  if (typeof args.query === 'string') {
    return {
      ok: true,
      ...DEV_INVOCATION_METADATA,
      truncated: false,
      catalog: CATALOG.filter((entry) => entry.token.startsWith(args.query as string)),
    }
  }
  const token = typeof args.token === 'string' ? args.token : ''
  const invocation = CATALOG.find((entry) => entry.token === token) ?? null
  return {
    ok: invocation !== null,
    ...DEV_INVOCATION_METADATA,
    token,
    invocation,
    truncated: false,
    catalog: [],
  }
}

async function discoveryPayload(toolName: unknown, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (toolName !== 'commerce.flight.discover' && toolName !== 'commerce.shopping.discover') {
    return { ok: false, code: 'unknown_tool' }
  }
  const context = isRecord(args.commerceContext) ? args.commerceContext : null
  if (!context
    || !validIdentifier(context.intentId)
    || !validSha256(context.intentDigest)
    || !validIdentifier(context.agentId)) {
    return { ok: false, code: 'discovery_context_invalid' }
  }
  const partial: Omit<DiscoveryOfferReceipt, 'receiptDigest'> = Object.freeze({
    schema: DISCOVERY_OFFER_SCHEMA,
    intentId: context.intentId,
    intentDigest: context.intentDigest,
    agentId: context.agentId,
    offerId: 'offer-1',
    amountMinor: 12_500,
    currency: 'USD',
    providerRevision: DEV_CHECKOUT_EVIDENCE_PIN.sourceRevision,
  })
  const offer: DiscoveryOfferReceipt = Object.freeze({
    ...partial,
    receiptDigest: await digestDiscoveryOffer(partial),
  })
  return { contract: DISCOVERY_RECEIPT_CONTRACT, ok: true, offers: [offer] }
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
}

function validSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

async function bodyRecord(request: Request): Promise<Record<string, unknown> | null> {
  const body = await readJsonObject(request)
  return isHttpFailure(body) ? null : body
}

function providerJson(
  value: unknown,
  status: number,
  binding: OperationalEvidenceBinding,
  permit: ClaimMutationPermit | null = null,
): Response {
  return Response.json(value, { status, headers: providerHeaders(binding, permit) })
}

function providerError(
  contract: string,
  code: string,
  status: number,
  binding?: OperationalEvidenceBinding,
  permit: ClaimMutationPermit | null = null,
): Response {
  const init: ResponseInit = binding
    ? { status, headers: providerHeaders(binding, permit) }
    : { status }
  return Response.json({ ok: false, contract, code }, init)
}

function providerHeaders(binding: OperationalEvidenceBinding, permit: ClaimMutationPermit | null): Headers {
  const headers = new Headers(operationalEvidenceResponseHeaders(binding))
  for (const [name, value] of Object.entries(devAuthoringHeaders(permit))) headers.set(name, value)
  return headers
}

function rpcResult(id: unknown, result: unknown, headers: HeadersInit = {}): Response {
  return Response.json({ jsonrpc: '2.0', id, result }, { headers })
}

function rpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status: 400 })
}
