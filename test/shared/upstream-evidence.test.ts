import { describe, expect, it } from 'vitest'

import {
  CHECKOUT_EVIDENCE_CHECKS,
  COMMERCE_PRD_REVISION,
  UPSTREAM_RUNTIME_EVIDENCE_SCHEMA,
  digestUpstreamRuntimeEvidence,
  readUpstreamEvidencePin,
  verifyUpstreamRuntimeEvidence,
} from '../../src/core/upstream-evidence.ts'

const CONTRACT = 'commerce.checkout-provider/v1'
const PROVIDER_VERSION_ID = 'checkout-provider-version-1'
const SOURCE_REVISION = 'a'.repeat(40)
const STORAGE_REVISION = 'checkout-storage/v1'

describe('upstream runtime evidence', () => {
  it('accepts only an exact digest- and provider-version-bound receipt', async () => {
    const evidence = await validEvidence()
    const pin = readUpstreamEvidencePin(JSON.stringify({
      sourceRevision: SOURCE_REVISION,
      receiptDigest: evidence.receiptDigest,
      storageCompatibilityRevision: STORAGE_REVISION,
      providerVersionId: PROVIDER_VERSION_ID,
    }))

    await expect(verifyUpstreamRuntimeEvidence(
      { ok: true, contract: CONTRACT, evidence },
      CONTRACT,
      pin,
      CHECKOUT_EVIDENCE_CHECKS,
    )).resolves.toMatchObject({ ok: true, code: null, providerVersionId: PROVIDER_VERSION_ID })

    const invalidEvidence = [
      { ...evidence, providerVersionId: 'checkout-provider-version-2' },
      { ...evidence, sourceRevision: 'b'.repeat(40) },
      { ...evidence, checks: evidence.checks.map((check, index) => (
        index === 0 ? { ...check, ok: false } : check
      )) },
      { ...evidence, checks: [...evidence.checks].reverse() },
      { ...evidence, checks: evidence.checks.map((check, index) => (
        index === 0 ? { ...check, name: 'unexpected_check' } : check
      )) },
    ]
    for (const changed of invalidEvidence) {
      await expect(verifyUpstreamRuntimeEvidence(
        { ok: true, contract: CONTRACT, evidence: changed },
        CONTRACT,
        pin,
        CHECKOUT_EVIDENCE_CHECKS,
      )).resolves.toMatchObject({ ok: false, code: 'evidence_receipt_mismatch' })
    }
  })

  it('rejects an evidence pin without the immutable provider version', () => {
    expect(readUpstreamEvidencePin(JSON.stringify({
      sourceRevision: SOURCE_REVISION,
      receiptDigest: 'b'.repeat(64),
      storageCompatibilityRevision: STORAGE_REVISION,
    }))).toBeNull()
  })

  it('rejects undeployed source and receipt sentinels while allowing leading-zero identities', () => {
    const pin = { sourceRevision: SOURCE_REVISION, receiptDigest: 'b'.repeat(64),
      storageCompatibilityRevision: STORAGE_REVISION, providerVersionId: PROVIDER_VERSION_ID }
    for (const [field, length] of [['sourceRevision', 40], ['receiptDigest', 64]] as const) {
      expect(readUpstreamEvidencePin(JSON.stringify({ ...pin, [field]: '0'.repeat(length) }))).toBeNull()
      expect(readUpstreamEvidencePin(JSON.stringify({ ...pin, [field]: `${'0'.repeat(length - 1)}1` })))
        .not.toBeNull()
    }
  })
})

async function validEvidence() {
  const value = {
    schema: UPSTREAM_RUNTIME_EVIDENCE_SCHEMA,
    prdRevision: COMMERCE_PRD_REVISION,
    sourceRevision: SOURCE_REVISION,
    storageCompatibilityRevision: STORAGE_REVISION,
    providerVersionId: PROVIDER_VERSION_ID,
    checks: CHECKOUT_EVIDENCE_CHECKS.map((name) => ({ name, ok: true })),
  }
  return Object.freeze({ ...value, receiptDigest: await digestUpstreamRuntimeEvidence(value) })
}
