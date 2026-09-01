import type { CheckoutConfirmInput, CheckoutPrepareInput } from './checkout-state.js'

const PREPARE_FIELDS = new Set([
  'agentId', 'amountMinor', 'budgetMinor', 'checkoutId', 'currency', 'intentId',
  'offerId', 'offerReceiptDigest',
])
const CONFIRM_FIELDS = new Set([
  'amountMinor', 'blockerDigest', 'checkoutId', 'confirmationToken', 'currency', 'offerId',
  'shopperPrincipalDigest',
])

export function checkoutInputFieldsAllowed(
  body: Readonly<Record<string, unknown>>,
  action: 'prepare' | 'confirm',
): boolean {
  const allowed = action === 'prepare' ? PREPARE_FIELDS : CONFIRM_FIELDS
  return Object.keys(body).every((field) => allowed.has(field))
}

export function exactCheckoutPrepareInput(
  body: Readonly<Record<string, unknown>>,
  checkoutId: string,
  offerProviderRevision: string,
): CheckoutPrepareInput {
  return Object.freeze({
    checkoutId,
    intentId: body.intentId,
    agentId: body.agentId,
    offerId: body.offerId,
    offerReceiptDigest: body.offerReceiptDigest,
    offerProviderRevision,
    amountMinor: body.amountMinor,
    budgetMinor: body.budgetMinor,
    currency: body.currency,
  }) as unknown as CheckoutPrepareInput
}

export function exactCheckoutConfirmInput(
  body: Readonly<Record<string, unknown>>,
  checkoutId: string,
): CheckoutConfirmInput {
  return Object.freeze({
    checkoutId,
    confirmationToken: body.confirmationToken,
    offerId: body.offerId,
    amountMinor: body.amountMinor,
    currency: body.currency,
    blockerDigest: body.blockerDigest,
    shopperPrincipalDigest: body.shopperPrincipalDigest,
  }) as unknown as CheckoutConfirmInput
}
