import { isHttpFailure, isRecord, readJsonObject } from '../shared/http.js'
import { CHECKOUT_PROVIDER_CONTRACT, MARKETPLACE_PROVIDER_CONTRACT } from '../core/provider-contract.js'
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
  CHECKOUT_EVIDENCE_CHECKS,
  COMMERCE_PRD_REVISION,
  MARKETPLACE_EVIDENCE_CHECKS,
  UPSTREAM_RUNTIME_EVIDENCE_SCHEMA,
  type UpstreamEvidencePin,
} from '../core/upstream-evidence.js'
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

const INVOCATION_PATH = new URL(DOCS_INVOCATION_ENDPOINT).pathname
const DEMO_CONTRACT = 'commerce.dev-provider/v1'
const CHECKOUT_PROVIDER_VERSION_ID = 'checkout-dev-fixture-v1'
const MARKETPLACE_PROVIDER_VERSION_ID = 'marketplace-dev-fixture-v1'

const CHECKOUT_EVIDENCE_PIN: UpstreamEvidencePin = Object.freeze({
  sourceRevision: 'c'.repeat(40),
  receiptDigest: '03562b1a8a5b16299466ceee22cf2bd1d61af42e564f7f23e1975d232762952d',
  storageCompatibilityRevision: 'checkout-demo/v1',
  providerVersionId: CHECKOUT_PROVIDER_VERSION_ID,
})
const MARKETPLACE_EVIDENCE_PIN: UpstreamEvidencePin = Object.freeze({
  sourceRevision: 'e'.repeat(40),
  receiptDigest: '802be270fcc3c27103f03794ad437b193e413b3eb337250730dba40356b3f15d',
  storageCompatibilityRevision: 'marketplace-demo/v1',
  providerVersionId: MARKETPLACE_PROVIDER_VERSION_ID,
})

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
  checkoutEvidence: CHECKOUT_EVIDENCE_PIN,
  marketplaceEvidence: MARKETPLACE_EVIDENCE_PIN,
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
      operations: ['register'],
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
    return runtimeEvidenceResponse(url.hostname)
  }
  if (request.method === 'POST' && url.pathname === '/internal/v1/checkouts/prepare') {
    return checkoutPrepareResponse(request)
  }
  if (request.method === 'POST' && url.pathname === '/internal/v1/checkouts/confirm') {
    return checkoutConfirmResponse(request)
  }
  if (request.method === 'GET' && url.pathname === '/internal/v1/checkouts/status') {
    return checkoutStatusResponse(url)
  }
  if (request.method === 'GET' && url.pathname === '/v1/vendors') {
    return Response.json({ ok: true, contract: MARKETPLACE_PROVIDER_CONTRACT, demo: true, vendors: [] })
  }
  if (request.method === 'GET' && /^\/v1\/settlements\/[^/]+$/u.test(url.pathname)) {
    return Response.json({
      ok: true,
      contract: MARKETPLACE_PROVIDER_CONTRACT,
      demo: true,
      splitId: url.pathname.split('/').at(-1),
      state: 'settled',
    })
  }
  if (request.method === 'POST' && /^\/v1\/vendors\/[^/]+\/transition$/u.test(url.pathname)) {
    const body = await bodyRecord(request)
    if (!body || typeof body.state !== 'string') {
      return providerError(MARKETPLACE_PROVIDER_CONTRACT, 'vendor_transition_malformed', 400)
    }
    return Response.json({
      ok: true,
      contract: MARKETPLACE_PROVIDER_CONTRACT,
      demo: true,
      vendorId: decodeURIComponent(url.pathname.split('/')[3] ?? ''),
      state: body.state,
    })
  }
  return Response.json({ ok: false, contract: DEMO_CONTRACT, code: 'not_found' }, { status: 404 })
}

async function admissionResponse(request: Request): Promise<Response> {
  const body = await bodyRecord(request)
  const fields = body ? Object.keys(body).sort() : []
  if (!body || JSON.stringify(fields) !== JSON.stringify([
    'agent_definition',
    'invocation_register_entry',
    'operator_instruction_ref',
    'tool_allowlist_entry',
  ])) return admissionRejection('registration_input_invalid')

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
    || reference.trim().length === 0) return admissionRejection('registration_input_rejected')

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
  })
}

function admissionRejection(reasonCode: string): Response {
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
  }, { status: 409 })
}

