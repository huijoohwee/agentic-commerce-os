import { describe, expect, it, vi } from 'vitest'

import { createStorefrontActions } from '../../src/edge/client/storefront-actions'

const RECEIPT_DIGEST = 'a'.repeat(64)

describe('storefront actions', () => {
  it('discovers one real scoped offer before enabling checkout preparation', async () => {
    const observedPaths: string[] = []
    const fetcher = fetchFixture(observedPaths, 'agent-a', true)
    const actions = createStorefrontActions({
      fetcher,
      catalogPath: '/v1/public/merchants/merchant-1/catalog',
      createId: () => 'fixed',
      localStore: {
        recordCompletedSync: vi.fn(async () => undefined),
        recordChange: vi.fn(async () => ({ ok: true as const, sequence: 1 })),
      },
    })

    const page = await actions.searchCatalog({ query: '', limit: 10 })
    expect(page.listings).toHaveLength(1)
    expect(page.listings[0]?.offers).toEqual([
      {
        offerId: 'offer-a',
        intentId: 'intent-fixed',
        agentId: 'agent-a',
        offerReceiptDigest: RECEIPT_DIGEST,
        amountMinor: 1250,
        budgetMinor: 1250,
        currency: 'USD',
      },
    ])

    const selected = await actions.selectOffer({ listingId: 'listing-a', offerId: 'offer-a' })
    expect(selected.ok).toBe(true)
    if (!selected.ok) throw new Error('selection unexpectedly refused')
    const prepared = await actions.initiateCheckout({
      offerId: selected.offerId,
      amountMinor: selected.amountMinor,
      currency: selected.currency,
    })
    expect(prepared).toEqual({
      ok: true,
      checkoutId: 'checkout-fixed',
      state: 'awaiting-human-confirmation',
    })
    expect(JSON.stringify(prepared)).not.toMatch(/confirmationToken|settlement/iu)
    expect(observedPaths).toEqual([
      '/v1/public/merchants/merchant-1/catalog',
      '/v1/session',
      '/v1/checkouts/checkout-fixed/prepare',
    ])
  })

  it('passes a merchant listing target and refuses an out-of-scope routed agent', async () => {
    const observedPaths: string[] = []
    const observedRouteBodies: Array<Record<string, unknown>> = []
    const actions = createStorefrontActions({
      fetcher: fetchFixture(observedPaths, 'agent-outside-scope', false, observedRouteBodies),
      catalogPath: '/v1/public/merchants/merchant-1/catalog',
      createId: () => 'fixed',
      localStore: { recordCompletedSync: vi.fn(async () => undefined) },
    })

    const result = await actions.searchCatalog({ query: '', limit: 10 })
    expect(result.listings).toEqual([expect.objectContaining({
      listingId: 'listing-a',
      offers: [],
      checkoutAvailability: { ok: false, code: 'routed_agent_outside_catalog' },
    })])
    expect(observedPaths).toEqual([
      '/v1/public/merchants/merchant-1/catalog', '/v1/session', '/v1/intents/route',
    ])
    expect(observedRouteBodies).toEqual([expect.objectContaining({
      merchantId: 'merchant-1', listingId: 'listing-a', category: 'travel',
    })])
  })

  it('propagates local capacity refusal before changing the selected offer', async () => {
    const actions = createStorefrontActions({
      fetcher: fetchFixture([], 'agent-a', true),
      catalogPath: '/v1/public/merchants/merchant-1/catalog',
      localStore: {
        recordCompletedSync: vi.fn(async () => undefined),
        recordChange: vi.fn(async () => ({
          ok: false as const, code: 'local_change_capacity_reached' as const, retained: 500,
        })),
      },
    })
    await actions.searchCatalog({ query: '', limit: 10 })
    await expect(actions.selectOffer({ listingId: 'listing-a', offerId: 'offer-a' })).resolves.toEqual({
      ok: false, code: 'local_change_capacity_reached', retained: 500,
    })
    await expect(actions.initiateCheckout({ offerId: 'offer-a', amountMinor: 1250, currency: 'USD' }))
      .resolves.toEqual({ ok: false, code: 'offer_selection_required' })
  })
})

function fetchFixture(
  observedPaths: string[],
  routedAgentId: string,
  embeddedOffer = false,
  observedRouteBodies: Array<Record<string, unknown>> = [],
): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request
      ? input
      : new Request(new URL(String(input), 'https://storefront.invalid'), init)
    const url = new URL(request.url)
    observedPaths.push(url.pathname)

    if (url.pathname.endsWith('/catalog')) {
      return Response.json({
        ok: true,
        listings: [{
          listingId: 'listing-a',
          agentId: 'agent-a',
          category: 'travel',
          title: 'Scoped listing',
          summary: 'Real merchant metadata with no embedded offers.',
          ...(embeddedOffer ? { offers: [{
            offerId: 'offer-a',
            intentId: 'intent-fixed',
            agentId: 'agent-a',
            offerReceiptDigest: RECEIPT_DIGEST,
            amountMinor: 1250,
            budgetMinor: 1250,
            currency: 'USD',
          }] } : {}),
        }],
      })
    }
    if (url.pathname === '/v1/session') return Response.json({ ok: true }, { status: 201 })
    if (url.pathname === '/v1/intents/route') {
      const body: Record<string, unknown> = await request.json()
      observedRouteBodies.push(body)
      const intentId = typeof body === 'object' && body !== null && 'intentId' in body
        ? String(body.intentId)
        : ''
      return Response.json({
        ok: true,
        agentId: routedAgentId,
        result: {
          offers: [{
            offerId: 'offer-a',
            intentId,
            agentId: routedAgentId,
            receiptDigest: RECEIPT_DIGEST,
            amountMinor: 1250,
            currency: 'USD',
          }],
        },
      })
    }
    if (url.pathname.endsWith('/prepare')) {
      return Response.json({
        ok: true,
        confirmationToken: crypto.randomUUID(),
        state: 'awaiting-human-confirmation',
      })
    }
    return Response.json({ ok: false, code: 'not_found' }, { status: 404 })
  }
}
