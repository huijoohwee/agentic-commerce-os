import { createPublicKey, verify } from 'node:crypto'
import { types } from 'node:util'

const text = value => typeof value === 'string' && value.length <= 512 && value.trim().length > 0
  && Buffer.byteLength(value, 'utf8') <= 512
const digest = value => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value)
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

function snapshot(value, fields) {
  if (!value || typeof value !== 'object' || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length !== fields.length
    || !fields.every(field => descriptors[field]?.enumerable
      && Object.hasOwn(descriptors[field], 'value'))) return null
  return Object.freeze(Object.fromEntries(fields.map(field => [field, descriptors[field].value])))
}

// Fixed signing bytes for an independent payment verifier. This constructs no authority.
// evidenceDigest comes from the ranker's exact byte snapshot, never reserialized JSON.
export function paymentAttestationMessage(verifierId, receipt, context, payment) {
  if (!text(verifierId) || !text(context?.candidateId) || !digest(context?.claimDigest)
    || !digest(context?.evidenceDigest) || receipt?.candidate?.id !== context.candidateId
    || receipt.candidate.claimDigest !== context.claimDigest
    || ![receipt.provider, receipt.providerReceipt, receipt.payer, receipt.paidArtifact,
      payment?.receipt, payment?.acceptanceNote].every(text)
    || !Number.isSafeInteger(payment?.amountMinor) || payment.amountMinor <= 0
    || typeof payment.currency !== 'string' || !/^[A-Z]{3}$/u.test(payment.currency)
    || payment.status !== 'collected') throw new Error('demand_payment_binding_invalid')
  return Buffer.from(JSON.stringify([
    'commerce-demand-payment/v1', verifierId, context.candidateId, context.claimDigest,
    context.evidenceDigest, receipt.provider, receipt.providerReceipt, receipt.payer,
    receipt.paidArtifact, payment.receipt, payment.status, payment.amountMinor,
    payment.currency, payment.acceptanceNote,
  ]), 'utf8')
}

/**
 * Supply an independently enrolled Ed25519 public key and trusted synchronous readers.
 * readPaymentAttestation(receipt, context) returns the payment fields above + signature
 * (canonical base64). readDemandEvidence() returns the existing Commerce capability read.
 * Pre-fetch through owner-authenticated transports; the synchronous OS ranker does no I/O.
 * No key, receipt, provider, payer, or candidate is enrolled by this module.
 */
export function createDemandEvidenceVerifier({
  verifierId, publicKey, readPaymentAttestation, readDemandEvidence,
} = {}) {
  if (!text(verifierId) || typeof readPaymentAttestation !== 'function'
    || typeof readDemandEvidence !== 'function') throw new Error('demand_verifier_configuration_invalid')
  let key
  try { key = createPublicKey(publicKey) } catch { throw new Error('demand_verifier_public_key_invalid') }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('demand_verifier_key_type_invalid')
  const rejected = reason => Object.freeze({
    verified: false, verifier: verifierId, receipt: `rejected:${reason}`,
  })

  return function verifyDemandEvidence(receipt, context) {
    // The ranker owns claim/digest and structural checks. Recheck freshness at this boundary.
    const observed = Date.parse(receipt?.observedAt)
    const evaluated = Date.parse(context?.evaluatedAt)
    if (!Number.isFinite(observed) || !Number.isFinite(evaluated)
      || observed > evaluated || evaluated - observed > MAX_AGE_MS) return rejected('stale')
    if (receipt?.schema !== 'agentic-os-demand-evidence/v1'
      || receipt.status !== 'verified') return rejected('receipt-invalid')
    let payment
    try { payment = snapshot(readPaymentAttestation(receipt, context), [
      'receipt', 'status', 'amountMinor', 'currency', 'acceptanceNote', 'signature',
    ]) }
    catch { return rejected('payment-unavailable') }
    let message
    try { message = paymentAttestationMessage(verifierId, receipt, context, payment) }
    catch { return rejected('payment-invalid') }
    if (typeof payment.signature !== 'string'
      || !/^[A-Za-z0-9+/]{86}==$/u.test(payment.signature)) return rejected('signature-invalid')
    const signature = Buffer.from(payment.signature, 'base64')
    if (signature.toString('base64') !== payment.signature
      || !verify(null, message, key, signature)) return rejected('signature-invalid')

    let demand
    try { demand = snapshot(readDemandEvidence(), [
      'ok', 'principalsWithTwoOrMoreSettlements', 'principalIdentityBasis',
      'externalPrincipalDistinction', 'reportedAs',
    ]) } catch { return rejected('demand-read-unavailable') }
    if (demand?.ok !== true || !Number.isSafeInteger(demand.principalsWithTwoOrMoreSettlements)
      || demand.principalsWithTwoOrMoreSettlements < 0
      || demand.principalIdentityBasis !== 'registered-agent-identifier'
      || demand.externalPrincipalDistinction !== 'unvalidated'
      || demand.reportedAs !== 'capability') return rejected('demand-read-invalid')
    // Zero is valid for an out-of-band setup fee. Never promote ledger counts to demand.
    return Object.freeze({ verified: true, verifier: verifierId, receipt: payment.receipt })
  }
}
