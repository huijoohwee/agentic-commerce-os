import { describe, expect, it } from 'vitest'

import {
  bindOperationalProviderRequest,
  operationalEvidenceResponseHeaders,
  readAuthenticatedOperationalEvidenceBinding,
  readOperationalEvidenceBinding,
  responseMatchesOperationalEvidence,
  verifyOperationalEvidence,
} from '../../src/core/provider-operation-gate.ts'
import {
  authenticateCommerceProviderRequest,
  COMMERCE_PROVIDER_AUTH_HEADERS,
  COMMERCE_PROVIDER_AUTH_SCHEMA,
} from '../../src/shared/commerce-provider-auth.ts'
import { canonicalJson, sha256Hex } from '../../src/shared/digest.ts'
import { AUTHORING_MUTATION_HEADER_NAMES } from '../../src/core/authoring-mutation-headers.ts'
import {
  COMMERCE_PRD_REVISION,
  UPSTREAM_RUNTIME_EVIDENCE_SCHEMA,
  digestUpstreamRuntimeEvidence,
  type UpstreamEvidencePin,
} from '../../src/core/upstream-evidence.ts'

const CONTRACT = 'commerce.checkout-provider/v1'
const CHECKS = Object.freeze(['alpha_check', 'beta_check'])
const SOURCE = 'a'.repeat(40)
const STORAGE = 'checkout/v1'
const VERSION = 'checkout-v1'
const AUTH_SECRET = 'checkout-provider-contract-test-secret'

