import { env, runInDurableObject } from 'cloudflare:test'
import { expect, it } from 'vitest'

import {
  createSettlementMarkupOutbox,
  type MarkupComputation,
} from '../../src/core/checkout-markup.ts'
import {
  SETTLEMENT_RECEIPT_SCHEMA,
  digestSettlementReceipt,
  type SettlementReceipt,
} from '../../src/core/checkout-receipts.ts'
import { CheckoutSession } from '../../src/core/checkout-session.ts'
import type { StoredCheckout } from '../../src/core/checkout-state.ts'
import { DEV_PROVIDER_PINS } from '../../src/dev/provider.ts'
import { canonicalJson } from '../../src/shared/digest.ts'

it('keeps deferred markup alarm-retryable without resubmitting the provider charge', async () => {
  const checkoutId = `checkout-markup-retry-${crypto.randomUUID()}`
  const receipt = await settlementReceipt(checkoutId)
  const forcedFault: MarkupComputation = () => { throw new Error('transient_compute_fault') }
  const outbox = createSettlementMarkupOutbox(
    500,
    Object.freeze({ agent_id: 'agent-markup-retry' }) as StoredCheckout,
    receipt,
    Date.parse('2026-08-30T00:00:00.000Z'),
    forcedFault,
  )
  expect(outbox.state).toBe('deferred')
  expect(outbox).toMatchObject({
    schema: 'commerce.markup-outbox/v2',
    input: { appliedRateBasisPoints: 500 },
  })
  const before = await providerCounts(checkoutId)
  const stub = env.CHECKOUT_SESSION.get(env.CHECKOUT_SESSION.newUniqueId())

  const recovered = await runInDurableObject(stub, async (instance, state) => {
    seedSettledCheckout(state, checkoutId, receipt, outbox)
    await (instance as CheckoutSession).alarm()
    const row = state.storage.sql.exec<{
      markup_finalization_state: string
      markup_finalization_json: string | null
    }>(
      'SELECT markup_finalization_state, markup_finalization_json FROM checkout_state WHERE singleton = 1',
    ).one()
    const events = state.storage.sql.exec<{ event_type: string }>(
      'SELECT event_type FROM checkout_event ORDER BY sequence',
    ).toArray()
    return Object.freeze({ row, events, alarm: await state.storage.getAlarm() })
  })

  expect(recovered.row?.markup_finalization_state).toBe('completed')
  expect(JSON.parse(recovered.row?.markup_finalization_json ?? 'null')).toMatchObject({
    stage: 'recorded', markupMinor: 625, evidenceDisposition: 'persisted', retryAt: null,
  })
  expect(recovered.events.map(({ event_type }) => event_type)).toContain('markup_recorded')
  expect(recovered.alarm).toBeNull()
  expect(await providerCounts(checkoutId)).toEqual(before)
})

it('caps repeated append-deferral backoff while preserving the settled provider result', async () => {
  const checkoutId = `checkout-markup-backoff-${crypto.randomUUID()}`
  const receipt = await settlementReceipt(checkoutId)
  const recordedAtMs = Date.parse('2026-08-30T00:00:00.000Z')
  const outbox = createSettlementMarkupOutbox(
    250,
    Object.freeze({ agent_id: 'agent-markup-retry' }) as StoredCheckout,
    receipt,
    recordedAtMs,
  )
  await env.REVENUE_LEDGER.getByName('primary').appendLine({
    settlementId: receipt.settlementId,
    agentId: 'conflicting-agent',
    settledAmountMinor: 1,
    currency: 'USD',
    appliedRateBasisPoints: 250,
    markupMinor: 0,
    recordedAtMs,
    recordedAt: new Date(recordedAtMs).toISOString(),
  })
  const before = await providerCounts(checkoutId)
  const stub = env.CHECKOUT_SESSION.get(env.CHECKOUT_SESSION.newUniqueId())
  const result = await runInDurableObject(stub, async (instance, state) => {
    seedSettledCheckout(state, checkoutId, receipt, outbox)
    const delays: number[] = []
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const startedAt = Date.now()
      await (instance as CheckoutSession).alarm()
      delays.push(Number(await state.storage.getAlarm()) - startedAt)
    }
    const row = state.storage.sql.exec<{
      markup_finalization_state: string
      markup_finalization_json: string | null
    }>('SELECT markup_finalization_state, markup_finalization_json FROM checkout_state').one()
    const deferredEvents = state.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM checkout_event WHERE event_type = 'markup_deferred'",
    ).one()?.count
    return Object.freeze({ delays, row, deferredEvents })
  })
  expect(result.row?.markup_finalization_state).toBe('pending')
  expect(JSON.parse(result.row?.markup_finalization_json ?? 'null')).toMatchObject({
    stage: 'deferred', failingStage: 'append', retryAt: expect.any(Number),
  })
  expect(result.deferredEvents).toBe(6)
  expect(result.delays.map((delay) => Math.round(delay / 60_000))).toEqual([1, 2, 4, 8, 15, 15])
  expect(await providerCounts(checkoutId)).toEqual(before)
})

function seedSettledCheckout(
  state: DurableObjectState,
  checkoutId: string,
  receipt: SettlementReceipt,
  outbox: ReturnType<typeof createSettlementMarkupOutbox>,
): void {
  state.storage.sql.exec(
    `INSERT INTO checkout_state (
      singleton, checkout_id, request_digest, intent_id, agent_id, offer_id,
      offer_receipt_digest, offer_provider_revision, amount_minor, budget_minor,
      currency, state, guardrail_receipt_digest, human_confirmation_digest,
      settlement_idempotency_key, provider_result_json, settlement_receipt_json,
      markup_outbox_json, markup_finalization_state, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'settled', ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    checkoutId,
    'a'.repeat(64),
    'intent-markup-retry',
    'agent-markup-retry',
    'offer-markup-retry',
    'b'.repeat(64),
    DEV_PROVIDER_PINS.checkoutEvidence.sourceRevision,
    12_500,
    12_500,
    'USD',
    receipt.guardrailReceiptDigest,
    receipt.humanConfirmationDigest,
    receipt.idempotencyKey,
    canonicalJson({ ok: true, settlementReceipt: receipt }),
    canonicalJson(receipt),
    canonicalJson(outbox),
    new Date().toISOString(),
  )
}

async function settlementReceipt(checkoutId: string): Promise<SettlementReceipt> {
  const value = Object.freeze({
    schema: SETTLEMENT_RECEIPT_SCHEMA,
    settlementId: `settlement-${checkoutId}`,
    checkoutId,
    offerId: 'offer-markup-retry',
    amountMinor: 12_500,
    currency: 'USD',
    idempotencyKey: `checkout-confirm:${checkoutId}`,
    humanConfirmationDigest: 'c'.repeat(64),
    guardrailReceiptDigest: 'd'.repeat(64),
    providerRevision: DEV_PROVIDER_PINS.checkoutEvidence.sourceRevision,
    state: 'settled' as const,
  })
  return Object.freeze({ ...value, receiptDigest: await digestSettlementReceipt(value) })
}

function providerCounts(checkoutId: string): Promise<{ confirmPosts: number; statusGets: number }> {
  return env.CHECKOUT_PROVIDER.fetch(
    `https://commerce.internal/__test__/checkout-provider-counts/${encodeURIComponent(checkoutId)}`,
  ).then((response) => response.json())
}
