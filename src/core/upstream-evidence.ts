import { isRecord } from '../shared/http.js'
import { canonicalJson, sha256Hex } from '../shared/digest.js'

export const UPSTREAM_RUNTIME_EVIDENCE_SCHEMA = 'commerce.upstream-runtime-evidence/v1'
export const COMMERCE_PRD_REVISION = '0.3.0'

export const CHECKOUT_EVIDENCE_CHECKS = Object.freeze([
  'guardrail_before_confirmation',
  'human_confirmation_before_issuance',
  'issuance_only_payment_caller',
  'settlement_readback',
])

export const MARKETPLACE_EVIDENCE_CHECKS = Object.freeze([
  'registry_canvas_parity',
  'active_vendor_at_dispatch',
  'same_transaction_split_projection',
  'commission_reproduction',
  'settlement_verified_before_payout',
  'payout_idempotency',
  'stored_row_reconstruction',
])

export type UpstreamEvidencePin = Readonly<{
  sourceRevision: string
  receiptDigest: string
  storageCompatibilityRevision: string
  providerVersionId: string
}>

export function readUpstreamEvidencePin(value: string): UpstreamEvidencePin | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed)
      || Object.keys(parsed).sort().join(',') !== 'providerVersionId,receiptDigest,sourceRevision,storageCompatibilityRevision'
      || typeof parsed.sourceRevision !== 'string'
      || !/^[0-9a-f]{40}$/u.test(parsed.sourceRevision)
      || typeof parsed.receiptDigest !== 'string'
      || !/^[0-9a-f]{64}$/u.test(parsed.receiptDigest)
      || typeof parsed.storageCompatibilityRevision !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(parsed.storageCompatibilityRevision)
      || typeof parsed.providerVersionId !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/u.test(parsed.providerVersionId)) {
      return null
    }
    return Object.freeze({
      sourceRevision: parsed.sourceRevision,
      receiptDigest: parsed.receiptDigest,
      storageCompatibilityRevision: parsed.storageCompatibilityRevision,
      providerVersionId: parsed.providerVersionId,
    })
  } catch {
    return null
  }
}

export async function verifyUpstreamRuntimeEvidence(
  value: unknown,
  expectedContract: string,
  pin: UpstreamEvidencePin | null,
  requiredChecks: readonly string[],
): Promise<Readonly<Record<string, unknown>>> {
  if (!pin) return result(false, 'evidence_pin_invalid')
  if (!isRecord(value)
    || Object.keys(value).sort().join(',') !== 'contract,evidence,ok'
    || value.ok !== true
    || value.contract !== expectedContract
    || !isRecord(value.evidence)) {
    return result(false, 'evidence_envelope_invalid')
  }
  const evidence = value.evidence
  if (Object.keys(evidence).sort().join(',')
    !== 'checks,prdRevision,providerVersionId,receiptDigest,schema,sourceRevision,storageCompatibilityRevision') {
    return result(false, 'evidence_envelope_invalid')
  }
  const checks = Array.isArray(evidence.checks) ? evidence.checks : []
  const names = checks.map((check) => (
    isRecord(check)
      && Object.keys(check).sort().join(',') === 'name,ok'
      && check.ok === true
      && typeof check.name === 'string'
      ? check.name
      : ''
  ))
  const exactChecks = names.length === requiredChecks.length
    && new Set(names).size === names.length
    && [...names].sort().join(',') === [...requiredChecks].sort().join(',')
  const providerVersionId = typeof evidence.providerVersionId === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/u.test(evidence.providerVersionId)
    ? evidence.providerVersionId
    : null
  const ok = evidence.schema === UPSTREAM_RUNTIME_EVIDENCE_SCHEMA
    && evidence.prdRevision === COMMERCE_PRD_REVISION
    && evidence.sourceRevision === pin.sourceRevision
    && evidence.receiptDigest === pin.receiptDigest
    && evidence.storageCompatibilityRevision === pin.storageCompatibilityRevision
    && providerVersionId === pin.providerVersionId
    && exactChecks
    && evidence.receiptDigest === await digestUpstreamRuntimeEvidence({
      schema: evidence.schema,
      prdRevision: evidence.prdRevision,
      sourceRevision: evidence.sourceRevision,
      storageCompatibilityRevision: evidence.storageCompatibilityRevision,
      providerVersionId: evidence.providerVersionId,
      checks,
    })
  return result(ok, ok ? null : 'evidence_receipt_mismatch', {
    providerVersionId,
    sourceRevision: typeof evidence.sourceRevision === 'string' ? evidence.sourceRevision : null,
    receiptDigest: typeof evidence.receiptDigest === 'string' ? evidence.receiptDigest : null,
    storageCompatibilityRevision: typeof evidence.storageCompatibilityRevision === 'string'
      ? evidence.storageCompatibilityRevision
      : null,
    checks: Object.freeze(names),
  })
}

export function digestUpstreamRuntimeEvidence(value: Readonly<{
  schema: unknown
  prdRevision: unknown
  sourceRevision: unknown
  storageCompatibilityRevision: unknown
  providerVersionId: unknown
  checks: unknown
}>): Promise<string> {
  return sha256Hex(canonicalJson(value))
}

function result(
  ok: boolean,
  code: string | null,
  detail: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({ ok, code, ...detail })
}
