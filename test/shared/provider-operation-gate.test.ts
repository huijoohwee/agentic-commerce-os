import { describe, expect, it } from 'vitest'

import {
  bindOperationalProviderRequest,
  operationalEvidenceResponseHeaders,
  readOperationalEvidenceBinding,
  responseMatchesOperationalEvidence,
  verifyOperationalEvidence,
} from '../../src/core/provider-operation-gate.ts'
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

    const original = new Request('https://commerce.internal/internal/v1/checkouts/prepare', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-06-18',
        'mcp-session-id': 'session-a',
        'x-commerce-contract': CONTRACT,
      },
      body: JSON.stringify({ checkoutId: 'checkout-1', amountMinor: 12500 }),
    })
    const operation = await bindOperationalProviderRequest(verified.permit, original)
    expect(operation.ok).toBe(true)
    if (!operation.ok) throw new Error(operation.code)
    const providerBinding = await readOperationalEvidenceBinding(operation.request, pin, CHECKS)
    expect(providerBinding).toEqual(operation.binding)

    const response = Response.json({ ok: true }, {
      headers: operationalEvidenceResponseHeaders(operation.binding),
    })
    expect(responseMatchesOperationalEvidence(response, operation.binding)).toBe(true)
    expect(responseMatchesOperationalEvidence(Response.json({ ok: true }), operation.binding)).toBe(false)

    const tampered = new Request('https://commerce.internal/internal/v1/checkouts/confirm', {
      method: operation.request.method,
      headers: operation.request.headers,
      body: await operation.request.clone().text(),
    })
    await expect(readOperationalEvidenceBinding(tampered, pin, CHECKS)).resolves.toBeNull()

    for (const [header, value] of [
      ['mcp-session-id', 'session-b'],
      ['mcp-protocol-version', '2099-01-01'],
    ] as const) {
      const headers = new Headers(operation.request.headers)
      headers.set(header, value)
      const transportMutation = new Request(operation.request, {
        headers,
        body: await operation.request.clone().text(),
      })
      await expect(readOperationalEvidenceBinding(transportMutation, pin, CHECKS)).resolves.toBeNull()
    }
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
