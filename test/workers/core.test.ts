import { env, runInDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { CheckoutSession } from '../../src/core/checkout-session.ts'
import { merchantThemeClaim, vendorTransitionClaim } from '../../src/domain/authoring-claim-policy.ts'
import { sha256Hex } from '../../src/shared/digest.ts'

const CONTRACT_HEADERS = Object.freeze({
  'content-type': 'application/json',
  'x-commerce-contract': 'commerce.edge-core/v1',
  'x-commerce-release-candidate': 'b'.repeat(40),
})
const REGISTRY_CLAIM_HEADERS = claimHeaders('operator-registry', 'core-worker-test-claim', 'test-fence-v1')
const MERCHANT_CLAIM = merchantThemeClaim('merchant-one')
const MERCHANT_CLAIM_HEADERS = claimHeaders(
  MERCHANT_CLAIM.semanticScope,
  'core-worker-merchant-claim',
  'test-merchant-fence-v1',
)
const VENDOR_CLAIM = vendorTransitionClaim('vendor-one')
const VENDOR_CLAIM_HEADERS = claimHeaders(
  VENDOR_CLAIM.semanticScope,
  'core-worker-vendor-claim',
  'test-vendor-fence-v1',
)

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
    await expect(unseeded.json()).resolves.toMatchObject({ ok: false, contract: 'commerce.core-readiness/v2' })

    const unresolvedInvocations = await coreJson('/internal/v1/invocations/resolve', {
      tokens: ['!wrong-sigil', '/not.registered'],
    })
    expect(unresolvedInvocations.status).toBe(200)
    await expect(unresolvedInvocations.json()).resolves.toMatchObject({
      ok: false,
      results: [
        { ok: false, code: 'invocation_token_unresolved', token: '!wrong-sigil' },
        { ok: false, code: 'invocation_token_unresolved', token: '/not.registered' },
      ],
    })

    const resolvedInvocation = await coreJson('/internal/v1/invocations/resolve', { tokens: ['/tool.route'] })
    expect(resolvedInvocation.status).toBe(200)
    await expect(resolvedInvocation.json()).resolves.toMatchObject({
      ok: true,
      priorSourceRevision: null,
      results: [{ ok: true, token: '/tool.route', sourceRevision: 'a'.repeat(40) }],
    })

    const malformedSync = await coreJson('/internal/v1/sync/merge', {
      base: { fields: [], eventLog: [] },
      left: [{ scope: 'storefront', field: 'selection', value: 'offer-1', origin: { deviceId: 'device-1' } }],
      right: [],
    })
    expect(malformedSync.status).toBe(400)
    await expect(malformedSync.json()).resolves.toMatchObject({ ok: false, code: 'sync_merge_malformed' })
  })

  it('persists registry, exclusive routing, and guarded checkout state', async () => {
    const releaseBoundaries = await SELF.fetch('https://core.test/internal/v1/release-boundaries', {
      headers: CONTRACT_HEADERS,
    })
    expect(releaseBoundaries.status).toBe(200)
    const boundaryPayload = await releaseBoundaries.json<{
      register: { boundaries: Array<{ id: string; state: string }> }
    }>()
    expect(boundaryPayload).toMatchObject({
      ok: true,
      register: {
        schema: 'agentic-commerce-deploy-boundary-register/v1',
        source: 'docs/deploy-boundary-register.json',
      },
    })
    expect(boundaryPayload.register.boundaries.find(({ id }) => id === 'mirror-to-delivery')).toMatchObject({
      state: 'closed',
    })
    expect(boundaryPayload.register.boundaries.find(({ id }) => id === 'sandbox-to-mirror')).toMatchObject({
      state: 'pending-protected-integration',
    })
    const unclaimedMutation = await coreJsonWithoutClaim('/internal/v1/vendors/vendor-before-claim/transition', {
      actorId: 'test-operator',
      state: 'active',
    })
    expect(unclaimedMutation.status).toBe(409)
    await expect(unclaimedMutation.json()).resolves.toMatchObject({ ok: false, code: 'authoring_claim_required' })
    const claim = await coreJson('/internal/v1/operator/claims/acquire', {
      claimId: 'core-worker-test-claim',
      actorId: 'test-operator',
      deviceId: 'test-device',
      sessionId: 'test-session',
      worktree: '/test/worktree',
      branch: 'agent/test/core',
      semanticScope: 'operator-registry',
      declaredWriteSet: ['registry'],
      leaseEpoch: 1,
      leaseExpiresAtMs: Date.now() + 60_000,
      fenceRevision: 'test-fence-v1',
    })
    expect(claim.status).toBe(200)
    const admittedClaim = await coreJson('/internal/v1/operator/claims/admit', {
      semanticScope: 'operator-registry', claimId: 'core-worker-test-claim', leaseEpoch: 1,
      fenceRevision: 'test-fence-v1',
      requiredWriteTarget: 'registry',
    })
    expect(admittedClaim.status).toBe(200)
    await expect(admittedClaim.json()).resolves.toMatchObject({
      ok: true, semanticScope: 'operator-registry', claimId: 'core-worker-test-claim', leaseEpoch: 1,
      actorId: 'test-operator', worktree: '/test/worktree', branch: 'agent/test/core', declaredWriteSet: ['registry'],
    })
    const malformedAdmission = await coreJson('/internal/v1/operator/claims/admit', {
      semanticScope: 'operator-registry', claimId: 'core-worker-test-claim', fenceRevision: 'test-fence-v1',
    })
    expect(malformedAdmission.status).toBe(400)
    await expect(malformedAdmission.json()).resolves.toMatchObject({ ok: false, code: 'claim_admission_request_malformed' })
    const crossClaimRelease = await coreJson('/internal/v1/operator/claims/release', {
      semanticScope: 'operator-registry',
      claimId: 'different-claim',
      leaseEpoch: 1,
      fenceRevision: 'test-fence-v1',
    })
    expect(crossClaimRelease.status).toBe(409)
    await expect(crossClaimRelease.json()).resolves.toMatchObject({
      ok: false,
      code: 'claim_release_authority_mismatch',
    })
    const overlappingScope = await coreJson('/internal/v1/operator/claims/acquire', {
      claimId: 'overlapping-core-worker-test-claim',
      actorId: 'test-operator',
      deviceId: 'second-test-device',
      sessionId: 'second-test-session',
      worktree: '/test/second-worktree',
      branch: 'agent/test/core-second',
      semanticScope: 'different-operator-scope',
      declaredWriteSet: ['registry'],
      leaseEpoch: 1,
      leaseExpiresAtMs: Date.now() + 60_000,
      fenceRevision: 'test-fence-v2',
    })
    expect(overlappingScope.status).toBe(409)
    await expect(overlappingScope.json()).resolves.toMatchObject({ ok: false, code: 'write_set_overlap' })
    const merchantClaim = await coreJson('/internal/v1/operator/claims/acquire', {
      claimId: MERCHANT_CLAIM_HEADERS['x-authoring-claim-id'],
      actorId: 'test-operator',
      deviceId: 'test-device',
      sessionId: 'test-session',
      worktree: '/test/worktree',
      branch: 'agent/test/core',
      semanticScope: MERCHANT_CLAIM.semanticScope,
      declaredWriteSet: [MERCHANT_CLAIM.writeTarget],
      leaseEpoch: 1,
      leaseExpiresAtMs: Date.now() + 60_000,
      fenceRevision: MERCHANT_CLAIM_HEADERS['x-authoring-fence-revision'],
    })
    expect(merchantClaim.status).toBe(200)
    const vendorClaimOutsideWriteSet = await coreJson('/internal/v1/operator/claims/acquire', {
      claimId: VENDOR_CLAIM_HEADERS['x-authoring-claim-id'],
      actorId: 'test-operator',
      deviceId: 'test-device',
      sessionId: 'test-session',
      worktree: '/test/worktree',
      branch: 'agent/test/core',
      semanticScope: VENDOR_CLAIM.semanticScope,
      declaredWriteSet: ['vendor:vendor-other'],
      leaseEpoch: 1,
      leaseExpiresAtMs: Date.now() + 60_000,
      fenceRevision: VENDOR_CLAIM_HEADERS['x-authoring-fence-revision'],
    })
    expect(vendorClaimOutsideWriteSet.status).toBe(200)
    const refusedVendor = await coreJson(
      '/internal/v1/vendors/vendor-one/transition',
      { actorId: 'test-operator', state: 'active' },
      VENDOR_CLAIM_HEADERS,
    )
    expect(refusedVendor.status).toBe(409)
    await expect(refusedVendor.json()).resolves.toMatchObject({
      ok: false,
      code: 'mutation_out_of_write_set',
      holdingClaimId: VENDOR_CLAIM_HEADERS['x-authoring-claim-id'],
    })
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
    expect(repeatedRegistration.status).toBe(409)
    await expect(repeatedRegistration.json()).resolves.toMatchObject({ ok: false, code: 'acos_admission_rejected' })
    // A definitive fenced provider refusal must close its reservation so the next operation can proceed.
    const duplicateCategory = await registerAgent(
      'flight-secondary', 'flight', 'commerce.flight.discover', '3'.repeat(64),
    )
    expect(duplicateCategory.status).toBe(200)
    await expect(duplicateCategory.json()).resolves.toMatchObject({
      ok: true,
      idempotent: false,
    })
    const publicAgents = await SELF.fetch('https://core.test/internal/v1/public/agents', {
      headers: CONTRACT_HEADERS,
    })
    expect(publicAgents.status).toBe(200)
    const publicCatalog = await publicAgents.json<{
      agents: Array<Record<string, unknown>>
    }>()
    expect(publicCatalog.agents).toHaveLength(3)
    expect(Object.keys(publicCatalog.agents[0] ?? {}).sort()).toEqual([
      'agentId', 'declaredCapabilities', 'declaredCategory', 'trustStatus',
    ])
    const crossScopeTheme = await coreJson('/internal/v1/operator/merchants/merchant-one/theme', {
      merchantId: 'merchant-one',
      catalogScope: ['flight-primary'],
    })
    expect(crossScopeTheme.status).toBe(409)
    await expect(crossScopeTheme.json()).resolves.toMatchObject({
      ok: false,
      code: 'authoring_claim_scope_mismatch',
    })
    const theme = await coreJson('/internal/v1/operator/merchants/merchant-one/theme', {
      merchantId: 'merchant-one',
      catalogScope: ['flight-primary'],
    }, MERCHANT_CLAIM_HEADERS)
    expect(theme.status).toBe(200)
    await expect(theme.json()).resolves.toMatchObject({
      ok: true,
      merchantId: 'merchant-one',
      resolvedCatalogScope: ['flight-primary'],
    })
    const merchantCatalog = await SELF.fetch('https://core.test/internal/v1/merchants/merchant-one/catalog', {
      headers: CONTRACT_HEADERS,
    })
    expect(merchantCatalog.status).toBe(200)
    await expect(merchantCatalog.json()).resolves.toMatchObject({
      ok: true,
      merchantId: 'merchant-one',
      listings: [{ listingId: 'flight-primary', owningAgentId: 'flight-primary' }],
    })
    const merchantDispatch = await coreJson('/internal/v1/intents/route', {
      intentId: 'intent-merchant-one',
      category: 'flight',
      constraints: { origin: 'SIN', destination: 'NRT' },
      merchantId: 'merchant-one',
      listingId: 'flight-primary',
    })
    expect(merchantDispatch.status).toBe(200)
    await expect(merchantDispatch.json()).resolves.toMatchObject({
      ok: true,
      status: 'completed',
      agentId: 'flight-primary',
    })
    const outOfScopeDispatch = await coreJson('/internal/v1/intents/route', {
      intentId: 'intent-merchant-out-of-scope',
      category: 'flight',
      constraints: {},
      merchantId: 'merchant-one',
      listingId: 'flight-secondary',
    })
    expect(outOfScopeDispatch.status).toBe(404)
    await expect(outOfScopeDispatch.json()).resolves.toMatchObject({ ok: false, code: 'listing_not_found' })
    const ready = await SELF.fetch('https://core.test/internal/readyz')
    expect(ready.status).toBe(503)
    const readiness = await ready.json<Record<string, unknown>>()
    expect(readiness).toMatchObject({
      ok: false,
      contract: 'commerce.core-readiness/v2',
      sourceReadiness: { ok: false },
      liveReleaseReadiness: { ok: false },
    })
    const unboundCapability = await coreJson('/internal/v1/invocations/authorize', {
      capabilityAction: 'checkout.prepare',
    })
    expect(unboundCapability.status).toBe(503)
    await expect(unboundCapability.json()).resolves.toMatchObject({
      ok: false,
      code: 'invocation_capability_upstream_coverage_missing',
      capabilityAction: 'checkout.prepare',
    })

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
    const emptyBlockerDigest = await sha256Hex('[]')
    const shopperPrincipalDigest = 'd'.repeat(64)

    const invalidConfirmation = await coreJson('/internal/v1/checkouts/checkout-1/confirm', {
      checkoutId: 'checkout-1',
      confirmationToken: 'x'.repeat(64),
      offerId: 'offer-1',
      amountMinor: 12_500,
      currency: 'USD',
      blockerDigest: emptyBlockerDigest,
      shopperPrincipalDigest,
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
      currency: 'USD',
      blockerDigest: emptyBlockerDigest,
      shopperPrincipalDigest,
    }
    const checkoutSession = env.CHECKOUT_SESSION.getByName('checkout-1')
    await runInDurableObject(checkoutSession, async (_instance, state) => state.storage.deleteAlarm())
    const confirmed = await coreJson('/internal/v1/checkouts/checkout-1/confirm', confirmation)
    expect(confirmed.status).toBe(200)
    await expect(confirmed.json()).resolves.toMatchObject({ ok: true, status: 'settled', idempotent: false })
    const armedRecoveryAlarm = await runInDurableObject(
      checkoutSession,
      async (_instance, state) => state.storage.getAlarm(),
    )
    expect(armedRecoveryAlarm).toBeNull()

    const alarmRecovery = await runInDurableObject(checkoutSession, async (instance, state) => {
      state.storage.sql.exec(
        "UPDATE checkout_state SET markup_finalization_state = 'pending', markup_finalization_json = NULL WHERE singleton = 1",
      )
      state.storage.sql.exec("DELETE FROM checkout_event WHERE event_type IN ('markup_recorded', 'markup_deferred')")
      await (instance as CheckoutSession).alarm()
      return state.storage.sql.exec<{
        markup_finalization_state: string
        markup_finalization_json: string | null
      }>(
        'SELECT markup_finalization_state, markup_finalization_json FROM checkout_state WHERE singleton = 1',
      ).one()
    })
    expect(alarmRecovery?.markup_finalization_state).toBe('completed')
    expect(JSON.parse(alarmRecovery?.markup_finalization_json ?? 'null')).toMatchObject({
      stage: 'recorded',
      idempotent: true,
      evidenceDisposition: 'persisted',
    })
    const repeatedConfirmation = await coreJson('/internal/v1/checkouts/checkout-1/confirm', confirmation)
    await expect(repeatedConfirmation.json()).resolves.toMatchObject({
      ok: true,
      status: 'settled',
      idempotent: true,
      markup: { stage: 'recorded', idempotent: true, evidenceDisposition: 'persisted' },
    })

    const status = await SELF.fetch('https://core.test/internal/v1/checkouts/checkout-1', {
      headers: CONTRACT_HEADERS,
    })
    const persisted = await status.json<{ events: Array<{ eventType: string }> }>()
    expect(persisted.events.map(({ eventType }) => eventType)).toEqual([
      'checkout_prepare_requested',
      'guardrail_passed',
      'human_confirmed',
      'settlement_recorded',
      'offer_observation_stopped',
      'markup_recorded',
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
      currency: 'USD',
      blockerDigest: emptyBlockerDigest,
      shopperPrincipalDigest,
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
      'offer_observation_stopped',
      'markup_recorded',
    ])

    const revenue = await SELF.fetch(
      'https://core.test/internal/v1/revenue?start=0&end=9007199254740991',
      { headers: CONTRACT_HEADERS },
    )
    expect(revenue.status).toBe(200)
    await expect(revenue.json()).resolves.toMatchObject({ ok: true, lineCount: 2, summedMarkupMinor: 626 })
  })
})

