import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { authoringMutationHeaders } from '../../src/core/authoring-mutation-headers.ts'
import type { ClaimMutationPermit } from '../../src/domain/authoring-claim-policy.ts'
import { vendorTransitionClaim } from '../../src/domain/authoring-claim-policy.ts'
import { admitDevAuthoringMutation } from '../../src/dev/authoring-fence.ts'

describe('dev provider authoring fence', () => {
  it('executes no provider mutation after a higher epoch has been presented', () => {
    fc.assert(fc.property(
      fc.integer({ min: 2, max: 1_000_000 }),
      fc.uuid(),
      (higherEpoch, identity) => {
        const vendorId = `vendor-${identity}`
        const now = Date.now()
        const higher = permit(vendorId, higherEpoch, now)
        const stale = permit(vendorId, 1, now)
        let providerCalls = 0
        const currentVerdict = admitDevAuthoringMutation(request(higher), vendorTransitionClaim(vendorId), now + 1)
        if (currentVerdict.ok) providerCalls += 1
        const staleVerdict = admitDevAuthoringMutation(request(stale), vendorTransitionClaim(vendorId), now + 1)
        if (staleVerdict.ok) providerCalls += 1
        expect(currentVerdict.ok).toBe(true)
        expect(staleVerdict).toMatchObject({ ok: false, code: 'authoring_mutation_fence_stale' })
        expect(providerCalls).toBe(1)
      },
    ), { numRuns: 300, seed: 19_021 })
  })

  it('requires monotonic mutation sequences within one lease', () => {
    const vendorId = 'vendor-same-lease-order'
    const now = Date.now()
    const first = permit(vendorId, 5, now, 1)
    const second = permit(vendorId, 5, now, 2)
    expect(admitDevAuthoringMutation(request(first), vendorTransitionClaim(vendorId), now + 1).ok).toBe(true)
    expect(admitDevAuthoringMutation(request(second), vendorTransitionClaim(vendorId), now + 1).ok).toBe(true)
    expect(admitDevAuthoringMutation(request(first), vendorTransitionClaim(vendorId), now + 1))
      .toMatchObject({ ok: false, code: 'authoring_mutation_fence_stale' })
  })
})

function request(permit: ClaimMutationPermit): Request {
  return new Request('https://marketplace.internal/v1/vendors/test/transition', {
    method: 'POST',
    headers: authoringMutationHeaders(permit),
  })
}

function permit(vendorId: string, epoch: number, now: number, mutationSequence = 1): ClaimMutationPermit {
  const requestDigest = (epoch * 1_000_000 + mutationSequence).toString(16).padStart(64, '0')
  return Object.freeze({
    schema: 'agentic-graph-authoring-mutation-permit/v2',
    mutationId: `mutation:${epoch}:${mutationSequence}:${requestDigest.slice(0, 32)}`,
    operationId: `operation:${requestDigest}`,
    requestDigest,
    mutationSequence,
    semanticScope: `vendor:${vendorId}`,
    claimId: `claim-${vendorId}-v${epoch}`,
    leaseEpoch: epoch,
    leaseExpiresAtMs: now + 60_000,
    fenceRevision: `fence-${vendorId}-v${epoch}`,
    requiredWriteTarget: `vendor:${vendorId}`,
    reservedAtMs: now,
  })
}