describe('operational provider evidence gate', () => {
  it('binds every pinned identity, the declared checks, and the exact request to the response', async () => {
    const evidence = await evidenceEnvelope([...CHECKS, 'forward_compatible_surplus'])
    const pin = evidencePin(evidence)
    const provider = evidenceProvider(evidence)
    const verified = await verifyOperationalEvidence(
      provider,
      'checkout-provider.internal',
      CONTRACT,
      JSON.stringify(pin),
      CHECKS,
    )
    expect(verified.ok).toBe(true)
    if (!verified.ok) throw new Error(verified.code)

    const operationBody = JSON.stringify({ checkoutId: 'checkout-1', amountMinor: 12500 })
    const operationUrl = 'https://commerce.internal/internal/v1/checkouts/prepare'
    const original = new Request(operationUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-06-18',
        'mcp-session-id': 'session-a',
        'x-commerce-contract': CONTRACT,
      },
      body: operationBody,
    })
    const operation = await bindOperationalProviderRequest(verified.permit, original)
    expect(operation.ok).toBe(true)
    if (!operation.ok) throw new Error(operation.code)
    expect(operation.binding.requestDigest).toBe(await sha256Hex(canonicalJson({
      method: 'POST',
      url: operationUrl,
      semanticHeaders: {
        accept: null,
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-06-18',
        'mcp-session-id': 'session-a',
        'x-commerce-contract': CONTRACT,
        'x-operator-id': null,
        ...Object.fromEntries(AUTHORING_MUTATION_HEADER_NAMES.map((name) => [name, null])),
      },
      bodyDigest: await sha256Hex(operationBody),
    })))
    await expect(operation.request.clone().text()).resolves.toBe(operationBody)
    const providerOperation = await readOperationalEvidenceBinding(operation.request, pin, CHECKS)
    expect(providerOperation).not.toBeNull()
    if (!providerOperation) throw new Error('provider operation binding missing')
    expect(providerOperation.binding).toEqual(operation.binding)
    await expect(providerOperation.request.clone().text()).resolves.toBe(operationBody)

    const response = Response.json({ ok: true }, {
      headers: operationalEvidenceResponseHeaders(operation.binding),
    })
    expect(responseMatchesOperationalEvidence(response, operation.binding)).toBe(true)
    expect(responseMatchesOperationalEvidence(Response.json({ ok: true }), operation.binding)).toBe(false)

    const tampered = new Request('https://commerce.internal/internal/v1/checkouts/confirm', {
      method: operation.request.method,
      headers: operation.request.headers,
      body: operationBody,
    })
    await expect(readOperationalEvidenceBinding(tampered, pin, CHECKS)).resolves.toBeNull()

    for (const [header, value] of [
      ['mcp-session-id', 'session-b'],
      ['mcp-protocol-version', '2099-01-01'],
    ] as const) {
      const headers = new Headers(operation.request.headers)
      headers.set(header, value)
      const transportMutation = new Request(operationUrl, {
        method: 'POST',
        headers,
        body: operationBody,
      })
      await expect(readOperationalEvidenceBinding(transportMutation, pin, CHECKS)).resolves.toBeNull()
    }
  })

  it('cancels an oversized chunked body and replays no partial request', async () => {
    const evidence = await evidenceEnvelope(CHECKS)
    const verified = await verifyOperationalEvidence(
      evidenceProvider(evidence),
      'checkout-provider.internal',
      CONTRACT,
      JSON.stringify(evidencePin(evidence)),
      CHECKS,
    )
    expect(verified.ok).toBe(true)
    if (!verified.ok) throw new Error(verified.code)

    let cancellationReason: unknown = null
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65_536))
        controller.enqueue(new Uint8Array([1]))
      },
      cancel(reason) {
        cancellationReason = reason
      },
    })
    const request = new Request('https://commerce.internal/internal/v1/checkouts/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })

    await expect(bindOperationalProviderRequest(verified.permit, request)).resolves.toEqual({
      ok: false,
      code: 'provider_request_unbindable',
    })
    expect(cancellationReason).toBe('provider request body exceeded bound')
  })

  it('authenticates the exact evidence-bound request and rejects forgery, wrong secrets, and cross-contract replay', async () => {
    const evidence = await evidenceEnvelope(CHECKS)
    const pin = evidencePin(evidence)
    const verified = await verifyOperationalEvidence(
      evidenceProvider(evidence),
      'checkout-provider.internal',
      CONTRACT,
      JSON.stringify(pin),
      CHECKS,
    )
    expect(verified.ok).toBe(true)
    if (!verified.ok) throw new Error(verified.code)
    const bound = await bindOperationalProviderRequest(verified.permit, new Request(
      'https://commerce.internal/internal/v1/checkouts/status?idempotencyKey=checkout-1',
      { headers: { 'x-commerce-contract': CONTRACT } },
    ))
    expect(bound.ok).toBe(true)
    if (!bound.ok) throw new Error(bound.code)
    const authenticated = await authenticateCommerceProviderRequest(bound.request, {
      contract: CONTRACT,
      requestDigest: bound.binding.requestDigest,
      bindingDigest: bound.binding.bindingDigest,
    }, AUTH_SECRET)
    expect(authenticated?.headers.get(COMMERCE_PROVIDER_AUTH_HEADERS.schema)).toBe(COMMERCE_PROVIDER_AUTH_SCHEMA)
    await expect(readAuthenticatedOperationalEvidenceBinding(
      authenticated!, CONTRACT, pin, CHECKS, AUTH_SECRET,
    )).resolves.not.toBeNull()
    await expect(readAuthenticatedOperationalEvidenceBinding(
      authenticated!, CONTRACT, pin, CHECKS, `${AUTH_SECRET}-wrong`,
    )).resolves.toBeNull()
    await expect(readAuthenticatedOperationalEvidenceBinding(
      authenticated!, 'commerce.marketplace-provider/v1', pin, CHECKS, AUTH_SECRET,
    )).resolves.toBeNull()

    const forgedHeaders = new Headers(bound.request.headers)
    forgedHeaders.set(COMMERCE_PROVIDER_AUTH_HEADERS.schema, COMMERCE_PROVIDER_AUTH_SCHEMA)
    forgedHeaders.set(COMMERCE_PROVIDER_AUTH_HEADERS.signature, '0'.repeat(64))
    await expect(readAuthenticatedOperationalEvidenceBinding(
      new Request(bound.request, { headers: forgedHeaders }), CONTRACT, pin, CHECKS, AUTH_SECRET,
    )).resolves.toBeNull()

    const forgedFenceHeaders = new Headers(authenticated!.headers)
    forgedFenceHeaders.set('x-authoring-lease-epoch', '999')
    await expect(readAuthenticatedOperationalEvidenceBinding(
      new Request(authenticated!, { headers: forgedFenceHeaders }), CONTRACT, pin, CHECKS, AUTH_SECRET,
    )).resolves.toBeNull()
  })

  it('fails closed for each immutable identity and for a missing required check', async () => {
    const evidence = await evidenceEnvelope(CHECKS)
    const pin = evidencePin(evidence)
    const mutations = [
      { ...evidence, sourceRevision: 'b'.repeat(40) },
      { ...evidence, receiptDigest: 'b'.repeat(64) },
      { ...evidence, storageCompatibilityRevision: 'checkout/v2' },
      { ...evidence, providerVersionId: 'checkout-v2' },
      { ...evidence, checks: evidence.checks.slice(1) },
    ]
    for (const mutation of mutations) {
      const result = await verifyOperationalEvidence(
        evidenceProvider(mutation),
        'checkout-provider.internal',
        CONTRACT,
        JSON.stringify(pin),
        CHECKS,
      )
      expect(result).toEqual({ ok: false, code: 'provider_evidence_mismatch' })
    }
  })

  it('fails closed when bounded evidence retrieval is unavailable', async () => {
    const pin = evidencePin(await evidenceEnvelope(CHECKS))
    const provider = Object.freeze({ fetch: async () => { throw new Error('offline') } }) as unknown as Fetcher
    await expect(verifyOperationalEvidence(
      provider,
      'checkout-provider.internal',
      CONTRACT,
      JSON.stringify(pin),
      CHECKS,
    )).resolves.toEqual({ ok: false, code: 'provider_evidence_unavailable' })
  })
})

async function evidenceEnvelope(checks: readonly string[]) {
  const value = Object.freeze({
    schema: UPSTREAM_RUNTIME_EVIDENCE_SCHEMA,
    prdRevision: COMMERCE_PRD_REVISION,
    sourceRevision: SOURCE,
    storageCompatibilityRevision: STORAGE,
    providerVersionId: VERSION,
    checks: Object.freeze(checks.map((name) => Object.freeze({ name, ok: true }))),
  })
  return Object.freeze({ ...value, receiptDigest: await digestUpstreamRuntimeEvidence(value) })
}

function evidencePin(evidence: Awaited<ReturnType<typeof evidenceEnvelope>>): UpstreamEvidencePin {
  return Object.freeze({
    sourceRevision: evidence.sourceRevision,
    receiptDigest: evidence.receiptDigest,
    storageCompatibilityRevision: evidence.storageCompatibilityRevision,
    providerVersionId: evidence.providerVersionId,
  })
}

function evidenceProvider(evidence: unknown): Fetcher {
  return Object.freeze({
    async fetch(request: Request) {
      return new URL(request.url).pathname === '/v1/runtime-evidence'
        ? Response.json({ ok: true, contract: CONTRACT, evidence })
        : Response.json({ ok: false, code: 'unexpected_operation' }, { status: 500 })
    },
  }) as unknown as Fetcher
}
