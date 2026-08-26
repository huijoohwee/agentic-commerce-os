import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

const CONTRACT_HEADERS = Object.freeze({
  'content-type': 'application/json',
  'x-commerce-contract': 'commerce.edge-core/v1',
  'x-commerce-release-candidate': 'b'.repeat(40),
})

describe('commerce core Worker and Durable Objects', () => {
  it('exposes liveness but rejects unbound internal calls', async () => {
    const live = await SELF.fetch('https://core.test/internal/livez')
    expect(live.status).toBe(200)
    await expect(live.json()).resolves.toMatchObject({ ok: true, contract: 'commerce.core-live/v1' })

    const rejected = await SELF.fetch('https://core.test/internal/v1/agents')
    expect(rejected.status).toBe(400)
    await expect(rejected.json()).resolves.toMatchObject({ ok: false, code: 'core_contract_required' })

    const staleRelease = await SELF.fetch('https://core.test/internal/v1/agents', {
      headers: { 'x-commerce-contract': 'commerce.edge-core/v1' },
    })
    expect(staleRelease.status).toBe(409)
    await expect(staleRelease.json()).resolves.toMatchObject({ ok: false, code: 'release_candidate_mismatch' })

    const unseeded = await SELF.fetch('https://core.test/internal/readyz')
    expect(unseeded.status).toBe(503)
    await expect(unseeded.json()).resolves.toMatchObject({ ok: false, contract: 'commerce.core-readiness/v1' })
  })

  it('persists registry, exclusive routing, and guarded checkout state', async () => {
    const flight = await registerAgent('flight-primary', 'flight', 'commerce.flight.discover', '1'.repeat(64))
    expect(flight.status).toBe(200)
    await expect(flight.json()).resolves.toMatchObject({ ok: true, idempotent: false })

    const shopping = await registerAgent(
      'shopping-primary',
      'shopping',
      'commerce.shopping.discover',
      '2'.repeat(64),
    )
    expect(shopping.status).toBe(200)

    const repeatedRegistration = await registerAgent(
      'flight-primary', 'flight', 'commerce.flight.discover', '1'.repeat(64),
    )
    await expect(repeatedRegistration.json()).resolves.toMatchObject({ ok: true, idempotent: true })

    const duplicateCategory = await registerAgent(
      'flight-secondary', 'flight', 'commerce.flight.discover', '3'.repeat(64),
    )
    expect(duplicateCategory.status).toBe(409)
    await expect(duplicateCategory.json()).resolves.toMatchObject({
      ok: false,
      code: 'category_already_registered',
    })

    const ready = await SELF.fetch('https://core.test/internal/readyz')
    expect(ready.status).toBe(200)
    const readiness = await ready.json<Record<string, unknown>>()
    expect(readiness).toMatchObject({ ok: true, contract: 'commerce.core-readiness/v1' })

    const intent = {
      intentId: 'intent-1',
      category: 'flight',
      constraints: { origin: 'SIN', destination: 'NRT' },
    }
    const unroutedCheckout = await coreJson('/internal/v1/checkouts/checkout-unrouted/prepare', {
      checkoutId: 'checkout-unrouted',
      intentId: 'intent-unrouted',
      agentId: 'flight-primary',
      offerId: 'offer-1',
      offerReceiptDigest: '0'.repeat(64),
      amountMinor: 12_500,
      budgetMinor: 15_000,
      currency: 'USD',
    })
    expect(unroutedCheckout.status).toBe(409)
    await expect(unroutedCheckout.json()).resolves.toMatchObject({
      ok: false,
      code: 'checkout_routing_evidence_required',
    })

    const firstDispatch = await coreJson('/internal/v1/intents/route', intent)
    expect(firstDispatch.status).toBe(200)
    const firstDispatchPayload = await firstDispatch.json<{
      result: { offers: Array<{ receiptDigest: string; providerRevision: string }> }
    }>()
    expect(firstDispatchPayload).toMatchObject({
      ok: true,
      status: 'completed',
      idempotent: false,
      agentId: 'flight-primary',
    })
    const discoveredOffer = firstDispatchPayload.result.offers[0]
    expect(discoveredOffer?.receiptDigest).toMatch(/^[0-9a-f]{64}$/u)
    const repeatedDispatch = await coreJson('/internal/v1/intents/route', intent)
    await expect(repeatedDispatch.json()).resolves.toMatchObject({ ok: true, idempotent: true })
    const changedReplay = await coreJson('/internal/v1/intents/route', {
      ...intent,
      constraints: { origin: 'SIN', destination: 'LHR' },
    })
    expect(changedReplay.status).toBe(422)
    await expect(changedReplay.json()).resolves.toMatchObject({
      ok: false,
      code: 'intent_precondition_failed',
    })

    const checkout = {
      checkoutId: 'checkout-1',
      intentId: 'intent-1',
      agentId: 'flight-primary',
      offerId: 'offer-1',
      offerReceiptDigest: discoveredOffer?.receiptDigest,
      amountMinor: 12_500,
      budgetMinor: 15_000,
      currency: 'USD',
    }
    const credentialInput = await coreJson('/internal/v1/checkouts/checkout-credential/prepare', {
      ...checkout,
      checkoutId: 'checkout-credential',
      paymentToken: 'must-not-cross-the-core-boundary',
    })
    expect(credentialInput.status).toBe(400)
    await expect(credentialInput.json()).resolves.toMatchObject({
      ok: false,
      code: 'checkout_input_fields_unsupported',
    })
    const substitutedOffer = await coreJson('/internal/v1/checkouts/checkout-substituted/prepare', {
      ...checkout,
      checkoutId: 'checkout-substituted',
      amountMinor: 12_499,
    })
    expect(substitutedOffer.status).toBe(409)
    await expect(substitutedOffer.json()).resolves.toMatchObject({
      ok: false,
      code: 'checkout_offer_receipt_required',
    })
    const prepared = await coreJson('/internal/v1/checkouts/checkout-1/prepare', checkout)
    expect(prepared.status).toBe(200)
    const preparation = await prepared.json<Record<string, unknown>>()
    expect(preparation).toMatchObject({ ok: true, status: 'confirmation_required', idempotent: false })
    expect(preparation.confirmationToken).toEqual(expect.any(String))

    const invalidConfirmation = await coreJson('/internal/v1/checkouts/checkout-1/confirm', {
      checkoutId: 'checkout-1',
      confirmationToken: 'x'.repeat(64),
      offerId: 'offer-1',
      amountMinor: 12_500,
    })
    expect(invalidConfirmation.status).toBe(409)
    await expect(invalidConfirmation.json()).resolves.toMatchObject({
      ok: false,
      code: 'confirmation_token_invalid',
    })

    const confirmation = {
      checkoutId: 'checkout-1',
      confirmationToken: preparation.confirmationToken,
      offerId: 'offer-1',
      amountMinor: 12_500,
    }
    const confirmed = await coreJson('/internal/v1/checkouts/checkout-1/confirm', confirmation)
    expect(confirmed.status).toBe(200)
    await expect(confirmed.json()).resolves.toMatchObject({ ok: true, status: 'settled', idempotent: false })

    const repeatedConfirmation = await coreJson('/internal/v1/checkouts/checkout-1/confirm', confirmation)
    await expect(repeatedConfirmation.json()).resolves.toMatchObject({ ok: true, status: 'settled', idempotent: true })

    const status = await SELF.fetch('https://core.test/internal/v1/checkouts/checkout-1', {
      headers: CONTRACT_HEADERS,
    })
    const persisted = await status.json<{ events: Array<{ eventType: string }> }>()
    expect(persisted.events.map(({ eventType }) => eventType)).toEqual([
      'checkout_prepare_requested',
      'guardrail_passed',
      'human_confirmed',
      'settlement_recorded',
    ])

    const reconcileCheckout = { ...checkout, checkoutId: 'checkout-reconcile' }
    const reconcilePrepared = await coreJson(
      '/internal/v1/checkouts/checkout-reconcile/prepare',
      reconcileCheckout,
    )
    const reconcilePreparation = await reconcilePrepared.json<Record<string, unknown>>()
    expect(reconcilePreparation).toMatchObject({ ok: true, status: 'confirmation_required' })
    const reconcileConfirmation = {
      checkoutId: 'checkout-reconcile',
      confirmationToken: reconcilePreparation.confirmationToken,
      offerId: 'offer-1',
      amountMinor: 12_500,
    }
    const ambiguous = await coreJson(
      '/internal/v1/checkouts/checkout-reconcile/confirm',
      reconcileConfirmation,
    )
    expect(ambiguous.status).toBe(409)
    await expect(ambiguous.json()).resolves.toMatchObject({
      ok: false,
      status: 'reconciliation_required',
    })

    const reconciled = await coreJson(
      '/internal/v1/checkouts/checkout-reconcile/confirm',
      reconcileConfirmation,
    )
    expect(reconciled.status).toBe(200)
    await expect(reconciled.json()).resolves.toMatchObject({
      ok: true,
      status: 'settled',
      idempotent: true,
    })

    const reconciledStatus = await SELF.fetch(
      'https://core.test/internal/v1/checkouts/checkout-reconcile',
      { headers: CONTRACT_HEADERS },
    )
    const reconciledState = await reconciledStatus.json<{ events: Array<{ eventType: string }> }>()
    expect(reconciledState.events.map(({ eventType }) => eventType)).toEqual([
      'checkout_prepare_requested',
      'guardrail_passed',
      'human_confirmed',
      'settlement_reconciliation_required',
      'settlement_reconciliation_requested',
      'settlement_recorded',
    ])
  })
})