async function registerAgent(
  agentId: string,
  category: string,
  discoveryTool: string,
  contentHash: string,
): Promise<Response> {
  const executableSource = `export async function executeTool(toolId, input) { if (toolId !== ${JSON.stringify(discoveryTool)}) throw new Error('tool_not_declared'); return { toolId, input }; }`
  return coreJson('/internal/v1/agents', {
    agentDefinition: {
      id: agentId,
      revision: `${agentId}-v1`,
      name: `${category} discovery`,
      source: { uri: `workspace:/agents/${agentId}.json`, digest: contentHash },
      model: { providerId: 'workspace-provider', modelId: 'workspace-model' },
      instructions: [{ name: 'purpose', content: `Discover bounded ${category} offers.` }],
      tools: [{ name: discoveryTool, loading: 'direct' }],
      executableTarget: {
        contract: 'agentic-graph-sandbox-executable/v1',
        kind: 'javascript-module',
        source: executableSource,
        sourceDigest: await sha256Hex(executableSource),
      },
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
    commerceProjection: {
      category,
      discoveryTool,
      declaredAttributes: {
        priceMinor: agentId.endsWith('secondary') ? 99_999 : 100,
        qualityScore: agentId.endsWith('secondary') ? 1 : 100,
        latencyMs: agentId.endsWith('secondary') ? 99_999 : 10,
      },
      fallbackAgentId: null,
    },
    expectedPreviousContentHash: null,
  })
}

function coreJson(
  path: string,
  body: unknown,
  authoringHeaders: Readonly<Record<string, string>> = REGISTRY_CLAIM_HEADERS,
): Promise<Response> {
  return SELF.fetch(`https://core.test${path}`, {
    method: 'POST',
    headers: {
      ...CONTRACT_HEADERS,
      ...authoringHeaders,
    },
    body: JSON.stringify(body),
  })
}

function claimHeaders(semanticScope: string, claimId: string, fenceRevision: string): Readonly<Record<string, string>> {
  return Object.freeze({ 'x-authoring-semantic-scope': semanticScope, 'x-authoring-claim-id': claimId,
    'x-authoring-lease-epoch': '1', 'x-authoring-fence-revision': fenceRevision })
}

function coreJsonWithoutClaim(path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://core.test${path}`, {
    method: 'POST',
    headers: CONTRACT_HEADERS,
    body: JSON.stringify(body),
  })
}
