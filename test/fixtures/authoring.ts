import type { ClaimMutationPermit } from '../../src/domain/authoring-claim-policy.js'

export function themeMutationPermit(merchantId: string): ClaimMutationPermit {
  const now = Date.now()
  const requestDigest = 'a'.repeat(64)
  return Object.freeze({
    schema: 'agentic-graph-authoring-mutation-permit/v2',
    mutationId: `mutation:1:1:${requestDigest.slice(0, 32)}`,
    operationId: `operation:${requestDigest}`,
    requestDigest,
    mutationSequence: 1,
    semanticScope: `merchant-theme:${merchantId}`,
    claimId: `claim-${merchantId}`,
    leaseEpoch: 1,
    leaseExpiresAtMs: now + 60_000,
    fenceRevision: `fence-${merchantId}`,
    requiredWriteTarget: `merchant-theme:${merchantId}`,
    reservedAtMs: now,
  })
}
