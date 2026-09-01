import { canonicalJson } from '../shared/digest.js'
import { readJsonResponse } from '../shared/http.js'
import {
  normalizeGuardrailReceipt,
  normalizeSettlementReceipt,
  type GuardrailReceipt,
  type SettlementReceipt,
} from './checkout-receipts.js'
import type { CheckoutPrepareInput, StoredCheckout } from './checkout-state.js'
import { CHECKOUT_PROVIDER_CONTRACT } from './provider-contract.js'
import {
  prepareCheckoutProviderOperation,
  responseMatchesOperationalEvidence,
} from './provider-operation-gate.js'

const PROVIDER_REQUEST_TIMEOUT_MS = 10_000
const MAXIMUM_PROVIDER_RESPONSE_BYTES = 65_536

export type SettlementProviderResult =
  | Readonly<{ ok: true; payload: unknown; receipt: SettlementReceipt }>
  | Readonly<{ ok: false; code: string }>

export async function requestGuardrail(env: CoreEnv, input: CheckoutPrepareInput): Promise<GuardrailReceipt | null> {
  try {
    const operation = await prepareCheckoutProviderOperation(env, new Request(
      'https://commerce.internal/internal/v1/checkouts/prepare', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-commerce-contract': CHECKOUT_PROVIDER_CONTRACT },
      body: JSON.stringify({
        contract: CHECKOUT_PROVIDER_CONTRACT,
        ...input,
        idempotencyKey: `checkout-prepare:${input.checkoutId}`,
      }),
      signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
    }))
    if (!operation.ok) return null
    const response = await env.CHECKOUT_PROVIDER.fetch(operation.request)
    if (!response.ok || !responseMatchesOperationalEvidence(response, operation.binding)) return null
    const payload = await readJsonResponse(response, MAXIMUM_PROVIDER_RESPONSE_BYTES)
    return await normalizeGuardrailReceipt(payload, {
      checkoutId: input.checkoutId,
      intentId: input.intentId,
      agentId: input.agentId,
      offerReceiptDigest: input.offerReceiptDigest,
      amountMinor: input.amountMinor,
      budgetMinor: input.budgetMinor,
      currency: input.currency,
      providerRevision: input.offerProviderRevision,
    })
  } catch {
    return null
  }
}

export async function submitSettlement(
  env: CoreEnv,
  state: StoredCheckout,
  humanConfirmationDigest: string,
  idempotencyKey: string,
): Promise<SettlementProviderResult> {
  try {
    const operation = await prepareCheckoutProviderOperation(env, new Request(
      'https://commerce.internal/internal/v1/checkouts/confirm', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-commerce-contract': CHECKOUT_PROVIDER_CONTRACT,
      },
      body: JSON.stringify(settlementRequest(state, humanConfirmationDigest, idempotencyKey)),
      signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
    }))
    if (!operation.ok) return Object.freeze({ ok: false, code: operation.code })
    const response = await env.CHECKOUT_PROVIDER.fetch(operation.request)
    if (!responseMatchesOperationalEvidence(response, operation.binding)) {
      return Object.freeze({ ok: false, code: 'settlement_provider_evidence_binding_mismatch' })
    }
    return consumeSettlementResponse(response, state, humanConfirmationDigest, idempotencyKey)
  } catch {
    return Object.freeze({ ok: false, code: 'settlement_provider_result_unknown' })
  }
}

export async function reconcileSettlement(
  env: CoreEnv,
  state: StoredCheckout,
  humanConfirmationDigest: string,
  idempotencyKey: string,
): Promise<SettlementProviderResult> {
  const statusUrl = new URL('/internal/v1/checkouts/status', 'https://commerce.internal')
  statusUrl.searchParams.set('idempotencyKey', idempotencyKey)
  try {
    const operation = await prepareCheckoutProviderOperation(env, new Request(statusUrl, {
      method: 'GET',
      headers: { accept: 'application/json', 'x-commerce-contract': CHECKOUT_PROVIDER_CONTRACT },
      signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
    }))
    if (!operation.ok) return Object.freeze({ ok: false, code: operation.code })
    const response = await env.CHECKOUT_PROVIDER.fetch(operation.request)
    if (!responseMatchesOperationalEvidence(response, operation.binding)) {
      return Object.freeze({ ok: false, code: 'settlement_provider_evidence_binding_mismatch' })
    }
    return consumeSettlementResponse(response, state, humanConfirmationDigest, idempotencyKey)
  } catch {
    return Object.freeze({ ok: false, code: 'settlement_reconciliation_incomplete' })
  }
}

async function consumeSettlementResponse(
  response: Response,
  state: StoredCheckout,
  humanConfirmationDigest: string,
  idempotencyKey: string,
): Promise<SettlementProviderResult> {
  if (!response.ok) return Object.freeze({ ok: false, code: 'settlement_provider_result_unknown' })
  let payload: unknown
  try {
    payload = await readJsonResponse(response, MAXIMUM_PROVIDER_RESPONSE_BYTES)
  } catch {
    return Object.freeze({ ok: false, code: 'settlement_provider_result_unknown' })
  }
  try {
    const receipt = await normalizeSettlementReceipt(payload, {
      checkoutId: state.checkout_id,
      offerId: state.offer_id,
      amountMinor: state.amount_minor,
      currency: state.currency,
      idempotencyKey,
      humanConfirmationDigest,
      guardrailReceiptDigest: state.guardrail_receipt_digest ?? '',
      providerRevision: state.offer_provider_revision,
    })
    return Object.freeze({ ok: true, payload, receipt })
  } catch {
    return Object.freeze({ ok: false, code: 'settlement_receipt_invalid' })
  }
}

function settlementRequest(
  state: StoredCheckout,
  humanConfirmationDigest: string,
  idempotencyKey: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    contract: CHECKOUT_PROVIDER_CONTRACT,
    checkoutId: state.checkout_id,
    offerId: state.offer_id,
    amountMinor: state.amount_minor,
    currency: state.currency,
    guardrailReceipt: JSON.parse(state.guardrail_receipt_json ?? 'null') as unknown,
    guardrailReceiptDigest: state.guardrail_receipt_digest,
    humanConfirmationDigest,
    idempotencyKey,
  })
}

export function settlementPayloadDigest(payload: unknown): string {
  return canonicalJson(payload)
}
