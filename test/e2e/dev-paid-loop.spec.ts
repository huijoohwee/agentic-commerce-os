import { expect, test } from '@playwright/test'
import {
  DEV_REGISTRATION_CLIENT_TIMEOUT_MS, devRuntimeEnvironment, registrationInput, registryClaim, registryClaimHeaders,
} from './dev-runtime.ts'

test('reviewed merchant offer reaches one visually confirmed settlement and one markup line', async ({ page, request }) => {
  const runtime = devRuntimeEnvironment()
  const agentHeaders = { authorization: `Bearer ${runtime.agentToken}` }
  const claim = registryClaim(runtime.runId)
  const operatorHeaders = { authorization: `Bearer ${runtime.operatorToken}`, ...registryClaimHeaders(claim) }
  const readRevenue = async () => {
    const response = await request.get('/v1/revenue?start=0&end=9007199254740991', { headers: agentHeaders })
    expect(response.status()).toBe(200)
    const { requestId, ...revenue } = await response.json()
    expect(requestId).toEqual(expect.any(String))
    return revenue
  }
  const empty = await request.get('/v1/registry', { headers: agentHeaders })
  expect(empty.status()).toBe(200)
  expect(await empty.json()).toMatchObject({ ok: true, agents: [] })
  const initialReadiness = await request.get('/readyz')
  expect(initialReadiness.status()).toBe(503)
  expect(await initialReadiness.json()).toMatchObject({ ok: false, sourceReadiness: { ok: false,
    checks: expect.arrayContaining([expect.objectContaining({ name: 'registry', ok: false,
      detail: expect.objectContaining({ requiredCategories: { flight: 0, shopping: 0 } }),
    })]),
  } })
  expect(await readRevenue()).toMatchObject({ ok: true, lineCount: 0, summedMarkupMinor: 0 })

  const acquired = await request.post('/v1/operator/claims/acquire', { headers: operatorHeaders, data: claim })
  expect(acquired.status()).toBe(200)
  let registrationFailure: unknown
  try {
    for (const category of ['flight', 'shopping'] as const) {
      const registration = await request.post('/v1/operator/agents', {
        headers: operatorHeaders, data: registrationInput(category), timeout: DEV_REGISTRATION_CLIENT_TIMEOUT_MS,
      })
      expect(registration.status(), `${category} registration: ${await registration.text()}`).toBe(200)
      expect(await registration.json()).toMatchObject({ ok: true, idempotent: false })
    }
    const registered = await request.get('/v1/registry', { headers: agentHeaders })
    expect(registered.status()).toBe(200)
    const registry = await registered.json()
    expect(registry.agents).toHaveLength(2)
    for (const category of ['flight', 'shopping']) {
      expect(registry.agents).toEqual(expect.arrayContaining([expect.objectContaining({
        agentId: `dev-e2e-${category}`, category, registrationState: 'active', admissionVerified: true,
      })]))
    }
  } catch (error) {
    registrationFailure = error
    throw error
  } finally {
    try {
      const released = await request.post('/v1/operator/claims/release', {
        headers: operatorHeaders,
        data: { semanticScope: claim.semanticScope, claimId: claim.claimId, leaseEpoch: claim.leaseEpoch, fenceRevision: claim.fenceRevision },
      })
      expect(released.status(), `claim release: ${await released.text()}`).toBe(200)
    } catch (releaseFailure) {
      if (registrationFailure !== undefined) throw new AggregateError(
        [registrationFailure, releaseFailure],
        `${String(registrationFailure)}\nClaim release also failed: ${String(releaseFailure)}`,
        { cause: registrationFailure },
      )
      throw releaseFailure
    }
  }

  // Consume the actual local-first launch contract through the existing operator boundary.
  // Review data itself never grants a publication permit or settlement authority.
  const launchModule = '../../public/local-first/launch.js'
  const { reviewLaunch, exportLaunchPack } = await import(launchModule)
  const draft = { id: '12345678-1234-1234-1234-123456789abc', revision: 1, title: 'Solo pilot',
    description: 'Private customer notes', price: '', createdAt: 1, updatedAt: 1,
    launch: { merchantId: 'solo-pilot', agentId: 'dev-e2e-flight', audience: 'Solo founders with a travel task',
      outcome: 'One reviewed itinerary', currency: 'USD', priceMinor: 12_500, deliveryCostMinor: 4_000,
      providerFeeMinor: 500, agentCostMinor: 100, acquisitionCostMinor: 900, fixedCostMinor: 10_000 } }
  const pack = await exportLaunchPack(draft, await reviewLaunch(draft))
  const merchantScope = 'merchant-theme:solo-pilot'
  const merchantClaim = { ...registryClaim(runtime.runId), claimId: `merchant-${runtime.runId}`,
    semanticScope: merchantScope, declaredWriteSet: [merchantScope] }
  const merchantHeaders = { authorization: `Bearer ${runtime.operatorToken}`, ...registryClaimHeaders(merchantClaim) }
  const themePath = '/v1/operator/merchants/solo-pilot/theme'
  const beforePublish = await request.get('/s/solo-pilot')
  expect(beforePublish.status()).toBe(404)
  const agentPublish = await request.post(themePath, { headers: agentHeaders, data: pack.themeManifest })
  expect(agentPublish.status()).toBe(401)
  const admitted = await request.post('/v1/operator/claims/acquire', { headers: merchantHeaders, data: merchantClaim })
  expect(admitted.status()).toBe(200)
  try {
    const published = await request.post(themePath, { headers: merchantHeaders, data: pack.nextAction.arguments.manifest })
    expect(published.status(), await published.text()).toBe(200)
    expect(await published.json()).toMatchObject({ ok: true, merchantId: 'solo-pilot', resolvedCatalogScope: ['dev-e2e-flight'] })
  } finally {
    const released = await request.post('/v1/operator/claims/release', { headers: merchantHeaders, data: {
      semanticScope: merchantScope, claimId: merchantClaim.claimId, leaseEpoch: merchantClaim.leaseEpoch,
      fenceRevision: merchantClaim.fenceRevision,
    } })
    expect(released.status(), await released.text()).toBe(200)
  }
  await page.goto(pack.checkout.path, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'One reviewed itinerary' })).toBeVisible()
  await page.locator('#catalog-query').fill('flight')
  const discoveryResponse = page.waitForResponse(response => response.url().endsWith('/v1/intents/route'))
  await page.getByRole('button', { name: 'Search catalog' }).click()
  const discovery = await discoveryResponse
  expect(discovery.status()).toBe(200)
  const routed = await discovery.json()
  expect(routed).toMatchObject({ ok: true, status: 'completed', idempotent: false, agentId: 'dev-e2e-flight' })
  const offer = routed.result.offers[0]
  expect(offer).toMatchObject({ agentId: 'dev-e2e-flight', offerId: 'offer-1', amountMinor: 12_500, currency: 'USD' })
  expect(offer.receiptDigest).toMatch(/^[0-9a-f]{64}$/u)

  await page.getByRole('button', { name: /Select offer offer-1/u }).click()
  const preparationResponse = page.waitForResponse(response => /\/v1\/checkouts\/[^/]+\/prepare$/u.test(response.url()))
  await page.getByRole('button', { name: 'Initiate guarded checkout' }).click()
  const preparation = await preparationResponse
  expect(preparation.status()).toBe(200)
  const prepared = await preparation.json()
  expect(prepared).toMatchObject({ ok: true, status: 'confirmation_required', humanConfirmation: {
    verificationMode: 'development-visual-only', audience: 'agentic-graph-commerce-checkout', relyingPartyOrigin: runtime.baseUrl,
  } })
  await expect(page.getByRole('heading', { name: 'Review and confirm' })).toBeVisible()
  await expect(page.locator('#confirmation-offer')).toHaveText('offer-1')
  await expect(page.locator('#confirmation-total')).toContainText('125.00')
  expect(await readRevenue()).toMatchObject({ lineCount: 0, summedMarkupMinor: 0 })

  const confirmationResponse = page.waitForResponse(response => /\/v1\/human\/checkouts\/[^/]+\/confirm$/u.test(response.url()))
  await page.getByRole('button', { name: 'Confirm checkout after reviewing the total' }).click()
  const confirmation = await confirmationResponse
  expect(confirmation.status()).toBe(200)
  const confirmed = await confirmation.json()
  expect(confirmed).toMatchObject({ ok: true, status: 'settled', idempotent: false })
  const settlement = confirmed.result.settlementReceipt
  expect(settlement).toMatchObject({
    checkoutId: prepared.checkoutId, offerId: 'offer-1', amountMinor: 12_500, currency: 'USD', state: 'settled',
  })
  expect(settlement.receiptDigest).toMatch(/^[0-9a-f]{64}$/u)
  await expect(page.locator('#checkout-confirmation-summary')).toHaveText('Checkout confirmed.')
  const revenue = await readRevenue()
  expect(revenue).toMatchObject({ ok: true, lineCount: 1, summedMarkupMinor: 313, lines: [{
    settlementId: settlement.settlementId, agentId: 'dev-e2e-flight', settledAmountMinor: 12_500,
    currency: 'USD', appliedRateBasisPoints: 250, markupMinor: 313,
  }] })

  // Replay the actual browser request, including its original session/challenge cookies.
  // The core must return the same settlement and must not charge or append markup twice.
  const sent = confirmation.request()
  const sentHeaders = await sent.allHeaders()
  expect(sentHeaders.cookie).toBeTruthy()
  const replay = await request.post(sent.url(), {
    headers: {
      cookie: sentHeaders.cookie ?? '', origin: runtime.baseUrl, 'content-type': 'application/json',
      'x-human-confirmation-csrf': sentHeaders['x-human-confirmation-csrf'] ?? '',
    },
    data: sent.postData() ?? '',
  })
  expect(replay.status()).toBe(200)
  expect(await replay.json()).toMatchObject({ ok: true, status: 'settled', idempotent: true,
    result: { settlementReceipt: settlement } })
  expect(await readRevenue()).toEqual(revenue)
})
