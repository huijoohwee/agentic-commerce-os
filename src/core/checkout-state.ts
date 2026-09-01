import { constantTimeTextMatch } from '../shared/auth.js'
import { canonicalJson, sha256Hex } from '../shared/digest.js'

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const CURRENCY_PATTERN = /^[A-Z]{3}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const REVISION_PATTERN = /^[0-9a-f]{40}$/u

export type CheckoutPrepareInput = Readonly<{
  checkoutId: string
  intentId: string
  agentId: string
  offerId: string
  offerReceiptDigest: string
  offerProviderRevision: string
  amountMinor: number
  budgetMinor: number
  currency: string
}>

export type CheckoutConfirmInput = Readonly<{
  checkoutId: string
  confirmationToken: string
  offerId: string
  amountMinor: number
  currency: string
  blockerDigest: string
  shopperPrincipalDigest: string
}>

export type CheckoutBlocker = Readonly<{
  sequence: number
  eventType: string
  evidence: unknown
}>

export type StoredCheckout = Readonly<{
  checkout_id: string
  request_digest: string
  intent_id: string
  agent_id: string
  offer_id: string
  offer_receipt_digest: string
  offer_provider_revision: string
  amount_minor: number
  budget_minor: number
  currency: string
  state: string
  guardrail_receipt_json: string | null
  guardrail_receipt_digest: string | null
  confirmation_token: string | null
  confirmation_token_digest: string | null
  confirmation_expires_at: number | null
  human_confirmation_digest: string | null
  settlement_idempotency_key: string | null
  applied_rate_basis_points: number | null
  provider_result_json: string | null
  settlement_receipt_json: string | null
  markup_outbox_json: string | null
  markup_finalization_state: string | null
  markup_finalization_json: string | null
  failure_code: string | null
  observation_failure_count: number | null
}>

export function validPrepare(input: CheckoutPrepareInput): boolean {
  return [input.checkoutId, input.intentId, input.agentId, input.offerId]
    .every((value) => IDENTIFIER_PATTERN.test(value))
    && SHA256_PATTERN.test(input.offerReceiptDigest)
    && REVISION_PATTERN.test(input.offerProviderRevision)
    && Number.isSafeInteger(input.amountMinor)
    && input.amountMinor > 0
    && Number.isSafeInteger(input.budgetMinor)
    && input.budgetMinor >= input.amountMinor
    && CURRENCY_PATTERN.test(input.currency)
}

export function validConfirm(input: CheckoutConfirmInput): boolean {
  return IDENTIFIER_PATTERN.test(input.checkoutId)
    && IDENTIFIER_PATTERN.test(input.offerId)
    && typeof input.confirmationToken === 'string'
    && /^[\x21-\x7e]{64,128}$/u.test(input.confirmationToken)
    && Number.isSafeInteger(input.amountMinor)
    && input.amountMinor > 0
    && CURRENCY_PATTERN.test(input.currency)
    && SHA256_PATTERN.test(input.blockerDigest)
    && SHA256_PATTERN.test(input.shopperPrincipalDigest)
}

export async function validConfirmationToken(input: CheckoutConfirmInput, state: StoredCheckout): Promise<boolean> {
  const candidateTokenDigest = await sha256Hex(input.confirmationToken)
  return Boolean(state.confirmation_token_digest)
    && await constantTimeTextMatch(candidateTokenDigest, state.confirmation_token_digest ?? '')
}

export async function digestHumanConfirmation(
  input: CheckoutConfirmInput,
  confirmationTokenDigest: string,
): Promise<string> {
  return sha256Hex(canonicalJson({
    checkoutId: input.checkoutId,
    offerId: input.offerId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    blockerDigest: input.blockerDigest,
    shopperPrincipalDigest: input.shopperPrincipalDigest,
    confirmationTokenDigest,
  }))
}

export function digestCheckoutBlockers(blockers: readonly CheckoutBlocker[]): Promise<string> {
  return sha256Hex(canonicalJson(blockers.map(({ sequence, eventType, evidence }) => ({
    sequence,
    eventType,
    evidence,
  }))))
}

export function preparedResult(state: StoredCheckout, idempotent: boolean): unknown {
  return Object.freeze({
    ok: true,
    status: 'confirmation_required',
    idempotent,
    checkoutId: state.checkout_id,
    confirmationToken: state.confirmation_token,
    confirmationExpiresAt: state.confirmation_expires_at,
    guardrailReceipt: state.guardrail_receipt_json
      ? JSON.parse(state.guardrail_receipt_json) as unknown
      : null,
  })
}

export function rejected(code: string, detail: Readonly<Record<string, unknown>> = {}): unknown {
  return Object.freeze({ ok: false, status: 'rejected', code, ...detail })
}
