import { canonicalJson, sha256Hex } from '../shared/digest.js'
import { isRecord } from '../shared/http.js'
import { CHECKOUT_PROVIDER_CONTRACT } from './provider-contract.js'

export const GUARDRAIL_RECEIPT_SCHEMA = 'commerce.guardrail-receipt/v1'
export const SETTLEMENT_RECEIPT_SCHEMA = 'commerce.settlement-receipt/v1'

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const CURRENCY_PATTERN = /^[A-Z]{3}$/u
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,256}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const REVISION_PATTERN = /^[0-9a-f]{40}$/u

export type GuardrailReceipt = Readonly<{
  schema: typeof GUARDRAIL_RECEIPT_SCHEMA
  receiptId: string
  checkoutId: string
  intentId: string
  agentId: string
  offerReceiptDigest: string
  amountMinor: number
  budgetMinor: number
  currency: string
  providerRevision: string
  receiptDigest: string
}>

export type SettlementReceipt = Readonly<{
  schema: typeof SETTLEMENT_RECEIPT_SCHEMA
  settlementId: string
  checkoutId: string
  offerId: string
  amountMinor: number
  currency: string
  idempotencyKey: string
  humanConfirmationDigest: string
  guardrailReceiptDigest: string
  providerRevision: string
  state: 'settled'
  receiptDigest: string
}>

export async function normalizeGuardrailReceipt(
  value: unknown,
  expected: Omit<GuardrailReceipt, 'schema' | 'receiptId' | 'receiptDigest'>,
): Promise<GuardrailReceipt> {
  if (!isRecord(value)
    || Object.keys(value).sort().join(',') !== 'contract,guardrailPassed,guardrailReceipt,ok'
    || value.ok !== true
    || value.contract !== CHECKOUT_PROVIDER_CONTRACT
    || value.guardrailPassed !== true
    || !isRecord(value.guardrailReceipt)) throw new Error('guardrail_receipt_invalid')
  const receipt = value.guardrailReceipt
  if (Object.keys(receipt).sort().join(',') !== 'agentId,amountMinor,budgetMinor,checkoutId,currency,intentId,offerReceiptDigest,providerRevision,receiptDigest,receiptId,schema'
    || receipt.schema !== GUARDRAIL_RECEIPT_SCHEMA
    || typeof receipt.receiptId !== 'string'
    || !IDENTIFIER_PATTERN.test(receipt.receiptId)
    || typeof receipt.checkoutId !== 'string'
    || !IDENTIFIER_PATTERN.test(receipt.checkoutId)
    || typeof receipt.intentId !== 'string'
    || !IDENTIFIER_PATTERN.test(receipt.intentId)
    || typeof receipt.agentId !== 'string'
    || !IDENTIFIER_PATTERN.test(receipt.agentId)
    || typeof receipt.offerReceiptDigest !== 'string'
    || !SHA256_PATTERN.test(receipt.offerReceiptDigest)
    || typeof receipt.amountMinor !== 'number'
    || !Number.isSafeInteger(receipt.amountMinor)
    || receipt.amountMinor <= 0
    || typeof receipt.budgetMinor !== 'number'
    || !Number.isSafeInteger(receipt.budgetMinor)
    || receipt.budgetMinor < receipt.amountMinor
    || typeof receipt.currency !== 'string'
    || !CURRENCY_PATTERN.test(receipt.currency)
    || typeof receipt.providerRevision !== 'string'
    || !REVISION_PATTERN.test(receipt.providerRevision)
    || typeof receipt.receiptDigest !== 'string'
    || !SHA256_PATTERN.test(receipt.receiptDigest)) throw new Error('guardrail_receipt_invalid')
  const normalized: GuardrailReceipt = Object.freeze({
    schema: GUARDRAIL_RECEIPT_SCHEMA,
    receiptId: receipt.receiptId,
    checkoutId: receipt.checkoutId,
    intentId: receipt.intentId,
    agentId: receipt.agentId,
    offerReceiptDigest: receipt.offerReceiptDigest,
    amountMinor: receipt.amountMinor,
    budgetMinor: receipt.budgetMinor,
    currency: receipt.currency,
    providerRevision: receipt.providerRevision,
    receiptDigest: receipt.receiptDigest,
  })
  if (Object.entries(expected).some(([key, expectedValue]) => (
    normalized[key as keyof GuardrailReceipt] !== expectedValue
  )) || normalized.receiptDigest !== await digestGuardrailReceipt(normalized)) {
    throw new Error('guardrail_receipt_mismatch')
  }
  return normalized
}

