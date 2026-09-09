import { isRecord } from '../shared/http.ts'
import { canonicalJson, isNonzeroHexIdentity, sha256Hex } from '../shared/digest.ts'
import {
  declaredRequirements,
  evaluateConvergence,
} from './convergence-evaluator.ts'

export const UPSTREAM_RUNTIME_EVIDENCE_SCHEMA = 'commerce.upstream-runtime-evidence/v1'
export const COMMERCE_PRD_REVISION = '0.3.0'

export const DISCOVERY_EVIDENCE_CHECKS = Object.freeze([
  'invocation_catalog_parity',
  'registered_agent_dispatch',
  'offer_receipt_binding',
])

export const CHECKOUT_EVIDENCE_CHECKS = Object.freeze([
  'guardrail_before_confirmation',
  'human_confirmation_before_issuance',
  'issuance_only_payment_caller',
  'settlement_readback',
])

export const MARKETPLACE_EVIDENCE_CHECKS = Object.freeze([
  'authoring_fence_atomic',
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
      || !isNonzeroHexIdentity(parsed.sourceRevision, 40)
      || !isNonzeroHexIdentity(parsed.receiptDigest, 64)
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
  const verdict = await evaluateConvergence(
    value,
    declaredRequirements(expectedContract, expectedContract, requiredChecks, pin),
  )
  const evidence = isRecord(value) && isRecord(value.evidence) ? value.evidence : null
  const checks = Array.isArray(evidence?.checks) ? evidence.checks : []
  const names = checks.filter(isRecord).map(({ name }) => typeof name === 'string' ? name : '')
  const ok = verdict.state !== 'blocked'
  return result(ok, ok ? null : 'evidence_receipt_mismatch', {
    verdict,
    providerVersionId: typeof evidence?.providerVersionId === 'string' ? evidence.providerVersionId : null,
    sourceRevision: typeof evidence?.sourceRevision === 'string' ? evidence.sourceRevision : null,
    receiptDigest: typeof evidence?.receiptDigest === 'string' ? evidence.receiptDigest : null,
    storageCompatibilityRevision: typeof evidence?.storageCompatibilityRevision === 'string'
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
