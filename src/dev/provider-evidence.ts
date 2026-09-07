import {
  CHECKOUT_PROVIDER_CONTRACT,
  DISCOVERY_PROVIDER_CONTRACT,
  MARKETPLACE_PROVIDER_CONTRACT,
} from '../core/provider-contract.ts'
import {
  CHECKOUT_EVIDENCE_CHECKS,
  COMMERCE_PRD_REVISION,
  DISCOVERY_EVIDENCE_CHECKS,
  MARKETPLACE_EVIDENCE_CHECKS,
  UPSTREAM_RUNTIME_EVIDENCE_SCHEMA,
  type UpstreamEvidencePin,
} from '../core/upstream-evidence.ts'
import {
  readAuthenticatedOperationalEvidenceBinding,
  readOperationalEvidenceBinding,
  type BoundOperationalEvidenceRequest,
} from '../core/provider-operation-gate.ts'
import { verifyCommerceProviderControlRequest } from '../shared/commerce-provider-auth.ts'
import { DEV_CHECKOUT_PROVIDER_AUTH_SECRET, DEV_MARKETPLACE_PROVIDER_AUTH_SECRET } from './provider-credentials.ts'

export { DEV_CHECKOUT_PROVIDER_AUTH_SECRET, DEV_MARKETPLACE_PROVIDER_AUTH_SECRET } from './provider-credentials.ts'

export const DEV_DISCOVERY_EVIDENCE_PIN: UpstreamEvidencePin = Object.freeze({
  sourceRevision: 'd'.repeat(40),
  receiptDigest: '51c0bfa6357374a5f621d4b165d531eab0655291ef79f02aeb764cde2849f890',
  storageCompatibilityRevision: 'discovery-demo/v1',
  providerVersionId: 'discovery-dev-fixture-v1',
})

export const DEV_CHECKOUT_EVIDENCE_PIN: UpstreamEvidencePin = Object.freeze({
  sourceRevision: 'c'.repeat(40),
  receiptDigest: '03562b1a8a5b16299466ceee22cf2bd1d61af42e564f7f23e1975d232762952d',
  storageCompatibilityRevision: 'checkout-demo/v1',
  providerVersionId: 'checkout-dev-fixture-v1',
})

export const DEV_MARKETPLACE_EVIDENCE_PIN: UpstreamEvidencePin = Object.freeze({
  sourceRevision: 'e'.repeat(40),
  receiptDigest: 'd427d9ab32998d58b14cdb8075f6a06e170999da39f2fa8c382d6b29dfd3534a',
  storageCompatibilityRevision: 'marketplace-demo/v1',
  providerVersionId: 'marketplace-dev-fixture-v1',
})

export function devRuntimeEvidenceResponse(hostname: string): Response {
  if (hostname === 'discovery-provider.internal') {
    return evidenceResponse(DISCOVERY_PROVIDER_CONTRACT, DEV_DISCOVERY_EVIDENCE_PIN, DISCOVERY_EVIDENCE_CHECKS)
  }
  if (hostname === 'checkout-provider.internal') {
    return evidenceResponse(CHECKOUT_PROVIDER_CONTRACT, DEV_CHECKOUT_EVIDENCE_PIN, CHECKOUT_EVIDENCE_CHECKS)
  }
  if (hostname === 'marketplace-provider.internal') {
    return evidenceResponse(MARKETPLACE_PROVIDER_CONTRACT, DEV_MARKETPLACE_EVIDENCE_PIN, MARKETPLACE_EVIDENCE_CHECKS)
  }
  return Response.json({ ok: false, code: 'provider_unknown' }, { status: 404 })
}

export function discoveryOperationBinding(request: Request): Promise<BoundOperationalEvidenceRequest | null> {
  return readOperationalEvidenceBinding(request, DEV_DISCOVERY_EVIDENCE_PIN, DISCOVERY_EVIDENCE_CHECKS)
}

export function checkoutOperationBinding(request: Request): Promise<BoundOperationalEvidenceRequest | null> {
  return readAuthenticatedOperationalEvidenceBinding(
    request,
    CHECKOUT_PROVIDER_CONTRACT,
    DEV_CHECKOUT_EVIDENCE_PIN,
    CHECKOUT_EVIDENCE_CHECKS,
    DEV_CHECKOUT_PROVIDER_AUTH_SECRET,
  )
}

export function marketplaceOperationBinding(request: Request): Promise<BoundOperationalEvidenceRequest | null> {
  return readAuthenticatedOperationalEvidenceBinding(
    request,
    MARKETPLACE_PROVIDER_CONTRACT,
    DEV_MARKETPLACE_EVIDENCE_PIN,
    MARKETPLACE_EVIDENCE_CHECKS,
    DEV_MARKETPLACE_PROVIDER_AUTH_SECRET,
  )
}

export function providerControlAuthenticated(request: Request): Promise<boolean> {
  const hostname = new URL(request.url).hostname
  if (hostname === 'checkout-provider.internal') {
    return verifyCommerceProviderControlRequest(
      request, CHECKOUT_PROVIDER_CONTRACT, DEV_CHECKOUT_PROVIDER_AUTH_SECRET,
    )
  }
  if (hostname === 'marketplace-provider.internal') {
    return verifyCommerceProviderControlRequest(
      request, MARKETPLACE_PROVIDER_CONTRACT, DEV_MARKETPLACE_PROVIDER_AUTH_SECRET,
    )
  }
  return Promise.resolve(hostname === 'discovery-provider.internal')
}

function evidenceResponse(contract: string, pin: UpstreamEvidencePin, checks: readonly string[]): Response {
  return Response.json({
    ok: true,
    contract,
    evidence: {
      schema: UPSTREAM_RUNTIME_EVIDENCE_SCHEMA,
      prdRevision: COMMERCE_PRD_REVISION,
      sourceRevision: pin.sourceRevision,
      receiptDigest: pin.receiptDigest,
      storageCompatibilityRevision: pin.storageCompatibilityRevision,
      providerVersionId: pin.providerVersionId,
      checks: checks.map((name) => ({ name, ok: true })),
    },
  })
}