async function registerAgent(
  agentId: string,
  category: string,
  discoveryTool: string,
  contentHash: string,
): Promise<Response> {
  return coreJson('/internal/v1/agents', {
    agentDefinition: {
      id: agentId,
      revision: `${agentId}-v1`,
      name: `${category} discovery`,
      source: { uri: `workspace:/agents/${agentId}.json`, digest: contentHash },
      model: { providerId: 'workspace-provider', modelId: 'workspace-model' },
      instructions: [{ name: 'purpose', content: `Discover bounded ${category} offers.` }],
    },
    toolAllowlistEntry: {
      entry_id: `allowlist-${agentId}`,
      agent_definition_id: agentId,
      adapter_identity: 'commerce-discovery',
      tool_names: [discoveryTool],
      review_required: true,
    },
    invocationRegisterEntry: {
      route: '/tool.route',
      tag: '#mcp',
      binding: '@mcp-gateway',
      tool_identity: 'acos.adapter.register',
    },
    operatorInstructionRef: `operator-instruction/commerce/${agentId}-v1`,
    commerceProjection: { category, discoveryTool },
    expectedPreviousContentHash: null,
  })
}

function coreJson(path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://core.test${path}`, {
    method: 'POST',
    headers: CONTRACT_HEADERS,
    body: JSON.stringify(body),
  })
}