export async function normalizeSettlementReceipt(
  value: unknown,
  expected: Omit<SettlementReceipt, 'schema' | 'settlementId' | 'state' | 'receiptDigest'>,
): Promise<SettlementReceipt> {
  if (!isRecord(value)
    || Object.keys(value).sort().join(',') !== 'contract,ok,settlementReceipt'
    || value.ok !== true
    || value.contract !== CHECKOUT_PROVIDER_CONTRACT
    || !isRecord(value.settlementReceipt)) throw new Error('settlement_receipt_invalid')
  const receipt = value.settlementReceipt
  if (Object.keys(receipt).sort().join(',') !== 'amountMinor,checkoutId,currency,guardrailReceiptDigest,humanConfirmationDigest,idempotencyKey,offerId,providerRevision,receiptDigest,schema,settlementId,state'
    || receipt.schema !== SETTLEMENT_RECEIPT_SCHEMA
    || receipt.state !== 'settled'
    || typeof receipt.settlementId !== 'string'
    || !IDENTIFIER_PATTERN.test(receipt.settlementId)
    || typeof receipt.checkoutId !== 'string'
    || !IDENTIFIER_PATTERN.test(receipt.checkoutId)
    || typeof receipt.offerId !== 'string'
    || !IDENTIFIER_PATTERN.test(receipt.offerId)
    || typeof receipt.amountMinor !== 'number'
    || !Number.isSafeInteger(receipt.amountMinor)
    || receipt.amountMinor <= 0
    || typeof receipt.currency !== 'string'
    || !CURRENCY_PATTERN.test(receipt.currency)
    || typeof receipt.idempotencyKey !== 'string'
    || !IDEMPOTENCY_KEY_PATTERN.test(receipt.idempotencyKey)
    || typeof receipt.humanConfirmationDigest !== 'string'
    || !SHA256_PATTERN.test(receipt.humanConfirmationDigest)
    || typeof receipt.guardrailReceiptDigest !== 'string'
    || !SHA256_PATTERN.test(receipt.guardrailReceiptDigest)
    || typeof receipt.providerRevision !== 'string'
    || !REVISION_PATTERN.test(receipt.providerRevision)
    || typeof receipt.receiptDigest !== 'string'
    || !SHA256_PATTERN.test(receipt.receiptDigest)) throw new Error('settlement_receipt_invalid')
  const normalized: SettlementReceipt = Object.freeze({
    schema: SETTLEMENT_RECEIPT_SCHEMA,
    settlementId: receipt.settlementId,
    checkoutId: receipt.checkoutId,
    offerId: receipt.offerId,
    amountMinor: receipt.amountMinor,
    currency: receipt.currency,
    idempotencyKey: receipt.idempotencyKey,
    humanConfirmationDigest: receipt.humanConfirmationDigest,
    guardrailReceiptDigest: receipt.guardrailReceiptDigest,
    providerRevision: receipt.providerRevision,
    state: 'settled',
    receiptDigest: receipt.receiptDigest,
  })
  if (Object.entries(expected).some(([key, expectedValue]) => (
    normalized[key as keyof SettlementReceipt] !== expectedValue
  )) || normalized.receiptDigest !== await digestSettlementReceipt(normalized)) {
    throw new Error('settlement_receipt_mismatch')
  }
  return normalized
}

export function digestGuardrailReceipt(receipt: Omit<GuardrailReceipt, 'receiptDigest'> | GuardrailReceipt): Promise<string> {
  return sha256Hex(canonicalJson(withoutReceiptDigest(receipt)))
}

export function digestSettlementReceipt(receipt: Omit<SettlementReceipt, 'receiptDigest'> | SettlementReceipt): Promise<string> {
  return sha256Hex(canonicalJson(withoutReceiptDigest(receipt)))
}

function withoutReceiptDigest(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'receiptDigest')))
}
