import { describe, expect, it } from 'vitest'

import {
  GUARDRAIL_RECEIPT_SCHEMA,
  SETTLEMENT_RECEIPT_SCHEMA,
  digestGuardrailReceipt,
  digestSettlementReceipt,
  normalizeGuardrailReceipt,
  normalizeSettlementReceipt,
  restoreSettlementReceipt,
  type GuardrailReceipt,
  type SettlementReceipt,
} from '../../src/core/checkout-receipts.ts'

const PROVIDER_REVISION = 'a'.repeat(40)
const OFFER_RECEIPT_DIGEST = 'b'.repeat(64)
const HUMAN_CONFIRMATION_DIGEST = 'c'.repeat(64)
const IDEMPOTENCY_KEY = 'checkout-confirm:checkout-1'

describe('checkout receipt validation', () => {
  it('accepts only an exact offer-bound guardrail receipt', async () => {
    const receipt = await guardrailReceipt()
    const payload = {
      contract: 'commerce.checkout-provider/v1',
      guardrailPassed: true,
      guardrailReceipt: receipt,
      ok: true,
    }
    const expected = {
      checkoutId: receipt.checkoutId,
      intentId: receipt.intentId,
      agentId: receipt.agentId,
      offerReceiptDigest: receipt.offerReceiptDigest,
      amountMinor: receipt.amountMinor,
      budgetMinor: receipt.budgetMinor,
      currency: receipt.currency,
      providerRevision: receipt.providerRevision,
    }

    await expect(normalizeGuardrailReceipt(payload, expected)).resolves.toEqual(receipt)
    await expect(normalizeGuardrailReceipt(payload, {
      ...expected,
      providerRevision: 'd'.repeat(40),
    })).rejects.toThrow('guardrail_receipt_mismatch')
    await expect(normalizeGuardrailReceipt({
      ...payload,
      guardrailReceipt: { ...receipt, amountMinor: String(receipt.amountMinor) },
    }, expected)).rejects.toThrow('guardrail_receipt_invalid')
    await expect(normalizeGuardrailReceipt({ ...payload, unexpected: true }, expected))
      .rejects.toThrow('guardrail_receipt_invalid')
  })

  it('accepts only an exact confirmation- and idempotency-bound settlement receipt', async () => {
    const guardrail = await guardrailReceipt()
    const receiptWithoutDigest = {
      schema: SETTLEMENT_RECEIPT_SCHEMA,
      settlementId: 'settlement-checkout-1',
      checkoutId: 'checkout-1',
      offerId: 'offer-1',
      amountMinor: 12_500,
      currency: 'USD',
      idempotencyKey: IDEMPOTENCY_KEY,
      humanConfirmationDigest: HUMAN_CONFIRMATION_DIGEST,
      guardrailReceiptDigest: guardrail.receiptDigest,
      providerRevision: PROVIDER_REVISION,
      state: 'settled' as const,
    } satisfies Omit<SettlementReceipt, 'receiptDigest'>
    const receipt: SettlementReceipt = Object.freeze({
      ...receiptWithoutDigest,
      receiptDigest: await digestSettlementReceipt(receiptWithoutDigest),
    })
    const payload = {
      contract: 'commerce.checkout-provider/v1',
      ok: true,
      settlementReceipt: receipt,
    }
    const expected = {
      checkoutId: receipt.checkoutId,
      offerId: receipt.offerId,
      amountMinor: receipt.amountMinor,
      currency: receipt.currency,
      idempotencyKey: receipt.idempotencyKey,
      humanConfirmationDigest: receipt.humanConfirmationDigest,
      guardrailReceiptDigest: receipt.guardrailReceiptDigest,
      providerRevision: receipt.providerRevision,
    }

    await expect(normalizeSettlementReceipt(payload, expected)).resolves.toEqual(receipt)
    await expect(normalizeSettlementReceipt(payload, {
      ...expected,
      idempotencyKey: 'checkout-confirm:checkout-other',
    })).rejects.toThrow('settlement_receipt_mismatch')
    await expect(normalizeSettlementReceipt({
      ...payload,
      settlementReceipt: { ...receipt, amountMinor: String(receipt.amountMinor) },
    }, expected)).rejects.toThrow('settlement_receipt_invalid')
    await expect(normalizeSettlementReceipt({ ...payload, unexpected: true }, expected))
      .rejects.toThrow('settlement_receipt_invalid')
    await expect(restoreSettlementReceipt(JSON.stringify(receipt), expected)).resolves.toEqual(receipt)
    await expect(restoreSettlementReceipt(JSON.stringify(receipt), {
      ...expected,
      checkoutId: 'checkout-other',
    })).resolves.toBeNull()
    await expect(restoreSettlementReceipt('{', expected)).resolves.toBeNull()
  })
})

async function guardrailReceipt(): Promise<GuardrailReceipt> {
  const receiptWithoutDigest = {
    schema: GUARDRAIL_RECEIPT_SCHEMA,
    receiptId: 'guardrail-checkout-1',
    checkoutId: 'checkout-1',
    intentId: 'intent-1',
    agentId: 'flight-primary',
    offerReceiptDigest: OFFER_RECEIPT_DIGEST,
    amountMinor: 12_500,
    budgetMinor: 15_000,
    currency: 'USD',
    providerRevision: PROVIDER_REVISION,
  } satisfies Omit<GuardrailReceipt, 'receiptDigest'>
  return Object.freeze({
    ...receiptWithoutDigest,
    receiptDigest: await digestGuardrailReceipt(receiptWithoutDigest),
  })
}
