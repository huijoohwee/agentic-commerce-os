import { SELF, env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import {
  reconcileSettlement,
  requestGuardrail,
  submitSettlement,
} from '../../src/core/checkout-provider-client.ts'
import type { StoredCheckout } from '../../src/core/checkout-state.ts'
import { observeHeldOffer } from '../../src/core/offer-watch.ts'
import { DEV_PROVIDER_PINS } from '../../src/dev/provider.ts'
import { vendorTransitionClaim } from '../../src/domain/authoring-claim-policy.ts'

describe('operational evidence at provider call sites', () => {
  it('binds guardrail, settlement submit, and settlement readback independently', async () => {
    const checkoutId = `checkout-operation-gate-${crypto.randomUUID()}`
    const prepare = Object.freeze({
      checkoutId,
      intentId: 'intent-operation-gate',
      agentId: 'agent-operation-gate',
      offerId: 'offer-operation-gate',
      offerReceiptDigest: 'a'.repeat(64),
      offerProviderRevision: DEV_PROVIDER_PINS.checkoutEvidence.sourceRevision,
      amountMinor: 12_500,
      budgetMinor: 15_000,
      currency: 'USD',
    })
    const guardrail = await requestGuardrail(env as unknown as CoreEnv, prepare)
    expect(guardrail).toMatchObject({ checkoutId, providerRevision: prepare.offerProviderRevision })
    if (!guardrail) throw new Error('guardrail fixture rejected operational evidence')
    const state = Object.freeze({
      checkout_id: checkoutId,
      offer_id: prepare.offerId,
      amount_minor: prepare.amountMinor,
      currency: prepare.currency,
      guardrail_receipt_json: JSON.stringify(guardrail),
      guardrail_receipt_digest: guardrail.receiptDigest,
      offer_provider_revision: prepare.offerProviderRevision,
    }) as StoredCheckout
    const humanDigest = 'b'.repeat(64)
    const key = `checkout-confirm:${checkoutId}`
    await expect(submitSettlement(env as unknown as CoreEnv, state, humanDigest, key))
      .resolves.toMatchObject({ ok: true, receipt: { checkoutId } })
    await expect(reconcileSettlement(env as unknown as CoreEnv, state, humanDigest, key))
      .resolves.toMatchObject({ ok: true, receipt: { checkoutId } })
    await expect(providerCounts(checkoutId)).resolves.toEqual({ confirmPosts: 1, statusGets: 1 })
  })

  it('binds offer observation and the marketplace settlement read', async () => {
    await expect(observeHeldOffer(env as unknown as CoreEnv, Object.freeze({
      offerId: 'offer-operation-observe',
      agentId: 'agent-operation-observe',
      recorded: Object.freeze({ priceMinor: 12_500, available: true, agentActive: true }),
      priorChanges: Object.freeze([]),
      failedAttempts: 0,
    }))).resolves.toMatchObject({ kind: 'agent-inactive' })

    const response = await SELF.fetch('https://core.test/internal/v1/settlements/split-operation-gate', {
      headers: {
        'x-commerce-contract': 'commerce.edge-core/v1',
        'x-commerce-release-candidate': DEV_PROVIDER_PINS.releaseCandidateSha,
        'x-commerce-release-candidate-digest': 'e'.repeat(64),
      },
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      contract: 'commerce.marketplace-provider/v1',
      splitId: 'split-operation-gate',
      state: 'settled',
    })
  })

  it('has the provider reject an operation that omits the evidence/request binding', async () => {
    const response = await env.CHECKOUT_PROVIDER.fetch(new Request(
      'https://commerce.internal/internal/v1/checkouts/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-commerce-contract': 'commerce.checkout-provider/v1' },
      body: JSON.stringify({ checkoutId: 'unbound' }),
    }))
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: 'operational_evidence_binding_invalid',
    })
  })

  it('binds an admitted marketplace vendor transition before mutation', async () => {
    const vendorId = `vendor-${crypto.randomUUID()}`
    const claim = vendorTransitionClaim(vendorId)
    const claimId = `claim-${crypto.randomUUID()}`
    const fenceRevision = `fence-${crypto.randomUUID()}`
    const claimHeaders = {
      ...coreHeaders(),
      'x-authoring-semantic-scope': claim.semanticScope,
      'x-authoring-claim-id': claimId,
      'x-authoring-lease-epoch': '1',
      'x-authoring-fence-revision': fenceRevision,
    }
    const acquired = await SELF.fetch('https://core.test/internal/v1/operator/claims/acquire', {
      method: 'POST',
      headers: coreHeaders(),
      body: JSON.stringify({
        claimId,
        actorId: 'operator-operation-gate',
        deviceId: 'device-operation-gate',
        sessionId: 'session-operation-gate',
        worktree: '/test/provider-operation-gate',
        branch: 'agent/test/provider-operation-gate',
        semanticScope: claim.semanticScope,
        declaredWriteSet: [claim.writeTarget],
        leaseEpoch: 1,
        leaseExpiresAtMs: Date.now() + 60_000,
        fenceRevision,
      }),
    })
    expect(acquired.status).toBe(200)
    const transitioned = await SELF.fetch(
      `https://core.test/internal/v1/vendors/${encodeURIComponent(vendorId)}/transition`,
      {
        method: 'POST',
        headers: claimHeaders,
        body: JSON.stringify({ actorId: 'operator-operation-gate', state: 'active' }),
      },
    )
    expect(transitioned.status).toBe(200)
    await expect(transitioned.json()).resolves.toMatchObject({ ok: true, vendorId, state: 'active' })
  })
})

function providerCounts(checkoutId: string): Promise<{ confirmPosts: number; statusGets: number }> {
  return env.CHECKOUT_PROVIDER.fetch(
    `https://commerce.internal/__test__/checkout-provider-counts/${encodeURIComponent(checkoutId)}`,
  ).then((response) => response.json())
}

function coreHeaders(): Readonly<Record<string, string>> {
  return Object.freeze({
    'content-type': 'application/json',
    'x-commerce-contract': 'commerce.edge-core/v1',
    'x-commerce-release-candidate': DEV_PROVIDER_PINS.releaseCandidateSha,
    'x-commerce-release-candidate-digest': 'e'.repeat(64),
  })
}