function capabilityResponse(hostname: string): Response {
  if (hostname === 'checkout-provider.internal') {
    return Response.json({
      ok: true,
      contract: CHECKOUT_PROVIDER_CONTRACT,
      demo: true,
      operations: ['prepare', 'confirm', 'status'],
    })
  }
  if (hostname === 'marketplace-provider.internal') {
    return Response.json({
      ok: true,
      contract: MARKETPLACE_PROVIDER_CONTRACT,
      demo: true,
      operations: ['vendor-list', 'vendor-transition', 'settlement-read'],
    })
  }
  return Response.json({ ok: false, contract: DEMO_CONTRACT, code: 'provider_unknown' }, { status: 404 })
}

function runtimeEvidenceResponse(hostname: string): Response {
  if (hostname === 'checkout-provider.internal') {
    return upstreamEvidenceResponse(
      CHECKOUT_PROVIDER_CONTRACT,
      CHECKOUT_EVIDENCE_PIN,
      CHECKOUT_EVIDENCE_CHECKS,
    )
  }
  if (hostname === 'marketplace-provider.internal') {
    return upstreamEvidenceResponse(
      MARKETPLACE_PROVIDER_CONTRACT,
      MARKETPLACE_EVIDENCE_PIN,
      MARKETPLACE_EVIDENCE_CHECKS,
    )
  }
  return providerError(DEMO_CONTRACT, 'provider_unknown', 404)
}

function upstreamEvidenceResponse(
  contract: string,
  pin: UpstreamEvidencePin,
  checks: readonly string[],
): Response {
  return Response.json({
    ok: true,
    contract,
    evidence: {
      schema: UPSTREAM_RUNTIME_EVIDENCE_SCHEMA,
      prdRevision: COMMERCE_PRD_REVISION,
      sourceRevision: pin.sourceRevision,
      receiptDigest: pin.receiptDigest,
      storageCompatibilityRevision: pin.storageCompatibilityRevision,
      providerVersionId: pin.providerVersionId,
      checks: checks.map((name) => ({ name, ok: true })),
    },
  })
}

async function checkoutPrepareResponse(request: Request): Promise<Response> {
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
    return providerError(CHECKOUT_PROVIDER_CONTRACT, 'checkout_prepare_malformed', 400)
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
    providerRevision: CHECKOUT_EVIDENCE_PIN.sourceRevision,
  })
  const guardrailReceipt: GuardrailReceipt = Object.freeze({
    ...partial,
    receiptDigest: await digestGuardrailReceipt(partial),
  })
  return Response.json({
    ok: true,
    contract: CHECKOUT_PROVIDER_CONTRACT,
    guardrailPassed: true,
    guardrailReceipt,
  })
}

async function checkoutConfirmResponse(request: Request): Promise<Response> {
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
    return providerError(CHECKOUT_PROVIDER_CONTRACT, 'checkout_confirmation_malformed', 400)
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
      ? settlementResponse(prior)
      : providerError(CHECKOUT_PROVIDER_CONTRACT, 'checkout_confirmation_precondition_failed', 409)
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
    providerRevision: CHECKOUT_EVIDENCE_PIN.sourceRevision,
    state: 'settled',
  })
  const receipt: SettlementReceipt = Object.freeze({
    ...partial,
    receiptDigest: await digestSettlementReceipt(partial),
  })
  DEV_SETTLEMENTS.set(body.idempotencyKey, receipt)
  return settlementResponse(receipt)
}

function checkoutStatusResponse(url: URL): Response {
  const idempotencyKey = url.searchParams.get('idempotencyKey')
  if (!idempotencyKey || [...url.searchParams.keys()].join(',') !== 'idempotencyKey') {
    return providerError(CHECKOUT_PROVIDER_CONTRACT, 'checkout_status_malformed', 400)
  }
  const receipt = DEV_SETTLEMENTS.get(idempotencyKey)
  return receipt
    ? settlementResponse(receipt)
    : providerError(CHECKOUT_PROVIDER_CONTRACT, 'settlement_not_found', 404)
}

function settlementResponse(receipt: SettlementReceipt): Response {
  return Response.json({ ok: true, contract: CHECKOUT_PROVIDER_CONTRACT, settlementReceipt: receipt })
}

async function mcpResponse(request: Request): Promise<Response> {
  if (request.method === 'DELETE') return new Response(null, { status: 204 })
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
  const payload = rpc.params.name === DOCS_INVOCATION_TOOL
    ? invocationPayload(args)
    : await discoveryPayload(rpc.params.name, args)
  return rpcResult(rpc.id, {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: payload.ok === false,
  })
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
    providerRevision: CHECKOUT_EVIDENCE_PIN.sourceRevision,
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

function providerError(contract: string, code: string, status: number): Response {
  return Response.json({ ok: false, contract, code }, { status })
}

function rpcResult(id: unknown, result: unknown, headers: HeadersInit = {}): Response {
  return Response.json({ jsonrpc: '2.0', id, result }, { headers })
}

function rpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status: 400 })
}
