import { canonicalJson, sha256Hex } from '../shared/digest.js'
import { isRecord } from '../shared/http.js'

export const DISCOVERY_RECEIPT_CONTRACT = 'commerce.discovery-receipt/v1'
export const DISCOVERY_OFFER_SCHEMA = 'commerce.discovery-offer/v1'

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const SHA_PATTERN = /^[0-9a-f]{64}$/u

export type DiscoveryOfferReceipt = Readonly<{
  schema: typeof DISCOVERY_OFFER_SCHEMA
  intentId: string
  intentDigest: string
  agentId: string
  offerId: string
  amountMinor: number
  currency: string
  providerRevision: string
  receiptDigest: string
}>

export async function normalizeDiscoveryReceipt(
  value: unknown,
  expectedIntentId: string,
  expectedIntentDigest: string,
  expectedAgentId: string,
): Promise<Readonly<{ contract: typeof DISCOVERY_RECEIPT_CONTRACT; ok: true; offers: readonly DiscoveryOfferReceipt[] }>> {
  if (!isRecord(value)
    || Object.keys(value).sort().join(',') !== 'contract,offers,ok'
    || value.contract !== DISCOVERY_RECEIPT_CONTRACT
    || value.ok !== true
    || !Array.isArray(value.offers)
    || value.offers.length < 1
    || value.offers.length > 100) {
    throw new Error('discovery_receipt_invalid')
  }
  const offers = await Promise.all(value.offers.map(async (candidate) => {
    if (!isRecord(candidate)
      || Object.keys(candidate).sort().join(',') !== 'agentId,amountMinor,currency,intentDigest,intentId,offerId,providerRevision,receiptDigest,schema'
      || candidate.schema !== DISCOVERY_OFFER_SCHEMA
      || candidate.intentId !== expectedIntentId
      || candidate.intentDigest !== expectedIntentDigest
      || candidate.agentId !== expectedAgentId
      || typeof candidate.offerId !== 'string'
      || !IDENTIFIER_PATTERN.test(candidate.offerId)
      || !Number.isSafeInteger(candidate.amountMinor)
      || Number(candidate.amountMinor) <= 0
      || typeof candidate.currency !== 'string'
      || !/^[A-Z]{3}$/u.test(candidate.currency)
      || typeof candidate.providerRevision !== 'string'
      || !/^[0-9a-f]{40}$/u.test(candidate.providerRevision)
      || typeof candidate.receiptDigest !== 'string'
      || !SHA_PATTERN.test(candidate.receiptDigest)) {
      throw new Error('discovery_offer_invalid')
    }
    const receipt: DiscoveryOfferReceipt = Object.freeze({
      schema: DISCOVERY_OFFER_SCHEMA,
      intentId: candidate.intentId,
      intentDigest: candidate.intentDigest,
      agentId: candidate.agentId,
      offerId: candidate.offerId,
      amountMinor: Number(candidate.amountMinor),
      currency: candidate.currency,
      providerRevision: candidate.providerRevision,
      receiptDigest: candidate.receiptDigest,
    })
    const expectedDigest = await digestDiscoveryOffer(receipt)
    if (receipt.receiptDigest !== expectedDigest) throw new Error('discovery_offer_digest_mismatch')
    return receipt
  }))
  const keys = offers.map(({ offerId, providerRevision }) => `${providerRevision}:${offerId}`)
  if (new Set(keys).size !== keys.length) throw new Error('discovery_offer_duplicate')
  return Object.freeze({ contract: DISCOVERY_RECEIPT_CONTRACT, ok: true, offers: Object.freeze(offers) })
}

export function digestDiscoveryOffer(
  receipt: Omit<DiscoveryOfferReceipt, 'receiptDigest'> | DiscoveryOfferReceipt,
): Promise<string> {
  return sha256Hex(canonicalJson({
    schema: receipt.schema,
    intentId: receipt.intentId,
    intentDigest: receipt.intentDigest,
    agentId: receipt.agentId,
    offerId: receipt.offerId,
    amountMinor: receipt.amountMinor,
    currency: receipt.currency,
    providerRevision: receipt.providerRevision,
  }))
}
